// The app server's API (server/main.ts), typed for the page.
import type { Scale, Theme } from "@paperboatlab/ui";
import type { RecentEntry } from "@paperboatlab/ui/workspace";
export type Entry = { path: string; name: string; kind: "dir" | "file"; size?: number; mtime?: number; children?: Entry[] };
export type Props = Record<string, string | string[]>;
export type Item = { path: string; name: string; type: string; title: string; props: Props; tags: string[]; links: string[]; cells: number; mtime: number; size: number };
export type Output =
  | { type: "stream"; name: string; text: string }
  | { type: "display" | "result"; data: Record<string, string> }
  | { type: "error"; error: { type?: string; message: string; traceback?: string } };
export type Lang = "julia" | "python";
export type Run = { note: string; hash: string; lang: Lang; state: "queued" | "running" | "done" | "failed"; ran?: string; ms?: number; outputs: Output[]; runtime?: { name: string; version: string; backend: string } };
export type Cell = { lang: Lang; code: string; hash: string; line: number };
export type NoteData = { path: string; text: string; props: Props; body: string; title: string; cells: Cell[]; sealed: boolean; intact?: boolean; outputs: Record<string, Run> };
export type LogEvent = { time: string; actor: string; action: string; target?: string; details?: Record<string, unknown> } | { damaged: string };
export type Links = { links: { link: string; path: string | null }[]; backlinks: { path: string; title: string; context: string }[]; history: LogEvent[] };
export type Session = { id: string; runtime: string; lang: Lang; backend: string; state: string; uptime_s?: number; idle_s?: number; stats: { cpu_percent: number; memory_bytes: number } | null; running: { note: string; title?: string; path?: string; since?: string }[] };
export type Trashed = { id: string; path: string; kind: "file" | "folder"; time: string; actor: string };
/** The open hub's settings (.malachite/hub.toml) and where it is. */
export type HubConf = { id: string; name: string; schema: number; author: string; created: string; keep: "90d" | "1y" | "always"; ignore: string; root: string; shown: string; place: Place; conflicts: string[] };
/** A hub this machine knows ($PAPERBOAT_HOME/hubs.toml). */
export type Place = "local" | "google-drive" | "onedrive" | "dropbox" | "icloud";
export type KnownHub = { id: string; path: string; shown: string; place: Place; name: string; missing?: boolean; conflicts?: string[]; notes?: number };
/** What Malachite works in (the kit's `Workspace`): a hub, or nothing (the Start page). */
export type Workspace = { kind: "hub"; root: string; name: string; hub: string };
/** Opening a workspace: the hub, and the file to open in it (a file opened from outside). */
export type Entered = { workspace: Workspace | null; open?: string };
export type Version = { id: string; time: string; author: string; what: string };
export type Peek = { sessions: Session[]; runtimes: { name: string; version: string }[] };

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({ error: r.statusText }));
  if (!r.ok) throw Object.assign(new Error(j.error ?? r.statusText), { body: j });
  return j as T;
}
const q = (p: string) => encodeURIComponent(p);

export const api = {
  hub: () => call<HubConf>("GET", "/api/hub"),
  hubs: () => call<KnownHub[]>("GET", "/api/hubs"),
  hubSet: (key: "name" | "author" | "keep" | "ignore", value: string) => call<HubConf>("POST", "/api/hub/config", { key, value }),
  workspace: () => call<{ workspace: Workspace | null; home: string; notHub?: { name: string; path: string } }>("GET", "/api/workspace"),
  /** { id }: a known hub; { path }: a folder or a file (a plain folder throws with `body.notHub`), `make` makes it a hub; {}: close. */
  enter: (to: { id: string } | { path: string; make?: boolean } | Record<string, never>) => call<Entered>("POST", "/api/workspace", to),
  hubNew: (name: string) => call<Entered>("POST", "/api/hubs/new", { name }),
  recent: () => call<{ version: 1; recent: RecentEntry[] }>("GET", "/api/recent"),
  opened: (p: string) => call("POST", "/api/recent", { path: p }),
  clearRecent: () => call("POST", "/api/recent/clear", {}),
  settings: () => call<{ version: 1; theme: Theme; scale: Scale }>("GET", "/api/settings"),
  setTheme: (theme: Theme) => call("PUT", "/api/settings", { theme }),
  setScale: (scale: Scale) => call("PUT", "/api/settings", { scale }),
  hubForget: (id: string) => call("POST", "/api/hubs/remove", { id }),
  apps: () => call<{ name: string; label: string }[]>("GET", "/api/apps"),
  openIn: (app: string, p: string, copy: boolean) => call<{ url: string; folder: string; file: string }>("POST", "/api/apps/open", { app, path: p, copy }),
  versions: (p: string) => call<{ ok: boolean; versions: Version[] }>("GET", `/api/versions?path=${q(p)}`),
  restoreVersion: (id: string, p: string) => call<{ id: string | null }>("POST", "/api/versions/restore", { id, path: p }),
  about: () => call<{ format: number; paperboat: string | null }>("GET", "/api/about"),
  tree: () => call<Entry[]>("GET", "/api/tree"),
  index: () => call<Item[]>("GET", "/api/index"),
  note: (p: string) => call<NoteData>("GET", `/api/note?path=${q(p)}`),
  text: (p: string) => fetch(`/api/raw?path=${q(p)}`).then((r) => r.text()),
  /** Writes the file; `mtime` is the one it has now (its watcher event says the same). */
  save: (p: string, text: string) => call<{ mtime?: number }>("PUT", `/api/note?path=${q(p)}`, { text }),
  create: (dir: string, title: string, kind = "note") => call<{ path: string }>("POST", "/api/note", { dir, title, kind }),
  folder: (p: string) => call("POST", "/api/folder", { path: p }),
  move: (from: string, to: string) => call("POST", "/api/move", { from, to }),
  trash: (p: string) => call("POST", "/api/trash", { path: p }),
  trashed: () => call<Trashed[]>("GET", "/api/trash"),
  restore: (id: string) => call<{ path: string }>("POST", "/api/trash/restore", { id }),
  purge: (id: string) => call("POST", "/api/trash/delete", { id }),
  emptyTrash: () => call("POST", "/api/trash/empty", {}),
  seal: (p: string) => call("POST", "/api/seal", { path: p }),
  prop: (p: string, key: string, value: string) => call("POST", "/api/prop", { path: p, key, value }),
  reveal: (p: string) => call("POST", "/api/reveal", { path: p }),
  links: (p: string) => call<Links>("GET", `/api/links?path=${q(p)}`),
  log: () => call<LogEvent[]>("GET", "/api/log?limit=300"),
  run: (p: string, hash: string) => call<Run>("POST", "/api/run", { path: p, hash }),
  interrupt: (lang: Lang) => call("POST", "/api/interrupt", { lang }),
  restart: (lang: Lang) => call("POST", "/api/restart", { lang }),
  /** Manage runtimes…: the Paperboat Launcher on its Runtimes page. */
  manageRuntimes: () => call("POST", "/api/launcher", {}),
  runtimes: () => call<Peek>("GET", "/api/runtimes"),
  ask: (lang: Lang, op: string, args: Record<string, unknown>) => call<unknown>("POST", "/api/ask", { lang, op, args }),
  /** A file's bytes; `v` (its mtime) makes a changed file load again. */
  raw: (p: string, v?: number) => `/api/raw?path=${q(p)}${v ? `&v=${Math.round(v)}` : ""}`,
  /** Bytes into the hub: a new file gets a free name; `replace` sends the old one to the trash first. */
  upload: async (p: string, body: Blob, replace = false) => {
    const r = await fetch(`/api/upload?path=${q(p)}${replace ? "&replace=1" : ""}`, { method: "POST", body });
    const j = await r.json().catch(() => ({ error: r.statusText }));
    if (!r.ok) throw new Error(j.error ?? r.statusText);
    return j as { path: string };
  },
};

/** The index with a watcher event's changes: items updated or added, paths gone; the order stays the server's. */
export function patchItems(items: Item[], updated: Item[], gone: string[]): Item[] {
  const upd = new Map(updated.map((i) => [i.path, i])), out = new Set(gone);
  const next = items.filter((i) => !out.has(i.path)).map((i) => { const u = upd.get(i.path); upd.delete(i.path); return u ?? i; });
  return upd.size ? [...next, ...upd.values()].sort((a, b) => a.path.localeCompare(b.path)) : next;
}

/** Server-Sent Events: files, cells, runtimes, the log. Reconnects by itself (EventSource does). */
export function listen(on: (e: any) => void): () => void {
  const es = new EventSource("/events");
  es.onmessage = (m) => { try { on(JSON.parse(m.data)); } catch { /* not ours */ } };
  return () => es.close();
}
