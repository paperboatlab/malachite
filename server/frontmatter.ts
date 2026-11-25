// A note's front matter in a YAML subset (pb#415 decision 3): read and written here, by the server and by
// the page (its properties table edits the text the editor holds), so both agree on every byte.
export type Props = Record<string, string | string[]>;

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

const entry = (k: string, v: string | string[]) => `${k}: ${Array.isArray(v) ? `[${v.map(quote).join(", ")}]` : quote(v)}`;

/** `text` with its front matter set to `props`, as an edit would make it: a line stays as written while its
 *  value is the same, a changed one is rewritten, a removed one goes, a new one is added at the end. */
export function patch(text: string, props: Props): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const { props: old, body } = split(text);
  if (!m) return join(props, body);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: string[] = [], seen = new Set<string>();
  for (const l of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):/.exec(l);
    if (!kv) { out.push(l); continue; }   // a comment stays
    seen.add(kv[1]);
    if (kv[1] in props) out.push(same(old[kv[1]], props[kv[1]]) ? l : entry(kv[1], props[kv[1]]));
  }
  for (const k of Object.keys(props)) if (!seen.has(k)) out.push(entry(k, props[k]));
  return out.some((l) => l.trim()) ? `---\n${out.join("\n")}\n---\n${body}` : body;
}

export function join(props: Props, body: string): string {
  const keys = Object.keys(props);
  if (!keys.length) return body;
  const lines = keys.map((k) => entry(k, props[k]));
  return `---\n${lines.join("\n")}\n---\n${body}`;
}
