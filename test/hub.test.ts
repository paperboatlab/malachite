import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Index } from "../server/index.ts";
import { split } from "../server/note.ts";
import { execFileSync } from "node:child_process";
import { Hub, ignoreTest, machine } from "../server/hub.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "malachite-"));
// a Paperboat home of their own: serving a hub records it in hubs.toml and keeps its history there
process.env.PAPERBOAT_HOME = tmp();

test("opening a folder makes it a hub and logs it", () => {
  const dir = tmp();
  const v = new Hub(dir);
  const conf = fs.readFileSync(path.join(dir, ".malachite", "hub.toml"), "utf8");
  assert.match(conf, /schema = 3/);
  assert.match(conf, /id = "h_/);
  assert.ok(!fs.existsSync(path.join(dir, "hub.toml")));
  assert.equal(v.events()[0] && "action" in v.events()[0] ? (v.events()[0] as any).action : "", "hub.created");
});

test("a newer schema is refused with a clear message", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".malachite"));
  fs.writeFileSync(path.join(dir, ".malachite", "hub.toml"), "schema = 99\n");
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
  fs.appendFileSync(path.join(v.root, ".malachite", "log", machine(), `${new Date().toISOString().slice(0, 7)}.jsonl`), "{oops\n");
  assert.ok("damaged" in v.events()[0]);
});

test("the tree hides the cache, git and dotfiles; folders first", () => {
  const v = new Hub(tmp());
  for (const f of [".malachite/out/x.json", ".git/HEAD", ".hidden", "b.md", "a/z.md"]) { fs.mkdirSync(path.dirname(path.join(v.root, f)), { recursive: true }); fs.writeFileSync(path.join(v.root, f), ""); }
  assert.deepEqual(v.tree().map((e) => e.name), ["a", "b.md"]);
});

test("what the hub's ignore names is not in the tree, the index or the watch (#69)", async () => {
  const v = new Hub(tmp());
  v.set("ignore", ".malachite/out/ out/ *.tmp stations/*/build/");
  const w = (p: string) => { fs.mkdirSync(path.dirname(path.join(v.root, p)), { recursive: true }); fs.writeFileSync(path.join(v.root, p), "# x\n"); };
  for (const f of ["stations/rig/notes/a.md", "stations/rig/build/_deps/eigen/README.md", "model/out/M.fmu", "build/keep.md"]) w(f);
  assert.deepEqual(v.files().map((f) => f.path), ["build/keep.md", "stations/rig/notes/a.md"]);
  assert.deepEqual(v.files("stations/rig/build"), []);
  const index = new Index(v);
  index.build();
  assert.deepEqual([...index.items.keys()].sort(), ["build/keep.md", "stations/rig/notes/a.md"]);
  index.apply(["stations/rig/build", "stations/rig/build/_deps/eigen/README.md"]);   // what the watcher sees during a build
  assert.ok(!index.items.has("stations/rig/build/_deps/eigen/README.md"));
  const seen: string[] = [], watch = v.watch((rel) => seen.push(rel));
  w("stations/rig/build/CMakeCache.txt"); w("stations/rig/notes/b.md");
  for (let t = 0; t < 100 && !seen.includes("stations/rig/notes/b.md"); t++) await new Promise((r) => setTimeout(r, 50));   // the build's write came first
  watch.close();
  assert.ok(seen.includes("stations/rig/notes/b.md") && !seen.some((r) => r.includes("/build/")), seen.join(", "));
});

test("ignore means what it means to Git", () => {
  const patterns = "out/ /top.md stations/*/build/ *.tmp docs/**/gen !keep.tmp ?.log";
  const paths = ["out", "a/out", "a/out/x.md", "top.md", "a/top.md", "stations/rig/build", "stations/rig/build/x", "stations/a/b/build",
    "x.tmp", "a/x.tmp", "keep.tmp", "docs/gen", "docs/a/b/gen/x", "a.log", "ab.log", "out.md"];
  const dir = tmp();
  execFileSync("git", ["init", "-q", dir]);
  fs.writeFileSync(path.join(dir, ".git", "info", "exclude"), patterns.split(" ").join("\n") + "\n");
  for (const p of paths) fs.mkdirSync(path.join(dir, p), { recursive: true });   // all folders: what git sees on disk
  const git = execFileSync("git", ["check-ignore", "--no-index", ...paths.map((p) => `${p}/`)], { cwd: dir, encoding: "utf8" }).split("\n").filter(Boolean).map((p) => p.replace(/\/$/, ""));
  const ours = ignoreTest(patterns);
  assert.deepEqual(paths.filter((p) => ours(p, true)), paths.filter((p) => git.includes(p)));
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

test("the index follows what changed, and only that: files, a moved folder, a removed one", () => {
  const v = new Hub(tmp());
  const w = (p: string, t: string) => { fs.mkdirSync(path.dirname(path.join(v.root, p)), { recursive: true }); fs.writeFileSync(path.join(v.root, p), t); };
  w("a/one.md", "# One\n"); w("a/deep/two.md", "# Two\nSee [[one]].\n"); w("b.md", "# B\n");
  const ix = new Index(v);
  ix.build();
  // an edit: that file read again, the tree unchanged
  w("b.md", "# Bee\nNow links [[two]].\n");
  let r = ix.apply(["b.md"]);
  assert.deepEqual(r.items.map((i) => [i.path, i.title]), [["b.md", "Bee"]]);
  assert.deepEqual([r.gone, r.tree], [[], false]);
  assert.deepEqual(ix.backlinks("a/deep/two.md"), ["b.md"]);
  // a folder moved (another app, git): the old name takes its files out, the new one is walked
  fs.renameSync(path.join(v.root, "a"), path.join(v.root, "c"));
  r = ix.apply(["a", "c"]);
  assert.deepEqual(r.items.map((i) => i.path).sort(), ["c/deep/two.md", "c/one.md"]);
  assert.deepEqual(r.gone.sort(), ["a/deep/two.md", "a/one.md"]);
  assert.equal(r.tree, true);
  assert.deepEqual([...ix.items.keys()].sort(), ["b.md", "c/deep/two.md", "c/one.md"]);
  assert.equal(ix.resolve("one"), "c/one.md");
  assert.equal(ix.resolve("a/one"), null);
  // a folder seen again: what didn't change isn't read again, what is gone from it leaves
  fs.rmSync(path.join(v.root, "c", "one.md"));
  w("c/three.md", "# Three\n");
  r = ix.apply(["c"]);
  assert.deepEqual([r.items.map((i) => i.path), r.gone], [["c/three.md"], ["c/one.md"]]);
  // a folder removed; a path outside the hub or never there changes nothing
  fs.rmSync(path.join(v.root, "c"), { recursive: true });
  r = ix.apply(["c", "../x.md", "nope.md"]);
  assert.deepEqual([r.items, r.gone.sort()], [[], ["c/deep/two.md", "c/three.md"]]);
  assert.deepEqual([...ix.items.keys()], ["b.md"]);
  assert.equal(ix.resolve("two"), null);
});

test("the watcher tells the page what changed, with its items, and never what it didn't", { timeout: 20_000 }, async () => {
  const { serve } = await import("../server/main.ts");
  const { Control } = await import("../server/control.ts");
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "notes", "old"), { recursive: true });
  fs.writeFileSync(path.join(dir, "notes", "old", "x.md"), "# X\n");
  const { server } = serve(dir, 0, new Control(path.join(dir, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const events: any[] = [], ac = new AbortController();
  const es = await fetch(`${base}/events`, { signal: ac.signal });
  (async () => { let buf = ""; for await (const c of es.body!) { buf += new TextDecoder().decode(c); let i; while ((i = buf.indexOf("\n\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 2); if (l.startsWith("data: ")) events.push(JSON.parse(l.slice(6))); } } })().catch(() => {});
  const files = async (pred: (e: any) => boolean) => { for (let i = 0; i < 200; i++) { const e = events.find((x) => x.type === "files" && pred(x)); if (e) return e; await new Promise((r) => setTimeout(r, 25)); } throw new Error(`no such event: ${JSON.stringify(events)}`); };
  try {
    // the page's save: its mtime is the one the watcher event carries
    const put = await fetch(`${base}/api/note?path=notes/a.md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "# A\n[[x]]\n" }) }).then((r) => r.json());
    let e = await files((x) => x.changed.includes("notes/a.md"));
    assert.equal(e.items.find((i: any) => i.path === "notes/a.md").mtime, put.mtime);
    assert.equal(e.tree, true);   // a new file
    // another editor's change to a file the page saved over (a rename replaced it): seen, patched in, the tree as it was
    await new Promise((r) => setTimeout(r, 200));
    await fetch(`${base}/api/note?path=notes/a.md`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "# A saved again\n" }) });
    await files((x) => x.items.some((i: any) => i.title === "A saved again"));
    await new Promise((r) => setTimeout(r, 200));
    events.length = 0;
    fs.writeFileSync(path.join(dir, "notes", "a.md"), "# A again\n");
    e = await files((x) => x.items.some((i: any) => i.title === "A again"));
    assert.deepEqual([e.gone, e.tree], [[], false]);
    // a new folder with a file in it, made from outside: watched, so a later change in it is seen
    fs.mkdirSync(path.join(dir, "notes", "fresh"));
    fs.writeFileSync(path.join(dir, "notes", "fresh", "y.md"), "# Y\n");
    await files((x) => x.items.some((i: any) => i.path === "notes/fresh/y.md"));
    await new Promise((r) => setTimeout(r, 200));
    events.length = 0;
    fs.writeFileSync(path.join(dir, "notes", "fresh", "y.md"), "# Y again\n");
    await files((x) => x.items.some((i: any) => i.title === "Y again"));
    fs.rmSync(path.join(dir, "notes", "fresh"), { recursive: true });
    await files((x) => x.gone.includes("notes/fresh/y.md"));
    // a folder moved from outside: its files leave under the old name and come back under the new one
    events.length = 0;
    fs.renameSync(path.join(dir, "notes", "old"), path.join(dir, "notes", "new"));
    e = await files((x) => x.items.some((i: any) => i.path === "notes/new/x.md"));
    assert.ok(e.gone.includes("notes/old/x.md") || events.some((x) => x.type === "files" && x.gone.includes("notes/old/x.md")));
    const index = await fetch(`${base}/api/index`).then((r) => r.json());
    assert.deepEqual(index.map((i: any) => i.path), ["notes/a.md", "notes/new/x.md"]);
  } finally { ac.abort(); server.close(); }
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
  const served = serve(dir, 0, new Control(path.join(dir, "none.sock"), false)), { server } = served, hub = served.hub!;
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

test("a schema 1 hub moves its settings out of sight, keeps them, and gets an id", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "hub.toml"), 'name = "tank-lab"\nschema = 1\nauthor = "lab"\ncreated = "2026-11-17T13:00:00Z"\n');
  const v = new Hub(dir);
  assert.ok(!fs.existsSync(path.join(dir, "hub.toml")));
  assert.equal(v.name, "tank-lab");
  assert.equal(v.author, "lab");
  assert.equal(v.conf.created, "2026-11-17T13:00:00Z");
  assert.match(v.id, /^h_/);
  assert.equal(new Hub(dir).id, v.id, "the id stays");
  assert.ok(v.events().some((e) => "action" in e && e.action === "hub.upgraded"));
});

test("settings are set, checked and logged", () => {
  const v = new Hub(tmp());
  v.set("keep", "1y");
  v.set("author", "ana");
  assert.equal(new Hub(v.root).conf.keep, "1y");
  assert.equal(new Hub(v.root).author, "ana");
  assert.throws(() => v.set("keep", "forever"), /keep is one of/);
  assert.throws(() => v.set("name", ""), /can't be empty/);
  assert.throws(() => v.set("id" as never, "x"), /not a hub setting/);
});

test("a schema 2 hub's log leaves the root for this machine's folder; the user's own files there stay", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, ".malachite"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".malachite", "hub.toml"), 'id = "h_old"\nname = "old"\nschema = 2\n');
  fs.mkdirSync(path.join(dir, "log"));
  fs.writeFileSync(path.join(dir, "log", "2026-10.jsonl"), '{"time":"2026-10-01T00:00:00Z","actor":"lab","action":"note.created"}\n');
  const v = new Hub(dir);
  assert.ok(!fs.existsSync(path.join(dir, "log")), "an emptied log/ goes");
  assert.deepEqual(v.events().map((e: any) => e.action), ["hub.upgraded", "note.created"]);
  assert.match(fs.readFileSync(path.join(dir, ".malachite", "hub.toml"), "utf8"), /schema = 3/);

  const mine = tmp();
  fs.mkdirSync(path.join(mine, ".malachite"), { recursive: true });
  fs.writeFileSync(path.join(mine, ".malachite", "hub.toml"), 'id = "h_mine"\nschema = 2\n');
  fs.mkdirSync(path.join(mine, "log"));
  fs.writeFileSync(path.join(mine, "log", "pump.csv"), "t,v\n");
  new Hub(mine);
  assert.ok(fs.existsSync(path.join(mine, "log", "pump.csv")), "not a log of ours: left alone");
});

test("each machine logs to its own file; the log reads them as one, by time", () => {
  const v = new Hub(tmp()), month = new Date().toISOString().slice(0, 7);
  const other = path.join(v.root, ".malachite", "log", "other-machine");
  fs.mkdirSync(other, { recursive: true });
  fs.writeFileSync(path.join(other, `${month}.jsonl`), JSON.stringify({ time: "2000-01-01T00:00:00Z", actor: "x", action: "old" }) + "\n" + JSON.stringify({ time: "2999-01-01T00:00:00Z", actor: "x", action: "future" }) + "\n");
  v.log("now");
  assert.deepEqual(v.events().map((e: any) => e.action), ["future", "now", "hub.created", "old"]);
  assert.ok(!fs.existsSync(path.join(v.root, "log")));
});
