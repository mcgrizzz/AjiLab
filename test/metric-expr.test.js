import test from "node:test";
import assert from "node:assert/strict";

import { evaluateExpression } from "../src/metric-expr.ts";

// Helper that builds a simple context: a map keyed by joined-path (e.g.
// `water.g` or `metric.total_water`) returning a number, or a string to
// surface a host-side error.
function makeCtx(entries) {
  return {
    lookup(path) {
      const key = path.map((s) => s.toLowerCase()).join(".");
      if (key in entries) return entries[key];
      return null;
    },
  };
}

test("arithmetic precedence: * and / bind tighter than + and -", () => {
  const r = evaluateExpression("1 + 2 * 3", makeCtx({}));
  assert.deepEqual(r, { ok: true, value: 7 });
});

test("parentheses override precedence", () => {
  const r = evaluateExpression("(1 + 2) * 3", makeCtx({}));
  assert.deepEqual(r, { ok: true, value: 9 });
});

test("variable lookup with unit suffix", () => {
  const ctx = makeCtx({ "water.g": 350, "flour.g": 500 });
  const r = evaluateExpression("water.g / flour.g * 100", ctx);
  assert.equal(r.ok, true);
  assert.equal(r.value, 70);
});

test("multi-word ingredient names use underscores in formulas", () => {
  const ctx = makeCtx({ "whole_wheat_flour.g": 100, "flour.g": 400 });
  const r = evaluateExpression("whole_wheat_flour.g / (whole_wheat_flour.g + flour.g) * 100", ctx);
  assert.equal(r.ok, true);
  assert.equal(r.value, 20);
});

test("bare variable (no path segment) is a one-segment path", () => {
  const ctx = makeCtx({ "salt": 10 });
  const r = evaluateExpression("salt * 2", ctx);
  assert.deepEqual(r, { ok: true, value: 20 });
});

test("multi-segment paths surface to the host (e.g. metric.<name>)", () => {
  const ctx = makeCtx({ "metric.total_water": 350, "metric.total_flour": 500 });
  const r = evaluateExpression("metric.total_water / metric.total_flour * 100", ctx);
  assert.equal(r.ok, true);
  assert.equal(r.value, 70);
});

test("unary minus is supported as a factor prefix", () => {
  const r = evaluateExpression("-3 + 5", makeCtx({}));
  assert.deepEqual(r, { ok: true, value: 2 });
});

test("unknown reference surfaces as a typed error, not a number", () => {
  const ctx = makeCtx({ "flour.g": 500 });
  const r = evaluateExpression("whater.g / flour.g", ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown reference 'whater.g'/);
});

test("context can surface its own error (e.g. unit conversion failure)", () => {
  const ctx = {
    lookup() { return "cannot convert g → l"; },
  };
  const r = evaluateExpression("flour.l", ctx);
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot convert g/);
});

test("divide-by-zero is an explicit error, not Infinity", () => {
  const r = evaluateExpression("1 / 0", makeCtx({}));
  assert.equal(r.ok, false);
  assert.match(r.error, /divide by zero/);
});

test("unbalanced parens produce a syntax error", () => {
  const r = evaluateExpression("(1 + 2", makeCtx({}));
  assert.equal(r.ok, false);
  assert.match(r.error, /syntax error/);
});

test("trailing garbage after a valid expression is rejected", () => {
  const r = evaluateExpression("1 + 2 garbage", makeCtx({}));
  assert.equal(r.ok, false);
  assert.match(r.error, /unexpected character|unexpected token/);
});

test("'.' with no following identifier is rejected", () => {
  const r = evaluateExpression("water. + 1", makeCtx({ "water": 1 }));
  assert.equal(r.ok, false);
  assert.match(r.error, /missing identifier/);
});

test("identifiers with underscores tokenize as a single var", () => {
  const ctx = makeCtx({ "tipo_zero_flour.g": 300 });
  const r = evaluateExpression("tipo_zero_flour.g + 0", ctx);
  assert.deepEqual(r, { ok: true, value: 300 });
});
