// Views (pb#415 "Views like Jira"): a saved way of looking at the hub's notes by their front matter. A view
// is a file, views/<name>.toml, flat keys and a [filter] table (the kit's TOML subset has no arrays, so a
// list is a comma-separated string). Plain functions, so the page and the tests share them.
import type { Item } from "./api.ts";

export type Show = "board" | "list" | "timeline";
export type View = {
  path: string | null;          // null: not saved yet
  name: string;
  show: Show;
  group: string;                // the board's columns and the timeline's lanes
  columns: string[];            // the order of the group's values; the rest follow
  date: string;                 // the timeline's start
  until: string;                // its end ("" : an item is a milestone)
  filter: Record<string, string>;
};

export const NONE = "none";
export const DEFAULT: View = { path: null, name: "All notes", show: "board", group: "status", columns: [], date: "created", until: "", filter: {} };
// the order a status runs in, when the view gives none
const FLOW = ["open", "planned", "in progress", "review", "blocked", "done", "closed", "sealed"];

type Toml = Record<string, unknown>;
const str = (v: unknown, or: string) => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : or);
const list = (v: unknown) => str(v, "").split(",").map((s) => s.trim()).filter(Boolean);

export function readView(path: string, t: Toml): View {
  const show = str(t.show, "board");
  const filter: Record<string, string> = {};
  if (t.filter && typeof t.filter === "object") for (const [k, v] of Object.entries(t.filter as Toml)) filter[k] = str(v, "");
  return {
    path, name: str(t.name, path.replace(/^.*\//, "").replace(/\.toml$/, "")),
    show: show === "list" || show === "timeline" ? show : "board",
    group: str(t.group, "status"), columns: list(t.columns), date: str(t.date, "created"), until: str(t.until, ""), filter,
  };
}

const q = (s: string) => JSON.stringify(s);
// ponytail: a view file is written whole, so comments typed into one by hand go; patch in place if people do
export function viewToml(v: View): string {
  const lines = [`name = ${q(v.name)}`, `show = ${q(v.show)}`, `group = ${q(v.group)}`];
  if (v.columns.length) lines.push(`columns = ${q(v.columns.join(", "))}`);
  lines.push(`date = ${q(v.date)}`);
  if (v.until) lines.push(`until = ${q(v.until)}`);
  const f = Object.entries(v.filter).filter(([, x]) => x);
  if (f.length) lines.push("", "[filter]", ...f.map(([k, x]) => `${k} = ${q(x)}`));
  return lines.join("\n") + "\n";
}

/** A view file's path for a name: views/<slug>.toml, numbered if taken. */
export function viewPath(name: string, taken: (p: string) => boolean): string {
  const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") || "view";
  let p = `views/${slug}.toml`;
  for (let i = 2; taken(p); i++) p = `views/${slug}-${i}.toml`;
  return p;
}

/** A property's values on an item: tags are the note's tags (front matter and #inline). */
export function valuesOf(it: Item, key: string): string[] {
  if (key === "tags") return it.tags;
  const v = it.props[key];
  return (Array.isArray(v) ? v : v ? [v] : []).map(String);
}
export const first = (it: Item, key: string) => valuesOf(it, key)[0] ?? "";

export const matches = (it: Item, filter: Record<string, string>) =>
  Object.entries(filter).every(([k, want]) => !want || valuesOf(it, k).some((x) => x.toLowerCase() === want.toLowerCase()));

/** The notes a view shows. */
export const itemsOf = (items: Item[], v: View) => items.filter((i) => i.type === "md" && matches(i, v.filter));

/** Every value a property takes in these notes, sorted. */
export function valuesIn(items: Item[], key: string): string[] {
  return [...new Set(items.flatMap((i) => valuesOf(i, key)))].sort((a, b) => a.localeCompare(b));
}

/** The properties these notes have, for Filter and group by. */
export function keysIn(items: Item[]): string[] {
  const ks = new Set(["tags"]);
  for (const i of items) for (const k of Object.keys(i.props)) if (!["id", "hash", "sealed_by", "title"].includes(k)) ks.add(k);
  return [...ks].sort();
}

/** The board's columns: the view's order, then a status's usual flow, then the rest; "none" last. */
export function columnsOf(items: Item[], v: View): string[] {
  const found = new Set(items.map((i) => first(i, v.group) || NONE));
  const known = v.group === "status" ? FLOW : [];
  const ordered = [...v.columns, ...known.filter((c) => found.has(c)), ...[...found].filter((c) => c !== NONE).sort()];
  const out = [...new Set(ordered)];
  return found.has(NONE) ? [...out, NONE] : out;
}

/** A date property as a day (UTC midnight, ms), or null. */
export function dayOf(it: Item, key: string): number | null {
  const s = first(it, key);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}
export const DAY = 86_400_000;
