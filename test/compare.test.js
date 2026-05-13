import test from "node:test";
import assert from "node:assert/strict";

import { buildInlineDiffLines, diffStepBlocks } from "../src/compare.ts";

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
