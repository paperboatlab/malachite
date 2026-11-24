// The two protocol clients against fakes that speak paperboat/docs/control.md and runtime.md, and a
// cell run end to end through them. The real daemon and a real runtime: e2e.test.ts.
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Control } from "../server/control.ts";
import { Runtime, RuntimeError } from "../server/runtime.ts";
import { Sessions, type Run } from "../server/sessions.ts";
import { Hub } from "../server/hub.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "malachite-"));
const frame = (m: object) => { const b = Buffer.from(JSON.stringify(m)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h, b]); };

/** A session runtime: `eval` of "fail" fails; anything else prints, displays and returns. */
function fakeRuntime(sock: string) {
  return net.createServer((c) => {
    c.write(frame({ type: "hello", protocol: "paperboat-runtime/0", mode: "session", runtime: { name: "python", version: "3.12.16" }, ops: ["eval"] }));
    let buf = Buffer.alloc(0);
    c.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const m = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
        buf = buf.subarray(4 + buf.readUInt32LE(0));
        if (m.args.code === "fail") { c.write(frame({ id: m.id, ok: false, error: { type: "ZeroDivisionError", message: "division by zero", traceback: "line 1" } })); continue; }
        c.write(frame({ type: "stream", id: m.id, name: "stdout", text: "hi" }));
        c.write(frame({ type: "stream", id: m.id, name: "stdout", text: "\n" }));
        c.write(frame({ type: "display", id: m.id, data: { "text/plain": "<plot>", "image/png": "iVBOR" } }));
        c.write(frame({ id: m.id, ok: true, result: { data: { "text/plain": "2" } } }));
      }
    });
  }).listen(sock);
}

/** paperboatd: acquire answers with a lease whose ipc folder holds the fake runtime's socket. */
function fakeDaemon(sock: string, ipc: string, calls: string[]) {
  let acquired: Record<string, unknown> | undefined;
  return net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        calls.push(m.op);
        if (m.op === "acquire") acquired = { id: "l-1", runtime: m.args.runtime, mode: "session", owner: m.args.owner, backend: "podman", state: "running", ipc, project: m.args.project, digest: "sha256:abc", verified: "unsigned" };
        const lease = acquired;
        const result = m.op === "acquire" ? lease : m.op === "ps" ? [lease, { ...lease, id: "other", owner: "someone else" }] : m.op === "stats" ? { stats: { cpu_percent: 1, memory_bytes: 1 << 20, pids: 3 } } : m.op === "runtimes.list" ? { runtimes: [{ name: "python", version: "3.12", modes: ["session"] }, { name: "omc", version: "1.27", modes: ["exec"] }] } : {};
        if (m.op === "acquire") c.write(JSON.stringify({ event: "lease.acquired", lease: "l-1" }) + "\n");
        c.write(JSON.stringify({ id: m.id, ok: true, result }) + "\n");
      }
    });
  }).listen(sock);
}

test("runtime client: hello, streamed output, a failure keeps its type and traceback", async () => {
  const dir = tmp(), sock = path.join(dir, "runtime.sock");
  const srv = fakeRuntime(sock);
  const rt = await Runtime.connect(sock, 2000);
  assert.equal(rt.hello?.runtime.name, "python");
  const notes: string[] = [];
  assert.deepEqual(await rt.request("eval", { code: "1+1" }, (n) => notes.push(n.type)), { data: { "text/plain": "2" } });
  assert.deepEqual(notes, ["stream", "stream", "display"]);
  await assert.rejects(rt.request("eval", { code: "fail" }), (e: RuntimeError) => e.error.type === "ZeroDivisionError" && e.error.traceback === "line 1");
  rt.close();
  srv.close();
});

test("runtime client waits for a runtime that isn't listening yet", async () => {
  const dir = tmp(), sock = path.join(dir, "runtime.sock");
  let srv: net.Server | undefined;
  setTimeout(() => (srv = fakeRuntime(sock)), 300);
  const rt = await Runtime.connect(sock, 3000);
  assert.equal(rt.hello?.mode, "session");
  rt.close();
  srv?.close();
});

test("a cell runs in a session lease and its output is kept beside the note", async () => {
  const dir = tmp(), ipc = path.join(dir, "ipc"), calls: string[] = [];
  fs.mkdirSync(ipc);
  const rsrv = fakeRuntime(path.join(ipc, "runtime.sock"));
  const dsrv = fakeDaemon(path.join(dir, "control.sock"), ipc, calls);
  const hub = new Hub(path.join(dir, "hub") + (fs.mkdirSync(path.join(dir, "hub")), ""));
  const p = hub.create("", "Cells");
  hub.write(p, hub.read(p) + "```python\nprint('hi'); 1+1\n```\n");
  const events: any[] = [];
  const s = new Sessions(hub, new Control(path.join(dir, "control.sock"), false), (e) => events.push(structuredClone(e)));   // as SSE sends them
  const { hash } = (await import("../server/note.ts")).parse(hub.read(p)).cells[0];
  const run = s.run(p, hash);
  while (run.state !== "done" && run.state !== "failed") await new Promise((r) => setTimeout(r, 10));
  assert.equal(run.state, "done");
  assert.deepEqual(run.outputs, [{ type: "stream", name: "stdout", text: "hi\n" }, { type: "display", data: { "text/plain": "<plot>", "image/png": "iVBOR" } }, { type: "result", data: { "text/plain": "2" } }]);
  assert.deepEqual(run.runtime, { name: "python", version: "3.12.16", backend: "podman", digest: "sha256:abc", verified: "unsigned" });
  assert.deepEqual(calls.slice(0, 2), ["subscribe", "acquire"]);
  const id = (await import("../server/note.ts")).split(hub.read(p)).props.id as string;
  const saved: Run = s.outputs(id)[hash];
  assert.equal(saved.state, "done");
  assert.ok(events.some((e) => e.type === "cell" && e.run.state === "running"));
  assert.ok(hub.events().some((e: any) => e.action === "cell.ran" && e.details.ok === true));
  const peek = await s.peek();
  assert.equal(peek.sessions[0].stats.pids, 3);
  assert.deepEqual(peek.runtimes.map((r) => r.name), ["python"]);
  s.close();
  rsrv.close();
  dsrv.close();
});

test("a cell whose code changed is refused with a reason", () => {
  const dir = tmp();
  const hub = new Hub(dir);
  const p = hub.create("", "x");
  const s = new Sessions(hub, new Control(path.join(dir, "none.sock"), false), () => {});
  assert.throws(() => s.run(p, "0000"), /changed or is gone/);
});

test("without the daemon a cell fails and says why", async () => {
  const dir = tmp();
  const hub = new Hub(dir);
  const p = hub.create("", "x");
  hub.write(p, hub.read(p) + "```julia\n1\n```\n");
  const s = new Sessions(hub, new Control(path.join(dir, "none.sock"), false), () => {});
  const { parse } = await import("../server/note.ts");
  const run = s.run(p, parse(hub.read(p)).cells[0].hash);
  while (run.state !== "failed" && run.state !== "done") await new Promise((r) => setTimeout(r, 10));
  assert.match((run.outputs[0] as any).error.message, /paperboatd is not running/);
});
