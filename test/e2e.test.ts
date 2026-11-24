// End to end against the real paperboatd and a real Python runtime (podman, or native). Skipped where
// there is no daemon to start: set PAPERBOATD, or have paperboatd on PATH.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Control } from "../server/control.ts";
import { parse } from "../server/note.ts";
import { Sessions } from "../server/sessions.ts";
import { Hub } from "../server/hub.ts";

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
