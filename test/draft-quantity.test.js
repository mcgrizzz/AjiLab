import test from "node:test";
import assert from "node:assert/strict";

import {
  formatEditableQuantity,
  rewriteDraftQuantity,
} from "../src/draft-quantity.js";

test("rewriteDraftQuantity rewrites only the selected token", () => {
  const text = "@salt{1%g} and @water{2%cup}";
  const token = { rangeStart: 6, rangeEnd: 7 };
  const nextText = rewriteDraftQuantity(text, token, 1.05);

  assert.equal(nextText, "@salt{1.05%g} and @water{2%cup}");
});

test("rewriteDraftQuantity works for timers and preserves surrounding syntax", () => {
  const text = "Bake for ~{25%minutes}.";
  const token = { rangeStart: 11, rangeEnd: 13 };
  const nextText = rewriteDraftQuantity(text, token, 30);

  assert.equal(nextText, "Bake for ~{30%minutes}.");
});

test("formatEditableQuantity rounds to two decimals and trims trailing zeroes", () => {
  assert.equal(formatEditableQuantity(1.234), "1.23");
  assert.equal(formatEditableQuantity(1.2), "1.2");
  assert.equal(formatEditableQuantity(2), "2");
});
