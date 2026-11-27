// The callout kinds (client/callouts.ts): aliases, any case, and a note for a kind it doesn't know.
import assert from "node:assert/strict";
import { test } from "node:test";
import { CALLOUT_KINDS, calloutKind } from "../client/callouts.ts";

test("a callout's type names its kind, an alias too, in any case; an unknown one is a note", () => {
  assert.deepEqual(calloutKind("tip"), { kind: "tip", icon: "lightbulb", role: "accent" });
  assert.equal(calloutKind("HINT").kind, "tip");
  assert.equal(calloutKind("error").kind, "danger");
  assert.equal(calloutKind("fail").role, "danger");
  assert.equal(calloutKind("caution").role, "ink");   // a warning stays in ink: red is only for harm and failure
  assert.equal(calloutKind("whatever").kind, "note");
  const names = CALLOUT_KINDS.flatMap((k) => [k.kind, ...k.aliases]);
  assert.equal(new Set(names).size, names.length, "no alias names two kinds");
});
