// Unicode in a note: non-ASCII and astral text, CRLF and a byte order mark saved back byte for byte, and a front
// matter that still reads (its id, its seal) after a BOM. (The editor's own typing and Tab are the kit's tests:
// paperboat-ui test/editor/unicode.test.ts.)
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { join, patch, split } from "../server/frontmatter.ts";
import { Hub } from "../server/hub.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "malachite-uni-"));
process.env.PAPERBOAT_HOME = tmp();

const FRONT = "---\r\nid: n_1\r\ntitle: Ünïcode 😀\r\ntags: [α, 中文]\r\n---\r\n";
const BODY = "# Ünïcode 😀\r\n\r\nα β ∑ 中文 👩‍🔬 x̂\r\n\r\n```julia\r\nθ = \"é\"\r\n```\r\n";

test("front matter reads with CRLF and after a byte order mark", () => {
  for (const text of [FRONT + BODY, `﻿${FRONT}${BODY}`]) {
    const { props, body } = split(text);
    assert.deepEqual(props, { id: "n_1", title: "Ünïcode 😀", tags: ["α", "中文"] }, JSON.stringify(text.slice(0, 4)));
    assert.equal(body, BODY);
  }
  // a property set on such a note keeps the rest as written; the mark goes (UTF-8 needs none)
  assert.equal(patch(`﻿${FRONT}${BODY}`, { id: "n_1", title: "Ünïcode 😀", tags: ["α", "中文"], status: "draft" }),
    `---\nid: n_1\ntitle: Ünïcode 😀\ntags: [α, 中文]\nstatus: draft\n---\n${BODY}`);
  assert.equal(split(join({ title: "naïve 😀" }, BODY)).props.title, "naïve 😀");
});

test("a note saves back byte for byte: non-ASCII, astral, CRLF, BOM, a name that isn't ASCII", () => {
  const hub = new Hub(tmp());
  const text = `﻿${FRONT}${BODY}`;
  hub.write("notes/Thé 😀.md", text);
  assert.deepEqual(fs.readFileSync(hub.resolve("notes/Thé 😀.md")), Buffer.from(text, "utf8"));
  assert.equal(hub.read("notes/Thé 😀.md"), text);
});

test("a sealed note with a byte order mark is still sealed", () => {
  const hub = new Hub(tmp());
  fs.writeFileSync(hub.resolve("s.md"), `﻿---\nid: n_2\nsealed: 2026-11-27T00:00:00Z\n---\n# Scellé\n`);
  assert.throws(() => hub.write("s.md", "# changed\n"), /sealed/);
});
