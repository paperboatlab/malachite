// The one file workflow's server side: the hub switched at runtime, a plain folder asked to become a hub,
// a file opening its hub, and the shared store under $PAPERBOAT_HOME (recent.json, settings.json).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Control } from "../server/control.ts";
import { serve } from "../server/main.ts";

const tmp = (p: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const home = tmp("ws-pb-");
process.env.PAPERBOAT_HOME = home;

test("the hub switches at runtime; a plain folder asks; the store follows", async () => {
  const a = tmp("ws-a-"), b = tmp("ws-b-"), plain = tmp("ws-plain-");
  fs.mkdirSync(path.join(b, "notes"));
  const { server } = serve(a, 0, new Control(path.join(a, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const call = (method: string, p: string, body?: object) => fetch(`${base}${p}`, { method, headers: { "content-type": "application/json", origin: base }, body: body && JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    assert.equal((await call("GET", "/api/workspace")).json.workspace.root, a);
    assert.ok(fs.existsSync(path.join(a, ".malachite", "serving.pid")));

    // a plain folder isn't a hub: it says so, and becomes one when asked
    const asked = await call("POST", "/api/workspace", { path: plain });
    assert.deepEqual([asked.status, asked.json.notHub], [409, { name: path.basename(plain), path: plain }]);
    assert.equal((await call("POST", "/api/workspace", { path: "relative/path" })).status, 400);
    const made = await call("POST", "/api/workspace", { path: plain, make: true });
    assert.equal(made.json.workspace.root, plain);
    assert.ok(fs.existsSync(path.join(plain, ".malachite", "hub.toml")));
    assert.ok(!fs.existsSync(path.join(a, ".malachite", "serving.pid")), "the old hub is let go");

    // a file in a hub opens that hub, and the file
    fs.mkdirSync(path.join(b, ".malachite"));
    fs.writeFileSync(path.join(b, ".malachite", "hub.toml"), 'id = "h_b"\nname = "bee"\nschema = 3\n');
    fs.writeFileSync(path.join(b, "notes", "step.md"), "# Step\n");
    const opened = await call("POST", "/api/workspace", { path: path.join(b, "notes", "step.md") });
    assert.deepEqual([opened.json.workspace.name, opened.json.open], ["bee", "notes/step.md"]);
    assert.equal((await call("GET", "/api/tree")).json[0].name, "notes");

    // by id, from the hubs this machine knows
    const known = (await call("GET", "/api/hubs")).json as { id: string; path: string; notes: number }[];
    assert.deepEqual(known.find((h) => h.path === b)?.notes, 1);
    const ida = known.find((h) => h.path === a)!.id;
    assert.equal((await call("POST", "/api/workspace", { id: ida })).json.workspace.root, a);

    // closed: the Start page; the hub's routes say there is none
    assert.equal((await call("POST", "/api/workspace", {})).json.workspace, null);
    assert.equal((await call("GET", "/api/tree")).status, 409);

    // recent.json: newest first, one entry per (kind, path), written whole
    const recent = JSON.parse(fs.readFileSync(path.join(home, "recent.json"), "utf8"));
    assert.equal(recent.version, 1);
    assert.deepEqual(recent.recent.map((e: { kind: string; path: string }) => [e.kind, e.path]),
      [["hub", a], ["file", path.join(b, "notes", "step.md")], ["hub", b], ["hub", plain]]);
    assert.ok(recent.recent.every((e: { app: string; at: number }) => e.app === "malachite" && Number.isInteger(e.at)));
    fs.writeFileSync(path.join(home, "recent.json"), JSON.stringify({ version: 1, recent: [...recent.recent, { kind: "folder", path: "/x", app: "julix", at: 1 }] }));
    await call("POST", "/api/recent/clear");
    assert.deepEqual((await call("GET", "/api/recent")).json.recent.map((e: { path: string }) => e.path), ["/x"], "Clear recent leaves the other apps' folders");

    // settings.json: the theme, written back; what else it holds stays
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ version: 1, theme: "light", other: 1 }));
    assert.equal((await call("GET", "/api/settings")).json.theme, "light");
    assert.equal((await call("PUT", "/api/settings", { theme: "dark" })).json.theme, "dark");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "settings.json"), "utf8")), { version: 1, theme: "dark", other: 1 });
    assert.equal((await call("PUT", "/api/settings", { theme: "pink" })).status, 400);
    assert.ok(!fs.readdirSync(home).some((f) => f.endsWith(".tmp")));
  } finally { server.close(); }
});

test("no hub at start: the Start page", async () => {
  const { server } = serve(null, 0, new Control(path.join(home, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  try {
    assert.deepEqual((await fetch(`${base}/api/workspace`).then((r) => r.json())).workspace, null);
    assert.equal((await fetch(`${base}/api/hub`)).status, 409);
  } finally { server.close(); }
});
