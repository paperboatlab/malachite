import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Control } from "../server/control.ts";
import { serve } from "../server/main.ts";

// a stand-in paperboat CLI: julix is installed, `app open` answers a session for the folder it was given
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const home = tmp("apps-home-"), bin = path.join(tmp("apps-bin-"), "paperboat");
fs.writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "app list") echo '[{"name":"malachite","label":"Malachite","installed":{}},{"name":"julix","label":"Julix","installed":{}},{"name":"articula","label":"Articula","installed":null}]' ;;
  "launcher --page") echo "$*" > "$(dirname "$0")/launcher-args"; echo '{}' ;;
  "app open") printf '{"id":"%s-1","url":"http://127.0.0.1:30473/","project":"%s"}' "$3" "$4" ;;
  *) echo '{"error":"no"}'; exit 2 ;;
esac
`, { mode: 0o755 });
process.env.PAPERBOAT_BIN = bin; process.env.PAPERBOAT_HOME = tmp("apps-pb-"); process.env.HOME = home;

test("a file another app draws: open it there on the hub, or copy it out of the hub", async () => {
  const dir = tmp("apps-hub-");
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(path.join(dir, "scripts", "fit.jl"), "1 + 1\n");
  const { server } = serve(dir, 0, new Control(path.join(dir, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const post = (body: object) => fetch(`http://127.0.0.1:${port}/api/apps/open`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  try {
    const apps = await fetch(`http://127.0.0.1:${port}/api/apps`).then((r) => r.json());
    assert.deepEqual(apps.map((a: { name: string }) => a.name), ["malachite", "julix"], "only what is installed");
    const open = await post({ app: "julix", path: "scripts/fit.jl", copy: false });
    assert.equal(open.json.url, "http://127.0.0.1:30473/?open=scripts%2Ffit.jl", "the hub's own file");
    const copy = await post({ app: "julix", path: "scripts/fit.jl", copy: true });
    assert.equal(copy.json.file, "fit.jl");
    assert.equal(fs.readFileSync(path.join(home, "Documents", "paperboat", "julix", "fit.jl"), "utf8"), "1 + 1\n");
    assert.equal((await post({ app: "julix", path: "scripts/fit.jl", copy: true })).json.file, "fit (2).jl", "a taken name gets a number");
    assert.equal((await post({ app: "articula", path: "scripts/fit.jl", copy: false })).status, 409, "not installed");
    assert.equal((await post({ app: "julix", path: "../outside.jl", copy: true })).status, 400, "paths stay in the hub");
  } finally { server.close(); }
});

test("Manage runtimes…: the Launcher on its Runtimes page (paperboat#69)", async () => {
  const { server } = serve(null, 0, new Control(path.join(home, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/launcher`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` }, body: "{}" });
    assert.equal(r.status, 200);
    assert.equal(fs.readFileSync(path.join(path.dirname(bin), "launcher-args"), "utf8").trim(), "launcher --page runtimes --json");
  } finally { server.close(); }
});
