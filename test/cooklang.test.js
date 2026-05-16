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

test("hidden ingredients drop from both summaries; intermediate refs drop only from flat (kept in section)", () => {
  const parsed = parseCooklang(`
Add some @-salt, @flour{200%g}, and @water.

Let the @&(~1)dough{} rest for ~{1%hour}.
  `);

  assert.deepEqual(
    parsed.ingredients.map((ingredient) => ingredient.name),
    ["salt", "flour", "water", "dough"],
  );
  // Flat totals: hidden (`@-salt`) and intermediate (`@&(~1)dough{}`) are both
  // excluded — including the intermediate would double-count with its
  // upstream definition.
  assert.deepEqual(
    parsed.ingredient_summary.flat.map((ingredient) => ingredient.name),
    ["flour", "water"],
  );
  // Section view shows what each section consumes, so the intermediate ref
  // belongs here even though the dough was produced earlier. `@-salt` (hidden)
  // is still excluded.
  assert.deepEqual(
    parsed.ingredient_summary.sections[0].ingredients.map((ingredient) => ingredient.name),
    ["flour", "water", "dough"],
  );
});

test("cross-section intermediate refs (`@&(=1)...`) show in the consuming section but not in flat totals", () => {
  const parsed = parseCooklang(`
= Sakadane
Mix @flour{500%g} and @water{400%g} to make @sakadane{}.

= Final dough
Add @&(=1)sakadane{30%g} to @bread flour{300%g}.
  `);

  // Flat: shows only the upstream definitions, not the cross-section ref.
  assert.deepEqual(
    parsed.ingredient_summary.flat.map((ing) => ing.name).sort(),
    ["bread flour", "flour", "sakadane", "water"].sort(),
  );

  // Sakadane section: the original ingredients used to produce sakadane.
  const sakadaneSection = parsed.ingredient_summary.sections.find((s) => s.name === "Sakadane");
  assert.ok(sakadaneSection);
  assert.deepEqual(
    sakadaneSection.ingredients.map((ing) => ing.name).sort(),
    ["flour", "sakadane", "water"].sort(),
  );

  // Final dough section: must include the intermediate ref ("sakadane 30 g")
  // alongside the local bread flour.
  const finalSection = parsed.ingredient_summary.sections.find((s) => s.name === "Final dough");
  assert.ok(finalSection);
  const finalNames = finalSection.ingredients.map((ing) => ing.name);
  assert.ok(finalNames.includes("sakadane"), `expected sakadane in Final dough section, got ${JSON.stringify(finalNames)}`);
  assert.ok(finalNames.includes("bread flour"));
  const sakadaneRow = finalSection.ingredients.find((ing) => ing.name === "sakadane");
  assert.equal(sakadaneRow.quantity, 30, "section view should show the ref's local quantity");
  assert.equal(sakadaneRow.units, "g");
});

test("optional and aliased ingredients preserve their display semantics in parsed output", () => {
  const parsed = parseCooklang("Add @?thyme and @white wine|wine{}.");

  assert.equal(parsed.ingredients[0].name, "thyme");
  assert.equal(parsed.ingredients[0].optional, true);
  assert.equal(parsed.ingredients[1].name, "wine");
  assert.equal(parsed.ingredients[1].optional, false);
});

test("`@&` references still appear in each section's ingredient list", () => {
  // Regression: plain `@&` (the cooklang "reference" modifier, no parens) was
  // being wrongly classified as `intermediate` and filtered out of section
  // summaries. The flat summary still merges via the parser's groupedQuantity;
  // the section view should show the reference's *local* quantity.
  const parsed = parseCooklang(`
= Dough
Mix @flour{400%g} and @water{300%g}.

= Top
Sprinkle @&flour{100%g} before baking.
  `);

  assert.deepEqual(
    parsed.ingredient_summary.sections.map((section) =>
      section.ingredients.map((ing) => ({ name: ing.name, quantity: ing.quantity, units: ing.units })),
    ),
    [
      [
        { name: "flour", quantity: 400, units: "g" },
        { name: "water", quantity: 300, units: "g" },
      ],
      [
        { name: "flour", quantity: 100, units: "g" },
      ],
    ],
  );
  // And the flat (top-level) summary still rolls them up via cooklang's
  // existing grouping machinery.
  const flatFlour = parsed.ingredient_summary.flat.find((ing) => ing.name === "flour");
  assert.equal(flatFlour.quantity, 500);
  assert.equal(flatFlour.units, "g");
});

test("explicit references are grouped in the flat summary total", () => {
  const parsed = parseCooklang("Add @flour{200%g}. Add more @&flour{300%g}.");

  assert.deepEqual(parsed.ingredient_summary.flat, [
    {
      name: "flour",
      quantity: 500,
      units: "g",
      note: null,
      optional: false,
      recipe_reference: false,
      intermediate: false,
      reference_path: null,
    },
  ]);
});

test("ingredient notes are exposed on parsed ingredients and inline step tokens", () => {
  const parsed = parseCooklang("Place @potato{2}(peeled and finely chopped) into the #bowl{}(large).");

  assert.equal(parsed.ingredients[0].name, "potato");
  assert.equal(parsed.ingredients[0].note, "peeled and finely chopped");

  const step = parsed.steps[0];
  const ingredientToken = step.find((t) => t.type === "ingredient");
  assert.equal(ingredientToken.note, "peeled and finely chopped");
  const cookwareToken = step.find((t) => t.type === "cookware");
  assert.equal(cookwareToken.note, "large");
});

test("ingredients without a note carry a null note rather than missing the field", () => {
  const parsed = parseCooklang("Add @salt{1%tsp}.");
  assert.equal(parsed.ingredients[0].note, null);
});

test("backslash line continuations surface as newline characters in step text tokens", () => {
  // The cooklang parser strips the backslash and keeps the newline so the
  // renderer can convert it to a forced <br>. Implicit line breaks inside
  // a step (no trailing backslash) get folded to a space instead, so any
  // remaining newline indicates an intentional hard break.
  const parsed = parseCooklang(
    "Lay out the @rice paper{1}.\\\nTop with @avocado{1/2}(sliced),\\\n@cucumber{1/2}(julienned).",
  );

  assert.equal(parsed.steps.length, 1, "all lines should fold into a single step");
  const step = parsed.steps[0];
  const textValues = step.filter((t) => t.type === "text").map((t) => t.value);
  const breakCount = textValues.reduce(
    (total, value) => total + (value.match(/\n/g)?.length || 0),
    0,
  );
  assert.equal(
    breakCount,
    2,
    `expected two forced line breaks in text tokens, got ${JSON.stringify(textValues)}`,
  );
  assert.ok(
    !textValues.some((value) => value.includes("\\")),
    "the line-continuation backslash should be consumed by the parser",
  );
});

test("plain newlines inside a step are folded to spaces, not forced breaks", () => {
  const parsed = parseCooklang("Mix @flour{200%g}\nuntil smooth.");
  assert.equal(parsed.steps.length, 1);
  const step = parsed.steps[0];
  for (const token of step) {
    if (token.type !== "text") continue;
    assert.ok(
      !token.value.includes("\n"),
      `text token should not contain a newline, got ${JSON.stringify(token.value)}`,
    );
  }
});

test("range quantities round-trip as strings instead of collapsing to the start value", () => {
  const parsed = parseCooklang("Bake @bread{1-2} loaves with @flour{200-300%g}.");

  const bread = parsed.ingredients.find((ing) => ing.name === "bread");
  const flour = parsed.ingredients.find((ing) => ing.name === "flour");
  assert.equal(bread.quantity, "1-2");
  assert.equal(flour.quantity, "200-300");
  assert.equal(flour.units, "g");

  const step = parsed.steps[0];
  const flourToken = step.find((t) => t.type === "ingredient" && t.name === "flour");
  assert.equal(flourToken.quantity, "200-300");
});

test("optional ingredients carry the optional flag on inline step tokens too", () => {
  const parsed = parseCooklang("Add @?thyme and @flour{200%g}.");

  const step = parsed.steps[0];
  const thymeToken = step.find((t) => t.type === "ingredient" && t.name === "thyme");
  const flourToken = step.find((t) => t.type === "ingredient" && t.name === "flour");
  assert.equal(thymeToken.optional, true);
  assert.equal(flourToken.optional, false);
});

test("intermediate step references expose intermediate=true on the inline token", () => {
  const parsed = parseCooklang("Mix @flour{200%g}.\n\nLet the @&(~1)dough{} rest.");
  const refToken = parsed.steps[1].find((t) => t.type === "ingredient" && t.name === "dough");
  assert.equal(refToken.intermediate, true);
  assert.equal(refToken.reference_target, "step");
  assert.equal(refToken.reference_step_number, 1);
});

test("intermediate section references expose the source section name for rendering", () => {
  const parsed = parseCooklang("= Doughs\nMix @flour{200%g}.\n\n= Bake\nUse the @&(=~1)dough{}.");
  const bakeStep = parsed.steps.find((step) =>
    step.some((t) => t.type === "ingredient" && t.name === "dough"),
  );
  const refToken = bakeStep.find((t) => t.type === "ingredient" && t.name === "dough");
  assert.equal(refToken.intermediate, true);
  assert.equal(refToken.reference_target, "section");
  assert.equal(refToken.reference_section_name, "Doughs");
});

test("`>> metric.<name>: <expr> | <unit>` computes the value from ingredient totals", () => {
  const parsed = parseCooklang(`>> metric.hydration: water.g / flour.g * 100 | %

Mix @flour{500%g} and @water{350%g}.`);
  assert.equal(parsed.metrics.length, 1);
  assert.equal(parsed.metrics[0].name, "hydration");
  assert.equal(parsed.metrics[0].value, 70);
  assert.equal(parsed.metrics[0].format_unit, "%");
  assert.equal(parsed.metrics[0].display, "70%");
  assert.equal(parsed.metrics[0].error, null);
});

test("metrics work inside YAML front matter (the natural place for metadata)", () => {
  const parsed = parseCooklang(`---
title: Sourdough
metric.hydration: water.g / flour.g * 100 | %
---

Mix @flour{500%g} and @water{350%g}.`);
  assert.equal(parsed.metrics.length, 1);
  assert.equal(parsed.metrics[0].name, "hydration");
  assert.equal(parsed.metrics[0].value, 70);
  assert.equal(parsed.metrics[0].display, "70%");
});

test("metric keys are stripped from metadata so they don't leak as step text", () => {
  const parsed = parseCooklang(`>> metric.hydration: water.g / flour.g * 100 | %

Mix @flour{500%g} and @water{350%g}.`);
  assert.ok(!("metric.hydration" in parsed.metadata), "metric.* keys should be removed from metadata");
});

test("multi-word ingredient names are addressable as underscored identifiers", () => {
  const parsed = parseCooklang(`>> metric.ww share: whole_wheat_flour.g / (flour.g + whole_wheat_flour.g) * 100 | %

Mix @flour{400%g}, @whole wheat flour{100%g}, and @water{350%g}.`);
  assert.equal(parsed.metrics.length, 1);
  assert.equal(parsed.metrics[0].value, 20);
  assert.equal(parsed.metrics[0].display, "20%");
});

test("a metric with a typo'd ingredient surfaces an error, not a number", () => {
  const parsed = parseCooklang(`>> metric.hydration: whater.g / flour.g * 100 | %

Mix @flour{500%g} and @water{350%g}.`);
  assert.equal(parsed.metrics.length, 1);
  assert.equal(parsed.metrics[0].value, null);
  assert.equal(parsed.metrics[0].display, null);
  assert.match(parsed.metrics[0].error || "", /unknown reference 'whater\.g'/);
});

test("unit conversion (kg → g) works when an ingredient is declared in kg", () => {
  const parsed = parseCooklang(`>> metric.dough weight: flour.g + water.g | g

Mix @flour{0.5%kg} and @water{350%g}.`);
  assert.equal(parsed.metrics[0].value, 850);
  assert.equal(parsed.metrics[0].display, "850 g");
});

test("incompatible unit conversion (g → l) emits an error chip", () => {
  const parsed = parseCooklang(`>> metric.bad: flour.l

Mix @flour{500%g}.`);
  assert.equal(parsed.metrics[0].value, null);
  assert.match(parsed.metrics[0].error || "", /cannot convert g → l/);
});

test("recipes without servings metadata do not leak the literal string 'null'", () => {
  // Regression: `recipe.servings` from cooklang-rs is null (not undefined)
  // when absent; `String(null)` was leaking into `metadata.servings` and
  // rendering as "Serves null" in the UI.
  const parsedBare = parseCooklang("Mix @flour{500%g}.");
  assert.ok(!("servings" in parsedBare.metadata), `expected servings absent from metadata, got: ${parsedBare.metadata.servings}`);

  // A bare YAML front-matter key with no value (`servings:`) should also be
  // skipped rather than stored as "null".
  const parsedBareYaml = parseCooklang(`---
title: Test
servings:
---

Mix @flour{500%g}.`);
  assert.ok(parsedBareYaml.metadata.servings === undefined || parsedBareYaml.metadata.servings !== "null", `bare YAML servings should not leak as 'null', got: ${parsedBareYaml.metadata.servings}`);

  // Explicit value still flows through.
  const parsedWithServings = parseCooklang(`>> servings: 4\n\nMix @flour{500%g}.`);
  assert.equal(parsedWithServings.metadata.servings, "4");
});

test("metrics array is always present (empty for recipes without metric.* keys)", () => {
  const parsed = parseCooklang("Mix @flour{500%g}.");
  assert.ok(Array.isArray(parsed.metrics));
  assert.equal(parsed.metrics.length, 0);
});

test("later metrics can reference earlier ones via `metric.<name>`", () => {
  const parsed = parseCooklang(`>> metric.total_water: water.g + unstrained_sakadane.g / 2 | g
>> metric.total_flour: flour.g + whole_wheat_flour.g + unstrained_sakadane.g / 2 | g
>> metric.hydration: metric.total_water / metric.total_flour * 100 | %

Mix @flour{400%g}, @whole wheat flour{100%g}, @water{300%g}, and @unstrained sakadane{100%g}.`);

  const byName = Object.fromEntries(parsed.metrics.map((m) => [m.name, m]));
  // total_water = 300 + (100 / 2) = 350
  assert.equal(byName["total_water"].value, 350);
  assert.equal(byName["total_water"].display, "350 g");
  // total_flour = 400 + 100 + (100 / 2) = 550
  assert.equal(byName["total_flour"].value, 550);
  // hydration = 350 / 550 * 100 ≈ 63.6
  assert.ok(Math.abs(byName["hydration"].value - (350 / 550 * 100)) < 0.0001, `unexpected hydration value: ${byName["hydration"].value}`);
});

test("forward references to a not-yet-defined metric error with a helpful message", () => {
  const parsed = parseCooklang(`>> metric.hydration: metric.total_water / metric.total_flour | %
>> metric.total_water: water.g | g
>> metric.total_flour: flour.g | g

Mix @flour{500%g} and @water{350%g}.`);
  const hydration = parsed.metrics.find((m) => m.name === "hydration");
  assert.ok(hydration);
  assert.equal(hydration.value, null);
  assert.match(hydration.error || "", /referenced before it's defined/);
});

test("reference to a metric that doesn't exist errors with a distinct message", () => {
  const parsed = parseCooklang(`>> metric.foo: metric.nope + 1 | g

Mix @flour{500%g}.`);
  const foo = parsed.metrics.find((m) => m.name === "foo");
  assert.match(foo.error || "", /unknown metric 'nope'/);
});

test("`| hidden` flag keeps a metric out of the chip strip but still usable from later metrics", () => {
  const parsed = parseCooklang(`>> metric.total_water: water.g | g | hidden
>> metric.total_flour: flour.g | g | hidden
>> metric.hydration: metric.total_water / metric.total_flour * 100 | %

Mix @flour{500%g} and @water{350%g}.`);
  const totalWater = parsed.metrics.find((m) => m.name === "total_water");
  const hydration = parsed.metrics.find((m) => m.name === "hydration");
  assert.equal(totalWater.hidden, true, "total_water should be flagged hidden");
  assert.equal(totalWater.value, 350, "hidden metrics still compute");
  assert.equal(hydration.hidden, false);
  assert.equal(hydration.value, 70, "later metric can read the hidden value");
});

test("`hidden` flag order doesn't matter (can appear before or after the format unit)", () => {
  const parsed = parseCooklang(`>> metric.a: 1 + 1 | hidden | g
>> metric.b: 1 + 1 | g | hidden

Mix @flour{500%g}.`);
  assert.equal(parsed.metrics.find((m) => m.name === "a").hidden, true);
  assert.equal(parsed.metrics.find((m) => m.name === "a").format_unit, "g");
  assert.equal(parsed.metrics.find((m) => m.name === "b").hidden, true);
  assert.equal(parsed.metrics.find((m) => m.name === "b").format_unit, "g");
});

test("temperature text is emitted as an inline quantity token in steps", () => {
  const parsed = parseCooklang("Preheat the #oven{} to 180 ºC.");
  const step = parsed.steps[0];

  assert.deepEqual(step, [
    { type: "text", value: "Preheat the ", step_id: "section-0-step-1", step_number: 1, section_index: 0 },
    { type: "cookware", value: "oven", name: "oven", note: null, step_id: "section-0-step-1", step_number: 1, section_index: 0 },
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

// ── Ranges (recipe specs) ─────────────────────────────────────────────────────

test("ingredient ranges surface as structured {min, max} alongside the display string", () => {
  const parsed = parseCooklang(`Add @water{20-30%g}.`);
  const water = parsed.ingredients[0];
  assert.equal(water.name, "water");
  assert.equal(water.units, "g");
  assert.deepEqual(water.range, { min: 20, max: 30 });
  assert.equal(String(water.quantity).replace(/\s/g, ""), "20-30");
});

test("scalar ingredients have range: null (regression)", () => {
  const parsed = parseCooklang(`Add @flour{500%g}.`);
  const flour = parsed.ingredients[0];
  assert.equal(flour.quantity, 500);
  assert.equal(flour.units, "g");
  assert.equal(flour.range, null);
});

test("timer ranges keep both endpoints instead of truncating to start", () => {
  const parsed = parseCooklang(`Rest ~rest{20-30%min}.`);
  const timer = parsed.steps[0].find((t) => t.type === "timer");
  assert.ok(timer, "expected a timer token");
  assert.equal(timer.units, "min");
  assert.deepEqual(timer.range, { min: 20, max: 30 });
  // quantity should NOT be the truncated start; it should reflect the range.
  assert.notEqual(timer.quantity, 20);
});

test("inline %{...} ranges are recognized", () => {
  const parsed = parseCooklang(`Heat to %{180-200%C}.`);
  const inline = parsed.steps[0].find((t) => t.type === "inlineQuantity");
  assert.ok(inline, "expected an inlineQuantity token");
  assert.deepEqual(inline.range, { min: 180, max: 200 });
  assert.equal(inline.units, "C");
  assert.notEqual(inline.kind, "temperature"); // %{...} is generic, not tagged
});

// ── ^{...} sigil (temperature/measurement spec) ───────────────────────────────

test("^{X%Y} parses as an inline quantity tagged with kind: temperature", () => {
  const parsed = parseCooklang(`Heat to ^{200%C}.`);
  const inline = parsed.steps[0].find((t) => t.type === "inlineQuantity");
  assert.ok(inline, "expected an inlineQuantity token");
  assert.equal(inline.quantity, 200);
  assert.equal(inline.units, "C");
  assert.equal(inline.kind, "temperature");
  assert.equal(inline.range, null);
});

test("^{X-Y%C} parses as a range with kind: temperature", () => {
  const parsed = parseCooklang(`Rest at ^{20-22%C}.`);
  const inline = parsed.steps[0].find((t) => t.type === "inlineQuantity");
  assert.ok(inline, "expected an inlineQuantity token");
  assert.deepEqual(inline.range, { min: 20, max: 22 });
  assert.equal(inline.units, "C");
  assert.equal(inline.kind, "temperature");
});

test("^{...} accepts natural temperature notation (°F, °C) without explicit %", () => {
  const parsed = parseCooklang(`Preheat to ^{550°F}.`);
  const inline = parsed.steps[0].find((t) => t.type === "inlineQuantity");
  assert.ok(inline, "expected an inlineQuantity token");
  assert.equal(inline.quantity, 550);
  assert.equal(inline.units, "°F");
  assert.equal(inline.kind, "temperature");
});

test("^{...} accepts natural range notation (20-22°C)", () => {
  const parsed = parseCooklang(`Hold at ^{20-22°C}.`);
  const inline = parsed.steps[0].find((t) => t.type === "inlineQuantity");
  assert.ok(inline, "expected an inlineQuantity token");
  assert.deepEqual(inline.range, { min: 20, max: 22 });
  assert.equal(inline.units, "°C");
  assert.equal(inline.kind, "temperature");
});

test("^{540-550%F} renders as 540-550°F (display normalizes the % separator)", () => {
  const parsed = parseCooklang(`Preheat to ^{540-550%F}.`);
  const inline = parsed.steps[0].find((t) => t.type === "inlineQuantity");
  assert.ok(inline, "expected an inlineQuantity token");
  assert.equal(inline.value, "540-550°F");
  assert.equal(inline.kind, "temperature");
  assert.deepEqual(inline.range, { min: 540, max: 550 });
});

test("^{...} and %{...} can coexist; only ^ is tagged temperature", () => {
  const parsed = parseCooklang(`Bring to %{100%C} then cool to ^{40%C}.`);
  const inlines = parsed.steps[0].filter((t) => t.type === "inlineQuantity");
  assert.equal(inlines.length, 2);
  assert.notEqual(inlines[0].kind, "temperature");
  assert.equal(inlines[1].kind, "temperature");
});

test("editable tokens flag ^{...} matches with measurementKind: temperature", () => {
  const parsed = parseCooklang(`Hold at ^{20-22%C} and use %{5%g}.`);
  const tempToken = parsed.editable_tokens.find((t) => t.measurementKind === "temperature");
  const plainToken = parsed.editable_tokens.find((t) => t.kind === "inlineQuantity" && t.measurementKind !== "temperature");
  assert.ok(tempToken, "expected a temperature-tagged editable token");
  assert.deepEqual(tempToken.range, { min: 20, max: 22 });
  assert.equal(tempToken.units, "C");
  assert.ok(plainToken, "expected a plain inline-quantity editable token");
  assert.equal(plainToken.range, null);
});

// ── Prose temperature ranges ──────────────────────────────────────────────────

test("prose temperature ranges are extracted with structured range", () => {
  const parsed = parseCooklang(`Heat to 20-22°C and rest.`);
  const inline = parsed.steps[0].find((t) => t.type === "inlineQuantity");
  assert.ok(inline, "expected an inlineQuantity token from prose");
  assert.deepEqual(inline.range, { min: 20, max: 22 });
  assert.equal(inline.units, "°C");
  assert.equal(inline.kind, "temperature");
});

test("prose scalar temperatures still parse (regression)", () => {
  const parsed = parseCooklang(`Heat to 200°C.`);
  const inline = parsed.steps[0].find((t) => t.type === "inlineQuantity");
  assert.ok(inline);
  assert.equal(inline.quantity, 200);
  assert.equal(inline.units, "°C");
  assert.equal(inline.range, null);
  assert.equal(inline.kind, "temperature");
});
