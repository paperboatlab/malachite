import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// the commands run as `bin/malachite hub …` does, against a home of their own
const home = fs.mkdtempSync(path.join(os.tmpdir(), "pbhome-"));
const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "malachite");
const hub = (...a: string[]) => {
  const r = spawnSync(bin, ["hub", ...a], { env: { ...process.env, PAPERBOAT_HOME: home, HOME: home }, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
};

test("new, list, rename, config, move, remove: the list follows the hub by its id", () => {
  const made = hub("new", "tank-lab", "--json");
  assert.equal(made.code, 0, made.err);
  const { id, path: dir } = made.json();
  assert.equal(dir, path.join(home, "Documents", "paperboat", "tank-lab"));
  assert.match(hub("list").out, /tank-lab\s+Local · ~\/Documents\/paperboat\/tank-lab/);
  assert.equal(hub("rename", "tank-lab", "tank-rig").code, 0);
  assert.equal(hub("config", "tank-rig", "keep", "90d").code, 0);
  assert.equal(hub("config", "tank-rig", "keep").out.trim(), "90d");
  assert.equal(hub("config", "tank-rig", "colour", "red").code, 2);
  const to = path.join(home, "elsewhere", "rig");
  assert.equal(hub("move", "tank-rig", to).code, 0);
  const listed = hub("list", "--json").json();
  assert.deepEqual(listed.map((h: { id: string; path: string; name: string }) => [h.id, h.path, h.name]), [[id, to, "tank-rig"]]);
  assert.match(hub("show", id).out, /holds\s+0 notes/);
  assert.equal(hub("remove", "tank-rig").code, 0);
  assert.deepEqual(hub("list", "--json").json(), []);
  assert.ok(fs.existsSync(path.join(to, ".malachite", "hub.toml")), "removing keeps the files");
  assert.equal(hub("add", to).code, 0);
  assert.equal(hub("add", path.join(home, "Documents")).code, 2, "a plain folder is not a hub");
});

test("a path given as the name is refused, never made under ~/Documents/paperboat", () => {
  const r = hub("new", path.join(home, "scratch", "lab"));
  assert.equal(r.code, 2, r.out);
  assert.match(r.err, /a hub's name, not a folder/);
  assert.ok(!fs.existsSync(path.join(home, "Documents", "paperboat", home.slice(1))));
});

test("a hub moved by hand is found again by pointing at its folder", () => {
  const { path: dir } = hub("new", "pump", "--json").json();
  const to = path.join(home, "moved-pump");
  fs.renameSync(dir, to);
  assert.match(hub("list").out, /pump.*can't find the folder/);
  assert.equal(hub("move", "pump", to).code, 0);
  assert.match(hub("list").out, /pump.*on this computer/);
});

test("a hub that Malachite has open won't move", () => {
  const { path: dir } = hub("new", "busy", "--json").json();
  fs.writeFileSync(path.join(dir, ".malachite", "serving.pid"), String(process.pid));
  const r = hub("move", "busy", path.join(home, "busy-2"));
  assert.equal(r.code, 2);
  assert.match(r.err, /close it first/);
});

test("the sync client is read from the folder's path; Paperboat syncs nothing itself", async () => {
  const { placeOf, isConflictCopy } = await import("../server/hubs.ts");
  const cases: [string, string][] = [
    ["/home/a/hubs/x", "local"], ["/home/a/Dropbox/hubs/x", "dropbox"], ["/home/a/Dropbox (Lab)/x", "dropbox"],
    ["/Users/a/Library/CloudStorage/Dropbox/x", "dropbox"], ["/home/a/OneDrive/x", "onedrive"], ["C:\\Users\\a\\OneDrive - Uni\\x", "onedrive"],
    ["/Users/a/Library/CloudStorage/GoogleDrive-a@b.c/My Drive/x", "google-drive"], ["G:\\My Drive\\x", "google-drive"],
    ["/Users/a/Library/Mobile Documents/com~apple~CloudDocs/x", "icloud"], ["/home/a/DropboxNotes/x", "local"],
  ];
  for (const [p, want] of cases) assert.equal(placeOf(p), want, p);
  for (const n of ["a (Ana's conflicted copy 2026-11-25).md", "a.sync-conflict-20261125-101010-ABCD.md", "a.md.conflict1"]) assert.ok(isConflictCopy(n), n);
  for (const n of ["a.md", "conflict.md", "a (2).md"]) assert.ok(!isConflictCopy(n), n);
});

test("a hub in Dropbox with a conflict copy says so", () => {
  const dir = path.join(home, "Dropbox", "lab");
  assert.equal(hub("new", "lab", "--in", dir).code, 0);
  fs.writeFileSync(path.join(dir, "a (Ana's conflicted copy 2026-11-25).md"), "x");
  const listed = hub("list", "--json").json().find((h: { name: string }) => h.name === "lab");
  assert.equal(listed.place, "dropbox");
  assert.deepEqual(listed.conflicts, ["a (Ana's conflicted copy 2026-11-25).md"]);
  assert.match(hub("list").out, /lab\s+Dropbox · .*1 conflict copy/);
  fs.rmSync(path.join(dir, "a (Ana's conflicted copy 2026-11-25).md"));
  assert.match(hub("list").out, /lab\s+Dropbox · .*Dropbox's app syncs it/);
});
