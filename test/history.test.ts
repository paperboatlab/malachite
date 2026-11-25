import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Hub } from "../server/hub.ts";
import { describe, History } from "../server/history.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
/** Runs `f` as another machine: its own Paperboat home (its own Git folders) and name. */
function on<T>(home: string, name: string, f: () => T): T {
  const was = [process.env.PAPERBOAT_HOME, process.env.MALACHITE_MACHINE];
  process.env.PAPERBOAT_HOME = home; process.env.MALACHITE_MACHINE = name;
  try { return f(); } finally { [process.env.PAPERBOAT_HOME, process.env.MALACHITE_MACHINE] = was as [string, string]; }
}

test("saves are versions with words; Restore brings a file back and keeps the current one", () => on(tmp("pb-"), "lab", () => {
  const hub = new Hub(tmp("hub-")), h = new History(hub);
  assert.ok(!fs.existsSync(path.join(hub.root, ".git")), "no Git folder in the hub");
  fs.writeFileSync(path.join(hub.root, "a.md"), "one\n");
  assert.ok(h.save());
  assert.equal(h.save(), null, "nothing changed: no version");
  fs.writeFileSync(path.join(hub.root, "a.md"), "two\n");
  h.save();
  const [now, first] = h.versions("a.md");
  assert.equal(now.what, "Edited", "a file's versions in its own words");
  assert.equal(h.versions()[0].what, "Edited a.md");
  h.restore(first.id, "a.md");
  assert.equal(fs.readFileSync(path.join(hub.root, "a.md"), "utf8"), "one\n");
  assert.equal(h.versions("a.md").length, 3, "the restore is a version too");
  fs.mkdirSync(path.join(hub.root, ".malachite", "out"), { recursive: true });
  fs.writeFileSync(path.join(hub.root, ".malachite", "out", "x.json"), "{}");
  assert.equal(h.save(), null, "Malachite's own files are not versioned");
}));

test("two machines: the files come by the sync, each one's bundle brings its past", () => {
  const a = tmp("hub-a-"), homeA = tmp("pb-a-"), homeB = tmp("pb-b-");
  on(homeA, "desk", () => {
    const h = new History(new Hub(a));
    fs.writeFileSync(path.join(a, "a.md"), "from the desk\n");
    h.save(); h.pack();
  });
  const b = tmp("hub-b-");
  fs.cpSync(a, b, { recursive: true });   // the sync
  on(homeB, "laptop", () => {
    const h = new History(new Hub(b));
    assert.deepEqual(h.merge(), ["desk"]);
    assert.equal(h.versions("a.md").length, 1, "the desk's past is here");
    fs.writeFileSync(path.join(b, "b.md"), "from the laptop\n");
    h.save(); h.pack();
  });
  fs.cpSync(path.join(b, ".malachite", "history"), path.join(a, ".malachite", "history"), { recursive: true });
  fs.copyFileSync(path.join(b, "b.md"), path.join(a, "b.md"));
  on(homeA, "desk", () => {
    const h = new History(new Hub(a));
    assert.deepEqual(h.merge(), ["laptop"]);
    assert.equal(h.versions("b.md").length, 1, "the laptop's past is here");
    assert.equal(h.versions("a.md").length, 1);
    assert.equal(fs.readFileSync(path.join(a, "b.md"), "utf8"), "from the laptop\n", "the files stay as they are");
  });
});

test("changes in words", () => {
  assert.equal(describe(["A  notes/a.md"]), "Added notes/a.md");
  assert.equal(describe(["R  a.md -> b/a.md"]), "Moved a.md to b/a.md");
  assert.equal(describe(["M  x/1.csv", "M  x/2.csv", "M  x/3.csv", "M  x/4.csv"]), "Edited 4 files: 1.csv, 2.csv, 3.csv, …");
  assert.equal(describe(["A  a", "D  b"]), "Changed 2 files: a, b");
  assert.equal(describe(["M  log/2026-11.jsonl", "M  notes/a.md"]), "Edited notes/a.md", "the log is not news");
});
