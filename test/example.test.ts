// An example opened where it is (paperboat#75) is read-only: every write is refused (403), what Malachite keeps
// of it (the log, the cells' outputs) goes outside it, it never joins the hubs this machine knows nor recent.json,
// and the folder is left byte for byte as it was, its checkout's `git status` clean. A copy of it is a hub like
// any other. Run against a real paperboat-examples checkout with PAPERBOAT_EXAMPLES_DIR set; else a stand-in.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Control } from "../server/control.ts";
import { History } from "../server/history.ts";
import { Hub, exampleAbove, exampleAt } from "../server/hub.ts";
import { addRecent, known, recent, remember } from "../server/hubs.ts";
import { serve } from "../server/main.ts";

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const home = tmp("ex-pb-");
process.env.PAPERBOAT_HOME = home;

/** A stand-in paperboat-examples checkout (golden.py at its top), a Git repository with everything committed. */
function standIn(): string {
  const root = tmp("ex-examples-"), ex = path.join(root, "malachite", "tank-lab");
  const files: Record<string, string> = {
    "golden.py": "# the golden harness\n",
    "malachite/tank-lab/example.toml": 'kind = "malachite"\napp = "malachite"\nname = "Tank Lab"\n',
    "malachite/tank-lab/.malachite/hub.toml": 'id = "h_tanklabgolden"\nname = "tank-lab"\nschema = 3\nauthor = "lab"\n',
    "malachite/tank-lab/start-here.md": "---\nid: n_start\nstatus: open\n---\n\n# Start here\n\n```python\n6 * 7\n```\n",
    "malachite/tank-lab/projects/a.md": "# A\n",
    "malachite/tank-lab/views/board.toml": 'name = "Board"\nshow = "board"\ngroup = "status"\n',
    "hubs/furuta-lab/example.toml": 'kind = "hub"\napp = "malachite"\nname = "Furuta Lab"\n',
    "hubs/furuta-lab/.malachite/hub.toml": 'id = "h_furuta"\nname = "furuta-lab"\nschema = 2\n',   // older: a writable hub would upgrade it
    "hubs/furuta-lab/index.md": "# Furuta\n",
    "hubs/furuta-lab/log/2026-01.jsonl": "{}\n",   // schema 2's log at the root: a writable hub would move it
  };
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), text); }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "ignore", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "examples");
  void ex;
  return root;
}
const checkout = process.env.PAPERBOAT_EXAMPLES_DIR ? fs.realpathSync(process.env.PAPERBOAT_EXAMPLES_DIR) : standIn();
const tank = path.join(checkout, "malachite", "tank-lab"), furuta = path.join(checkout, "hubs", "furuta-lab");

/** Every file and folder under `dir`, with its bytes' hash, mode and mtime: what "left as it was" means. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name), st = fs.lstatSync(p), rel = path.relative(dir, p);
      if (e.name === ".git" && d === checkout) continue;
      if (e.isDirectory()) { out[`${rel}/`] = `${st.mode}`; walk(p); }
      else out[rel] = `${st.mode}:${st.mtimeMs}:${createHash("sha256").update(fs.readFileSync(p)).digest("hex")}`;
    }
  };
  walk(dir);
  return out;
}
const gitStatus = () => (fs.existsSync(path.join(checkout, ".git")) ? execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: checkout, encoding: "utf8" }) : "");

test("an example is found where paperboat-examples keeps it; a copy of it isn't one", () => {
  assert.deepEqual(exampleAt(tank), { id: "malachite/tank-lab" });
  assert.deepEqual(exampleAt(furuta), { id: "hubs/furuta-lab" });
  assert.deepEqual(exampleAbove(path.join(tank, "projects")), { id: "malachite/tank-lab", root: tank });
  assert.equal(exampleAt(checkout), null);
  const mine = path.join(tmp("ex-mine-"), "tank-lab");
  fs.cpSync(tank, mine, { recursive: true });
  assert.equal(exampleAt(mine), null, "a copy is the user's");
  assert.equal(new Hub(mine).example, null);
  // GitHub's copy, kept in <home>/cache/examples: an example too (no golden.py needed)
  const cached = path.join(home, "cache", "examples", "malachite", "tank-lab");
  fs.cpSync(tank, cached, { recursive: true });
  assert.deepEqual(exampleAt(cached), { id: "malachite/tank-lab" });
  fs.rmSync(path.join(home, "cache", "examples"), { recursive: true });
});

test("every write to an example is refused, a run writes nothing in it, and it joins no list", async () => {
  const before = { tank: snapshot(tank), furuta: snapshot(furuta), git: gitStatus() };
  const { server } = serve(null, 0, new Control(path.join(home, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const call = (method: string, p: string, body?: object | Blob) => fetch(`${base}${p}`, {
    method, headers: { "content-type": body instanceof Blob ? "application/octet-stream" : "application/json", origin: base }, body: body instanceof Blob ? body : body && JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    for (const [dir, id] of [[furuta, "hubs/furuta-lab"], [tank, "malachite/tank-lab"]]) {
      const opened = await call("POST", "/api/workspace", { path: dir });
      assert.equal(opened.status, 200, JSON.stringify(opened.json));
      assert.deepEqual(opened.json.workspace.example, { id });
      assert.deepEqual((await call("GET", "/api/hub")).json.example, { id });
    }
    const md = "start-here.md";
    assert.ok(fs.existsSync(path.join(tank, md)) || !process.env.PAPERBOAT_EXAMPLES_DIR, "the checkout has Tank Lab's start-here.md");
    const note = (await call("GET", `/api/note?path=${md}`)).json;
    const refused: [string, string, (object | Blob)?][] = [
      ["PUT", `/api/note?path=${md}`, { text: "changed" }],
      ["PUT", "/api/note?path=new.md", { text: "new" }],   // Save as… into the example
      ["POST", "/api/note", { dir: "", title: "New" }],
      ["POST", "/api/folder", { path: "new" }],
      ["POST", "/api/move", { from: md, to: "moved.md" }],
      ["POST", "/api/trash", { path: md }],
      ["POST", "/api/trash/restore", { id: "x" }],
      ["POST", "/api/trash/delete", { id: "x" }],
      ["POST", "/api/trash/empty", {}],
      ["POST", "/api/prop", { path: md, key: "status", value: "done" }],
      ["POST", "/api/seal", { path: md }],
      ["POST", "/api/hub/config", { key: "name", value: "mine" }],
      ["POST", "/api/versions/restore", { id: "abcdef12", path: md }],
      ["POST", "/api/apps/open", { app: "julix", path: md, copy: false }],
      ["POST", "/api/upload?path=dropped.png", new Blob([new Uint8Array([1, 2, 3])])],
      ["POST", "/api/upload?path=pic.png&replace=1", new Blob([new Uint8Array([1])])],
    ];
    for (const [m, p, b] of refused) {
      const r = await call(m, p, b);
      assert.equal(r.status, 403, `${m} ${p}: ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, /is an example: copy/, `${m} ${p}`);
    }
    assert.equal((await call("POST", "/api/workspace", { path: path.join(tank, "projects"), make: true })).json.workspace?.example?.id, "malachite/tank-lab", "a folder in it opens the example, made no hub");
    assert.equal((await call("POST", "/api/examples/copy", { id: "malachite/tank-lab", to: path.join(tank, "projects") })).status, 400, "never copied into an example");
    assert.deepEqual((await call("GET", "/api/versions")).json.versions, [], "an example keeps no versions");

    // a run: its outputs and its log line go outside the example (no daemon here: the cell fails, and says so)
    const cell = note.cells[0];
    if (cell) {
      await call("POST", "/api/run", { path: md, hash: cell.hash });
      const outs = path.join(home, "cache", "malachite", "examples", "malachite", "tank-lab", "out");
      for (let i = 0; i < 100 && !fs.existsSync(outs); i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(fs.readdirSync(outs).length, "the run's output is kept outside the example");
      const again = (await call("GET", `/api/note?path=${md}`)).json;
      assert.ok(again.outputs[cell.hash], "and shown with the note");
      assert.ok(((await call("GET", "/api/log")).json as { action?: string }[]).some((e) => e.action === "cell.ran"));
    }
    await new Promise((r) => setTimeout(r, 300));   // the watcher's batch, a history save would come after

    // never in the lists: hubs.toml (the selector, the picker, hub list), recent.json
    assert.ok(!known().some((k) => k.path === tank || k.path === furuta));
    assert.ok(!((await call("GET", "/api/hubs")).json as { path: string }[]).some((h) => h.path === tank || h.path === furuta));
    assert.ok(!recent().some((e) => e.path.startsWith(checkout)));
    assert.ok(!fs.existsSync(path.join(home, "hubs", "h_tanklabgolden")), "no history folder made for it");
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.deepEqual(snapshot(tank), before.tank, "Tank Lab is byte for byte as it was");
  assert.deepEqual(snapshot(furuta), before.furuta, "Furuta Lab too (not even upgraded)");
  assert.equal(gitStatus(), before.git, "git status of the examples checkout is as it was");
});

test("example entries an earlier Malachite wrote leave hubs.toml and recent.json; a copy joins the list", () => {
  const mine = path.join(tmp("ex-copy-"), "tank-lab");
  fs.cpSync(tank, mine, { recursive: true });
  fs.writeFileSync(path.join(home, "hubs.toml"), `# old\n\n[[hub]]\nid = "h_tanklabgolden"\npath = ${JSON.stringify(tank)}\nplace = "local"\n\n[[hub]]\nid = "h_furuta"\npath = ${JSON.stringify(furuta)}\nplace = "local"\n`);
  fs.writeFileSync(path.join(home, "recent.json"), JSON.stringify({ version: 1, recent: [
    { kind: "hub", path: tank, hub: "h_tanklabgolden", app: "malachite", at: 3 },
    { kind: "file", path: path.join(furuta, "index.md"), app: "malachite", at: 2 },
    { kind: "folder", path: "/elsewhere", app: "julix", at: 1 },
  ] }));
  assert.deepEqual(known(), []);
  assert.ok(!fs.readFileSync(path.join(home, "hubs.toml"), "utf8").includes(tank), "pruned in the file too");
  assert.deepEqual(recent().map((e) => e.path), ["/elsewhere"]);
  remember("h_tanklabgolden", tank);
  addRecent({ kind: "hub", path: tank });
  assert.deepEqual(known(), []);
  assert.deepEqual(recent().map((e) => e.path), ["/elsewhere"]);
  const copy = new Hub(mine);
  remember(copy.id, copy.root);
  assert.deepEqual(known().map((k) => k.path), [copy.root], "the copy is a hub of the user's");
  copy.write("start-here.md", "# Mine\n");
  assert.equal(fs.readFileSync(path.join(mine, "start-here.md"), "utf8"), "# Mine\n", "and writable");
});

test("the Hub and History refuse an example's changes themselves, not only the routes", () => {
  const before = snapshot(tank);
  const hub = new Hub(tank), history = new History(hub);
  assert.equal(history.ok, false);
  for (const f of [() => hub.write("x.md", "x"), () => hub.create("", "x"), () => hub.mkdir("x"), () => hub.rename("start-here.md", "y.md"), () => hub.trash("start-here.md"),
    () => hub.seal("start-here.md"), () => hub.setProp("start-here.md", "status", "x"), () => hub.set("name", "x"), () => hub.purge(), () => history.restore("abcdef12")])
    assert.throws(f, /is an example: copy it to change it/);
  hub.log("note.opened", "start-here.md");
  assert.equal(history.save(), null); history.pack(); history.merge();
  assert.ok((hub.events(1)[0] as { action: string }).action === "note.opened", "its log is kept outside it");
  assert.deepEqual(snapshot(tank), before);
});
