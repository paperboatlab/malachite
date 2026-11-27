import assert from "node:assert/strict";
import { test } from "node:test";
import { stepSize } from "../client/noteSize.ts";

test("the note text steps through its sizes and stops at either end", () => {
  assert.equal(stepSize(1, 1), 1.1);
  assert.equal(stepSize(1, -1), 0.9);
  assert.equal(stepSize(1.6, 1), 1.6);
  assert.equal(stepSize(0.8, -1), 0.8);
  assert.equal(stepSize(1.05, 1), 1.1);   // a size it doesn't know steps from the usual one
});
