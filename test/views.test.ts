import assert from "node:assert/strict";
import { test } from "node:test";
import type { Item } from "../client/api.ts";
import { DEFAULT, columnsOf, dayOf, itemsOf, readView, viewPath, viewToml } from "../client/views.ts";

const item = (name: string, props: Record<string, string | string[]>, tags: string[] = []): Item =>
  ({ path: `notes/${name}.md`, name: `${name}.md`, type: "md", title: name, props, tags, links: [], cells: 0, mtime: 0 });

test("a view file is written flat and read back", () => {
  const v = { ...DEFAULT, path: "views/tank.toml", name: "Tank \"level\"", show: "timeline" as const, columns: ["open", "in progress"], until: "due", filter: { project: "tank-level", kind: "" } };
  assert.equal(viewToml(v), 'name = "Tank \\"level\\""\nshow = "timeline"\ngroup = "status"\ncolumns = "open, in progress"\ndate = "created"\nuntil = "due"\n\n[filter]\nproject = "tank-level"\n');
  // what the kit's parseToml makes of that text
  const parsed = { name: 'Tank "level"', show: "timeline", group: "status", columns: "open, in progress", date: "created", until: "due", filter: { project: "tank-level" } };
  assert.deepEqual(readView("views/tank.toml", parsed), { ...v, filter: { project: "tank-level" } });
  assert.equal(readView("views/x.toml", {}).name, "x");
});

test("filters match a property's value, a list's member, or a tag", () => {
  const items = [item("a", { kind: "issue", status: "open" }, ["pump"]), item("b", { kind: "experiment", status: "done", project: ["tank", "pump"] }), { ...item("c", {}), type: "csv" }];
  assert.deepEqual(itemsOf(items, DEFAULT).map((i) => i.title), ["a", "b"]);
  assert.deepEqual(itemsOf(items, { ...DEFAULT, filter: { kind: "Issue" } }).map((i) => i.title), ["a"]);
  assert.deepEqual(itemsOf(items, { ...DEFAULT, filter: { project: "pump" } }).map((i) => i.title), ["b"]);
  assert.deepEqual(itemsOf(items, { ...DEFAULT, filter: { tags: "pump" } }).map((i) => i.title), ["a"]);
});

test("columns: the view's order, then the status flow, then the rest, none last", () => {
  const items = [item("a", { status: "done" }), item("b", { status: "open" }), item("c", { status: "waiting" }), item("d", {}), item("e", { status: "blocked" })];
  assert.deepEqual(columnsOf(items, DEFAULT), ["open", "blocked", "done", "waiting", "none"]);
  assert.deepEqual(columnsOf(items, { ...DEFAULT, columns: ["waiting", "review"] }), ["waiting", "review", "open", "blocked", "done", "none"]);
});

test("dates read as days; a view path is free", () => {
  assert.equal(dayOf(item("a", { created: "2026-11-17T14:03:00Z" }), "created"), Date.UTC(2026, 10, 17));
  assert.equal(dayOf(item("a", { created: "soon" }), "created"), null);
  assert.equal(viewPath("Tank level!", (p) => p === "views/tank-level.toml"), "views/tank-level-2.toml");
});
