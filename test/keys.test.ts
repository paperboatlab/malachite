// End to end in a browser: the editor's keys (Standard, Vim, Helix) chosen in Settings › Editor reach every
// Malachite window through malachite.toml, and in Vim (and Helix, for `:w`) the mode shows, `i` inserts, `:w` saves the note through
// Malachite's Save, Malachite's own keys (Ctrl Enter, the cell) still go first, and in an example `:w` says it is
// read-only. Needs the built page (npm run build) and a Chrome or Chromium: set CHROME, or have one where Linux
// keeps it. Skipped without either.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chromium, type Page } from "playwright-core";
import { Control } from "../server/control.ts";
import { serve } from "../server/main.ts";

// the browser itself, not a wrapper script that outlives close() (Fedora's /usr/bin/chromium-browser)
const chrome = [process.env.CHROME, "/usr/bin/google-chrome", "/usr/lib64/chromium-browser/chromium-browser", "/usr/lib/chromium/chromium", "/usr/bin/chromium"].find((p) => p && fs.existsSync(p));
const built = fs.existsSync(new URL("../dist/main.js", import.meta.url));
const skip = process.platform !== "linux" ? "Linux only" : !built ? "no dist/ (npm run build)" : !chrome && "no Chrome (set CHROME)";

const NOTE = "x\n\n```python\n6 * 7\n```\n";

test("Vim chosen in Settings: every window has it, i inserts, :w saves, Ctrl Enter runs the cell, an example says it is read-only", { skip, timeout: 120_000 }, async () => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "malachite-keys-")));
  const hub = path.join(tmp, "hub"), conf = path.join(tmp, "config");
  fs.mkdirSync(path.join(hub, ".malachite"), { recursive: true });
  fs.writeFileSync(path.join(hub, ".malachite", "hub.toml"), 'id = "h_keystest"\nname = "keys"\nschema = 3\n');
  fs.writeFileSync(path.join(hub, "a.md"), NOTE);
  // an example where paperboat says examples are (a stand-in CLI: `example list --json`'s root): read-only
  const ex = path.join(tmp, "examples", "malachite", "lab"), bin = path.join(tmp, "paperboat");
  fs.mkdirSync(path.join(ex, ".malachite"), { recursive: true });
  fs.writeFileSync(bin, `#!/bin/sh\necho '${JSON.stringify([{ app: "malachite", id: "malachite/lab", name: "Lab", path: ex, root: path.join(tmp, "examples") }])}'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(ex, "example.toml"), 'app = "malachite"\nname = "Lab"\n');
  fs.writeFileSync(path.join(ex, ".malachite", "hub.toml"), 'id = "h_keysexample"\nname = "lab"\nschema = 3\n');
  fs.writeFileSync(path.join(ex, "a.md"), NOTE);

  const env = { PAPERBOAT_HOME: process.env.PAPERBOAT_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, PAPERBOAT_BIN: process.env.PAPERBOAT_BIN };
  process.env.PAPERBOAT_HOME = path.join(tmp, "home"); process.env.XDG_CONFIG_HOME = conf; process.env.PAPERBOAT_BIN = bin;
  const { server } = serve(hub, 0, new Control(path.join(tmp, "none.sock"), false));
  await new Promise((r) => server.once("listening", r));
  const browser = await chromium.launch({ executablePath: chrome });
  try {
    const file = path.join(conf, "paperboat", "malachite.toml");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const open = async (stored?: object): Promise<Page> => {   // a window of its own (no storage shared with the others)
      const context = await browser.newContext();
      if (stored) await context.addInitScript((v) => localStorage.setItem("malachite.editor", v), JSON.stringify(stored));
      const page = await context.newPage();
      await page.goto(url);
      await page.getByRole("treeitem", { name: /^a/ }).first().click();
      await page.getByRole("radio", { name: "Edit" }).click();   // the Markdown as it is: the cell is text the cursor goes in
      await page.locator(".cm-content").waitFor();
      return page;
    };
    const choose = async (page: Page, keys: string) => {   // Settings › Editor › Keys
      await page.keyboard.press("Control+Comma");
      await page.getByRole("dialog").getByText("Editor", { exact: true }).click();
      await page.getByLabel("Keys").selectOption(keys);
      await page.keyboard.press("Escape");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      await waitFor(() => fs.existsSync(file) && new RegExp(`^keymap = "${keys}"`, "m").test(fs.readFileSync(file, "utf8")));
    };
    const status = (page: Page) => page.locator(".cm-vim-panel").innerText().catch(() => "");

    // Standard to start: no mode; Settings › Editor › Keys: Vim, kept in malachite.toml
    const one = await open();
    assert.equal(await one.locator(".cm-vim-panel").count(), 0);
    await choose(one, "vim");
    assert.match(await status(one), /NORMAL/);

    // another window (another port's page has none of this one's storage) reads it from the file
    const two = await open();
    assert.match(await status(two), /NORMAL/);
    await two.locator(".cm-line").first().click();
    await two.keyboard.press("0");
    await two.keyboard.type("iy");
    assert.match(await status(two), /INSERT/);
    await two.keyboard.press("Escape");
    assert.match(await status(two), /NORMAL/);
    await two.keyboard.type(":w");
    await two.keyboard.press("Enter");
    await waitFor(() => fs.readFileSync(path.join(hub, "a.md"), "utf8") === `y${NOTE}`);

    // Malachite's keys go ahead of the mode: Ctrl Enter in the cell runs it
    // (caught here: the run would start a Python session, which this test doesn't need)
    await two.route("**/api/run", (r) => r.fulfill({ status: 503, contentType: "application/json", body: '{"error":"not in this test"}' }));
    const run = two.waitForRequest((r) => r.url().endsWith("/api/run") && r.method() === "POST");
    await two.keyboard.type("Gk");   // the last line is the closing fence: one up is the code
    await two.keyboard.press("Control+Enter");
    assert.equal(JSON.parse((await run).postData() ?? "{}").path, "a.md");

    // Helix: its `:w` saves too
    await choose(two, "helix");
    await two.locator(".cm-line").first().click();
    await two.keyboard.press("Home");
    await two.keyboard.type("iz");
    await two.keyboard.press("Escape");
    await two.keyboard.type(":w");
    await two.keyboard.press("Enter");
    await waitFor(() => fs.readFileSync(path.join(hub, "a.md"), "utf8") === `zy${NOTE}`);
    await choose(two, "vim");

    // an example: `:w` doesn't save, it says why
    const r = await fetch(`${url}api/workspace`, { method: "POST", headers: { "content-type": "application/json", origin: url.slice(0, -1) }, body: JSON.stringify({ path: ex }) });
    assert.equal(r.status, 200, await r.text());
    const three = await open();
    // its banner and Copy, though the window's URL has no ?example= (the server says it is one)
    await three.getByRole("note", { name: "Lab: an example" }).getByRole("button", { name: /Copy/ }).waitFor({ timeout: 5000 });
    assert.match(await status(three), /NORMAL/);
    await three.locator(".cm-line").first().click();
    await three.keyboard.press("0");
    await three.keyboard.type("iz");   // the mode moves about it, the text stays as it is
    await three.keyboard.press("Escape");
    assert.equal(await three.locator(".cm-line").first().innerText(), "x");
    await three.keyboard.type(":w");
    await three.keyboard.press("Enter");
    await three.getByText("Not saved: the example is read-only").waitFor({ timeout: 5000 });
    assert.equal(fs.readFileSync(path.join(ex, "a.md"), "utf8"), NOTE);

    // a choice made before malachite.toml (in a window's localStorage) seeds the first file, once: after that the file wins
    fs.rmSync(file);
    await open({ keymap: "vim", fontSize: 15 });
    await waitFor(() => fs.existsSync(file) && /^keymap = "vim"/m.test(fs.readFileSync(file, "utf8")));
    assert.match(fs.readFileSync(file, "utf8"), /^font_size = 15$/m);
    const four = await open({ keymap: "standard" });
    assert.match(await status(four), /NORMAL/);
    assert.match(fs.readFileSync(file, "utf8"), /^keymap = "vim"/m);
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

async function waitFor(ok: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
