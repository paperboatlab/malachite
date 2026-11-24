// The Malachite app server: `malachite <vault> [--port N]`. Serves the page (dist/), a JSON API over the
// vault, and Server-Sent Events for what changes (files, cells, runtimes). It listens on 127.0.0.1 only
// and answers only requests addressed to it (Host) from its own page (Origin), so a web page elsewhere
// can't drive it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Control, ControlError } from "./control.ts";
import { Index } from "./index.ts";
import { bodyHash, parse, type Lang } from "./note.ts";
import { Sessions } from "./sessions.ts";
import { Vault, VaultError } from "./vault.ts";

export const DEFAULT_PORT = 59210;   // paperboat/apps.toml
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".png": "image/png", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".json": "application/json", ".pdf": "application/pdf",
};

export function serve(vaultDir: string, port = DEFAULT_PORT, control = new Control()) {
  const vault = new Vault(vaultDir);
  const index = new Index(vault);
  index.build();
  const clients = new Set<http.ServerResponse>();
  const emit = (e: Record<string, unknown>) => { const s = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(s); };
  vault.onEvent = (e) => emit({ type: "log", event: e });
  const sessions = new Sessions(vault, control, emit);

  // the index follows the files: whoever changed them (this server, an editor, git)
  let pending = new Set<string>(), timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(vault.root, { recursive: true }, (_ev, f) => {
    if (!f) return;
    const rel = f.toString().split(path.sep).join("/");
    if (rel.split("/").some((p) => p.startsWith(".") || p === "node_modules")) return;
    pending.add(rel);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const changed = [...pending];
      pending = new Set();
      for (const r of changed) { try { index.update(r); } catch { /* outside or gone */ } }
      // a folder that moved takes its files with it
      for (const p of index.items.keys()) if (!fs.existsSync(path.join(vault.root, p))) index.items.delete(p);
      for (const f of vault.files()) if (!index.items.has(f)) index.update(f);
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
      const q = (k: string) => { const v = url.searchParams.get(k); if (v === null) throw new VaultError(`missing ${k}`); return v; };
      const body = req.method === "GET" ? {} : await json(req);
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case "GET /api/vault": return send(res, 200, { name: vault.name, root: vault.root, author: vault.author });
        case "GET /api/tree": return send(res, 200, vault.tree());
        case "GET /api/index": return send(res, 200, index.list());
        case "GET /api/note": {
          const p = q("path"), text = vault.read(p), n = parse(text, path.basename(p, ".md"));
          const id = typeof n.props.id === "string" ? n.props.id : p;
          const intact = n.props.hash ? `sha256:${bodyHash(n.body)}` === n.props.hash : undefined;
          return send(res, 200, { path: p, text, props: n.props, body: n.body, title: n.title, cells: n.cells, sealed: !!n.props.sealed, intact, outputs: sessions.outputs(id) });
        }
        case "PUT /api/note": { vault.write(q("path"), String(body.text ?? "")); index.update(q("path")); return send(res, 200, {}); }
        case "POST /api/note": { const p = vault.create(String(body.dir ?? ""), String(body.title ?? "Untitled"), String(body.kind ?? "note")); index.update(p); return send(res, 200, { path: p }); }
        case "POST /api/folder": { vault.mkdir(String(body.path)); return send(res, 200, {}); }
        case "POST /api/move": { vault.rename(String(body.from), String(body.to)); return send(res, 200, {}); }
        case "POST /api/trash": { vault.trash(String(body.path)); index.update(String(body.path)); return send(res, 200, {}); }
        case "POST /api/seal": { vault.seal(String(body.path)); index.update(String(body.path)); return send(res, 200, {}); }
        case "GET /api/links": {
          const p = q("path");
          return send(res, 200, {
            links: index.links(p),
            backlinks: index.backlinks(p).map((b) => ({ path: b, title: index.items.get(b)?.title ?? b, context: index.context(b, p) })),
            history: vault.events(20, p),
          });
        }
        case "POST /api/reveal": {   // the folder in the OS file manager (this server runs on the user's machine)
          const abs = vault.resolve(String(body.path)), dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
          spawn(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [dir], { detached: true, stdio: "ignore" }).on("error", () => {}).unref();
          return send(res, 200, {});
        }
        case "GET /api/log": return send(res, 200, vault.events(Number(url.searchParams.get("limit") ?? 200)));
        case "GET /api/raw": {
          const abs = vault.resolve(q("path"));
          res.writeHead(200, { "content-type": TYPES[path.extname(abs).toLowerCase()] ?? "application/octet-stream", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:", "x-content-type-options": "nosniff" });
          return fs.createReadStream(abs).pipe(res);
        }
        case "POST /api/run": return send(res, 200, sessions.run(String(body.path), String(body.hash)));
        case "POST /api/interrupt": return send(res, 200, await sessions.interrupt(lang(body.lang)));
        case "POST /api/restart": return send(res, 200, sessions.restart(lang(body.lang)));
        case "GET /api/runtimes": return send(res, 200, await sessions.peek());
        default: return send(res, 404, { error: `no ${route}` });
      }
    } catch (e) {
      if (e instanceof VaultError) return send(res, e.status, { error: e.message });
      if (e instanceof ControlError) return send(res, 503, { error: e.message });
      console.error(e);
      return send(res, 500, { error: String((e as Error).message ?? e) });
    }
  });

  server.listen(port, "127.0.0.1");
  server.on("close", () => { watcher.close(); sessions.close(); for (const c of clients) c.end(); });
  return { server, vault, index, sessions };
}

const lang = (l: unknown): Lang => { if (l === "julia" || l === "python") return l; throw new VaultError("lang is julia or python"); };

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function json(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { s += d; if (s.length > 32 << 20) { reject(new VaultError("too large", 413)); req.destroy(); } });
    req.on("end", () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new VaultError("bad JSON")); } });
    req.on("error", reject);
  });
}

function file(res: http.ServerResponse, p: string) {
  const rel = p === "/" ? "index.html" : decodeURIComponent(p).replace(/^\/+/, "");
  const abs = path.resolve(DIST, rel);
  if (!abs.startsWith(DIST + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": TYPES[path.extname(abs)] ?? "application/octet-stream" });
  fs.createReadStream(abs).pipe(res);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--port");
  const port = pi >= 0 ? Number(args.splice(pi, 2)[1]) : Number(process.env.MALACHITE_PORT ?? DEFAULT_PORT);
  const dir = args[0];
  if (!dir || args.includes("--help") || args.includes("-h")) {
    console.log("usage: malachite <vault folder> [--port N]\n  Opens the folder as a vault (vault.toml is written on first open) and serves it on 127.0.0.1.");
    process.exit(dir ? 0 : 2);
  }
  fs.mkdirSync(dir, { recursive: true });
  const { server, vault } = serve(dir, port);
  server.on("listening", () => console.log(`Malachite: ${vault.name} (${vault.root}) on http://127.0.0.1:${port}/`));
  server.on("error", (e) => { console.error(`malachite: ${e.message}`); process.exit(1); });
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { server.close(); process.exit(0); });
}
