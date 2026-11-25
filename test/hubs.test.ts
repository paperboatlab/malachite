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
