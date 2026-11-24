// The vault: the folder Malachite opens (pb#415). The files are the record; `.malachite/` is a cache
// (the outputs of cells, the trash) and `log/` the activity log. Every path from the page goes through
// `resolve`, which keeps it inside the vault.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { bodyHash, join, split } from "./note.ts";

export type Entry = { path: string; name: string; kind: "dir" | "file"; size?: number; mtime?: number; children?: Entry[] };
export type Event = { time: string; actor: string; action: string; target?: string; details?: Record<string, unknown> };
export class VaultError extends Error { readonly status: number; constructor(message: string, status = 400) { super(message); this.status = status; } }

const HIDDEN = new Set([".malachite", ".git", "node_modules", ".DS_Store"]);
const SCHEMA = 1;

/** "n_" and 12 base32 letters: stable across renames; time-ordered enough to read. */
export const newId = (prefix = "n") => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

export class Vault {
  readonly root: string;
  name: string;
  author: string;
  onEvent: (e: Event) => void = () => {};

  constructor(root: string) {
    this.root = fs.realpathSync(root);
    const file = path.join(this.root, "vault.toml");
    const conf = fs.existsSync(file) ? readToml(fs.readFileSync(file, "utf8")) : {};
    if (conf.schema && Number(conf.schema) > SCHEMA) throw new VaultError(`vault.toml has schema ${conf.schema}; this Malachite reads ${SCHEMA}. Update Malachite.`);
    this.name = conf.name ?? path.basename(this.root);
    this.author = conf.author ?? os.userInfo().username;
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, `# A Malachite vault (github.com/paperboatlab/malachite)\nname = ${JSON.stringify(this.name)}\nschema = ${SCHEMA}\nauthor = ${JSON.stringify(this.author)}\ncreated = ${JSON.stringify(new Date().toISOString())}\n`);
      this.log("vault.created");
    }
  }

  /** An absolute path for a vault-relative one, or an error if it leaves the vault. */
  resolve(rel: string): string {
    if (typeof rel !== "string" || rel.includes("\0")) throw new VaultError("bad path");
    const abs = path.resolve(this.root, rel.replace(/^\/+/, ""));
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new VaultError("outside the vault");
    // a symlink may point out: check where it really lands (the last part may not exist yet)
    let real = abs;
    try { real = fs.realpathSync(abs); } catch { try { real = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)); } catch { /* a new folder chain */ } }
    if (real !== this.root && !real.startsWith(this.root + path.sep)) throw new VaultError("outside the vault");
    return abs;
  }
  rel = (abs: string) => path.relative(this.root, abs).split(path.sep).join("/");

  tree(dir = this.root): Entry[] {
    const out: Entry[] = [];
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (HIDDEN.has(d.name) || d.name.startsWith(".")) continue;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) out.push({ path: this.rel(abs), name: d.name, kind: "dir", children: this.tree(abs) });
      else if (d.isFile()) { const st = fs.statSync(abs); out.push({ path: this.rel(abs), name: d.name, kind: "file", size: st.size, mtime: st.mtimeMs }); }
    }
    return out.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === "dir" ? -1 : 1));
  }

  /** Every file, relative (the index walks this). */
  files(): string[] {
    const out: string[] = [];
    const walk = (es: Entry[]) => { for (const e of es) e.kind === "dir" ? walk(e.children!) : out.push(e.path); };
    walk(this.tree());
    return out;
  }

  read(rel: string): string {
    const abs = this.resolve(rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new VaultError(`${rel} not found`, 404);
    return fs.readFileSync(abs, "utf8");
  }

  /** Writes a note; a sealed one refuses (corrections are annotations or a new note). */
  write(rel: string, text: string) {
    const abs = this.resolve(rel);
    if (fs.existsSync(abs) && split(fs.readFileSync(abs, "utf8")).props.sealed) throw new VaultError(`${rel} is sealed`, 409);
    if (split(text).props.sealed) throw new VaultError("a note is sealed with Seal, not by writing", 409);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, abs);
    this.log("note.updated", rel);
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
    if (a === this.root) throw new VaultError("the vault itself can't move");
    if (fs.existsSync(b)) throw new VaultError(`${to} exists`, 409);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.renameSync(a, b);
    this.log("file.moved", to, { from });
  }

  /** Move to trash: into `.malachite/trash/<time>/`, so it can come back. */
  trash(rel: string) {
    const abs = this.resolve(rel);
    if (abs === this.root) throw new VaultError("the vault itself can't go to the trash");
    const dest = path.join(this.root, ".malachite", "trash", new Date().toISOString().replace(/[:.]/g, "-"), rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(abs, dest);
    this.log("file.trashed", rel, { to: this.rel(dest) });
  }

  /** Seal: freeze the body, record who, when and its hash. Afterwards the note only takes annotations. */
  seal(rel: string) {
    const abs = this.resolve(rel);
    const { props, body } = split(this.read(rel));
    if (props.sealed) throw new VaultError(`${rel} is already sealed`, 409);
    const hash = bodyHash(body);
    fs.writeFileSync(abs, join({ ...props, status: "sealed", sealed: new Date().toISOString().replace(/\.\d+Z$/, "Z"), sealed_by: this.author, hash: `sha256:${hash}` }, body));
    this.log("note.sealed", rel, { hash: `sha256:${hash}` });
  }

  /** The append-only activity log: one writer (this), one line per event, a file per month. */
  log(action: string, target?: string, details?: Record<string, unknown>) {
    const e: Event = { time: new Date().toISOString(), actor: this.author, action, ...(target ? { target } : {}), ...(details ? { details } : {}) };
    const dir = path.join(this.root, "log");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${e.time.slice(0, 7)}.jsonl`), JSON.stringify(e) + "\n");
    this.onEvent(e);
  }

  /** The newest events first, optionally for one file. A damaged line is shown, not repaired. */
  events(limit = 200, target?: string): (Event | { damaged: string })[] {
    const dir = path.join(this.root, "log");
    if (!fs.existsSync(dir)) return [];
    const out: (Event | { damaged: string })[] = [];
    for (const f of fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse()) {
      const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).reverse();
      for (const l of lines) {
        let e: Event | { damaged: string };
        try { e = JSON.parse(l); } catch { e = { damaged: `${f}: ${l.slice(0, 80)}` }; }
        if (target && ("damaged" in e || e.target !== target)) continue;
        out.push(e);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }
}

// ponytail: vault.toml holds flat `key = value` lines; a full TOML parser when it grows tables.
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
