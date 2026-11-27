// The hub: the folder Malachite opens (pb#415). The files are the record; `.malachite/` is a cache
// (the outputs of cells, the trash, the activity log in `.malachite/log/<machine>/`). Every path from the page goes through
// `resolve`, which keeps it inside the hub.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { bodyHash, join, split } from "./note.ts";

export type Entry = { path: string; name: string; kind: "dir" | "file"; size?: number; mtime?: number; children?: Entry[] };
export type Event = { time: string; actor: string; action: string; target?: string; details?: Record<string, unknown> };
export type Trashed = { id: string; path: string; kind: "file" | "folder"; time: string; actor: string };
export class HubError extends Error { readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

const HIDDEN = new Set([".malachite", ".git", "node_modules", ".DS_Store"]);
export const SCHEMA = 3;   // 1: hub.toml at the root; 2: .malachite/hub.toml, with an id (paperboat#16); 3: the log in .malachite/log/
const MONTH = /^\d{4}-\d{2}\.jsonl$/;
// one collator for the tree's order: `localeCompare` with options builds one per call (seconds on a big hub)
const byName = new Intl.Collator(undefined, { numeric: true }).compare;

/** This machine's name in the files only it writes (its log, its history bundle): its host name, made safe. */
export const machine = () => (process.env.MALACHITE_MACHINE ?? os.hostname()).replace(/[^\w.-]+/g, "-") || "machine";
export const KEEP = ["90d", "1y", "always"] as const;

/** A hub's settings (`.malachite/hub.toml`): set from its Settings pane or `paperboat hub config`, never by hand. */
export type HubConfig = { id: string; name: string; schema: number; author: string; created: string; keep: (typeof KEEP)[number]; ignore: string };
export type HubKey = "name" | "author" | "keep" | "ignore";

/** "n_" and 12 base32 letters: stable across renames; time-ordered enough to read. */
export const newId = (prefix = "n") => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

/** The settings file of a hub folder: where schema 2 keeps it, else where schema 1 did. */
export const configFile = (root: string) => path.join(root, ".malachite", "hub.toml");
const oldConfigFile = (root: string) => path.join(root, "hub.toml");

/** A folder's hub settings without opening it (no file is written), or null when it isn't a hub. */
export function peek(root: string): (Partial<HubConfig> & { schema: number }) | null {
  for (const f of [configFile(root), oldConfigFile(root)]) {
    if (fs.existsSync(f)) { const c = readToml(fs.readFileSync(f, "utf8")); return { ...c, schema: Number(c.schema ?? 1) } as Partial<HubConfig> & { schema: number }; }
  }
  return null;
}

export class Hub {
  readonly root: string;
  conf: HubConfig;
  onEvent: (e: Event) => void = () => {};

  constructor(root: string) {
    this.root = fs.realpathSync(root);
    const file = configFile(this.root), old = oldConfigFile(this.root);
    const fresh = !fs.existsSync(file) && !fs.existsSync(old);
    let upgraded = false;
    if (!fs.existsSync(file) && fs.existsSync(old)) {   // schema 1 → 2: the settings move out of sight
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.renameSync(old, file);
      upgraded = true;
    }
    const c = fs.existsSync(file) ? readToml(fs.readFileSync(file, "utf8")) : {};
    if (!fresh && Number(c.schema ?? 1) < 3 && this.moveOldLog()) upgraded = true;
    if (c.schema && Number(c.schema) > SCHEMA) throw new HubError(`this hub has schema ${c.schema}; this Malachite reads ${SCHEMA}. Update Malachite.`);
    this.conf = {
      id: c.id || newId("h"), name: c.name || path.basename(this.root), schema: SCHEMA, author: c.author || os.userInfo().username,
      created: c.created || new Date().toISOString(), keep: (KEEP as readonly string[]).includes(c.keep) ? (c.keep as HubConfig["keep"]) : "always",
      ignore: c.ignore ?? ".malachite/out/ *.tmp",
    };
    if (fresh || upgraded || !c.id || Number(c.schema) !== SCHEMA) this.save();
    if (fresh) this.log("hub.created");
    else if (upgraded) this.log("hub.upgraded", undefined, { schema: SCHEMA });
  }

  /** Schema 2 and before kept the log at the root (`log/YYYY-MM.jsonl`), in every file tree: into this machine's. */
  private moveOldLog(): boolean {
    const old = path.join(this.root, "log");
    if (!fs.existsSync(old) || !fs.statSync(old).isDirectory()) return false;
    const months = fs.readdirSync(old).filter((f) => MONTH.test(f));
    if (!months.length) return false;
    const to = path.join(this.root, ".malachite", "log", machine());
    fs.mkdirSync(to, { recursive: true });
    for (const f of months) {
      if (fs.existsSync(path.join(to, f))) fs.appendFileSync(path.join(to, f), fs.readFileSync(path.join(old, f))), fs.rmSync(path.join(old, f));
      else fs.renameSync(path.join(old, f), path.join(to, f));
    }
    if (!fs.readdirSync(old).length) fs.rmdirSync(old);   // the user's own files there stay
    return true;
  }

  get id() { return this.conf.id; }
  get name() { return this.conf.name; }
  get author() { return this.conf.author; }

  /** One setting changed (the Settings pane, `paperboat hub config`). */
  set(key: HubKey, value: string) {
    const v = value.trim();
    if (key === "keep" && !(KEEP as readonly string[]).includes(v)) throw new HubError(`keep is one of ${KEEP.join(", ")}`);
    if ((key === "name" || key === "author") && (!v || /[\n"]/.test(v))) throw new HubError(`${key} can't be empty or hold quotes`);
    if (!["name", "author", "keep", "ignore"].includes(key)) throw new HubError(`${key} is not a hub setting (name, author, keep, ignore)`);
    const from = this.conf[key];
    if (from === v) return;
    (this.conf as Record<HubKey, string>)[key] = v;
    this.save();
    this.log("hub.config", undefined, { key, from, to: v });
  }

  private save() {
    const c = this.conf, file = configFile(this.root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = ["# A Malachite hub (github.com/paperboatlab/malachite). Set from its Settings or `paperboat hub config`."]
      .concat((Object.keys(c) as (keyof HubConfig)[]).map((k) => `${k} = ${typeof c[k] === "number" ? c[k] : JSON.stringify(c[k])}`));
    this.put(file, lines.join("\n") + "\n");
  }

  /** An absolute path for a hub-relative one, or an error if it leaves the hub. */
  resolve(rel: string): string {
    if (typeof rel !== "string" || rel.includes("\0")) throw new HubError("bad path");
    const abs = path.resolve(this.root, rel.replace(/^\/+/, ""));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new HubError("outside the hub");
    // a symlink may point out: check where it really lands (the last part may not exist yet)
    let real = abs;
    try { real = fs.realpathSync.native(abs); } catch { try { real = path.join(fs.realpathSync.native(path.dirname(abs)), path.basename(abs)); } catch { /* a new folder chain */ } }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new HubError("outside the hub");
    return abs;
  }
  rel = (abs: string) => path.relative(this.root, abs).split(path.sep).join("/");

  tree(dir = this.root, rel = this.rel(dir)): Entry[] {
    const out: Entry[] = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (HIDDEN.has(d.name) || d.name.startsWith(".") || d.name.endsWith(".tmp")) continue;   // a write in progress
      const abs = path.join(dir, d.name), p = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) out.push({ path: p, name: d.name, kind: "dir", children: this.tree(abs, p) });
      else if (d.isFile()) { const st = fs.statSync(abs); out.push({ path: p, name: d.name, kind: "file", size: st.size, mtime: st.mtimeMs }); }
    }
    return out.sort((a, b) => (a.kind === b.kind ? byName(a.name, b.name) : a.kind === "dir" ? -1 : 1));
  }

  /** Calls `on` with the hub-relative path of what changes (a file or a folder; whoever changed it), but what
   *  the tree hides (dot folders, node_modules, a write in progress). On Linux one watch per folder: Node's own
   *  recursive watch there also watches every file, stats it on each change, and loses a file once a rename
   *  replaces it (every save here is one), so a note saved once never showed a change from outside again. */
  watch(on: (rel: string) => void): { close: () => void } {
    const hidden = (rel: string) => rel.split("/").some((p) => p.startsWith(".") || HIDDEN.has(p)) || rel.endsWith(".tmp");
    const tell = (rel: string) => { if (!hidden(rel)) on(rel); };
    if (process.platform !== "linux") {
      const w = fs.watch(this.root, { recursive: true }, (_e, f) => f && tell(f.toString().split(path.sep).join("/")));
      return { close: () => w.close() };
    }
    const dirs = new Map<string, fs.FSWatcher>();
    const drop = (rel: string) => { for (const [k, w] of dirs) if (k === rel || k.startsWith(`${rel}/`)) { w.close(); dirs.delete(k); } };
    const add = (rel: string) => {
      if (dirs.has(rel) || (rel && hidden(rel))) return;
      const abs = path.join(this.root, rel);
      let w: fs.FSWatcher, ds: fs.Dirent[];
      try {
        w = fs.watch(abs, (ev, f) => {
          if (!f) return;
          const r = rel ? `${rel}/${f}` : f.toString();
          tell(r);
          if (ev !== "rename") return;   // a folder that came (watched, with its folders) or went
          try { if (fs.statSync(path.join(this.root, r)).isDirectory()) add(r); } catch { drop(r); }
        });
        ds = fs.readdirSync(abs, { withFileTypes: true });
      } catch { return; }   // gone already
      w.on("error", () => drop(rel));
      dirs.set(rel, w);
      for (const d of ds) if (d.isDirectory()) add(rel ? `${rel}/${d.name}` : d.name);
    };
    add("");
    return { close: () => { for (const w of dirs.values()) w.close(); dirs.clear(); } };
  }

  /** Every file, relative (the index walks this): the hub's, or one folder's. */
  files(under = ""): Entry[] {
    const out: Entry[] = [];
    const walk = (es: Entry[]) => { for (const e of es) e.kind === "dir" ? walk(e.children!) : out.push(e); };
    walk(this.tree(under ? this.resolve(under) : this.root));
    return out;
  }

  read(rel: string): string {
    const abs = this.resolve(rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new HubError(`${rel} not found`, 404);
    return fs.readFileSync(abs, "utf8");
  }

  /** Writes a note; a sealed one refuses (corrections are annotations or a new note). */
  write(rel: string, text: string) {
    const abs = this.resolve(rel);
    if (fs.existsSync(abs) && split(fs.readFileSync(abs, "utf8")).props.sealed) throw new HubError(`${rel} is sealed`, 409);
    if (split(text).props.sealed) throw new HubError("a note is sealed with Seal, not by writing", 409);
    this.put(abs, text);
    this.log("note.updated", rel);
  }

  /** One front matter property set (a board card moved to a column), or removed with "". */
  setProp(rel: string, key: string, value: string) {
    if (!/^[A-Za-z_][\w-]*$/.test(key) || ["id", "sealed", "sealed_by", "hash"].includes(key)) throw new HubError(`${key} is not a property to set`, 400);
    const abs = this.resolve(rel), { props, body } = split(fs.readFileSync(abs, "utf8"));
    if (props.sealed) throw new HubError(`${rel} is sealed`, 409);
    const from = props[key] ?? "";
    if (String(from) === value) return;   // a card dropped where it was
    if (value) props[key] = value; else delete props[key];
    this.put(abs, join(props, body));
    this.log("note.property", rel, { key, from, to: value });
  }

  private put(abs: string, text: string) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, abs);
  }

  /** A new note with its id, time and author set by the app; a free name if this one is taken. */
  create(dir: string, title: string, kind = "note"): string {
    const base = title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "untitled";
    let rel = path.posix.join(dir, `${base}.md`);
    for (let n = 2; fs.existsSync(this.resolve(rel)); n++) rel = path.posix.join(dir, `${base}-${n}.md`);
    const props = { id: newId(), created: new Date().toISOString().replace(/\.\d+Z$/, "Z"), author: this.author, kind, status: "open" };
    const abs = this.resolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, join(props, `\n# ${title.trim() || "Untitled"}\n\n`), { flag: "wx" });
    this.log("note.created", rel, { id: props.id });
    return rel;
  }

  mkdir(rel: string) {
    fs.mkdirSync(this.resolve(rel), { recursive: true });
    this.log("folder.created", rel);
  }

  rename(from: string, to: string) {
    const a = this.resolve(from), b = this.resolve(to);
    if (a === this.root) throw new HubError("the hub itself can't move");
    if (fs.existsSync(b)) throw new HubError(`${to} exists`, 409);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    this.log("file.moved", to, { from });
  }

  /** Move to trash: into `.malachite/trash/<time>/`, so it can come back. */
  /** To the hub's trash: `.malachite/trash/<id>/<path>`, with `trashed.json` saying what, from where, who and
   *  when, so it can come back. */
  trash(rel: string) {
    const abs = this.resolve(rel);
    if (abs === this.root) throw new HubError("the hub itself can't go to the trash");
    const kind = fs.statSync(abs).isDirectory() ? "folder" : "file";
    let id = new Date().toISOString().replace(/[:.]/g, "-");
    while (fs.existsSync(this.trashDir(id))) id += "x";
    const dest = path.join(this.trashDir(id), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(abs, dest);
    fs.writeFileSync(path.join(this.trashDir(id), "trashed.json"), JSON.stringify({ path: rel, kind, time: new Date().toISOString(), actor: this.author }) + "\n");
    this.log("file.trashed", rel, { trash: id });
  }

  private trashDir = (id: string) => {
    if (!/^[\w-]+$/.test(id)) throw new HubError(`no ${id} in the trash`, 404);
    return path.join(this.root, ".malachite", "trash", id);
  };

  /** What is in the trash, newest first. An entry from before trashed.json is read from its folders. */
  trashed(): Trashed[] {
    const dir = path.join(this.root, ".malachite", "trash");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((id) => /^[\w-]+$/.test(id)).map((id): Trashed => {
      const at = path.join(dir, id);
      try { const m = JSON.parse(fs.readFileSync(path.join(at, "trashed.json"), "utf8")); return { id, path: m.path, kind: m.kind, time: m.time, actor: m.actor }; } catch { /* an older entry */ }
      let rel = "";
      for (let names = fs.readdirSync(at); names.length === 1 && fs.statSync(path.join(at, rel, names[0])).isDirectory(); ) { rel = rel ? `${rel}/${names[0]}` : names[0]; names = fs.readdirSync(path.join(at, rel)); }
      const names = fs.readdirSync(path.join(at, rel));
      const one = names.length === 1 ? (rel ? `${rel}/${names[0]}` : names[0]) : rel;
      return { id, path: one, kind: fs.statSync(path.join(at, one)).isDirectory() ? "folder" : "file", time: fs.statSync(at).mtime.toISOString(), actor: "" };
    }).sort((a, b) => b.time.localeCompare(a.time));
  }

  /** Back where it was; if something new has that name, beside it as "<name> (restored)". Returns its path. */
  restore(id: string): string {
    const t = this.trashed().find((x) => x.id === id);
    if (!t) throw new HubError(`no ${id} in the trash`, 404);
    let to = t.path;
    const ext = path.extname(to), stem = to.slice(0, to.length - ext.length);
    for (let n = 1; fs.existsSync(this.resolve(to)); n++) to = `${stem} (restored${n > 1 ? ` ${n}` : ""})${ext}`;
    fs.mkdirSync(path.dirname(this.resolve(to)), { recursive: true });
    fs.renameSync(path.join(this.trashDir(id), t.path), this.resolve(to));
    fs.rmSync(this.trashDir(id), { recursive: true, force: true });
    this.log("file.restored", to, to === t.path ? {} : { was: t.path });
    return to;
  }

  /** Gone for good: one entry, or (no id) the whole trash. */
  purge(id?: string) {
    const all = this.trashed(), gone = id ? all.filter((x) => x.id === id) : all;
    if (id && !gone.length) throw new HubError(`no ${id} in the trash`, 404);
    for (const t of gone) fs.rmSync(this.trashDir(t.id), { recursive: true, force: true });
    if (id) this.log("file.deleted", gone[0].path, { trash: id });
    else this.log("trash.emptied", undefined, { count: gone.length });
  }

  /** Seal: freeze the body, record who, when and its hash. Afterwards the note only takes annotations. */
  seal(rel: string) {
    const abs = this.resolve(rel);
    const { props, body } = split(this.read(rel));
    if (props.sealed) throw new HubError(`${rel} is already sealed`, 409);
    const hash = bodyHash(body);
    fs.writeFileSync(abs, join({ ...props, status: "sealed", sealed: new Date().toISOString().replace(/\.\d+Z$/, "Z"), sealed_by: this.author, hash: `sha256:${hash}` }, body));
    this.log("note.sealed", rel, { hash: `sha256:${hash}` });
  }

  /** The append-only activity log: a file per machine and month, so two machines never write the same file
   *  (a sync client would keep one and make a conflict copy of the other). */
  log(action: string, target?: string, details?: Record<string, unknown>) {
    const e: Event = { time: new Date().toISOString(), actor: this.author, action, ...(target ? { target } : {}), ...(details ? { details } : {}) };
    const dir = path.join(this.root, ".malachite", "log", machine());
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${e.time.slice(0, 7)}.jsonl`), JSON.stringify(e) + "\n");
    this.onEvent(e);
  }

  /** The newest events first, optionally for one file. A damaged line is shown, not repaired. */
  events(limit = 200, target?: string): (Event | { damaged: string })[] {
    const dir = path.join(this.root, ".malachite", "log");
    if (!fs.existsSync(dir)) return [];
    const machines = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const months = [...new Set(machines.flatMap((m) => fs.readdirSync(path.join(dir, m)).filter((f) => MONTH.test(f))))].sort().reverse();
    const out: (Event | { damaged: string })[] = [];
    for (const f of months) {   // a month at a time: every machine's lines, newest first
      const all: { t: string; e: Event | { damaged: string } }[] = [];
      for (const m of machines.filter((m) => fs.existsSync(path.join(dir, m, f)))) {
        let t = "";   // a damaged line sits where it was: at the time of the line before it
        for (const l of fs.readFileSync(path.join(dir, m, f), "utf8").split("\n").filter(Boolean)) {
          let e: Event | { damaged: string };
          try { e = JSON.parse(l); t = (e as Event).time ?? t; } catch { e = { damaged: `${m}/${f}: ${l.slice(0, 80)}` }; }
          all.push({ t, e });
        }
      }
      for (const { e } of all.reverse().sort((a, b) => b.t.localeCompare(a.t))) {
        if (target && ("damaged" in e || e.target !== target)) continue;
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

// ponytail: hub.toml holds flat `key = value` lines; a full TOML parser when it grows tables.
function readToml(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([\w-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2].replace(/\s+#.*$/, "");
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { /* keep as written */ } }
    out[m[1]] = v;
  }
  return out;
}
