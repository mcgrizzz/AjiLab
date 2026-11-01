import test from "node:test";
import assert from "node:assert/strict";

import { parseCooklang, scaleCooklangText, unscaleCooklangText, normalizeScale } from "../src/cooklang.ts";
import { classifyCookLogVsSource, synthesizePromotedRecipe, tokenChangeId } from "../src/compare.ts";
import { cookLogSourceAtLogScale, cookLogTextAtRecipeScale } from "../src/recipe-store.ts";

const SOURCE = `---
servings: 2
metric.hydration: water.g / flour.g | %
---
Mix @flour{500%g}, @water{375%g}, @salt{=10%g} and @milk{1/3%cup}.
Add @eggs{2} and @butter{2-3%tbsp}, @pepper{some}, @oil{}. Rest ~{30%min} at ^{25%C}, then %{2%tbsp} more.
Add more @water{25%g}.`;

test("scaling: ingredient amounts only — fixed, timers, temperatures and inline amounts stay", () => {
  const scaled = scaleCooklangText(SOURCE, 2);
  assert.match(scaled, /@flour\{1000%g\}/);
  assert.match(scaled, /@water\{750%g\}/);
  assert.match(scaled, /@water\{50%g\}/);
  assert.match(scaled, /@salt\{=10%g\}/);
  assert.match(scaled, /@milk\{2\/3%cup\}/);
  assert.match(scaled, /@eggs\{4\}/);
  assert.match(scaled, /@butter\{4-6%tbsp\}/);
  assert.match(scaled, /@pepper\{some\}/);
  assert.match(scaled, /~\{30%min\}/);
  assert.match(scaled, /\^\{25%C\}/);
  assert.match(scaled, /%\{2%tbsp\}/);
  // Frontmatter (formulas, servings) is left alone.
  assert.ok(scaled.startsWith("---\nservings: 2\nmetric.hydration: water.g / flour.g | %\n---\n"));
});

test("scaling: 1× and bad factors leave the text alone", () => {
  assert.equal(scaleCooklangText(SOURCE, 1), SOURCE);
  assert.equal(normalizeScale("abc"), 1);
  assert.equal(normalizeScale(-2), 1);
  assert.equal(normalizeScale("1.5"), 1.5);
});

test("unscaling: an unchanged log comes back exactly as the source wrote it", () => {
  for (const factor of [2, 1.5, 0.5, 3]) {
    assert.equal(unscaleCooklangText(scaleCooklangText(SOURCE, factor), factor, SOURCE), SOURCE, `at ${factor}×`);
  }
});

test("unscaling: changed amounts divide and round to the source's precision", () => {
  const log = scaleCooklangText(SOURCE, 2)
    .replace("@water{750%g}", "@water{700%g}")
    .replace("@eggs{4}", "@eggs{3}");
  const back = unscaleCooklangText(log, 2, SOURCE);
  assert.match(back, /@water\{350%g\}/);
  assert.match(back, /@eggs\{1\.5\}/, "1.5 eggs isn't rounded to 2");
  assert.match(back, /@flour\{500%g\}/);
  assert.match(back, /@water\{25%g\}/);

  const odd = scaleCooklangText(SOURCE, 1.5).replace("@water{562.5%g}", "@water{550%g}");
  assert.match(unscaleCooklangText(odd, 1.5, SOURCE), /@water\{367%g\}/, "366.67 g rounds like the source's 375");
});

test("unscaling: a fixed source amount isn't divided even if the `=` was dropped", () => {
  const log = scaleCooklangText(SOURCE, 2).replace("@salt{=10%g}", "@salt{12%g}");
  assert.match(unscaleCooklangText(log, 2, SOURCE), /@salt\{12%g\}/);
});

test("parser marks fixed amounts so the Overview doesn't scale them", () => {
  const parsed = parseCooklang("Add @salt{=1%tsp} and @flour{500%g}.");
  const [salt, flour] = parsed.steps[0].filter((t) => t.type === "ingredient");
  assert.equal(salt.fixed, true);
  assert.equal(flour.fixed, false);
  assert.equal(parsed.ingredient_summary.flat.find((i) => i.name === "salt").fixed, true);
});

test("cook log at 2×: unchanged cook shows no differences, real changes do", () => {
  const log = { source_cooklang_text: SOURCE, scale: 2, cooklang_text: scaleCooklangText(SOURCE, 2) };
  const source = parseCooklang(cookLogSourceAtLogScale(log));
  const same = classifyCookLogVsSource(parseCooklang(log.cooklang_text), source);
  assert.equal(same.steps.length, 0);

  log.cooklang_text = log.cooklang_text.replace("@water{750%g}", "@water{700%g}");
  const changed = classifyCookLogVsSource(parseCooklang(log.cooklang_text), source);
  const diffs = changed.steps.flatMap((s) => s.token_diffs || []);
  assert.equal(diffs.length, 1);
  assert.equal(Number(diffs[0].from_quantity), 750);
  assert.equal(Number(diffs[0].to_quantity), 700);
});

test("cook log at 2×: promoting brings amounts back to 1×", () => {
  const log = {
    source_cooklang_text: SOURCE,
    scale: 2,
    cooklang_text: scaleCooklangText(SOURCE, 2).replace("@water{750%g}", "@water{700%g}").replace("@flour{1000%g}", "@flour{1010%g}"),
  };
  // Whole log (fork to draft / promote).
  const whole = cookLogTextAtRecipeScale(log);
  assert.match(whole, /@water\{350%g\}/);
  assert.match(whole, /@flour\{505%g\}/);
  assert.match(whole, /@milk\{1\/3%cup\}/);

  // Cherry-pick only the water change.
  const scaledSource = cookLogSourceAtLogScale(log);
  const classified = classifyCookLogVsSource(parseCooklang(log.cooklang_text), parseCooklang(scaledSource));
  const step = classified.steps[0];
  const water = step.token_diffs.find((d) => Number(d.to_quantity) === 700);
  const picked = cookLogTextAtRecipeScale(log, synthesizePromotedRecipe(scaledSource, log.cooklang_text, new Set([tokenChangeId(step, water)])));
  assert.match(picked, /@water\{350%g\}/);
  assert.match(picked, /@flour\{500%g\}/, "unpicked change keeps the source amount");
});
