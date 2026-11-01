import test from "node:test";
import assert from "node:assert/strict";
import { lineEdits, mergeCooklangText } from "../src/store/merge.ts";

const base = ["a", "b", "c", "d", "e"].join("\n");
const edit = (pairs) => base.split("\n").map((line) => pairs[line] ?? line).join("\n");

test("separate runs of changed lines are separate edits", () => {
  assert.deepEqual(lineEdits(base, edit({ b: "B", d: "D" })), [
    { baseStart: 1, baseEnd: 2, replacement: ["B"] },
    { baseStart: 3, baseEnd: 4, replacement: ["D"] },
  ]);
  assert.deepEqual(lineEdits(base, base), []);
  assert.deepEqual(lineEdits("a\nc", "a\nb\nc"), [{ baseStart: 1, baseEnd: 1, replacement: ["b"] }]);
});

test("changes to different lines merge cleanly, even with one between", () => {
  const result = mergeCooklangText(base, edit({ b: "B" }), edit({ d: "D" }));
  assert.equal(result.status, "clean");
  assert.equal(result.merged_text, edit({ b: "B", d: "D" }));
  // Neighbouring lines too.
  assert.equal(mergeCooklangText(base, edit({ b: "B" }), edit({ c: "C" })).merged_text, edit({ b: "B", c: "C" }));
});

test("different changes to the same line conflict", () => {
  const result = mergeCooklangText(base, edit({ c: "C1" }), edit({ c: "C2" }));
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts, [{ base_start: 2, base_end: 3, ours: "C1", theirs: "C2" }]);
});

test("the same change on both sides is applied once", () => {
  const result = mergeCooklangText(base, edit({ b: "B", d: "D" }), edit({ b: "B" }));
  assert.equal(result.status, "clean");
  assert.equal(result.merged_text, edit({ b: "B", d: "D" }));
});
