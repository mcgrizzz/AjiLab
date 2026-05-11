import test from "node:test";
import assert from "node:assert/strict";

import { diffIngredients } from "../src/ingredient-compare.js";

test("diffIngredients returns percent change for numeric same-unit edits", () => {
  const result = diffIngredients(
    [{ name: "Flour", quantity: 20, units: "g" }],
    [{ name: "Flour", quantity: 15, units: "g" }]
  );

  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].from_display, "20 g");
  assert.equal(result.changed[0].to_display, "15 g");
  assert.equal(result.changed[0].percent_change, -25);
});

test("diffIngredients omits percent change when units differ", () => {
  const result = diffIngredients(
    [{ name: "Salt", quantity: 1, units: "tsp" }],
    [{ name: "Salt", quantity: 5, units: "g" }]
  );

  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].percent_change, null);
});

test("diffIngredients emits added and removed rows with zero fallback display", () => {
  const result = diffIngredients(
    [{ name: "Salt", quantity: 1, units: "g" }],
    [{ name: "Baking soda", quantity: 2, units: "g" }]
  );

  assert.equal(result.removed.length, 1);
  assert.equal(result.removed[0].from_display, "1 g");
  assert.equal(result.removed[0].to_display, "0 g");

  assert.equal(result.added.length, 1);
  assert.equal(result.added[0].from_display, "0 g");
  assert.equal(result.added[0].to_display, "2 g");
});

test("diffIngredients matches duplicate ingredient names by occurrence order", () => {
  const result = diffIngredients(
    [
      { name: "Salt", quantity: 1, units: "g" },
      { name: "Salt", quantity: 5, units: "g" },
    ],
    [
      { name: "Salt", quantity: 1, units: "g" },
      { name: "Salt", quantity: 6, units: "g" },
    ]
  );

  assert.equal(result.changed.length, 1);
  assert.equal(result.changed[0].from_quantity, 5);
  assert.equal(result.changed[0].to_quantity, 6);
  assert.equal(result.changed[0].percent_change, 20);
});

test("diffIngredients ignores amountless placeholder additions and removals", () => {
  const result = diffIngredients(
    [{ name: "dry mixture", quantity: "", units: "" }],
    [{ name: "boil salt", quantity: "", units: "" }]
  );

  assert.equal(result.changed.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.added.length, 0);
});

test("diffIngredients ignores intermediate ingredients", () => {
  const result = diffIngredients(
    [{ name: "preferment", quantity: 100, units: "g", intermediate: true }],
    [{ name: "preferment", quantity: 120, units: "g", intermediate: true }]
  );

  assert.equal(result.changed.length, 0);
  assert.equal(result.removed.length, 0);
  assert.equal(result.added.length, 0);
});
