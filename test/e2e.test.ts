// End to end against the real paperboatd and a real Python runtime (podman, or native). Skipped where
// there is no daemon to start: set PAPERBOATD, or have paperboatd on PATH. The read-only example's test starts a
// paperboatd of its own (0.2.0-beta.9 or newer: PAPERBOATD, else the one on PATH), on its own socket and state,
// that sees no container engine, so its runtime is native.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Control } from "../server/control.ts";
import { parse } from "../server/note.ts";
import { Sessions } from "../server/sessions.ts";
import { Hub, launched } from "../server/hub.ts";

const daemon = process.env.PAPERBOATD ?? (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, "paperboatd")).find((p) => fs.existsSync(p));

test("a Python cell runs in a session lease, in its note's folder", { skip: !daemon && "no paperboatd", timeout: 300_000 }, async () => {
  const hub = new Hub(fs.mkdtempSync(path.join(os.tmpdir(), "malachite-e2e-")));
  fs.mkdirSync(path.join(hub.root, "notes"));
  fs.writeFileSync(path.join(hub.root, "notes", "data.txt"), "42\n");
  const p = hub.create("notes", "E2E");
  hub.write(p, `${hub.read(p)}\`\`\`python\nimport os\nprint(open("data.txt").read().strip(), os.path.basename(os.getcwd()))\n6 * 7\n\`\`\`\n`);
  const s = new Sessions(hub, new Control(), () => {});
  try {
    const run = s.run(p, parse(hub.read(p)).cells[0].hash);
    while (run.state !== "done" && run.state !== "failed") await new Promise((r) => setTimeout(r, 50));
    assert.equal(run.state, "done", JSON.stringify(run.outputs));
    assert.deepEqual(run.outputs, [{ type: "stream", name: "stdout", text: "42 notes\n" }, { type: "result", data: { "text/plain": "42" } }]);
    assert.equal(run.runtime?.name, "python");
  } finally {
    s.close();
  }
});

test("a cell in an example where it is runs, and writes nothing in its folder", { skip: !daemon && "no paperboatd", timeout: 300_000 }, async () => {
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "malachite-e2e-examples-"))), dir = path.join(top, "malachite", "lab");
  fs.mkdirSync(path.join(dir, ".malachite"), { recursive: true });
  fs.writeFileSync(path.join(dir, "example.toml"), 'app = "malachite"\nname = "Lab"\n');
  fs.writeFileSync(path.join(dir, ".malachite", "hub.toml"), 'id = "h_e2eexample"\nname = "lab"\nschema = 3\n');
  fs.writeFileSync(path.join(dir, "cell.md"), "# Cell\n\n```python\ntry:\n    open('written.txt', 'w').write('x'); print('wrote')\nexcept OSError as e:\n    print('refused', type(e).__name__)\n6 * 7\n```\n");
  const list = () => fs.readdirSync(dir, { recursive: true }).map(String).sort();
  const before = list();
  launched(dir, { PAPERBOAT_EXAMPLE: "malachite/lab" });   // as `paperboat example open` starts the server
  const hub = new Hub(dir), s = new Sessions(hub, new Control(), () => {});
  launched(null);
  assert.ok(hub.example);
  try {
    const run = s.run("cell.md", parse(hub.read("cell.md")).cells[0].hash);
    while (run.state !== "done" && run.state !== "failed") await new Promise((r) => setTimeout(r, 50));
    assert.equal(run.state, "done", JSON.stringify(run.outputs));
    assert.deepEqual(run.outputs.at(-1), { type: "result", data: { "text/plain": "42" } });
    assert.match(JSON.stringify(run.outputs), /refused/, `the project is mounted read-only (${run.runtime?.backend})`);
    assert.ok(fs.existsSync(path.join(s.outDir("cell.md"), `${run.hash}.json`)), "its output kept outside the example");
  } finally {
    s.close();
  }
  assert.deepEqual(list(), before, "the example's folder is as it was");
});

/** A paperboatd at 0.2.0-beta.9 or newer (read-only projects, pb#91), or why there is none. */
function newDaemon(): string | { skip: string } {
  if (!daemon) return { skip: "no paperboatd" };
  let v = "";
  try { v = execFileSync(daemon, ["--version"], { encoding: "utf8", timeout: 5000 }).trim().split(/\s+/).pop() ?? ""; } catch { return { skip: `${daemon} --version failed` }; }
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?/.exec(v);
  const n = m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : [];
  const want = [0, 2, 0, 9];
  for (let i = 0; i < 4; i++) if (n[i] !== want[i]) return (n[i] ?? -1) > want[i] ? daemon : { skip: `paperboatd ${v}: read-only projects need 0.2.0-beta.9 or newer` };
  return daemon;
}
const ro = newDaemon();
const onPath = (name: string) => (process.env.PATH ?? "").split(path.delimiter).map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
// what the native runtime runs: python3, through env (the cleaned environment)
const tools = ["python3", "env"].map((t) => [t, onPath(t)] as const);
const roSkip = typeof ro !== "string" ? ro.skip : process.platform !== "linux" ? "Landlock is Linux's"
  : tools.find(([, p]) => !p) ? `no ${tools.find(([, p]) => !p)![0]} for the native runtime` : false;

test("native: a cell can't write into an example by its absolute path; the folder stays as it was", { skip: roSkip, timeout: 300_000 }, async () => {
  // a paperboatd of this test's own: its socket, its state, a PATH with python3 (and env) but no podman or docker
  const run = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mlc-ro-"))), bin = path.join(run, "bin");
  fs.mkdirSync(bin);
  for (const [t, p] of tools) fs.symlinkSync(p!, path.join(bin, t));
  const sock = path.join(run, "c.sock");
  const d = spawn(ro as string, ["--socket", sock, "--state", path.join(run, "state"), "--idle-exit", "60"], { env: { HOME: os.homedir(), PATH: bin }, stdio: "ignore" });
  const home = process.env.PAPERBOAT_HOME;
  process.env.PAPERBOAT_HOME = path.join(run, "home");   // the example's outputs and log: here, not the user's cache

  // an examples checkout, everything committed; opened as `paperboat example open malachite/lab` does
  const top = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mlc-examples-"))), dir = path.join(top, "malachite", "lab");
  fs.mkdirSync(path.join(dir, ".malachite"), { recursive: true });
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "example.toml"), 'app = "malachite"\nname = "Lab"\n');
  fs.writeFileSync(path.join(dir, ".malachite", "hub.toml"), 'id = "h_e2ereadonly"\nname = "lab"\nschema = 3\n');
  fs.writeFileSync(path.join(dir, "data", "in.txt"), "42\n");
  const abs = JSON.stringify(dir);
  fs.writeFileSync(path.join(dir, "cell.md"), [
    "# Cells", "",
    // every way in, by absolute path, each refused; the folder can still be read, and the temporary and working folders written
    "```python", "import os, shutil, tempfile",
    `ex = ${abs}`, "refused = []",
    "for what, f in [",
    "    ('new file', lambda: open(os.path.join(ex, 'written.txt'), 'w').write('x')),",
    "    ('append', lambda: open(os.path.join(ex, 'data', 'in.txt'), 'a').write('x')),",
    "    ('truncate', lambda: open(os.path.join(ex, 'cell.md'), 'w')),",
    "    ('remove', lambda: os.remove(os.path.join(ex, 'data', 'in.txt'))),",
    "    ('mkdir', lambda: os.mkdir(os.path.join(ex, 'made'))),",
    "    ('rename', lambda: os.rename(os.path.join(ex, 'data'), os.path.join(ex, 'moved'))),",
    "    ('rmtree', lambda: shutil.rmtree(os.path.join(ex, 'data'))),",
    "]:",
    "    try:", "        f()", "    except OSError:", "        refused.append(what)",
    "print('refused', ','.join(refused))",
    "print('read', open(os.path.join(ex, 'data', 'in.txt')).read().strip())",
    "t = os.path.join(tempfile.gettempdir(), 'mlc-ro-scratch.txt'); open(t, 'w').write('ok'); print('temp', open(t).read()); os.remove(t)",
    "```", "",
    // left to fail: the runtime's words for it
    "```python", `open(${JSON.stringify(path.join(dir, "out.csv"))}, "w").write("a,b\\n")`, "```", "",
  ].join("\n"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: top, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "examples");
  const snapshot = () => fs.readdirSync(top, { recursive: true }).map(String).filter((f) => !f.startsWith(".git")).sort()
    .map((f) => { const p = path.join(top, f), st = fs.lstatSync(p); return `${f} ${st.mode} ${st.mtimeMs} ${st.isFile() ? fs.readFileSync(p, "hex") : ""}`; });
  const before = snapshot();

  launched(dir, { PAPERBOAT_EXAMPLE: "malachite/lab" });
  const hub = new Hub(dir);
  launched(null);
  assert.deepEqual(hub.example, { id: "malachite/lab", name: "Lab" });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 100));
  const control = new Control(sock, false), s = new Sessions(hub, control, () => {});
  const ran = async (i: number) => {
    const r = s.run("cell.md", parse(hub.read("cell.md")).cells[i].hash);
    while (r.state !== "done" && r.state !== "failed") await new Promise((z) => setTimeout(z, 50));
    return r;
  };
  try {
    const all = await ran(0);
    assert.equal(all.state, "done", JSON.stringify(all.outputs));
    assert.equal(all.runtime?.backend, "native");
    const out = all.outputs.map((o) => (o.type === "stream" ? o.text : "")).join("");
    assert.match(out, /^refused new file,append,truncate,remove,mkdir,rename,rmtree$/m, out);
    assert.match(out, /^read 42$/m, "the example can be read");
    assert.match(out, /^temp ok$/m, "the temporary folder can be written");
    const lease = (await control.call<{ id: string; owner: string; project?: string; readonly?: boolean; isolation?: string[] }[]>("ps")).find((l) => l.owner === `malachite:${hub.name}`);
    assert.equal(lease?.readonly, true, JSON.stringify(lease));
    assert.match(String(lease?.isolation), /read-only \(Landlock\)/);

    const one = await ran(1);
    assert.equal(one.state, "failed", JSON.stringify(one.outputs));
    const err = one.outputs.find((o) => o.type === "error");
    assert.ok(err && err.type === "error", JSON.stringify(one.outputs));
    assert.match(err.error.message, /is read-only: it is an example; copy it/, err.error.message);
    assert.ok(fs.existsSync(path.join(s.outDir("cell.md"), `${one.hash}.json`)), "its output kept outside the example, in the cache");
    assert.ok(s.outDir("cell.md").startsWith(path.join(run, "home")));
  } finally {
    s.close();
    d.kill();
    await new Promise((r) => d.once("exit", r));
    if (home === undefined) delete process.env.PAPERBOAT_HOME; else process.env.PAPERBOAT_HOME = home;
    fs.rmSync(run, { recursive: true, force: true });
  }
  assert.deepEqual(snapshot(), before, "the example's folder is byte for byte as it was");
  assert.equal(git("status", "--porcelain", "--ignored"), "", "and its checkout's git status is clean");
  fs.rmSync(top, { recursive: true, force: true });   // kept when it changed, to see how
});
