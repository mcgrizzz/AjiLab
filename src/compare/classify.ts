// ── Cook log → source step classifier ────────────────────────────────────────
// Asymmetric step-level diff with classification for the cherry-pick promote
// UI. Walks paired log/source steps via pairCookLogStepsToSource, then per
// matched step inspects ingredient / timer / inlineQuantity tokens. Each
// numeric diff is classified `within-spec` (log scalar lands in source range)
// or `deviation`. Step-level classification aggregates the per-token results
// plus structural changes (added / skipped / text-only).

import { pairCookLogStepsToSource } from "../cooklang.ts";
import type { ParsedStep, ParsedRecipe, QuantityRange } from "../cooklang.ts";
import { diffIngredients } from "../ingredient-compare.js";
import type { TokenDiff, StepClassification } from "./types.ts";

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
