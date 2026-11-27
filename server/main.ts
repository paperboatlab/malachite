// The Malachite app server: `malachite [<hub>] [--port N]`. Serves the page (dist/), a JSON API over the
// hub it works in (switched at runtime: open, new, close; none is the Start page), the shared store
// (`recent.json`, `settings.json`), and Server-Sent Events for what changes (files, cells, runtimes). It listens on 127.0.0.1 only
// and answers only requests addressed to it (Host) from its own page (Origin), so a web page elsewhere
// can't drive it.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Control, ControlError, paperboatVersion } from "./control.ts";
import { Index } from "./index.ts";
import { bodyHash, parse, type Lang } from "./note.ts";
import { NoSession, Sessions } from "./sessions.ts";
import { History } from "./history.ts";
import { Hub, HubError, SCHEMA, type HubKey } from "./hub.ts";
import { addRecent, conflictsIn, defaultFolder, dropRecent, forget, hubAbove, infos, placeOf, recent, remember, saveSettings, settings, tilde, isScale, isTheme } from "./hubs.ts";

export const DEFAULT_PORT = 30474;   // Malachite's home port (paperboat/apps.toml); other hubs get --port from the CLI (30500–30599)
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

/** What is open: one hub with its history, index and sessions; `close` ends them (and saves the history). */
type Open = { hub: Hub; history: History; index: Index; sessions: Sessions; saveSoon: () => void; holdSave: () => void; close: () => void };
/** What the page works in (the kit's `Workspace`): Malachite works in hubs only; null is the Start page. */
export type Workspace = { kind: "hub"; root: string; name: string; hub: string } | null;

/** `ask`: a plain folder the page offers to make a hub (NotAHub) instead of making it one unasked. */
export function serve(hubDir: string | null, port = DEFAULT_PORT, control = new Control(), ask?: string) {
  const clients = new Set<http.ServerResponse>();
  const emit = (e: Record<string, unknown>) => { const s = `data: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(s); };

  /** Opens a hub: its settings (made on a plain folder), the history, the index, the sessions, the watcher. */
  const work = (dir: string): Open => {
    // what the open does, for the page's Start (its words show past 2 s; sent before each long step, which
    // holds the event loop)
    const doing = (detail: string) => emit({ type: "opening", detail });
    const hub = new Hub(dir);
    remember(hub.id, hub.root);   // $PAPERBOAT_HOME/hubs.toml: every app's list of hubs
    // while this serves the hub, `paperboat hub move` refuses to move it from under us
    const serving = path.join(hub.root, ".malachite", "serving.pid");
    fs.writeFileSync(serving, String(process.pid));
    // the history: other machines' pasts first, then what changed while no Malachite was watching
    doing("Reading the history");
    const history = new History(hub);
    history.merge();
    history.save(history.versions(".", 1).length ? "Changes while Malachite was closed" : undefined);
    let packTimer: NodeJS.Timeout | undefined, saveTimer: NodeJS.Timeout | undefined;
    const pack = () => { clearTimeout(packTimer); try { history.pack(); } catch (e) { console.error(`malachite: history: ${(e as Error).message}`); } };
    const saveSoon = () => {   // a version a few seconds after the last change; the bundle every few minutes
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        try { if (history.save() && !packTimer) packTimer = setTimeout(() => { packTimer = undefined; pack(); }, 5 * 60_000).unref(); }
        catch (e) { console.error(`malachite: history: ${(e as Error).message}`); }
      }, 3000).unref();   // never what keeps the process up: closing saves and packs anyway
    };
    const index = new Index(hub);
    index.build((n) => doing(`Indexing ${n.toLocaleString("en").replace(/,/g, " ")} files`));
    hub.onEvent = (e) => emit({ type: "log", event: e });
    const sessions = new Sessions(hub, control, emit);

    // the index follows the files: whoever changed them (this server, an editor, git)
    let pending = new Set<string>(), timer: NodeJS.Timeout | undefined;
    const watcher = hub.watch((rel) => {
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const changed = [...pending];
        pending = new Set();
        // what changed, with its items: the page patches its tree and index instead of asking for them again
        emit({ type: "files", changed, ...index.apply(changed) });
        saveSoon();
      }, 120);
    });
    const close = () => {
      watcher.close(); clearTimeout(timer); clearTimeout(saveTimer); clearTimeout(packTimer);
      sessions.stop();   // this hub's sessions end; the daemon connection stays for the next hub
      try { history.save(); history.pack(); } catch { /* the next open saves it */ }
      try { if (fs.readFileSync(serving, "utf8") === String(process.pid)) fs.rmSync(serving); } catch { /* gone */ }
    };
    return { hub, history, index, sessions, saveSoon, holdSave: () => clearTimeout(saveTimer), close };
  };

  let cur: Open | null = null;
  process.on("exit", () => cur?.close());
  const workspace = (): Workspace => (cur ? { kind: "hub", root: cur.hub.root, name: cur.hub.name, hub: cur.hub.id } : null);
  /** Switches the hub at runtime (null: none, the Start page): the new one opens before the old one closes,
   *  so a hub that can't open leaves the page where it was. */
  const switchTo = (dir: string | null) => {
    if (dir && cur && fs.realpathSync(dir) === cur.hub.root) return;
    const next = dir ? work(dir) : null;
    cur?.close();
    cur = next;
    ask = undefined;
    if (cur) addRecent({ kind: "hub", path: cur.hub.root, hub: cur.hub.id });
    emit({ type: "workspace" });
  };
  const need = (): Open => { if (!cur) throw new HubError("no hub is open", 409); return cur; };
  if (hubDir) switchTo(hubDir);

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
        const { hub, index } = need();
        const p = await upload(req, hub, q("path"), url.searchParams.get("replace") === "1");
        index.update(p);
        return send(res, 200, { path: p });
      }
      const body = req.method === "GET" ? {} : await json(req);
      const route = `${req.method} ${url.pathname}`;
      // what works without a hub: the workspace, the hubs, the shared store, About
      switch (route) {
        case "GET /api/workspace": return send(res, 200, { workspace: workspace(), home: os.homedir(), ...(ask && { notHub: { name: path.basename(ask), path: ask } }) });
        // { id }: a known hub; { path }: a folder or a file (its hub), { path, make: true }: a plain folder made a hub; {}: close
        case "POST /api/workspace": {
          if (typeof body.id === "string") {
            const h = infos().find((x) => x.id === body.id);
            if (!h) throw new HubError("no such hub", 404);
            if (h.missing) throw new HubError(`can't find ${h.name}'s folder (${h.shown})`, 410);
            switchTo(h.path);
            return send(res, 200, { workspace: workspace() });
          }
          if (typeof body.path !== "string") { switchTo(null); return send(res, 200, { workspace: null }); }
          const typed = body.path.trim();
          if (!/^(\/|~(\/|$)|[A-Za-z]:[\\/])/.test(typed)) throw new HubError("a whole path: from / or ~");
          const abs = path.resolve(typed.replace(/^~(?=$|[\\/])/, os.homedir()));
          if (!fs.existsSync(abs)) { dropRecent({ kind: "hub", path: abs }); dropRecent({ kind: "file", path: abs }); throw new HubError(`${tilde(abs)} isn't there`, 404); }
          const isFile = fs.statSync(abs).isFile(), folder = isFile ? path.dirname(abs) : abs;
          const root = hubAbove(folder) ?? (body.make === true ? folder : null);
          // Malachite works in hubs only: a plain folder asks to become one (the page's NotAHub)
          if (!root) return send(res, 409, { error: `${path.basename(folder)} isn't a hub`, notHub: { name: path.basename(folder), path: folder } });
          switchTo(root);
          const open = isFile ? path.relative(cur!.hub.root, fs.realpathSync(abs)).split(path.sep).join("/") : undefined;
          if (open) addRecent({ kind: "file", path: path.join(cur!.hub.root, open), hub: cur!.hub.id });
          return send(res, 200, { workspace: workspace(), open });
        }
        case "GET /api/hubs": return send(res, 200, infos());
        case "POST /api/hubs/remove": { forget(String(body.id)); return send(res, 200, {}); }
        case "POST /api/hubs/new": {   // New hub…: in ~/Documents/paperboat/<name>, and Malachite works in it
          const name = String(body.name ?? "").trim();
          const dir = defaultFolder(name);
          if (fs.existsSync(dir)) throw new HubError(`${dir} exists: pick another name`, 409);
          fs.mkdirSync(dir, { recursive: true });
          switchTo(dir);
          return send(res, 200, { workspace: workspace() });
        }
        case "GET /api/recent": return send(res, 200, { version: 1, recent: recent() });
        case "POST /api/recent": {   // a file the page opened, in the open hub
          const { hub } = need();
          addRecent({ kind: "file", path: hub.resolve(String(body.path)), hub: hub.id });
          return send(res, 200, {});
        }
        case "POST /api/recent/clear": { dropRecent(); return send(res, 200, {}); }
        case "GET /api/settings": return send(res, 200, settings());
        case "PUT /api/settings": {
          const { theme, scale } = body;   // either or both
          if (theme !== undefined && !isTheme(theme)) throw new HubError("theme is light, dark or system");
          if (scale !== undefined && !isScale(scale)) throw new HubError("scale is 0.75, 1 or 1.25");
          saveSettings({ ...(theme !== undefined ? { theme } : {}), ...(scale !== undefined ? { scale } : {}) });
          return send(res, 200, settings());
        }
        // About: the hub format and Paperboat's version (null: not installed); never starts paperboatd
        case "GET /api/about": return send(res, 200, { format: SCHEMA, paperboat: await paperboatVersion() });
        case "GET /api/apps": return send(res, 200, await installedApps().catch(() => []));
      }
      const { hub, history, index, sessions, saveSoon, holdSave } = need();
      const hubInfo = () => ({ ...hub.conf, root: hub.root, shown: tilde(hub.root), place: placeOf(hub.root), conflicts: conflictsIn(hub.root) });
      switch (route) {
        case "GET /api/hub": return send(res, 200, hubInfo());
        case "POST /api/hub/config": { hub.set(String(body.key) as HubKey, String(body.value ?? "")); history.excludes(); saveSoon(); return send(res, 200, hubInfo()); }
        case "GET /api/versions": return send(res, 200, { ok: history.ok, versions: history.versions(url.searchParams.get("path") ?? "") });
        case "POST /api/versions/restore": {
          holdSave();
          const id = history.restore(String(body.id), String(body.path ?? ""));
          for (const f of hub.files()) index.update(f.path);
          return send(res, 200, { id });
        }
        // a file another app draws: open it there on this hub (the app works in the hub), or copy it out
        case "POST /api/apps/open": {
          const app = String(body.app), rel = String(body.path), copy = !!body.copy;
          if (!(await installedApps()).some((a) => a.name === app)) throw new HubError(`${app} is not installed · paperboat app install ${app}`, 409);
          if (!fs.statSync(hub.resolve(rel)).isFile()) throw new HubError(`${rel} is not a file`);
          let folder = hub.root, open = rel;
          if (copy) {
            folder = copyFolder(app);
            fs.mkdirSync(folder, { recursive: true });
            const ext = path.extname(rel), stem = path.basename(rel, ext);
            open = `${stem}${ext}`;
            for (let n = 2; fs.existsSync(path.join(folder, open)); n++) open = `${stem} (${n})${ext}`;
            fs.copyFileSync(hub.resolve(rel), path.join(folder, open), fs.constants.COPYFILE_EXCL);
            hub.log("file.copied", rel, { app, to: path.join(folder, open) });
          }
          const s = await paperboat(["app", "open", app, folder, "--no-open"]);
          return send(res, 200, { url: `${s.url.replace(/\/?$/, "/")}?open=${encodeURIComponent(open)}`, folder: tilde(folder), file: open });
        }
        case "GET /api/tree": return send(res, 200, hub.tree());
        case "GET /api/index": return send(res, 200, index.list());
        case "GET /api/note": {
          const p = q("path"), text = hub.read(p), n = parse(text, path.basename(p, ".md"));
          const id = typeof n.props.id === "string" ? n.props.id : p;
          const intact = n.props.hash ? `sha256:${bodyHash(n.body)}` === n.props.hash : undefined;
          return send(res, 200, { path: p, text, props: n.props, body: n.body, title: n.title, cells: n.cells, sealed: !!n.props.sealed, intact, outputs: sessions.outputs(id) });
        }
        case "PUT /api/note": { hub.write(q("path"), String(body.text ?? "")); return send(res, 200, { mtime: index.update(q("path"))?.mtime }); }
        case "POST /api/note": { const p = hub.create(String(body.dir ?? ""), String(body.title ?? "Untitled"), String(body.kind ?? "note")); index.update(p); return send(res, 200, { path: p }); }
        case "POST /api/folder": { hub.mkdir(String(body.path)); return send(res, 200, {}); }
        case "POST /api/move": { hub.rename(String(body.from), String(body.to)); return send(res, 200, {}); }
        case "POST /api/trash": { hub.trash(String(body.path)); index.update(String(body.path)); return send(res, 200, {}); }
        case "GET /api/trash": return send(res, 200, hub.trashed());
        case "POST /api/trash/restore": { const p = hub.restore(String(body.id)); index.apply([p]); return send(res, 200, { path: p }); }
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
  server.on("close", () => { cur?.close(); cur = null; control.close(); for (const c of clients) c.end(); });
  return { server, get hub() { return cur?.hub; }, workspace };
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

/** The paperboat CLI with --json: its answer, or its words as an error. */
function paperboat(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.env.PAPERBOAT_BIN ?? "paperboat", [...args, "--json"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", () => reject(new HubError("this needs the paperboat CLI on PATH", 501)));
    p.on("close", (code) => {
      let j: any;
      try { j = JSON.parse(out); } catch { /* not JSON */ }
      if (code === 0 && j !== undefined) return resolve(j);
      reject(new HubError(`paperboat ${args.slice(0, 2).join(" ")}: ${(j?.error ?? (err || out)).toString().trim() || `exit ${code}`}`, 502));
    });
  });
}

/** The apps installed beside Malachite (paperboat app list), asked at most every 10 s. */
let appsSeen: { at: number; list: { name: string; label: string }[] } | undefined;
async function installedApps() {
  if (!appsSeen || Date.now() - appsSeen.at > 10_000) {
    const all: { name: string; label: string; installed: unknown }[] = await paperboat(["app", "list"]);
    appsSeen = { at: Date.now(), list: all.filter((a) => a.installed).map((a) => ({ name: a.name, label: a.label })) };
  }
  return appsSeen.list;
}

/** Where "Copy to <app>" puts a file: the app's own folder, outside every hub. */
const copyFolder = (app: string) => path.join(os.homedir(), "Documents", "paperboat", app);

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
  if (args.includes("--help") || args.includes("-h")) {
    console.log("usage: malachite [<hub folder>] [--port N]\n  Serves Malachite on 127.0.0.1, in the hub the folder is in, or on the Start page (a plain folder: it asks to make it a hub).\n       malachite hub …  the hubs this machine knows (paperboat hub …)");
    process.exit(0);
  }
  if (dir) fs.mkdirSync(dir, { recursive: true });
  // a folder in a hub opens that hub; a plain one is the Start page, asking to make it one
  const root = dir ? hubAbove(dir) : null;
  const { server, hub } = serve(root, port, undefined, dir && !root ? path.resolve(dir) : undefined);
  server.on("listening", () => console.log(`Malachite: ${hub ? `${hub.name} (${hub.root})` : "no hub"} on http://127.0.0.1:${port}/`));
  server.on("error", (e) => { console.error(`malachite: ${e.message}`); process.exit(1); });
  for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => { server.close(); process.exit(0); });
}
