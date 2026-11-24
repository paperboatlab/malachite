// The index (pb#415 decision 18): built from the files at start and kept live; never the record.
// Notes give title, tags, links, properties and cells. Other apps' files give their name and type only,
// until those apps publish an index manifest: Malachite never parses a format it does not own.
import fs from "node:fs";
import path from "node:path";
import { parse, type Props } from "./note.ts";
import type { Vault } from "./vault.ts";

export type Item = {
  path: string;
  name: string;      // the file name without .md
  type: string;      // the extension: md, pst, mo, jl, mx, csv, …
  title: string;
  props: Props;
  tags: string[];
  links: string[];   // as written: [[name]]
  cells: number;
  mtime: number;
};
export type Resolved = { link: string; path: string | null };

export class Index {
  items = new Map<string, Item>();
  private vault: Vault;
  constructor(vault: Vault) { this.vault = vault; }

  build() {
    this.items.clear();
    for (const f of this.vault.files()) this.update(f);
  }

  /** Re-read one file; gone, it leaves the index. */
  update(rel: string) {
    const abs = this.vault.resolve(rel);
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { this.items.delete(rel); return; }
    if (!st.isFile()) { this.items.delete(rel); return; }
    const type = path.extname(rel).slice(1).toLowerCase();
    const name = path.basename(rel).replace(/\.md$/i, "");
    if (type !== "md") { this.items.set(rel, { path: rel, name, type, title: path.basename(rel), props: {}, tags: [], links: [], cells: 0, mtime: st.mtimeMs }); return; }
    const n = parse(fs.readFileSync(abs, "utf8"), name);
    this.items.set(rel, { path: rel, name, type, title: n.title, props: n.props, tags: n.tags, links: n.links, cells: n.cells.length, mtime: st.mtimeMs });
  }

  /** `[[x]]` to a file: a vault path, a note's name (case-insensitive), or any file's name with its extension. */
  resolve(link: string, from = ""): string | null {
    const l = link.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (this.items.has(l)) return l;
    if (this.items.has(`${l}.md`)) return `${l}.md`;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), l));
    if (this.items.has(rel)) return rel;
    if (this.items.has(`${rel}.md`)) return `${rel}.md`;
    const low = l.toLowerCase();
    let best: string | null = null;
    for (const it of this.items.values()) {
      const base = path.posix.basename(it.path).toLowerCase();
      if (it.name.toLowerCase() === low || base === low || it.path.toLowerCase().endsWith(`/${low}`) || it.path.toLowerCase().endsWith(`/${low}.md`)) {
        // the nearest one to the linking note wins (as Obsidian does)
        if (!best || shared(it.path, from) > shared(best, from)) best = it.path;
      }
    }
    return best;
  }

  links(rel: string): Resolved[] {
    return (this.items.get(rel)?.links ?? []).map((link) => ({ link, path: this.resolve(link, rel) }));
  }

  backlinks(rel: string): string[] {
    const out: string[] = [];
    for (const it of this.items.values()) if (it.path !== rel && it.links.some((l) => this.resolve(l, it.path) === rel)) out.push(it.path);
    return out.sort();
  }

  /** A line of the note that names the target: the context a backlink shows. */
  context(from: string, to: string): string {
    const it = this.items.get(from);
    if (!it || it.type !== "md") return "";
    const text = fs.readFileSync(this.vault.resolve(from), "utf8");
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
        if (this.resolve(m[1].trim(), from) === to) return line.trim().slice(0, 240);
      }
    }
    return "";
  }

  list(): Item[] { return [...this.items.values()].sort((a, b) => a.path.localeCompare(b.path)); }
}

const shared = (a: string, b: string) => { const x = a.split("/"), y = b.split("/"); let n = 0; while (n < x.length && x[n] === y[n]) n++; return n; };
