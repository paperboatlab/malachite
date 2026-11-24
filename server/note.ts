// A note: Markdown with a front matter in a YAML subset (pb#415 decision 3: what GitHub and Obsidian
// show): `---`, `key: value`, `[a, b]` lists, "quoted" strings. Cells are fenced blocks in a runtime's
// language (decision 16); a cell is known by the hash of its language and code, so changing the code
// leaves no stale output behind.
import { createHash } from "node:crypto";

export type Props = Record<string, string | string[]>;
export type Lang = "julia" | "python";
export type Cell = { lang: Lang; code: string; hash: string; line: number };
export type Note = { props: Props; body: string; title: string; tags: string[]; links: string[]; cells: Cell[] };

const LANGS: Record<string, Lang> = { julia: "julia", jl: "julia", python: "python", py: "python" };

// ponytail: a YAML subset (scalars, flow lists, quotes); nested maps and block lists are kept as text.
function parseValue(v: string): string | string[] {
  v = v.trim();
  if (v.startsWith("[") && v.endsWith("]")) return v.slice(1, -1).split(",").map((x) => unquote(x.trim())).filter((x) => x !== "");
  return unquote(v);
}
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replaceAll("''", "'");
  return v;
}
const plain = (s: string) => /^[^\s"'[\]{},#:&*!|>%@`-][^"[\]{},#:]*$/.test(s) && s === s.trim() && !/:\s/.test(s);
const quote = (s: string) => (plain(s) ? s : JSON.stringify(s));

/** The front matter and the body after it. A note without one has empty props. */
export function split(text: string): { props: Props; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { props: {}, body: text };
  const props: Props = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) props[kv[1]] = parseValue(kv[2]);
  }
  return { props, body: text.slice(m[0].length) };
}

export function join(props: Props, body: string): string {
  const keys = Object.keys(props);
  if (!keys.length) return body;
  const lines = keys.map((k) => { const v = props[k]; return `${k}: ${Array.isArray(v) ? `[${v.map(quote).join(", ")}]` : quote(v)}`; });
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

export const cellHash = (lang: Lang, code: string) => createHash("sha256").update(`${lang}\n${code}`).digest("hex").slice(0, 16);
export const bodyHash = (body: string) => createHash("sha256").update(body).digest("hex");

/** Everything the index needs from a note. `name` is its file name without .md, the last resort for a title. */
export function parse(text: string, name = ""): Note {
  const { props, body } = split(text);
  const cells: Cell[] = [], links: string[] = [], tags = new Set<string>();
  const ptags = props.tags;
  for (const t of Array.isArray(ptags) ? ptags : ptags ? [ptags] : []) tags.add(t.replace(/^#/, ""));
  let title = typeof props.title === "string" ? props.title : "";
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const fence = /^(`{3,}|~{3,})\s*([\w+-]*)/.exec(lines[i]);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !(/^(`{3,}|~{3,})\s*$/.test(lines[j]) && lines[j][0] === fence[1][0])) j++;   // a bare fence closes
      const lang = LANGS[fence[2].toLowerCase()];
      if (lang) { const code = lines.slice(i + 1, j).join("\n"); cells.push({ lang, code, hash: cellHash(lang, code), line: i }); }
      i = j;
      continue;
    }
    const line = lines[i].replace(/`[^`]*`/g, "");
    if (!title) { const h = /^#\s+(.+)$/.exec(line); if (h) title = h[1].trim(); }
    for (const l of line.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) links.push(l[1].trim());
    for (const t of line.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]*[\p{L}_/-][\p{L}\p{N}_/-]*)/gu)) tags.add(t[1]);
  }
  return { props, body, title: title || name, tags: [...tags], links: [...new Set(links)], cells };
}
