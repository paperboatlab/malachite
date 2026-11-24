import assert from "node:assert/strict";
import { test } from "node:test";
import { cellHash, join, parse, split } from "../server/note.ts";

test("front matter round-trips: scalars, lists, quotes", () => {
  const props = { id: "n_1", title: "Step: 5 cm", tags: ["tank", "step"], author: "cyyth" };
  const text = join(props, "\n# Body\n");
  assert.equal(text.split("\n")[2], 'title: "Step: 5 cm"');
  assert.deepEqual(split(text), { props, body: "\n# Body\n" });
});

test("a note without front matter is all body", () => {
  assert.deepEqual(split("# Just text\n"), { props: {}, body: "# Just text\n" });
});

test("title, tags, links and cells; code is not scanned for links or tags", () => {
  const n = parse(`---
tags: [tank]
---
# Step response

See [[protocol-level-sensor]] and ![[level-loop.pst]], [[pump-check|the pump]] and [[a#section]].
Inline \`[[not-a-link]]\` and #step but not # heading or #12.

\`\`\`julia
x = 1  # [[nope]] #nope
\`\`\`

\`\`\`py
print(2)
\`\`\`

\`\`\`text
plain
\`\`\`
`, "step-response");
  assert.equal(n.title, "Step response");
  assert.deepEqual(n.links, ["protocol-level-sensor", "level-loop.pst", "pump-check", "a"]);
  assert.deepEqual(n.tags.sort(), ["step", "tank"]);
  assert.deepEqual(n.cells.map((c) => [c.lang, c.code]), [["julia", "x = 1  # [[nope]] #nope"], ["python", "print(2)"]]);
  assert.equal(n.cells[0].hash, cellHash("julia", "x = 1  # [[nope]] #nope"));
});

test("a cell's hash changes with its code and its language", () => {
  assert.notEqual(cellHash("julia", "1"), cellHash("julia", "2"));
  assert.notEqual(cellHash("julia", "1"), cellHash("python", "1"));
});

test("the file name is the title of last resort", () => {
  assert.equal(parse("no heading", "my-note").title, "my-note");
});

test("a cell closes at a bare fence, not at the next opening one; empty cells count", () => {
  const n = parse("```julia\n```\n```python\nx = 1\n```\n");
  assert.deepEqual(n.cells.map((c) => [c.lang, c.code, c.line]), [["julia", "", 0], ["python", "x = 1", 2]]);
});
