import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Index } from "../server/index.ts";
import { split } from "../server/note.ts";
import { Docs } from "../server/docs.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "malachite-"));

test("opening a folder makes it docs and logs it", () => {
  const dir = tmp();
  const v = new Docs(dir);
  assert.match(fs.readFileSync(path.join(dir, "docs.toml"), "utf8"), /schema = 1/);
  assert.equal(v.events()[0] && "action" in v.events()[0] ? (v.events()[0] as any).action : "", "docs.created");
});

test("a newer schema is refused with a clear message", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "docs.toml"), "schema = 99\n");
  assert.throws(() => new Docs(dir), /schema 99.*Update Malachite/);
});

test("paths stay inside the docs, symlinks included", () => {
  const dir = tmp(), outside = tmp();
  const v = new Docs(dir);
  fs.symlinkSync(outside, path.join(dir, "escape"));
  for (const p of ["../x", "/../../etc/passwd", "a/../../x", "escape/file", "escape"]) assert.throws(() => v.resolve(p), /outside the docs/, p);
  assert.equal(v.resolve("/notes/a.md"), path.join(fs.realpathSync(dir), "notes/a.md"));
});

test("create, write, move, seal, trash; every one a log line", () => {
  const v = new Docs(tmp());
  const p = v.create("notes", "Step response at 5 cm", "experiment");
  assert.equal(p, "notes/step-response-at-5-cm.md");
  assert.equal(v.create("notes", "Step response at 5 cm"), "notes/step-response-at-5-cm-2.md");
  const { props } = split(v.read(p));
  assert.match(String(props.id), /^n_/);
  assert.equal(props.kind, "experiment");
  v.write(p, v.read(p) + "More.\n");
  v.rename(p, "notes/step.md");
  v.seal("notes/step.md");
  assert.throws(() => v.write("notes/step.md", "changed"), /sealed/);
  assert.throws(() => v.seal("notes/step.md"), /already sealed/);
  assert.match(String(split(v.read("notes/step.md")).props.hash), /^sha256:[0-9a-f]{64}$/);
  v.trash("notes/step.md");
  assert.ok(!fs.existsSync(path.join(v.root, "notes/step.md")));
  const actions = v.events().map((e: any) => e.action);
  assert.deepEqual(actions, ["file.trashed", "note.sealed", "file.moved", "note.updated", "note.created", "note.created", "docs.created"]);
});

test("a damaged log line is shown, not dropped", () => {
  const v = new Docs(tmp());
  fs.appendFileSync(path.join(v.root, "log", `${new Date().toISOString().slice(0, 7)}.jsonl`), "{oops\n");
  assert.ok("damaged" in v.events()[0]);
});

test("the tree hides the cache, git and dotfiles; folders first", () => {
  const v = new Docs(tmp());
  for (const f of [".malachite/out/x.json", ".git/HEAD", ".hidden", "b.md", "a/z.md"]) { fs.mkdirSync(path.dirname(path.join(v.root, f)), { recursive: true }); fs.writeFileSync(path.join(v.root, f), ""); }
  assert.deepEqual(v.tree().map((e) => e.name), ["a", "log", "b.md", "docs.toml"]);
});

test("the index resolves links and finds backlinks with their context", () => {
  const v = new Docs(tmp());
  const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(v.root, p)), { recursive: true }); fs.writeFileSync(path.join(v.root, p), t); };
  w("tank/notes/step.md", "# Step\nUses [[protocol]] and ![[level-loop.pst]] and [[missing]].\n");
  w("tank/notes/protocol.md", "# Protocol\n");
  w("other/protocol.md", "# Another protocol\n");
  w("tank/level-loop.pst", "{}");
  w("tank/report.md", "Cites [[step]] here.\n");
  const ix = new Index(v);
  ix.build();
  assert.deepEqual(ix.links("tank/notes/step.md"), [
    { link: "protocol", path: "tank/notes/protocol.md" },   // the nearer of two
    { link: "level-loop.pst", path: "tank/level-loop.pst" },
    { link: "missing", path: null },
  ]);
  assert.deepEqual(ix.backlinks("tank/notes/step.md"), ["tank/report.md"]);
  assert.equal(ix.context("tank/report.md", "tank/notes/step.md"), "Cites [[step]] here.");
  assert.equal(ix.items.get("tank/level-loop.pst")?.type, "pst");
});
