// ── Cook log ↔ source step pairing + diff annotation ─────────────────────────
// Pairs cook log steps to the source recipe's steps for the diff overlay in
// the cook log view. Strategy: position-aligned within each section, with a
// similarity fallback so a small reorder doesn't drop the pairing. The source
// cursor only advances on non-added log steps so `!+` insertions don't push
// later log steps onto the wrong source position.
//
// `annotate*Diff` walks the pairing and mutates log tokens / ingredient
// entries in place to attach `source_quantity` / `source_units` /
// `source_range` / `source_value` when the values differ from the paired
// source token. The renderer reads these fields to draw a "was X" chip.

import type {
  ParsedStep,
  ParsedIngredient,
  ParsedIngredientSummary,
} from "../cooklang.ts";

export type StepPairReason =
  | "position"        // position-aligned, similarity above threshold
  | "similarity"      // position-aligned was a poor match; nearby step won
  | "skipped"         // log step is `!-` — pairs to its position-aligned source
  | "added"           // log step is `!+` — no source counterpart
  | "no-match";       // no source step within range met the similarity bar

export interface StepPair {
  logIndex: number;
  sourceIndex: number | null;
  reason: StepPairReason;
}

const PAIRING_SIMILARITY_THRESHOLD = 0.3;
const PAIRING_NEARBY_RADIUS = 2;

function stepIsNumbered(step: ParsedStep[] | undefined): boolean {
  if (!step) return false;
  for (const tok of step) {
    if (tok && typeof tok === "object" && Number.isFinite((tok as any).step_number)) return true;
  }
  return false;
}

function stepSectionIndex(step: ParsedStep[] | undefined): number {
  if (!step) return -1;
  for (const tok of step) {
    if (tok && typeof tok === "object" && Number.isFinite((tok as any).section_index)) {
      return (tok as any).section_index as number;
    }
  }
  return -1;
}

function stepDeviation(step: ParsedStep[] | undefined): "added" | "skipped" | null {
  if (!step) return null;
  for (const tok of step) {
    if (tok && typeof tok === "object" && (tok as any).deviation) {
      return (tok as any).deviation as "added" | "skipped";
    }
  }
  return null;
}

function stepIngredientNames(step: ParsedStep[]): string[] {
  const out: string[] = [];
  for (const tok of step) {
    if (tok && typeof tok === "object" && tok.type === "ingredient" && typeof tok.name === "string") {
      out.push(tok.name.toLowerCase());
    }
  }
  return out;
}

function stepTextWords(step: ParsedStep[]): string[] {
  const text = step
    .filter((tok) => tok && typeof tok === "object" && (tok.type === "text" || tok.type === "comment"))
    .map((tok) => String((tok as any).value || ""))
    .join(" ");
  return text.toLowerCase().match(/[a-z0-9]+/g) || [];
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function stepSimilarity(a: ParsedStep[], b: ParsedStep[]): number {
  const ingA = stepIngredientNames(a);
  const ingB = stepIngredientNames(b);
  if (ingA.length > 0 || ingB.length > 0) {
    const ingScore = jaccard(ingA, ingB);
    const textScore = jaccard(stepTextWords(a), stepTextWords(b));
    return 0.7 * ingScore + 0.3 * textScore;
  }
  return jaccard(stepTextWords(a), stepTextWords(b));
}

export function pairCookLogStepsToSource(
  logSteps: ParsedStep[][],
  sourceSteps: ParsedStep[][],
): StepPair[] {
  const pairs: StepPair[] = [];
  // Group source step indices by section. Each entry is the LIST of indices
  // (into sourceSteps) of numbered steps in that section, in order.
  const sourceBySection = new Map<number, number[]>();
  sourceSteps.forEach((step, idx) => {
    if (!stepIsNumbered(step)) return;
    const sec = stepSectionIndex(step);
    if (!sourceBySection.has(sec)) sourceBySection.set(sec, []);
    sourceBySection.get(sec)!.push(idx);
  });

  // Per-section cursors track the next source step to consider.
  const cursors = new Map<number, number>();

  logSteps.forEach((logStep, logIdx) => {
    if (!stepIsNumbered(logStep)) return;
    const sec = stepSectionIndex(logStep);
    const sourceIdxs = sourceBySection.get(sec) || [];
    const cursor = cursors.get(sec) || 0;
    const deviation = stepDeviation(logStep);

    if (deviation === "added") {
      pairs.push({ logIndex: logIdx, sourceIndex: null, reason: "added" });
      return; // cursor doesn't advance — added log step has no source slot
    }

    if (deviation === "skipped") {
      const sourceIdx = cursor < sourceIdxs.length ? sourceIdxs[cursor] : null;
      pairs.push({ logIndex: logIdx, sourceIndex: sourceIdx, reason: "skipped" });
      cursors.set(sec, cursor + 1);
      return;
    }

    const positionIdx = cursor < sourceIdxs.length ? sourceIdxs[cursor] : null;
    let bestIdx: number | null = null;
    let bestScore = -1;
    let bestReason: StepPairReason = "no-match";

    if (positionIdx !== null) {
      const score = stepSimilarity(logStep, sourceSteps[positionIdx]);
      if (score >= PAIRING_SIMILARITY_THRESHOLD) {
        bestIdx = positionIdx;
        bestScore = score;
        bestReason = "position";
      }
    }

    // Similarity fallback: scan nearby source steps within this section.
    if (bestIdx === null) {
      for (let offset = -PAIRING_NEARBY_RADIUS; offset <= PAIRING_NEARBY_RADIUS; offset++) {
        const probe = cursor + offset;
        if (probe < 0 || probe >= sourceIdxs.length) continue;
        const idx = sourceIdxs[probe];
        const score = stepSimilarity(logStep, sourceSteps[idx]);
        if (score >= PAIRING_SIMILARITY_THRESHOLD && score > bestScore) {
          bestIdx = idx;
          bestScore = score;
          bestReason = offset === 0 ? "position" : "similarity";
        }
      }
    }

    pairs.push({ logIndex: logIdx, sourceIndex: bestIdx, reason: bestReason });
    // Advance the cursor past whichever source step we consumed. If we matched
    // a nearby one, advance to one past that match so we don't re-consume it.
    if (bestIdx !== null) {
      const consumedAt = sourceIdxs.indexOf(bestIdx);
      cursors.set(sec, Math.max(cursor + 1, consumedAt + 1));
    } else {
      cursors.set(sec, cursor + 1);
    }
  });

  return pairs;
}

// Walks paired ingredient / timer / inlineQuantity tokens within each pair
// and mutates log tokens in place to add `source_quantity`, `source_units`,
// `source_value`, and `source_range` when the values differ. The renderer
// reads these fields to draw a "was X" chip beside changed values.
export function annotateCookLogDiff(
  logSteps: ParsedStep[][],
  sourceSteps: ParsedStep[][],
): void {
  const pairing = pairCookLogStepsToSource(logSteps, sourceSteps);
  for (const pair of pairing) {
    if (pair.sourceIndex === null) continue;
    // Skipped steps already get full-step strikethrough from CSS — adding
    // per-token "was X" chips on top would be visually noisy.
    if (pair.reason === "skipped") continue;
    const logStep = logSteps[pair.logIndex];
    const sourceStep = sourceSteps[pair.sourceIndex];
    annotateStepDiff(logStep, sourceStep);
  }
}

// Annotates the ingredient_summary lists (.flat + .sections[].ingredients)
// with source_quantity / source_units / source_range when totals differ from
// the source. Pairs by lowercase ingredient name. Lets the cook-log ingredient
// list show the same `(was → now)` arrow that step ingredients do.
export function annotateIngredientSummaryDiff(
  logSummary: ParsedIngredientSummary | undefined,
  sourceSummary: ParsedIngredientSummary | undefined,
): void {
  if (!logSummary || !sourceSummary) return;
  annotateIngredientListDiff(logSummary.flat, sourceSummary.flat);
  for (const logSection of logSummary.sections || []) {
    const sourceSection = (sourceSummary.sections || []).find(
      (s) => sectionKey(s.name) === sectionKey(logSection.name),
    );
    if (sourceSection) {
      annotateIngredientListDiff(logSection.ingredients, sourceSection.ingredients);
    }
  }
}

function sectionKey(name: string | null | undefined): string {
  return (name || "").trim().toLowerCase();
}

function annotateIngredientListDiff(
  logList: ParsedIngredient[] | undefined,
  sourceList: ParsedIngredient[] | undefined,
): void {
  if (!logList || !sourceList) return;
  const byName = new Map<string, ParsedIngredient[]>();
  for (const ing of sourceList) {
    const key = (ing.name || "").toLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(ing);
  }
  for (const logIng of logList) {
    const key = (logIng.name || "").toLowerCase();
    const src = byName.get(key)?.shift();
    if (!src) continue;
    attachDiffFields(logIng as any, src as any);
  }
}

function annotateStepDiff(logStep: ParsedStep[], sourceStep: ParsedStep[]): void {
  // Pair ingredients by lowercase name in order (handles duplicate names).
  const sourceIngByName = new Map<string, ParsedStep[]>();
  for (const tok of sourceStep) {
    if (tok && typeof tok === "object" && tok.type === "ingredient" && typeof tok.name === "string") {
      const key = tok.name.toLowerCase();
      if (!sourceIngByName.has(key)) sourceIngByName.set(key, []);
      sourceIngByName.get(key)!.push(tok as ParsedStep);
    }
  }
  // Sequences for positional matching of timers / inline quantities.
  const sourceTimers = sourceStep.filter((t) => t && typeof t === "object" && t.type === "timer") as ParsedStep[];
  const sourceInlines = sourceStep.filter((t) => t && typeof t === "object" && t.type === "inlineQuantity") as ParsedStep[];
  let timerCursor = 0;
  let inlineCursor = 0;

  for (const tok of logStep) {
    if (!tok || typeof tok !== "object") continue;
    if (tok.type === "ingredient" && typeof tok.name === "string") {
      const pool = sourceIngByName.get(tok.name.toLowerCase());
      const src = pool?.shift();
      if (src) attachDiffFields(tok as any, src as any);
    } else if (tok.type === "timer") {
      const src = sourceTimers[timerCursor++];
      if (src) attachDiffFields(tok as any, src as any);
    } else if (tok.type === "inlineQuantity") {
      const src = sourceInlines[inlineCursor++];
      if (src) attachDiffFields(tok as any, src as any);
    }
  }
}

function attachDiffFields(logTok: any, srcTok: any): void {
  const qChanged = String(logTok.quantity ?? "") !== String(srcTok.quantity ?? "");
  const uChanged = String(logTok.units ?? "") !== String(srcTok.units ?? "");
  const rangeChanged = JSON.stringify(logTok.range ?? null) !== JSON.stringify(srcTok.range ?? null);
  if (!qChanged && !uChanged && !rangeChanged) return;
  logTok.source_quantity = srcTok.quantity ?? null;
  logTok.source_units = srcTok.units ?? "";
  logTok.source_range = srcTok.range ?? null;
  logTok.source_value = srcTok.value ?? null;
}
