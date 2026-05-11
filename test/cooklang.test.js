import test from "node:test";
import assert from "node:assert/strict";

import { parseCooklang } from "../src/cooklang.ts";

test("multi-section recipes default to sectioned ingredient summaries", () => {
  const parsed = parseCooklang(`
= Dough
Mix @flour{300%g} with @water{200%g}.

= Sauce
Stir @tomatoes{400%g} with @salt{1%tsp}.
  `);

  assert.equal(parsed.ingredient_summary.has_multiple_sections, true);
  assert.equal(parsed.ingredient_summary.mode_default, "sectioned");
  assert.equal(parsed.ingredient_summary.sections.length, 2);
  assert.deepEqual(
    parsed.ingredient_summary.sections.map((section) => section.name),
    ["Dough", "Sauce"],
  );
});

test("section ingredient order follows the source recipe order", () => {
  const parsed = parseCooklang(`
= Filling
Combine @apples{2} with @brown sugar{50%g} and @cinnamon{1%tsp}.
  `);

  assert.deepEqual(
    parsed.ingredient_summary.sections[0].ingredients.map((ingredient) => ingredient.name),
    ["brown sugar", "apples", "cinnamon"],
  );
});

test("repeated ingredients appear in every section where they are used", () => {
  const parsed = parseCooklang(`
= Marinade
Whisk @salt{1%tsp} with @oil{2%tbsp}.

= Roast
Season vegetables with @salt{1%tsp} and bake.
  `);

  assert.deepEqual(
    parsed.ingredient_summary.sections.map((section) =>
      section.ingredients.map((ingredient) => ingredient.name),
    ),
    [
      ["oil", "salt"],
      ["salt"],
    ],
  );
});

test("single-section recipes still expose a flat ingredient summary without a sectioned default", () => {
  const parsed = parseCooklang("Toast @bread{2%slices} with @butter{1%tbsp}.");

  assert.equal(parsed.ingredient_summary.has_multiple_sections, false);
  assert.equal(parsed.ingredient_summary.mode_default, "flat");
  assert.equal(parsed.ingredient_summary.sections.length, 1);
  assert.deepEqual(
    parsed.ingredient_summary.flat.map((ingredient) => ingredient.name),
    ["butter", "bread"],
  );
});

test("flat and sectioned summaries sort ingredients largest to smallest by amount", () => {
  const parsed = parseCooklang(`
= Batter
Whisk @milk{250%ml} with @flour{180%g}, @salt{2%tsp}, and @eggs{2}.

= Topping
Brush with @butter{30%g} and pour over @cream{120%ml}.
  `);

  assert.deepEqual(
    parsed.ingredient_summary.flat.map((ingredient) => ingredient.name),
    ["milk", "flour", "cream", "butter", "salt", "eggs"],
  );
  assert.deepEqual(
    parsed.ingredient_summary.sections[0].ingredients.map((ingredient) => ingredient.name),
    ["milk", "flour", "salt", "eggs"],
  );
  assert.deepEqual(
    parsed.ingredient_summary.sections[1].ingredients.map((ingredient) => ingredient.name),
    ["cream", "butter"],
  );
});

test("hidden and intermediate ingredients stay inline but are excluded from ingredient summaries", () => {
  const parsed = parseCooklang(`
Add some @-salt, @flour{200%g}, and @water.

Let the @&(~1)dough{} rest for ~{1%hour}.
  `);

  assert.deepEqual(
    parsed.ingredients.map((ingredient) => ingredient.name),
    ["salt", "flour", "water", "dough"],
  );
  assert.deepEqual(
    parsed.ingredient_summary.flat.map((ingredient) => ingredient.name),
    ["flour", "water"],
  );
  assert.deepEqual(
    parsed.ingredient_summary.sections[0].ingredients.map((ingredient) => ingredient.name),
    ["flour", "water"],
  );
});

test("optional and aliased ingredients preserve their display semantics in parsed output", () => {
  const parsed = parseCooklang("Add @?thyme and @white wine|wine{}.");

  assert.equal(parsed.ingredients[0].name, "thyme");
  assert.equal(parsed.ingredients[0].optional, true);
  assert.equal(parsed.ingredients[1].name, "wine");
  assert.equal(parsed.ingredients[1].optional, false);
});

test("explicit references are grouped in the flat summary total", () => {
  const parsed = parseCooklang("Add @flour{200%g}. Add more @&flour{300%g}.");

  assert.deepEqual(parsed.ingredient_summary.flat, [
    {
      name: "flour",
      quantity: 500,
      units: "g",
      optional: false,
      recipe_reference: false,
    },
  ]);
});

test("temperature text is emitted as an inline quantity token in steps", () => {
  const parsed = parseCooklang("Preheat the #oven{} to 180 ºC.");
  const step = parsed.steps[0];

  assert.deepEqual(step, [
    { type: "text", value: "Preheat the ", step_id: "section-0-step-1", step_number: 1, section_index: 0 },
    { type: "cookware", value: "oven", name: "oven", step_id: "section-0-step-1", step_number: 1, section_index: 0 },
    { type: "text", value: " to ", step_id: "section-0-step-1", step_number: 1, section_index: 0 },
    { type: "inlineQuantity", value: "180 ºC", quantity: 180, units: "°C", step_id: "section-0-step-1", step_number: 1, section_index: 0 },
    { type: "text", value: ".", step_id: "section-0-step-1", step_number: 1, section_index: 0 },
  ]);
});

test("note lines are preserved as comment steps instead of plain text steps", () => {
  const parsed = parseCooklang("> ~13% flour protein.");

  assert.deepEqual(parsed.steps, [
    [
      { type: "comment", value: "~13% flour protein." },
    ],
  ]);
});

test("step references expose the referenced step number for hover interactions", () => {
  const parsed = parseCooklang(`
Add @flour{200%g} and @water.

Mix until combined.

Let the @&(~1)dough{} rest.

Shape the @&(2)dough{}.
  `);

  assert.equal(parsed.steps[2][1].reference_target, "step");
  assert.equal(parsed.steps[2][1].reference_step_number, 2);
  assert.equal(parsed.steps[2][1].reference_step_id, "section-0-step-2");
  assert.equal(parsed.steps[2][1].step_number, 3);
  assert.equal(parsed.steps[2][1].step_id, "section-0-step-3");
  assert.equal(parsed.steps[3][1].reference_target, "step");
  assert.equal(parsed.steps[3][1].reference_step_number, 2);
  assert.equal(parsed.steps[3][1].reference_step_id, "section-0-step-2");
  assert.equal(parsed.steps[3][1].step_number, 4);
  assert.equal(parsed.steps[3][1].step_id, "section-0-step-4");
});

test("step references resolve through section content indexes when notes are present", () => {
  const parsed = parseCooklang(`
Mix @flour{200%g} and @water{}.

> Hydrate fully.

Combine @yeast{2%g} and @salt{5%g}.

Add the @&(2)wet mixture{} to the @&(1)dry mixture{}.
  `);

  assert.equal(parsed.steps[3][1].reference_target, "step");
  assert.equal(parsed.steps[3][1].reference_step_number, 2);
  assert.equal(parsed.steps[3][1].reference_step_id, "section-0-step-2");
  assert.equal(parsed.steps[3][3].reference_target, "step");
  assert.equal(parsed.steps[3][3].reference_step_number, 1);
  assert.equal(parsed.steps[3][3].reference_step_id, "section-0-step-1");
});
