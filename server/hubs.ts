// The hubs this machine knows (paperboat#16): `$PAPERBOAT_HOME/hubs.toml`, written by Malachite, read by
// every app and the Launcher. Only where each hub is lives here; a hub's own settings travel inside it
// (`.malachite/hub.toml`). A hub is found by its id, so a renamed or moved one is still the same hub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HubError, peek } from "./hub.ts";

export type Place = "local" | "google-drive";
export type Known = { id: string; path: string; place: Place };
/** A known hub as the selector, the picker and `hub list` show it. */
export type HubInfo = Known & { name: string; shown: string; missing?: boolean };

/** A path as people read it: the home folder as ~. */
export const tilde = (p: string) => (p === os.homedir() || p.startsWith(os.homedir() + path.sep) ? `~${p.slice(os.homedir().length)}` : p);

/** Paperboat's home, as the paperboat CLI finds it (src/lib/paths.cpp). */
export function paperboatHome(): string {
  const env = process.env;
  if (env.PAPERBOAT_HOME) return env.PAPERBOAT_HOME;
  if (process.platform === "win32" && env.LOCALAPPDATA) return path.join(env.LOCALAPPDATA, "paperboat");
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "paperboat");
}
const listFile = () => path.join(paperboatHome(), "hubs.toml");

/** Where new hubs go unless told (REBRAND Settings › Malachite › Hubs). */
export const defaultFolder = (name: string) => path.join(os.homedir(), "Documents", "paperboat", name);

export function known(): Known[] {
  const f = listFile();
  if (!fs.existsSync(f)) return [];
  const out: Known[] = [];
  let cur: Partial<Known> | null = null;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (/^\s*\[\[hub\]\]\s*$/.test(line)) { cur = {}; out.push(cur as Known); continue; }
    const m = /^\s*(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (cur && m) (cur as Record<string, string>)[m[1]] = JSON.parse(`"${m[2]}"`);
  }
  return out.filter((k) => k.id && k.path).map((k) => ({ ...k, place: k.place === "google-drive" ? "google-drive" : "local" }));
}

function save(list: Known[]) {
  const f = listFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const text = "# The hubs this machine knows: written by Malachite (paperboat hub …), read by every app.\n" +
    list.map((k) => `\n[[hub]]\nid = ${JSON.stringify(k.id)}\npath = ${JSON.stringify(k.path)}\nplace = ${JSON.stringify(k.place)}\n`).join("");
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
}

/** Adds a hub, or notes where it is now (opened from another folder after a move). */
export function remember(id: string, root: string, place: Place = "local") {
  const list = known().filter((k) => k.id !== id && path.resolve(k.path) !== path.resolve(root));
  save([...list, { id, path: root, place }].sort((a, b) => a.path.localeCompare(b.path)));
}

export function forget(id: string) { save(known().filter((k) => k.id !== id)); }

/** The known hubs with their names; a folder that is gone says so (its last name is unknown). */
export function infos(): HubInfo[] {
  return known().map((k) => {
    const c = fs.existsSync(k.path) ? peek(k.path) : null;
    return c ? { ...k, name: c.name || path.basename(k.path), shown: tilde(k.path) } : { ...k, name: path.basename(k.path), shown: tilde(k.path), missing: true };
  });
}

/** A hub by its name, id or folder; an ambiguous name says so. */
export function find(word: string): HubInfo {
  const all = infos(), abs = path.resolve(word);
  const hit = all.filter((h) => h.id === word || path.resolve(h.path) === abs);
  const named = hit.length ? hit : all.filter((h) => h.name === word);
  if (named.length === 1) return named[0];
  if (named.length > 1) throw new HubError(`${named.length} hubs are called ${word}: name one by its folder (${named.map((h) => h.path).join(", ")})`);
  throw new HubError(`no hub ${word} · paperboat hub list shows them`, 404);
}
