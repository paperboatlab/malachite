// The Malachite app server: `malachite <hub> [--port N]`. Serves the page (dist/), a JSON API over the
// hub, and Server-Sent Events for what changes (files, cells, runtimes). It listens on 127.0.0.1 only
// and answers only requests addressed to it (Host) from its own page (Origin), so a web page elsewhere
// can't drive it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Control, ControlError, paperboatVersion } from "./control.ts";
import { Index } from "./index.ts";
import { bodyHash, parse, type Lang } from "./note.ts";
import { NoSession, Sessions } from "./sessions.ts";
import { Hub, HubError, SCHEMA } from "./hub.ts";

export const DEFAULT_PORT = 59210;   // paperboat/apps.toml
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".json": "application/json", ".pdf": "application/pdf",
  ".avif": "image/avif", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac",
};
const UPLOAD_MAX = 2 ** 31;   // 2 GiB: a video from a lab camera, not a disk image

export function serve(hubDir: string, port = DEFAULT_PORT, control = new Control()) {
  const hub = new Hub(hubDir);
  const index = new Index(hub);
  index.build();
  const clients = new Set<http.ServerResponse>();
  const emit = (e: Record<string, unknown>) => { const s = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(s); };
  hub.onEvent = (e) => emit({ type: "log", event: e });
  const sessions = new Sessions(hub, control, emit);

  // the index follows the files: whoever changed them (this server, an editor, git)
  let pending = new Set<string>(), timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(hub.root, { recursive: true }, (_ev, f) => {
    if (!f) return;
    const rel = f.toString().split(path.sep).join("/");
    if (rel.split("/").some((p) => p.startsWith(".") || p === "node_modules") || rel.endsWith(".tmp")) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = [...pending];
      pending = new Set();
      for (const r of changed) { try { index.update(r); } catch { /* outside or gone */ } }
      // a folder that moved takes its files with it
      for (const p of index.items.keys()) if (!fs.existsSync(path.join(hub.root, p))) index.items.delete(p);
      for (const f of hub.files()) if (!index.items.has(f)) index.update(f);
      emit({ type: "files", changed });
    }, 120);
  });

  const host = () => [`127.0.0.1:${server.address() && (server.address() as any).port}`, `localhost:${(server.address() as any)?.port}`];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    try {
      if (!host().includes(req.headers.host ?? "")) return send(res, 421, { error: "wrong host" });
      if (req.method !== "GET" && req.headers.origin && !host().some((h) => req.headers.origin === `http://${h}`)) return send(res, 403, { error: "wrong origin" });
      if (!url.pathname.startsWith("/api/") && url.pathname !== "/events") return file(res, url.pathname);
      if (url.pathname === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        res.write(": malachite\n\n");
        clients.add(res);
        req.on("close", () => clients.delete(res));
        return;
      }
      const q = (k: string) => { const v = url.searchParams.get(k); if (v === null) throw new HubError(`missing ${k}`); return v; };
      // a file's bytes (a picture dropped in a note, an edited picture): before the JSON body is read
      if (req.method === "POST" && url.pathname === "/api/upload") {
        const p = await upload(req, hub, q("path"), url.searchParams.get("replace") === "1");
        index.update(p);
        return send(res, 200, { path: p });
      }
      const body = req.method === "GET" ? {} : await json(req);
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case "GET /api/hub": return send(res, 200, { name: hub.name, root: hub.root, author: hub.author });
        // About: the hub format and Paperboat's version (null: not installed); never starts paperboatd
        case "GET /api/about": return send(res, 200, { format: SCHEMA, paperboat: await paperboatVersion() });
        case "GET /api/tree": return send(res, 200, hub.tree());
        case "GET /api/index": return send(res, 200, index.list());
        case "GET /api/note": {
          const p = q("path"), text = hub.read(p), n = parse(text, path.basename(p, ".md"));
          const id = typeof n.props.id === "string" ? n.props.id : p;
          const intact = n.props.hash ? `sha256:${bodyHash(n.body)}` === n.props.hash : undefined;
          return send(res, 200, { path: p, text, props: n.props, body: n.body, title: n.title, cells: n.cells, sealed: !!n.props.sealed, intact, outputs: sessions.outputs(id) });
        }
        case "PUT /api/note": { hub.write(q("path"), String(body.text ?? "")); index.update(q("path")); return send(res, 200, {}); }
        case "POST /api/note": { const p = hub.create(String(body.dir ?? ""), String(body.title ?? "Untitled"), String(body.kind ?? "note")); index.update(p); return send(res, 200, { path: p }); }
        case "POST /api/folder": { hub.mkdir(String(body.path)); return send(res, 200, {}); }
        case "POST /api/move": { hub.rename(String(body.from), String(body.to)); return send(res, 200, {}); }
        case "POST /api/trash": { hub.trash(String(body.path)); index.update(String(body.path)); return send(res, 200, {}); }
        case "GET /api/trash": return send(res, 200, hub.trashed());
        case "POST /api/trash/restore": { const p = hub.restore(String(body.id)); index.update(p); for (const f of hub.files()) if (!index.items.has(f)) index.update(f); return send(res, 200, { path: p }); }
        case "POST /api/trash/delete": { hub.purge(String(body.id)); return send(res, 200, {}); }
        case "POST /api/trash/empty": { hub.purge(); return send(res, 200, {}); }
        case "POST /api/prop": { hub.setProp(String(body.path), String(body.key), String(body.value ?? "")); index.update(String(body.path)); return send(res, 200, {}); }
        case "POST /api/seal": { hub.seal(String(body.path)); index.update(String(body.path)); return send(res, 200, {}); }
        case "GET /api/links": {
          const p = q("path");
          return send(res, 200, {
            links: index.links(p),
            backlinks: index.backlinks(p).map((b) => ({ path: b, title: index.items.get(b)?.title ?? b, context: index.context(b, p) })),
            history: hub.events(20, p),
          });
        }
        case "POST /api/reveal": {   // the folder in the OS file manager (this server runs on the user's machine)
          const abs = hub.resolve(String(body.path)), dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
          spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [dir], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
          return send(res, 200, {});
        }
        case "GET /api/log": return send(res, 200, hub.events(Number(url.searchParams.get("limit") ?? 200)));
        case "GET /api/raw": {
          const abs = hub.resolve(q("path"));
          return stream(res, abs, { "content-type": TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:", "x-content-type-options": "nosniff", "cache-control": "no-cache" }, req.headers.range);
        }
        case "POST /api/run": return send(res, 200, sessions.run(String(body.path), String(body.hash)));
        case "POST /api/interrupt": return send(res, 200, await sessions.interrupt(lang(body.lang)));
        case "POST /api/restart": return send(res, 200, sessions.restart(lang(body.lang)));
        case "GET /api/runtimes": return send(res, 200, await sessions.peek());
        case "POST /api/ask": return send(res, 200, await sessions.ask(lang(body.lang), String(body.op), body.args ?? {}));
        default: return send(res, 404, { error: `no ${route}` });
      }
    } catch (e) {
      if (e instanceof HubError) return send(res, e.status, { error: e.message });
      if (e instanceof ControlError) return send(res, 503, { error: e.message });
      if (e instanceof NoSession) return send(res, 409, { error: e.message });
      console.error(e);
      return send(res, 500, { error: String((e as Error).message ?? e) });
    }
  });

  server.listen(port, "127.0.0.1");
  server.on("close", () => { watcher.close(); sessions.close(); for (const c of clients) c.end(); });
  return { server, hub, index, sessions };
}

const lang = (l: unknown): Lang => { if (l === "julia" || l === "python") return l; throw new HubError("lang is julia or python"); };

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function json(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { s += d; if (s.length > 32 << 20) { reject(new HubError("too large", 413)); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new HubError("bad JSON")); } });
    req.on("error", reject);
  });
}

function file(res: http.ServerResponse, p: string) {
  const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
  const abs = path.resolve(DIST, rel);
  if (!abs.startsWith(DIST + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: "not found" });
  stream(res, abs, { "content-type": TYPES[path.extname(abs)] ?? "application/octet-stream" });
}

/** A file to the response. One that is gone (moved, deleted, mid-checkout) is a 404, never a crash. */
/** A file, whole or (a video seeking) the byte range asked for. */
function stream(res: http.ServerResponse, abs: string, headers: http.OutgoingHttpHeaders, range?: string) {
  let size: number;
  try { const st = fs.statSync(abs); if (!st.isFile()) throw new Error("not a file"); size = st.size; } catch { return send(res, 404, { error: "not found" }); }
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  let start = 0, end = size - 1, status = 200;
  if (m && (m[1] || m[2])) {
    if (m[1] === "") { start = Math.max(0, size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    if (start > end || start >= size) { res.writeHead(416, { "content-range": `bytes */${size}` }); return res.end(); }
    status = 206;
  }
  const s = fs.createReadStream(abs, size ? { start, end } : {});
  s.once("open", () => {
    res.writeHead(status, { ...headers, "accept-ranges": "bytes", "content-length": size ? end - start + 1 : 0, ...(status === 206 ? { "content-range": `bytes ${start}-${end}/${size}` } : {}) });
    s.pipe(res);
  });
  s.once("error", () => { if (!res.headersSent) send(res, 404, { error: "not found" }); else res.destroy(); });
}

/** A file written from the request's bytes: to a temporary name, then renamed, so a cut-off upload leaves
 *  nothing half-written. `replace` sends what was there to the trash first (it can come back); otherwise
 *  a taken name becomes "<name> (2)". Returns the path written. */
async function upload(req: http.IncomingMessage, hub: Hub, rel: string, replace: boolean): Promise<string> {
  let to = rel;
  if (!path.extname(to) || /(^|\/)\./.test(to)) throw new HubError(`${rel}: a file name with its type, outside dot folders`);
  if (fs.existsSync(hub.resolve(to))) {
    if (replace) hub.trash(to);
    else { const ext = path.extname(to), stem = to.slice(0, -ext.length); for (let n = 2; fs.existsSync(hub.resolve(to)); n++) to = `${stem} (${n})${ext}`; }
  }
  const abs = hub.resolve(to), tmp = `${abs}.${process.pid}.upload.tmp`;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    let n = 0;
    const out = fs.createWriteStream(tmp);
    req.on("data", (d: Buffer) => { n += d.length; if (n > UPLOAD_MAX) { req.destroy(); out.destroy(); reject(new HubError("too large: 2 GiB at most", 413)); } });
    req.on("error", reject); out.on("error", reject);
    out.on("finish", () => resolve());
    req.pipe(out);
  }).catch((e) => { fs.rmSync(tmp, { force: true }); throw e; });
  fs.renameSync(tmp, abs);
  hub.log(replace && to === rel ? "file.replaced" : "file.added", to, { bytes: fs.statSync(abs).size });
  return to;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--port");
  const port = pi >= 0 ? Number(args.splice(pi, 2)[1]) : Number(process.env.MALACHITE_PORT ?? DEFAULT_PORT);
  const dir = args[0];
  if (!dir || args.includes("--help") || args.includes("-h")) {
    console.log("usage: malachite <hub folder> [--port N]\n  Opens the folder as a hub (hub.toml is written on first open) and serves it on 127.0.0.1.");
    process.exit(dir ? 0 : 2);
  }
  fs.mkdirSync(dir, { recursive: true });
  const { server, hub } = serve(dir, port);
  server.on("listening", () => console.log(`Malachite: ${hub.name} (${hub.root}) on http://127.0.0.1:${port}/`));
  server.on("error", (e) => { console.error(`malachite: ${e.message}`); process.exit(1); });
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { server.close(); process.exit(0); });
}
