import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInlineDiffLines,
  diffStepBlocks,
  classifyIngredientRow,
  classifyCookLogSteps,
  classifyCookLogVsSource,
  synthesizePromotedRecipe,
  tokenChangeId,
} from "../src/compare.ts";
import { diffIngredients } from "../src/ingredient-compare.js";
import { parseCooklang, resolveDeviationMarkers } from "../src/cooklang.ts";

// Mirror the /classify route + client selection-building: classify the resolved
// log against source, then collect the change IDs exactly as the cherry-pick UI
// would for "select all".
function selectAllChangeIds(src, log) {
  const classes = classifyCookLogSteps(
    parseCooklang(resolveDeviationMarkers(log)).steps,
    parseCooklang(src).steps,
  );
  const selections = new Set();
  for (const c of classes) {
    if (c.kind === "added") selections.add(`step-add:${c.section_index}:${c.step_number}`);
    else if (c.kind === "removed") selections.add(`step-remove:${c.section_index}:${c.step_number}`);
    else if (c.kind === "modified") for (const d of c.token_diffs) selections.add(tokenChangeId(c, d));
  }
  return selections;
}

const before = `Cover and ferment at 28°C-30°C for ~{2%hours}, until roughly tripled and bubbly.

= Autolyse

Mix @flour{316%g}, @whole wheat flour{40%g}, and @water{258%g} in a #bowl{} until combined.

Cover and rest for ~{2%hours}.

= Cold Proof

Cover and refrigerate for ~{18-24%hours}.

= Bake

Bake covered or with steam for ~{20%min}.

Then bake uncovered at 450°F for ~{25%min}.

Cool for at least ~{1%hour} before slicing.
`;
const after = `Cover and ferment at 26.5°C for ~{2%hours}, until roughly tripled and bubbly.

= Autolyse

Mix @flour{316%g}, @whole wheat flour{40%g}, and @water{266%g} in a #bowl{} until combined.

Cover and rest for ~{2%hours}.

= Cold Proof

Cover and refrigerate for ~{20%hours}.

= Bake

Bake covered or with steam for ~{20%min}.

Then bake uncovered at 450°F for ~{12.5%min}.

Cool for at least ~{1%hour} before slicing.
`;

test("inline diff pairs lines and keeps shared text as context tokens", async () => {
  const Diff = await import("diff");
  const patch = Diff.createTwoFilesPatch("v1.0", "v1.1", before, after, "", "", { context: 3 });
  const lines = buildInlineDiffLines(patch);
  // The first paired (removed, added) in this patch is the ferment-temp line.
  const removedIdx = lines.findIndex((l) => l.kind === "removed");
  assert.ok(removedIdx >= 0);
  const removed = lines[removedIdx];
  const added = lines[removedIdx + 1];
  assert.equal(added?.kind, "added", "paired added line should follow the removed line");
  // The shared opening phrase shows up as context tokens on BOTH sides.
  const removedCtx = removed.tokens.filter((t) => t.op === "context").map((t) => t.text).join("");
  const addedCtx = added.tokens.filter((t) => t.op === "context").map((t) => t.text).join("");
  assert.ok(removedCtx.includes("Cover and ferment at "), `expected shared prefix as context, got: ${JSON.stringify(removedCtx)}`);
  assert.ok(removedCtx.includes("tripled and bubbly"), "expected shared suffix as context");
  assert.equal(removedCtx, addedCtx, "context tokens must match on both sides of the pair");
  // The changed substring lives on the appropriate side. The word-differ may
  // split `28°C-30°C` into smaller pieces (e.g. "28" removed, "°C" context,
  // "-30°C" removed) — that's fine, it's even more precise highlighting.
  const removedText = removed.tokens.filter((t) => t.op === "removed").map((t) => t.text).join(" ");
  assert.ok(/28/.test(removedText) && /30/.test(removedText), `expected '28' and '30' inside removed tokens, got: ${JSON.stringify(removed.tokens)}`);
  const addedText = added.tokens.filter((t) => t.op === "added").map((t) => t.text).join(" ");
  assert.ok(/26\.5/.test(addedText), `expected '26.5' inside added tokens, got: ${JSON.stringify(added.tokens)}`);
});

test("step-block diff coalesces a swap into a single replace with surrounding context", () => {
  const changes = diffStepBlocks(before, after);
  const coldProof = changes.find((c) => c.kind === "modified" && c.section_name === "Cold Proof");
  assert.ok(coldProof, `expected a modified step in Cold Proof, got: ${JSON.stringify(changes.map((c) => ({ kind: c.kind, section: c.section_name, step: c.step_number })))}`);
  const tokens = coldProof.inline_tokens || [];
  // Exactly one replace item carrying the whole swap.
  const replaces = tokens.filter((t) => t.op === "replace");
  assert.equal(replaces.length, 1, `expected one replace token, got: ${JSON.stringify(tokens)}`);
  assert.ok(/18-24/.test(replaces[0].removed), `expected '18-24' in replace.removed, got: ${replaces[0].removed}`);
  assert.ok(/20/.test(replaces[0].added), `expected '20' in replace.added, got: ${replaces[0].added}`);
  // Shared sentence is preserved as context tokens.
  const ctx = tokens.filter((t) => t.op === "context").map((t) => t.text).join("");
  assert.ok(ctx.includes("Cover and refrigerate for"), `expected shared prefix as context, got: ${ctx}`);
});

test("temperature-range to single-value swap merges the °C bridge into one replace", () => {
  // The diff library finds `°C` is common between `28°C-30°C` and `26.5°C`,
  // which used to produce a confusing [28][26.5][°C][-30°C] stream. The
  // coalescer folds the `°C` bridge back into the single change region so the
  // result reads as `28°C-30°C → 26.5°C` plus untouched surrounding context.
  const changes = diffStepBlocks(
    "Cover and ferment at 28°C-30°C for 2 hours.",
    "Cover and ferment at 26.5°C for 2 hours.",
  );
  const c = changes.find((x) => x.kind === "modified");
  assert.ok(c);
  const replaces = c.inline_tokens.filter((t) => t.op === "replace");
  assert.equal(replaces.length, 1, `expected exactly one replace, got: ${JSON.stringify(c.inline_tokens)}`);
  assert.equal(replaces[0].removed, "28°C-30°C");
  assert.equal(replaces[0].added, "26.5°C");
});

test("pure addition inside a step emits a replace with empty removed side", () => {
  const changes = diffStepBlocks(
    "Mix flour.",
    "Mix flour and salt.",
  );
  const c = changes.find((x) => x.kind === "modified");
  assert.ok(c);
  const replaces = c.inline_tokens.filter((t) => t.op === "replace");
  assert.ok(replaces.length >= 1);
  assert.ok(replaces.some((r) => r.removed === "" && /salt/.test(r.added)), `expected an empty-removed replace, got: ${JSON.stringify(replaces)}`);
});

test("unpaired removal stays solid-red (no spurious word diff)", async () => {
  const Diff = await import("diff");
  const a = "step one.\nstep two.\nstep three.\n";
  const b = "step one.\nstep three.\n";
  const patch = Diff.createTwoFilesPatch("a", "b", a, b, "", "", { context: 3 });
  const lines = buildInlineDiffLines(patch);
  const removed = lines.find((l) => l.kind === "removed");
  assert.ok(removed);
  // Solo removal: single removed token, no context tokens.
  assert.equal(removed.tokens.length, 1);
  assert.equal(removed.tokens[0].op, "removed");
});

// ── Ingredient classification (cook log vs source) ────────────────────────────

test("ingredient classifier: scalar inside source range → within-spec", () => {
  // Source: 500-525g flour, log: 510g flour.
  const src = parseCooklang("Mix @flour{500-525%g}.");
  const log = parseCooklang("Mix @flour{510%g}.");
  const diff = diffIngredients(src.ingredient_summary.flat, log.ingredient_summary.flat);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].classification, "within-spec");
});

test("ingredient classifier: scalar outside source range → deviation", () => {
  const src = parseCooklang("Mix @flour{500-525%g}.");
  const log = parseCooklang("Mix @flour{540%g}.");
  const diff = diffIngredients(src.ingredient_summary.flat, log.ingredient_summary.flat);
  assert.equal(diff.changed[0].classification, "deviation");
});

test("ingredient classifier: source had no range → deviation when value changes", () => {
  const src = parseCooklang("Mix @flour{500%g}.");
  const log = parseCooklang("Mix @flour{525%g}.");
  const diff = diffIngredients(src.ingredient_summary.flat, log.ingredient_summary.flat);
  assert.equal(diff.changed[0].classification, "deviation");
});

test("ingredient classifier: added → addition", () => {
  const src = parseCooklang("Mix @flour{500%g}.");
  const log = parseCooklang("Mix @flour{500%g} and @salt{2%g}.");
  const diff = diffIngredients(src.ingredient_summary.flat, log.ingredient_summary.flat);
  assert.equal(diff.added.length, 1);
  assert.equal(diff.added[0].classification, "addition");
});

test("ingredient classifier: removed → removal", () => {
  const src = parseCooklang("Mix @flour{500%g} and @salt{2%g}.");
  const log = parseCooklang("Mix @flour{500%g}.");
  const diff = diffIngredients(src.ingredient_summary.flat, log.ingredient_summary.flat);
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].classification, "removal");
});

test("ingredient classifier: classifyIngredientRow handles unit mismatch as deviation", () => {
  const fromIng = { name: "flour", quantity: 500, units: "g", range: { min: 500, max: 525 } };
  const row = {
    status: "changed",
    from_quantity: 500, from_units: "g",
    to_quantity: 510, to_units: "ml",  // wrong unit
  };
  assert.equal(classifyIngredientRow(row, fromIng), "deviation");
});

// ── Step classification (cook log vs source) ──────────────────────────────────

test("step classifier: !+ added log step → addition", () => {
  const src = parseCooklang("Mix @flour{500%g}.");
  const log = parseCooklang("Mix @flour{500%g}.\n\n!+ Added a rest step.");
  const classes = classifyCookLogSteps(log.steps, src.steps);
  const added = classes.find((c) => c.kind === "added");
  assert.ok(added, "expected an added classification");
  assert.equal(added.classification, "addition");
});

test("step classifier: !- skipped log step → removal", () => {
  const src = parseCooklang("Mix @flour{500%g}.\n\nKnead briefly.");
  const log = parseCooklang("Mix @flour{500%g}.\n\n!- Knead briefly.");
  const classes = classifyCookLogSteps(log.steps, src.steps);
  const removed = classes.find((c) => c.kind === "removed");
  assert.ok(removed);
  assert.equal(removed.classification, "removal");
});

test("step classifier: ingredient scalar in source range → within-spec", () => {
  const src = parseCooklang("Mix @flour{500-525%g}.");
  const log = parseCooklang("Mix @flour{510%g}.");
  const classes = classifyCookLogSteps(log.steps, src.steps);
  const mod = classes.find((c) => c.kind === "modified");
  assert.ok(mod);
  assert.equal(mod.classification, "within-spec");
  assert.equal(mod.token_diffs[0].classification, "within-spec");
});

test("step classifier: ingredient scalar outside source range → deviation", () => {
  const src = parseCooklang("Mix @flour{500-525%g}.");
  const log = parseCooklang("Mix @flour{540%g}.");
  const classes = classifyCookLogSteps(log.steps, src.steps);
  const mod = classes.find((c) => c.kind === "modified");
  assert.equal(mod.classification, "deviation");
});

test("step classifier: temperature scalar in source range → within-spec", () => {
  const src = parseCooklang("Hold at ^{20-22%C}.");
  const log = parseCooklang("Hold at ^{21%C}.");
  const classes = classifyCookLogSteps(log.steps, src.steps);
  const mod = classes.find((c) => c.kind === "modified");
  assert.ok(mod);
  assert.equal(mod.classification, "within-spec");
});

test("step classifier: mixed within-spec + deviation tokens → deviation at step level", () => {
  const src = parseCooklang("Mix @flour{500-525%g} with @water{300-350%g}.");
  const log = parseCooklang("Mix @flour{510%g} with @water{400%g}."); // water out of range
  const classes = classifyCookLogSteps(log.steps, src.steps);
  const mod = classes.find((c) => c.kind === "modified");
  assert.equal(mod.classification, "deviation");
  // Per-token: one within-spec, one deviation
  const classes_set = new Set(mod.token_diffs.map((d) => d.classification));
  assert.ok(classes_set.has("within-spec"));
  assert.ok(classes_set.has("deviation"));
});

test("step classifier: identical steps emit nothing", () => {
  const src = parseCooklang("Mix @flour{500%g}.");
  const log = parseCooklang("Mix @flour{500%g}.");
  const classes = classifyCookLogSteps(log.steps, src.steps);
  assert.equal(classes.length, 0);
});

test("step classifier: source step with no log counterpart → removal", () => {
  // Both steps are different ingredients so similarity fallback can't pair
  // them; the second source step becomes an unmatched removal.
  const src = parseCooklang("Mix @flour{500%g}.\n\nFry @onion{1}.");
  const log = parseCooklang("Mix @flour{500%g}.");
  const classes = classifyCookLogSteps(log.steps, src.steps);
  const removals = classes.filter((c) => c.kind === "removed");
  assert.equal(removals.length, 1);
  assert.equal(removals[0].source_index, 1);
  assert.equal(removals[0].log_index, null);
});

test("classifyCookLogVsSource bundles ingredients + steps", () => {
  const src = parseCooklang("Mix @flour{500-525%g}.");
  const log = parseCooklang("Mix @flour{510%g}.");
  const result = classifyCookLogVsSource(log, src);
  assert.equal(result.ingredients.changed[0].classification, "within-spec");
  assert.equal(result.steps[0].classification, "within-spec");
});

// ── synthesizePromotedRecipe (cherry-pick promote) ────────────────────────────

test("synthesize: with empty selections, the result equals source (spec preservation)", () => {
  const src = "Mix @flour{500-525%g}.";
  const log = "Mix @flour{540%g}.";
  const out = synthesizePromotedRecipe(src, log, new Set());
  assert.equal(out, src);
});

test("synthesize: a selected token rewrite replaces the source's value with the log's", () => {
  const src = "Mix @flour{500-525%g}.";
  const log = "Mix @flour{540%g}.";
  const out = synthesizePromotedRecipe(src, log, new Set(["step-token:0:1:ingredient:0"]));
  assert.equal(out, "Mix @flour{540%g}.");
});

test("synthesize: an unselected within-spec keeps the source range", () => {
  const src = "Hold at ^{20-22%C}.";
  const log = "Hold at ^{21%C}.";
  const out = synthesizePromotedRecipe(src, log, new Set());
  assert.equal(out, src);
});

test("synthesize: a selected !+ addition is appended to the section", () => {
  const src = "Mix @flour{500%g}.";
  const log = "Mix @flour{500%g}.\n\n!+ Rest 20 min.";
  const out = synthesizePromotedRecipe(src, log, new Set(["step-add:0:2"]));
  // Resolver strips the `!+ ` marker; new step appended.
  assert.ok(out.includes("Rest 20 min."), `expected addition; got: ${out}`);
  assert.ok(!out.includes("!+ "), `marker should be stripped; got: ${out}`);
});

test("synthesize: a selected !- removal drops the source step", () => {
  const src = "Mix @flour{500%g}.\n\nKnead briefly.";
  const log = "Mix @flour{500%g}.\n\n!- Knead briefly.";
  const out = synthesizePromotedRecipe(src, log, new Set(["step-remove:0:2"]));
  assert.ok(!out.includes("Knead briefly"), `expected removal; got: ${out}`);
  assert.ok(out.includes("Mix @flour{500%g}"));
});

test("synthesize: mixed selections — flour selected, temperature unselected", () => {
  const src = "Mix @flour{500-525%g} at ^{20-22%C}.";
  const log = "Mix @flour{540%g} at ^{21%C}.";
  // Select the flour deviation but NOT the within-spec temperature.
  const out = synthesizePromotedRecipe(src, log, new Set(["step-token:0:1:ingredient:0"]));
  assert.ok(out.includes("@flour{540%g}"), `flour should update; got: ${out}`);
  assert.ok(out.includes("^{20-22%C}"), `temp range should be preserved; got: ${out}`);
});

test("synthesize: nothing happens when source has no log changes", () => {
  const src = "Mix @flour{500%g}.";
  const log = "Mix @flour{500%g}.";
  const out = synthesizePromotedRecipe(src, log, new Set(["step-token:0:1:ingredient:0"]));
  assert.equal(out, src);
});

// Regression: an added/skipped step before a modified step shifts the LOG step
// numbering. Selections must still land on the right SOURCE step, and the
// change IDs from /classify (resolved log) must match what synthesis applies.
test("synthesize: a token edit after an added step still lands on the source step", () => {
  const src = "= Steps\n\nMix @flour{500%g}.\n\nBake @sugar{10%g}.";
  const log = "= Steps\n\nMix @flour{500%g}.\n\n!+ Rest 20 min.\n\nBake @sugar{20%g}.";
  const out = synthesizePromotedRecipe(src, log, selectAllChangeIds(src, log));
  assert.ok(out.includes("@sugar{20%g}"), `sugar should update; got: ${out}`);
  assert.ok(out.includes("@flour{500%g}"), `flour unchanged; got: ${out}`);
  assert.ok(out.includes("Rest 20 min."), `added step should land; got: ${out}`);
});

test("synthesize: select-all with a skip + later edit applies every selection", () => {
  const src = "= Steps\n\nMix @flour{500%g}.\n\nKnead well.\n\nBake @sugar{10%g}.";
  const log = "= Steps\n\nMix @flour{500%g}.\n\n!- Knead well.\n\nBake @sugar{20%g}.";
  const out = synthesizePromotedRecipe(src, log, selectAllChangeIds(src, log));
  assert.ok(out.includes("@sugar{20%g}"), `sugar should update; got: ${out}`);
  assert.ok(!out.includes("Knead well"), `knead should be removed; got: ${out}`);
});
