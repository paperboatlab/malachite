// The index (pb#415 decision 18): built from the files at start and kept live; never the record.
// Notes give title, tags, links, properties and cells. Other apps' files give their name and type only,
// until those apps publish an index manifest: Malachite never parses a format it does not own.
import fs from "node:fs";
import path from "node:path";
import { parse, type Props } from "./note.ts";
import type { Hub } from "./hub.ts";

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
  size: number;      // bytes
};
export type Resolved = { link: string; path: string | null };

export class Index {
  private all = new Map<string, Item>();
  /** The paths by a lower-cased name and file name: what `[[x]]` finds without walking every item. */
  private named = new Map<string, Set<string>>();
  private came = false;   // a file came or went since the last `apply`: the page's tree is out of date
  private hub: Hub;
  constructor(hub: Hub) { this.hub = hub; }

  get items(): ReadonlyMap<string, Item> { return this.all; }

  /** `found`: how many files the walk found, before they are read (the page says "Indexing 4 812 files"). */
  build(found?: (n: number) => void) {
    this.all.clear();
    this.named.clear();
    const files = this.hub.files();
    found?.(files.length);
    for (const f of files) this.update(f.path, path.join(this.hub.root, f.path));   // the walk stays in the hub
    this.came = false;
  }

  /** What the watcher saw change (hub-relative files and folders), and only that: a named file is read again,
   *  a folder that is there is walked (its files new or changed since are read: a folder moved or checked out),
   *  a path that is gone takes everything under it out. Never the whole hub: on a synced folder every stat is
   *  the network. `tree`: a file came or went since the last call (here, or by the API before its event). */
  apply(changed: string[]): { items: Item[]; gone: string[]; tree: boolean } {
    const items = new Map<string, Item>(), gone = new Set<string>();
    const read = (rel: string) => { const had = this.all.has(rel), it = this.update(rel); if (it) { items.set(rel, it); gone.delete(rel); } else if (had) gone.add(rel); };
    for (const rel of changed) {
      let st: fs.Stats | null = null;
      try { st = fs.statSync(this.hub.resolve(rel)); } catch { /* gone, or outside the hub */ }
      if (st?.isDirectory()) {
        const files = this.hub.files(rel), here = new Set(files.map((f) => f.path));
        for (const p of this.under(rel)) if (!here.has(p)) read(p);
        for (const f of files) { const it = this.all.get(f.path); if (!it || it.mtime !== f.mtime || it.size !== f.size) read(f.path); }
      } else {
        if (!st) for (const p of this.under(rel)) read(p);   // a folder gone or moved away
        try { read(rel); } catch { /* outside the hub */ }
      }
    }
    const tree = this.came;
    this.came = false;
    return { items: [...items.values()], gone: [...gone], tree };
  }

  private under(dir: string): string[] { const pre = `${dir}/`; return [...this.all.keys()].filter((p) => p.startsWith(pre)); }

  /** Re-read one file; gone, it leaves the index. Returns its item, or null when it isn't (or is no longer) a file. */
  update(rel: string, abs = this.hub.resolve(rel)): Item | null {
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { this.delete(rel); return null; }
    if (!st.isFile()) { this.delete(rel); return null; }
    const type = path.extname(rel).slice(1).toLowerCase();
    const name = path.basename(rel).replace(/\.md$/i, "");
    const base = { path: rel, name, type, mtime: st.mtimeMs, size: st.size };
    let it: Item;
    if (type !== "md") it = { ...base, title: path.basename(rel), props: {}, tags: [], links: [], cells: 0 };
    else { const n = parse(fs.readFileSync(abs, "utf8"), name); it = { ...base, title: n.title, props: n.props, tags: n.tags, links: n.links, cells: n.cells.length }; }
    if (!this.all.has(rel)) {
      this.came = true;
      for (const k of keys(it)) { let s = this.named.get(k); if (!s) this.named.set(k, (s = new Set())); s.add(rel); }
    }
    this.all.set(rel, it);
    return it;
  }

  /** One file out of the index; returns whether it was in. */
  delete(rel: string): boolean {
    const it = this.all.get(rel);
    if (!it) return false;
    this.all.delete(rel);
    this.came = true;
    for (const k of keys(it)) { const s = this.named.get(k); s?.delete(rel); if (s && !s.size) this.named.delete(k); }
    return true;
  }

  /** `[[x]]` to a file: a hub path, a note's name (case-insensitive), or any file's name with its extension. */
  resolve(link: string, from = ""): string | null {
    const l = link.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (this.items.has(l)) return l;
    if (this.items.has(`${l}.md`)) return `${l}.md`;
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(from), l));
    if (this.items.has(rel)) return rel;
    if (this.items.has(`${rel}.md`)) return `${rel}.md`;
    const low = l.toLowerCase();
    let best: string | null = null;
    // every match has the link's last part as its name or file name: only those are looked at
    for (const p of this.named.get(low.slice(low.lastIndexOf("/") + 1)) ?? []) {
      const it = this.all.get(p)!, base = path.posix.basename(it.path).toLowerCase();
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
    const out: string[] = [], to = this.all.get(rel), names = new Set(to ? keys(to) : []);
    // a link can only find `rel` when its last part is rel's name or file name: only those are resolved
    const may = (l: string) => { const low = l.replace(/\\/g, "/").toLowerCase(), last = low.slice(low.lastIndexOf("/") + 1); return names.has(last) || last === "" || last === "." || last === ".."; };
    for (const it of this.all.values()) if (it.path !== rel && it.links.some((l) => may(l) && this.resolve(l, it.path) === rel)) out.push(it.path);
    return out.sort();
  }

  /** A line of the note that names the target: the context a backlink shows. */
  context(from: string, to: string): string {
    const it = this.items.get(from);
    if (!it || it.type !== "md") return "";
    const text = fs.readFileSync(this.hub.resolve(from), "utf8");
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
        if (this.resolve(m[1].trim(), from) === to) return line.trim().slice(0, 240);
      }
    }
    return "";
  }

  list(): Item[] { return [...this.items.values()].sort((a, b) => a.path.localeCompare(b.path)); }
}

const keys = (it: Item) => [it.name.toLowerCase(), path.posix.basename(it.path).toLowerCase()];
const shared = (a: string, b: string) => { const x = a.split("/"), y = b.split("/"); let n = 0; while (n < x.length && x[n] === y[n]) n++; return n; };
