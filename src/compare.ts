import {
  pairCookLogStepsToSource,
  parseCooklang,
  updateStepQuantity,
  deleteStep as deleteCooklangStep,
  insertStepInSection,
  resolveDeviationMarkers,
} from "./cooklang.ts";
import type { ParsedStep, ParsedRecipe, QuantityRange } from "./cooklang.ts";
import { diffIngredients, classifyIngredientRow } from "./ingredient-compare.js";
import type {
  DiffToken,
  InlineDiffToken,
  DiffLineEntry,
  StepBlock,
  StepChange,
  Classification,
  TokenDiff,
  StepClassification,
} from "./compare/types.ts";
import { buildInlineDiffLines } from "./compare/inline-diff.ts";
import { diffStepBlocks } from "./compare/step-diff.ts";

export { diffIngredients, classifyIngredientRow, buildInlineDiffLines, diffStepBlocks };
export type {
  DiffToken,
  InlineDiffToken,
  DiffLineEntry,
  StepBlock,
  StepChange,
  Classification,
  TokenDiff,
  StepClassification,
};

// ── Cook log → source step classifier ────────────────────────────────────────
// Asymmetric step-level diff with classification for the cherry-pick promote
// UI. Walks paired log/source steps via pairCookLogStepsToSource, then per
// matched step inspects ingredient / timer / inlineQuantity tokens. Each
// numeric diff is classified `within-spec` (log scalar lands in source range)
// or `deviation`. Step-level classification aggregates the per-token results
// plus structural changes (added / skipped / text-only).

export function classifyCookLogSteps(
  logSteps: ParsedStep[][],
  sourceSteps: ParsedStep[][],
): StepClassification[] {
  const out: StepClassification[] = [];
  const pairing = pairCookLogStepsToSource(logSteps, sourceSteps);
  const pairedSourceIdxs = new Set<number>();
  for (const pair of pairing) {
    if (pair.sourceIndex !== null) pairedSourceIdxs.add(pair.sourceIndex);
    const logStep = logSteps[pair.logIndex];
    const meta = stepMeta(logStep);

    if (pair.reason === "added") {
      out.push({
        kind: "added",
        classification: "addition",
        section_index: meta.section_index,
        step_number: meta.step_number,
        log_index: pair.logIndex,
        text_snippet: stepTextSnippet(logStep),
      });
      continue;
    }

    if (pair.reason === "skipped") {
      const srcStep = sourceSteps[pair.sourceIndex!];
      out.push({
        kind: "removed",
        classification: "removal",
        section_index: meta.section_index,
        step_number: meta.step_number,
        log_index: pair.logIndex,
        source_index: pair.sourceIndex!,
        text_snippet: stepTextSnippet(srcStep || logStep),
      });
      continue;
    }

    if (pair.sourceIndex === null) {
      // No source match and not flagged !+ — treat as an addition anyway.
      out.push({
        kind: "added",
        classification: "addition",
        section_index: meta.section_index,
        step_number: meta.step_number,
        log_index: pair.logIndex,
        text_snippet: stepTextSnippet(logStep),
      });
      continue;
    }

    const sourceStep = sourceSteps[pair.sourceIndex];
    const tokenDiffs = diffStepTokens(logStep, sourceStep);
    if (tokenDiffs.length === 0) continue; // identical — skip
    // Step classification: deviation if ANY token diff is deviation.
    const stepClass = tokenDiffs.some((d) => d.classification === "deviation")
      ? "deviation"
      : "within-spec";
    out.push({
      kind: "modified",
      classification: stepClass,
      section_index: meta.section_index,
      step_number: meta.step_number,
      log_index: pair.logIndex,
      source_index: pair.sourceIndex,
      token_diffs: tokenDiffs,
      text_snippet: stepTextSnippet(logStep),
    });
  }

  // Source steps that had no log pair = pure removal (user deleted the step
  // entirely without marking `!-`). Emit them so promote can offer to keep
  // the original or drop it.
  for (let srcIdx = 0; srcIdx < sourceSteps.length; srcIdx++) {
    if (pairedSourceIdxs.has(srcIdx)) continue;
    const step = sourceSteps[srcIdx];
    if (!isNumberedStep(step)) continue;
    const meta = stepMeta(step);
    out.push({
      kind: "removed",
      classification: "removal",
      section_index: meta.section_index,
      step_number: meta.step_number,
      log_index: null,
      source_index: srcIdx,
      text_snippet: stepTextSnippet(step),
    });
  }

  return out;
}

// Render-time identifier for a step: a short prefix of its visible text so the
// cherry-pick UI can show "Cool overnight…" instead of "Section 2, Step 1".
// Concatenates text + token names/values, collapses whitespace, truncates to
// ~50 chars on a word boundary.
const STEP_SNIPPET_MAX = 50;
function stepTextSnippet(step: ParsedStep[] | undefined): string {
  if (!step || !Array.isArray(step)) return "";
  const parts: string[] = [];
  for (const tok of step) {
    if (tok == null) continue;
    if (typeof tok === "string") { parts.push(tok); continue; }
    const t = tok as any;
    if (t.type === "text" || t.type === "comment") {
      if (typeof t.value === "string") parts.push(t.value);
    } else if (t.type === "ingredient" || t.type === "cookware") {
      if (typeof t.name === "string") parts.push(t.name);
    } else if (t.type === "timer") {
      if (typeof t.value === "string" && t.value) parts.push(t.value);
      else if (typeof t.name === "string" && t.name) parts.push(t.name);
    } else if (t.type === "inlineQuantity") {
      if (typeof t.value === "string") parts.push(t.value);
    }
  }
  const flat = parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
  if (flat.length <= STEP_SNIPPET_MAX) return flat;
  const cut = flat.slice(0, STEP_SNIPPET_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return base + "…";
}

function stepMeta(step: ParsedStep[]): { section_index: number; step_number: number } {
  for (const tok of step || []) {
    if (tok && typeof tok === "object") {
      const t = tok as any;
      if (Number.isFinite(t.step_number) && Number.isFinite(t.section_index)) {
        return { section_index: t.section_index, step_number: t.step_number };
      }
    }
  }
  return { section_index: -1, step_number: -1 };
}

function isNumberedStep(step: ParsedStep[]): boolean {
  for (const tok of step || []) {
    if (tok && typeof tok === "object" && Number.isFinite((tok as any).step_number)) return true;
  }
  return false;
}

function diffStepTokens(logStep: ParsedStep[], sourceStep: ParsedStep[]): TokenDiff[] {
  const diffs: TokenDiff[] = [];
  // Walk source first to assign a stable kind-index to each source token —
  // that's the index synthesize uses with updateStepQuantity.
  const sourceIngByName = new Map<string, Array<{ tok: ParsedStep; index: number }>>();
  const sourceTimers: Array<{ tok: ParsedStep; index: number }> = [];
  const sourceInlines: Array<{ tok: ParsedStep; index: number }> = [];
  let ingIdx = 0, timerIdx = 0, inlineIdx = 0;
  for (const tok of sourceStep) {
    if (!tok || typeof tok !== "object") continue;
    if (tok.type === "ingredient" && typeof tok.name === "string") {
      const key = tok.name.toLowerCase();
      if (!sourceIngByName.has(key)) sourceIngByName.set(key, []);
      sourceIngByName.get(key)!.push({ tok, index: ingIdx++ });
    } else if (tok.type === "timer") {
      sourceTimers.push({ tok, index: timerIdx++ });
    } else if (tok.type === "inlineQuantity") {
      sourceInlines.push({ tok, index: inlineIdx++ });
    }
  }
  let timerCursor = 0;
  let inlineCursor = 0;

  for (const tok of logStep) {
    if (!tok || typeof tok !== "object") continue;
    if (tok.type === "ingredient" && typeof tok.name === "string") {
      const src = sourceIngByName.get(tok.name.toLowerCase())?.shift();
      if (!src) continue;
      const diff = tokenDiff("ingredient", tok, src.tok, src.index);
      if (diff) diffs.push(diff);
    } else if (tok.type === "timer") {
      const src = sourceTimers[timerCursor++];
      if (!src) continue;
      const diff = tokenDiff("timer", tok, src.tok, src.index);
      if (diff) diffs.push(diff);
    } else if (tok.type === "inlineQuantity") {
      const src = sourceInlines[inlineCursor++];
      if (!src) continue;
      const diff = tokenDiff("inlineQuantity", tok, src.tok, src.index);
      if (diff) diffs.push(diff);
    }
  }
  return diffs;
}

function tokenDiff(
  kind: "ingredient" | "timer" | "inlineQuantity",
  logTok: any,
  srcTok: any,
  sourceTokenIndex: number,
): TokenDiff | null {
  const qChanged = String(logTok.quantity ?? "") !== String(srcTok.quantity ?? "");
  const uChanged = String(logTok.units ?? "") !== String(srcTok.units ?? "");
  const rangeChanged = JSON.stringify(logTok.range ?? null) !== JSON.stringify(srcTok.range ?? null);
  if (!qChanged && !uChanged && !rangeChanged) return null;
  const classification = classifyTokenChange(logTok, srcTok);
  return {
    kind,
    name: typeof logTok.name === "string" ? logTok.name : null,
    source_token_index: sourceTokenIndex,
    from_quantity: srcTok.quantity ?? null,
    from_units: srcTok.units ?? "",
    from_range: srcTok.range ?? null,
    to_quantity: logTok.quantity ?? null,
    to_units: logTok.units ?? "",
    classification,
  };
}

function classifyTokenChange(logTok: any, srcTok: any): "within-spec" | "deviation" {
  const range = srcTok.range as QuantityRange | null | undefined;
  const sameUnits = String(logTok.units ?? "") === String(srcTok.units ?? "");
  const toQty = Number(logTok.quantity);
  if (range && Number.isFinite(range.min) && Number.isFinite(range.max) && Number.isFinite(toQty) && sameUnits) {
    if (toQty >= range.min && toQty <= range.max) return "within-spec";
  }
  return "deviation";
}

// Convenience wrapper that classifies a whole cook-log/source parsed pair —
// returns ingredient-summary diffs + step classifications in one shot. The
// promote UI consumes this directly.
export function classifyCookLogVsSource(logParsed: ParsedRecipe, sourceParsed: ParsedRecipe) {
  const ingredientDiff = diffIngredients(
    sourceParsed.ingredient_summary?.flat || [],
    logParsed.ingredient_summary?.flat || [],
  );
  return {
    ingredients: ingredientDiff,
    steps: classifyCookLogSteps(logParsed.steps, sourceParsed.steps),
  };
}

// Stable identifiers for cherry-pick selections. Client renders a checkbox
// per change with one of these IDs; server applies only the selected ones.
//   step-add:LOG_SECTION:LOG_STEP_NUMBER
//   step-remove:SOURCE_SECTION:SOURCE_STEP_NUMBER
//   step-token:SOURCE_SECTION:SOURCE_STEP_NUMBER:KIND:SOURCE_TOKEN_INDEX
export function changeIdsForClassification(classification: StepClassification): string[] {
  if (classification.kind === "added") {
    return [`step-add:${classification.section_index}:${classification.step_number}`];
  }
  if (classification.kind === "removed") {
    return [`step-remove:${classification.section_index}:${classification.step_number}`];
  }
  return classification.token_diffs.map((d) => tokenChangeId(classification, d));
}

export function tokenChangeId(classification: StepClassification & { kind: "modified" }, d: TokenDiff): string {
  return `step-token:${classification.section_index}:${classification.step_number}:${d.kind}:${d.source_token_index}`;
}

// Synthesizes a promoted recipe text by starting from the source recipe and
// applying only the cherry-picked changes. Unselected within-spec changes
// therefore preserve the source's range / scalar by construction (spec
// preservation falls out of starting from source instead of from log).
//
// Apply order matters — we want each helper's index lookups to stay valid:
//   1. step-token rewrites first (in-place edits, no line-count changes)
//   2. step removals next, descending by (section, step_number) so earlier
//      step_numbers stay stable
//   3. step additions last, after counts have settled
export function synthesizePromotedRecipe(
  sourceText: string,
  logText: string,
  selections: Set<string>,
): string {
  const logResolved = resolveDeviationMarkers(logText);
  const logParsed = parseCooklang(logResolved);
  const sourceParsed = parseCooklang(sourceText);
  const classifications = classifyCookLogSteps(logParsed.steps, sourceParsed.steps);

  let result = sourceText;

  // Phase 1: token rewrites
  for (const c of classifications) {
    if (c.kind !== "modified") continue;
    for (const d of c.token_diffs) {
      if (!selections.has(tokenChangeId(c, d))) continue;
      const newQty = d.to_quantity == null ? "" : String(d.to_quantity);
      const newUnits = d.to_units || "";
      result = updateStepQuantity(
        result,
        c.section_index,
        c.step_number,
        d.kind,
        d.source_token_index,
        newQty,
        newUnits,
      );
    }
  }

  // Phase 2: removals, descending so step_numbers stay valid as we delete
  const removals = classifications
    .filter((c) => c.kind === "removed")
    .map((c) => c as Extract<StepClassification, { kind: "removed" }>)
    .filter((c) => selections.has(`step-remove:${c.section_index}:${c.step_number}`))
    .sort((a, b) => {
      if (a.section_index !== b.section_index) return b.section_index - a.section_index;
      return b.step_number - a.step_number;
    });
  for (const c of removals) {
    result = deleteCooklangStep(result, c.section_index, c.step_number);
  }

  // Phase 3: additions — append the log's step text to the matching section.
  // We reach into the resolved log to pull the actual step text (post marker
  // strip) and use insertStepInSection.
  const additions = classifications
    .filter((c) => c.kind === "added")
    .filter((c) => selections.has(`step-add:${c.section_index}:${c.step_number}`));
  for (const c of additions) {
    const stepText = extractLogStepText(logResolved, logParsed, c.section_index, c.step_number);
    if (!stepText) continue;
    result = insertStepInSection(result, c.section_index, stepText);
  }

  return result;
}

// Walk the resolved log text and pull out the literal lines for a given
// (section, step_number). `findStepLineRange` lives in cooklang.ts but is
// already exported indirectly — we re-derive the range by parsing the log
// and using the same line-count rules.
function extractLogStepText(
  logText: string,
  logParsed: ParsedRecipe,
  sectionIndex: number,
  stepNumber: number,
): string {
  // Reuse the parser's section content order to find which paragraph index
  // this step occupies, then slice it from the raw text. Simpler approach:
  // split the resolved text into paragraphs and walk per-section.
  const paragraphs = splitParagraphs(logText);
  let currentSection = -1;
  let stepCount = 0;
  for (const p of paragraphs) {
    const first = p.trim().split("\n")[0] || "";
    if (/^=\s/.test(first)) {
      currentSection = currentSection < 0 ? 0 : currentSection + 1;
      stepCount = 0;
      continue;
    }
    if (/^>>/.test(first) || /^>\s/.test(first)) continue;
    if (currentSection < 0) currentSection = 0;
    stepCount += 1;
    if (currentSection === sectionIndex && stepCount === stepNumber) return p;
  }
  return "";
}

function splitParagraphs(text: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") {
      if (buf.length) { out.push(buf.join("\n")); buf = []; }
    } else {
      buf.push(line);
    }
  }
  if (buf.length) out.push(buf.join("\n"));
  return out;
}
