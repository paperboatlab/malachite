// Sessions against a fake paperboatd and runtime (paperboat/docs/control.md, runtime.md): the hub's Julia
// packages installed before its first session, Run all, why a cell's session ended, and a closed hub that
// starts nothing. The real daemon: e2e.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Control } from "../server/control.ts";
import { parse } from "../server/note.ts";
import { INSTANTIATE, missing, recorded, slug } from "../server/packages.ts";
import { Sessions, type Run } from "../server/sessions.ts";
import { Hub } from "../server/hub.ts";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "malachite-")));
const frame = (m: object) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };
const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error("timed out"); await new Promise((r) => setTimeout(r, 10)); } };
const settled = (r: Run) => r.state === "done" || r.state === "failed" || r.state === "skipped";
const isChdir = (code: string) => code.includes("PAPERBOAT_PROJECT");

/** A session runtime. `fail` fails, `hang` never answers, `die` ends the process, `slow` answers after 300 ms,
 *  `figure` is a JulixPlot figure (whose SVG it prints when asked), anything else prints itself. `evals` gets every cell's code as it arrives. */
function fakeRuntime(sock: string, evals: string[]) {
  return net.createServer((c) => {
    c.write(frame({ type: "hello", protocol: "paperboat-runtime/0", mode: "session", runtime: { name: "python", version: "3.12.16" }, ops: ["eval"] }));
    let buf = Buffer.alloc(0);
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const m = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
        buf = buf.subarray(4 + buf.readUInt32LE(0));
        const code = String(m.args?.code ?? "");
        if (m.op === "eval" && !isChdir(code)) evals.push(code);
        if (code === "fail") c.write(frame({ id: m.id, ok: false, error: { type: "ValueError", message: "no" } }));
        else if (code === "hang") { /* busy */ }
        else if (code === "die") c.destroy();
        else if (code === "figure") c.write(frame({ id: m.id, ok: true, result: { data: { "text/plain": "Figure(600×450)", "application/vnd.paperboat.figure+json": '{"scene":{}}' } } }));
        else if (code.includes('MIME"image/svg+xml"')) { c.write(frame({ type: "stream", id: m.id, name: "stdout", text: "<svg/>" })); c.write(frame({ id: m.id, ok: true, result: { data: null } })); }
        else if (code === "slow") setTimeout(() => c.write(frame({ id: m.id, ok: true, result: { data: null } })), 300);
        else { c.write(frame({ type: "stream", id: m.id, name: "stdout", text: `${code}\n` })); c.write(frame({ id: m.id, ok: true, result: { data: null } })); }
      }
    });
  }).listen(sock);
}

/** paperboatd: session leases on the fake runtime; exec leases end on the first `ps` with `execLog` as their
 *  log; `volumes` answers `volumes`. Every request lands in `calls`. */
function fakeDaemon(sock: string, ipc: string, o: { calls: { op: string; args: any }[]; volumes?: object[]; execLog?: string }) {
  const leases = new Map<string, any>();
  let n = 0;
  return net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        o.calls.push({ op: m.op, args: m.args });
        let result: unknown = {};
        if (m.op === "acquire") {
          const id = `l-${++n}`, runtime = m.args.runtime === "julia" ? "julia@1.11.9" : "python@3.12";
          leases.set(id, { id, runtime, mode: m.args.mode, owner: m.args.owner, backend: "podman", state: "running", ipc, project: m.args.project });
          result = leases.get(id);
        } else if (m.op === "ps") {
          result = [...leases.values()];
          for (const l of leases.values()) if (l.mode === "exec") l.state = "exited";
        } else if (m.op === "logs") result = { text: leases.get(m.args.lease)?.mode === "exec" ? o.execLog ?? "  Installed Example ─ v0.5.5\nMALACHITE-DONE\n" : "Segmentation fault\n" };
        else if (m.op === "runtimes.list") result = { runtimes: [{ name: "julia", version: "1.11.9", modes: ["session", "exec"] }, { name: "python", version: "3.12", modes: ["session"] }] };
        else if (m.op === "volumes") result = o.volumes ?? [];
        else if (m.op === "release") leases.delete(m.args.lease);
        c.write(JSON.stringify({ id: m.id, ok: true, result }) + "\n");
      }
    });
  }).listen(sock);
}

/** A hub with one note of `cells` ([lang, code]); its fakes; `close` ends them all. */
function rig(cells: [string, string][], o: { volumes?: (hub: string) => object[]; execLog?: string; manifest?: string } = {}) {
  const dir = tmp(), ipc = path.join(dir, "ipc"), calls: { op: string; args: any }[] = [], evals: string[] = [], events: any[] = [];
  fs.mkdirSync(ipc);
  fs.mkdirSync(path.join(dir, "hub"));
  const hub = new Hub(path.join(dir, "hub"));
  if (o.manifest) { fs.writeFileSync(path.join(hub.root, "Project.toml"), '[deps]\nExample = "7876af07-990d-54b4-ab0e-23690620f79a"\n'); fs.writeFileSync(path.join(hub.root, "Manifest.toml"), o.manifest); }
  const rsrv = fakeRuntime(path.join(ipc, "runtime.sock"), evals);
  const dsrv = fakeDaemon(path.join(dir, "control.sock"), ipc, { calls, volumes: o.volumes?.(hub.root), execLog: o.execLog });
  const p = hub.create("", "Cells");
  hub.write(p, hub.read(p) + cells.map(([l, c]) => `\`\`\`${l}\n${c}\n\`\`\`\n`).join("\n"));
  const s = new Sessions(hub, new Control(path.join(dir, "control.sock"), false), (e) => events.push(structuredClone(e)));
  const hashes = parse(hub.read(p)).cells.map((c) => c.hash);
  return { dir, hub, p, s, calls, evals, events, hashes, close: () => { s.close(); rsrv.close(); dsrv.close(); } };
}

const MANIFEST = `julia_version = "1.11.9"\nmanifest_format = "2.0"\n\n[[deps.Example]]\ngit-tree-sha1 = "e1f0e1a832ccd8e97d6d0348dec33ee139a5aeaf"\nuuid = "7876af07-990d-54b4-ab0e-23690620f79a"\nversion = "0.5.5"\n\n[[deps.LinearAlgebra]]\ndeps = ["Libdl"]\nuuid = "37e2e46d-f89d-539d-b4ee-838fcccc9c8e"\nversion = "1.11.0"\n\n[[deps.Mine]]\npath = "dev/Mine"\nuuid = "11111111-2222-3333-4444-555555555555"\nversion = "0.1.0"\n`;

test("a Manifest's packages: from a registry or a repository, in Pkg's own folder for their version", () => {
  assert.deepEqual(recorded(MANIFEST).map((p) => p.name), ["Example"]);   // not the standard library's, nor a developed path's
  assert.equal(slug("7876af07-990d-54b4-ab0e-23690620f79a", "e1f0e1a832ccd8e97d6d0348dec33ee139a5aeaf"), "SUIr0");   // as Pkg installed it in a real deps volume
  const dir = tmp(), deps = path.join(dir, "deps");
  fs.writeFileSync(path.join(dir, "Manifest.toml"), MANIFEST);
  assert.deepEqual(missing(dir, null), ["Example"]);
  fs.mkdirSync(path.join(deps, "packages", "Example", "AAAAA"), { recursive: true });   // another version doesn't count
  assert.deepEqual(missing(dir, deps), ["Example"]);
  fs.mkdirSync(path.join(deps, "packages", "Example", "SUIr0"));
  assert.deepEqual(missing(dir, deps), []);
  assert.deepEqual(missing(tmp(), null), [], "no Manifest: nothing to install");
});

test("a hub's Manifest is installed, read-only, before its first Julia session (as julix#47)", async () => {
  const r = rig([["julia", "using Example"]], { manifest: MANIFEST });
  try {
    const run = r.s.run(r.p, r.hashes[0]);
    await until(() => settled(run));
    assert.equal(run.state, "done", JSON.stringify(run.outputs));
    const acquires = r.calls.filter((c) => c.op === "acquire").map((c) => c.args);
    assert.equal(acquires.length, 2);
    assert.equal(acquires[0].mode, "exec");
    assert.deepEqual(acquires[0].command.at(-1), INSTANTIATE);
    assert.deepEqual(acquires[0].policy, { network: true }, "the network for that step; the project stays read-only");
    assert.equal(acquires[0].project, r.hub.root);
    assert.equal(acquires[1].mode, "session");
    assert.ok(r.calls.some((c) => c.op === "release" && c.args.lease === "l-1"), "the install's lease is released");
    const details = r.events.filter((e) => e.type === "session" && e.detail).map((e) => e.detail);
    assert.ok(details.includes("Installing Example from the hub's Manifest.toml"), JSON.stringify(details));
    assert.ok(details.some((d) => d.endsWith("Installed Example ─ v0.5.5")), "Pkg's latest line shows");
  } finally { r.close(); }
});

test("a deps volume that has the Manifest's packages starts the session at once; Python never installs", async () => {
  const r = rig([["julia", "1"], ["python", "2"]], { manifest: MANIFEST, volumes: (hub) => {
    const deps = path.join(tmp(), "deps");
    fs.mkdirSync(path.join(deps, "packages", "Example", "SUIr0"), { recursive: true });
    return [{ runtime: "julia-1-11", project: hub, path: deps, exists: true }];
  } });
  try {
    const runs = r.s.runAll(r.p);
    await until(() => runs.every(settled));
    assert.deepEqual(runs.map((x) => x.state), ["done", "done"]);
    assert.deepEqual(r.calls.filter((c) => c.op === "acquire").map((c) => c.args.mode), ["session", "session"]);
  } finally { r.close(); }
});

test("a failed install doesn't keep the session from starting: its first cell says why", async () => {
  const r = rig([["julia", "1"]], { manifest: MANIFEST, execLog: "ERROR: could not download https://pkg.julialang.org\n" });
  try {
    const run = r.s.run(r.p, r.hashes[0]);
    await until(() => settled(run));
    assert.equal(run.state, "done");
    assert.equal(run.outputs[0].type, "stream");
    assert.match((run.outputs[0] as any).text, /packages couldn't be installed.*could not download/s);
    assert.deepEqual(run.outputs[1], { type: "stream", name: "stdout", text: "1\n" });
  } finally { r.close(); }
});

test("Run all: every cell in order, across languages; after a failure the rest are skipped and keep their outputs", async () => {
  const r = rig([["python", "a"], ["julia", "slow"], ["python", "b"], ["python", "fail"], ["julia", "c"]]);
  try {
    const first = r.s.run(r.p, r.hashes[4]);   // the last cell has an output from before
    await until(() => settled(first));
    r.evals.length = 0;
    const runs = r.s.runAll(r.p);
    assert.deepEqual(runs.map((x) => x.state), ["queued", "queued", "queued", "queued", "queued"]);
    await until(() => runs.every(settled));
    assert.deepEqual(r.evals, ["a", "slow", "b", "fail"], "b waits for the Julia cell before it");
    assert.deepEqual(runs.map((x) => x.state), ["done", "done", "done", "failed", "skipped"]);
    assert.deepEqual(runs[4].outputs, [{ type: "stream", name: "stdout", text: "c\n" }], "the skipped cell keeps the output it had");
    const id = (await import("../server/note.ts")).split(r.hub.read(r.p)).props.id as string;
    assert.equal(r.s.outputs(id)[r.hashes[4]].state, "done", "a skip is never saved");
    assert.ok(r.events.some((e) => e.type === "cell" && e.run.state === "skipped"));
  } finally { r.close(); }
});

test("a closed hub's queued cells never run, and start no session (a hub switched away from)", async () => {
  const r = rig([["python", "hang"], ["python", "a"]]);
  try {
    const busy = r.s.run(r.p, r.hashes[0]), queued = r.s.run(r.p, r.hashes[1]);
    await until(() => r.evals.includes("hang"));
    const said = r.events.length;
    r.s.stop();
    await until(() => settled(busy) && settled(queued));
    await new Promise((z) => setTimeout(z, 200));
    assert.equal(busy.state, "failed");
    assert.equal((busy.outputs[0] as any).error.message, "The hub closed while the cell ran.");
    assert.equal(queued.state, "skipped");
    assert.deepEqual(r.evals, ["hang"]);
    assert.equal(r.calls.filter((c) => c.op === "acquire").length, 1, "no session started for the closed hub");
    assert.ok(!r.events.slice(said).some((e) => e.type === "cell"), "the page, now on another hub, hears nothing of these cells");
  } finally { r.close(); }
});

test("a cell says why its session ended: a restart, or the runtime ending with the end of its log", async () => {
  const r = rig([["python", "hang"], ["python", "die"]]);
  try {
    const a = r.s.run(r.p, r.hashes[0]);
    await until(() => r.evals.includes("hang"));
    r.s.restart("python");
    await until(() => settled(a));
    assert.deepEqual((a.outputs[0] as any).error, { message: "The Python session restarted while the cell ran." });
    const b = r.s.run(r.p, r.hashes[1]);
    await until(() => settled(b));
    const e = (b.outputs[0] as any).error;
    assert.match(e.message, /^The Python session ended while the cell ran/);
    assert.equal(e.traceback, "Segmentation fault", "the runtime's last words, from paperboatd's logs");
  } finally { r.close(); }
});

test("an interrupt the cell doesn't heed restarts the session, and the cell says so", { timeout: 10_000 }, async () => {
  const r = rig([["julia", "hang"]]);
  try {
    const run = r.s.run(r.p, r.hashes[0]);
    await until(() => r.evals.includes("hang"));
    assert.deepEqual(r.s.interrupt("julia"), { interrupted: true });
    await until(() => settled(run), 6000);
    assert.match((run.outputs[0] as any).error.message, /didn't stop within 3 s, so the Julia session restarted/);
    assert.ok(r.calls.some((c) => c.op === "interrupt"));
  } finally { r.close(); }
});

test("a JulixPlot figure comes with its SVG, asked of the session: Malachite draws pictures, not scenes", async () => {
  const r = rig([["julia", "figure"], ["julia", "1"]]);
  try {
    const runs = r.s.runAll(r.p);
    await until(() => runs.every(settled));
    assert.deepEqual(runs[0].outputs, [{ type: "result", data: { "text/plain": "Figure(600×450)", "application/vnd.paperboat.figure+json": '{"scene":{}}', "image/svg+xml": "<svg/>" } }]);
    assert.equal(r.evals.length, 3, "one question after the figure, none after a plain value");
  } finally { r.close(); }
});
