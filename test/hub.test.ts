import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Index } from "../server/index.ts";
import { split } from "../server/note.ts";
import { Hub } from "../server/hub.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "malachite-"));

test("opening a folder makes it a hub and logs it", () => {
  const dir = tmp();
  const v = new Hub(dir);
  assert.match(fs.readFileSync(path.join(dir, "hub.toml"), "utf8"), /schema = 1/);
  assert.equal(v.events()[0] && "action" in v.events()[0] ? (v.events()[0] as any).action : "", "hub.created");
});

test("a newer schema is refused with a clear message", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "hub.toml"), "schema = 99\n");
  assert.throws(() => new Hub(dir), /schema 99.*Update Malachite/);
});

test("paths stay inside the hub, symlinks included", () => {
  const dir = tmp(), outside = tmp();
  const v = new Hub(dir);
  fs.symlinkSync(outside, path.join(dir, "escape"));
  for (const p of ["../x", "/../../etc/passwd", "a/../../x", "escape/file", "escape"]) assert.throws(() => v.resolve(p), /outside the hub/, p);
  assert.equal(v.resolve("/notes/a.md"), path.join(fs.realpathSync(dir), "notes/a.md"));
});

test("create, write, move, seal, trash; every one a log line", () => {
  const v = new Hub(tmp());
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
  assert.deepEqual(actions, ["file.trashed", "note.sealed", "file.moved", "note.updated", "note.created", "note.created", "hub.created"]);
});

test("a damaged log line is shown, not dropped", () => {
  const v = new Hub(tmp());
  fs.appendFileSync(path.join(v.root, "log", `${new Date().toISOString().slice(0, 7)}.jsonl`), "{oops\n");
  assert.ok("damaged" in v.events()[0]);
});

test("the tree hides the cache, git and dotfiles; folders first", () => {
  const v = new Hub(tmp());
  for (const f of [".malachite/out/x.json", ".git/HEAD", ".hidden", "b.md", "a/z.md"]) { fs.mkdirSync(path.dirname(path.join(v.root, f)), { recursive: true }); fs.writeFileSync(path.join(v.root, f), ""); }
  assert.deepEqual(v.tree().map((e) => e.name), ["a", "log", "b.md", "hub.toml"]);
});

test("the index resolves links and finds backlinks with their context", () => {
  const v = new Hub(tmp());
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

test("the server answers a missing file with 404 and stays up", async () => {
  const { serve } = await import("../server/main.ts");
  const { Control } = await import("../server/control.ts");
  const dir = tmp();
  const { server } = serve(dir, 0, new Control(path.join(dir, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.status);
  assert.equal(await get("/api/raw?path=gone.csv"), 404);
  assert.equal(await get("/api/hub"), 200);
  server.close();
});

test("a property is set on its own, logged, and refused on a sealed note", () => {
  const v = new Hub(tmp());
  const p = v.create("", "Card", "issue");
  v.setProp(p, "status", "in progress");
  const { props, body } = split(fs.readFileSync(v.resolve(p), "utf8"));
  assert.equal(props.status, "in progress");
  assert.match(body, /# Card/);
  const ev = v.events(1)[0] as any;
  assert.deepEqual([ev.action, ev.details.from, ev.details.to], ["note.property", "open", "in progress"]);
  v.setProp(p, "status", "in progress");
  assert.equal((v.events(1)[0] as any).details.from, "open", "an unchanged value writes and logs nothing");
  v.setProp(p, "status", "");
  assert.equal(split(fs.readFileSync(v.resolve(p), "utf8")).props.status, undefined);
  assert.throws(() => v.setProp(p, "sealed", "x"), /not a property/);
  v.seal(p);
  assert.throws(() => v.setProp(p, "status", "done"), /sealed/);
});

test("the trash: listed, restored (beside a newcomer), deleted, emptied; every one a log line", () => {
  const v = new Hub(tmp());
  const a = v.create("", "Alpha"), b = v.create("", "Beta");
  v.mkdir("old"); fs.writeFileSync(v.resolve("old/data.csv"), "t,x\n");
  v.trash(a); v.trash("old"); v.trash(b);
  const list = v.trashed();
  assert.deepEqual(list.map((t) => [t.path, t.kind]).sort(), [[a, "file"], [b, "file"], ["old", "folder"]].sort());
  assert.equal(v.restore(list.find((t) => t.path === "old")!.id), "old");
  assert.equal(fs.readFileSync(v.resolve("old/data.csv"), "utf8"), "t,x\n");
  fs.writeFileSync(v.resolve(a), "a newcomer\n");
  const back = v.restore(v.trashed().find((t) => t.path === a)!.id);
  assert.equal(back, a.replace(/\.md$/, " (restored).md"));
  assert.match(fs.readFileSync(v.resolve(back), "utf8"), /# Alpha/);
  v.purge(v.trashed()[0].id);
  assert.equal(v.trashed().length, 0);
  v.trash(back); v.purge();
  assert.deepEqual([v.trashed().length, (v.events(1)[0] as any).action], [0, "trash.emptied"]);
  assert.throws(() => v.restore("../../etc"), /no .* in the trash/);
});

test("media: byte ranges for seeking; uploads never overwrite (a replaced file goes to the trash)", async () => {
  const { serve } = await import("../server/main.ts");
  const { Control } = await import("../server/control.ts");
  const dir = tmp();
  const { server, hub } = serve(dir, 0, new Control(path.join(dir, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const up = (p: string, body: string, replace = false) => fetch(`${base}/api/upload?path=${encodeURIComponent(p)}${replace ? "&replace=1" : ""}`, { method: "POST", body, headers: { origin: base } }).then((r) => r.json());
  assert.deepEqual(await up("media/clip.mp4", "0123456789"), { path: "media/clip.mp4" });
  assert.deepEqual(await up("media/clip.mp4", "abc"), { path: "media/clip (2).mp4" });
  let r = await fetch(`${base}/api/raw?path=media/clip.mp4`, { headers: { range: "bytes=2-5" } });
  assert.deepEqual([r.status, r.headers.get("content-range"), r.headers.get("content-type"), await r.text()], [206, "bytes 2-5/10", "video/mp4", "2345"]);
  r = await fetch(`${base}/api/raw?path=media/clip.mp4`, { headers: { range: "bytes=-3" } });
  assert.equal(await r.text(), "789");
  r = await fetch(`${base}/api/raw?path=media/clip.mp4`, { headers: { range: "bytes=20-" } });
  assert.equal(r.status, 416);
  await up("media/clip.mp4", "edited", true);
  assert.equal(fs.readFileSync(hub.resolve("media/clip.mp4"), "utf8"), "edited");
  assert.deepEqual(hub.trashed().map((t) => t.path), ["media/clip.mp4"]);
  assert.equal((await fetch(`${base}/api/upload?path=.malachite/x.png`, { method: "POST", body: "x", headers: { origin: base } })).status, 400);
  assert.ok(!fs.readdirSync(hub.resolve("media")).some((f) => f.endsWith(".tmp")));
  server.close();
});
