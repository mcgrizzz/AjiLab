import * as Diff from "diff";
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

export { diffIngredients, classifyIngredientRow };
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

// Walks a unified patch and, for each consecutive `-` / `+` block, pairs the
// changed lines and runs an intra-line word diff so the renderer can highlight
// just the substrings that actually differ. Unpaired removals / additions
// (e.g. a pure deletion or insertion) fall through with a single token.
export function buildInlineDiffLines(patch: string): DiffLineEntry[] {
  const lines = patch.split("\n");
  const out: DiffLineEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("---") || line.startsWith("+++")) {
      out.push({ kind: "header", text: line });
      i += 1;
      continue;
    }
    if (line.startsWith("@@")) {
      out.push({ kind: "hunk", text: line });
      i += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      out.push({ kind: "context", text: line });
      i += 1;
      continue;
    }
    if (line.startsWith("-")) {
      const removed: string[] = [];
      const added: string[] = [];
      while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) {
        removed.push(lines[i].slice(1));
        i += 1;
      }
      while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
        added.push(lines[i].slice(1));
        i += 1;
      }
      const pairs = Math.min(removed.length, added.length);
      for (let j = 0; j < pairs; j++) {
        const [removedTokens, addedTokens] = wordDiffTokens(removed[j], added[j]);
        out.push({ kind: "removed", prefix: "-", tokens: removedTokens });
        out.push({ kind: "added", prefix: "+", tokens: addedTokens });
      }
      for (let j = pairs; j < removed.length; j++) {
        out.push({ kind: "removed", prefix: "-", tokens: [{ op: "removed", text: removed[j] }] });
      }
      for (let j = pairs; j < added.length; j++) {
        out.push({ kind: "added", prefix: "+", tokens: [{ op: "added", text: added[j] }] });
      }
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ kind: "added", prefix: "+", tokens: [{ op: "added", text: line.slice(1) }] });
      i += 1;
      continue;
    }
    out.push({ kind: "context", text: line });
    i += 1;
  }
  return out;
}

function wordDiffTokens(oldStr: string, newStr: string): [DiffToken[], DiffToken[]] {
  const parts = (Diff as any).diffWordsWithSpace(oldStr, newStr);
  const removed: DiffToken[] = [];
  const added: DiffToken[] = [];
  for (const part of parts) {
    if (part.added) {
      added.push({ op: "added", text: part.value });
    } else if (part.removed) {
      removed.push({ op: "removed", text: part.value });
    } else {
      removed.push({ op: "context", text: part.value });
      added.push({ op: "context", text: part.value });
    }
  }
  return [removed, added];
}

// ── Step-level diff ──────────────────────────────────────────────────────────
// Groups raw cooklang into ordered blocks (section heads, steps, notes), pairs
// them across versions by section + ordinal, and emits a list of changes —
// each carrying its own context (section name, step number) and a token-level
// intra-step word diff so the surrounding sentence stays readable.

export function diffStepBlocks(fromText: string, toText: string): StepChange[] {
  const fromGroups = groupBySectionName(parseBlocks(fromText));
  const toGroups = groupBySectionName(parseBlocks(toText));
  const out: StepChange[] = [];
  const usedToKeys = new Set<string>();
  // Walk from-sections in source order so the diff matches reading order.
  for (const { name: sectionName, blocks: fromBlocks } of fromGroups) {
    const key = sectionKey(sectionName);
    const toEntry = toGroups.find((g) => sectionKey(g.name) === key);
    if (!toEntry) {
      for (const block of fromBlocks) {
        out.push({ kind: "removed", section_name: sectionName, step_number: block.step_number, block_kind: block.kind, text: block.text });
      }
      continue;
    }
    usedToKeys.add(key);
    diffSectionBlocks(sectionName, fromBlocks, toEntry.blocks, out);
  }
  for (const { name: sectionName, blocks: toBlocks } of toGroups) {
    if (usedToKeys.has(sectionKey(sectionName))) continue;
    for (const block of toBlocks) {
      out.push({ kind: "added", section_name: sectionName, step_number: block.step_number, block_kind: block.kind, text: block.text });
    }
  }
  return out;
}

function diffSectionBlocks(
  sectionName: string | null,
  fromBlocks: StepBlock[],
  toBlocks: StepBlock[],
  out: StepChange[],
) {
  // Pair blocks positionally within the section. Real recipes rarely reorder
  // steps; LCS would be overkill and brittle for short lists.
  const pairs = Math.min(fromBlocks.length, toBlocks.length);
  for (let i = 0; i < pairs; i++) {
    const f = fromBlocks[i];
    const t = toBlocks[i];
    if (f.text === t.text) continue; // unchanged
    out.push({
      kind: "modified",
      section_name: sectionName,
      step_number: f.step_number,
      block_kind: f.kind,
      inline_tokens: inlineWordDiff(f.text, t.text),
    });
  }
  for (let i = pairs; i < fromBlocks.length; i++) {
    const b = fromBlocks[i];
    out.push({ kind: "removed", section_name: sectionName, step_number: b.step_number, block_kind: b.kind, text: b.text });
  }
  for (let i = pairs; i < toBlocks.length; i++) {
    const b = toBlocks[i];
    out.push({ kind: "added", section_name: sectionName, step_number: b.step_number, block_kind: b.kind, text: b.text });
  }
}

// Produces a coalesced inline stream: alternating context segments and
// single `replace` items. Each replace is one contiguous change region —
// all the removed text on one side, all the added text on the other,
// including any short shared context between them (e.g. `°C` between
// `28°C-30°C` and `26.5°C`). Renderer draws each replace as `old → new`.
function inlineWordDiff(oldStr: string, newStr: string): InlineDiffToken[] {
  const parts = (Diff as any).diffWordsWithSpace(oldStr, newStr) as Array<{ value: string; added?: boolean; removed?: boolean }>;
  const out: InlineDiffToken[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      // Plain context. Will get pulled into a change region downstream if it
      // sits between two changes and is short; otherwise emit as-is.
      if (isShortBoundary(part.value) && hasChangeAround(parts, i)) {
        // Fall through to the change-collector below.
      } else {
        out.push({ op: "context", text: part.value });
        i += 1;
        continue;
      }
    }
    // Start a change region. Greedily extend through any removed/added and
    // any short context that's flanked by more change content.
    let removed = "";
    let added = "";
    while (i < parts.length) {
      const cur = parts[i];
      if (cur.removed) { removed += cur.value; i += 1; continue; }
      if (cur.added) { added += cur.value; i += 1; continue; }
      // Context. Fold into the region if it's a short bridge between changes.
      if (isShortBoundary(cur.value)) {
        const next = findNextChange(parts, i + 1);
        if (next !== -1 && onlyShortContextBetween(parts, i, next)) {
          for (let k = i; k < next; k++) {
            removed += parts[k].value;
            added += parts[k].value;
          }
          i = next;
          continue;
        }
      }
      break;
    }
    out.push({ op: "replace", removed, added });
  }
  return out;
}

function isShortBoundary(text: string): boolean {
  // A "short bridge" is something like `°C`, `%`, `:` — too short to be a
  // meaningful piece of preserved sentence context. We require no whitespace
  // so we don't accidentally absorb a real word.
  return text.length > 0 && text.length <= 4 && !/\s/.test(text);
}

function findNextChange(parts: Array<{ added?: boolean; removed?: boolean }>, from: number): number {
  for (let i = from; i < parts.length; i++) {
    if (parts[i].added || parts[i].removed) return i;
  }
  return -1;
}

function onlyShortContextBetween(parts: Array<{ value: string; added?: boolean; removed?: boolean }>, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (parts[i].added || parts[i].removed) return false;
    if (!isShortBoundary(parts[i].value)) return false;
  }
  return true;
}

function hasChangeAround(parts: Array<{ added?: boolean; removed?: boolean }>, i: number): boolean {
  const before = i > 0 && (parts[i - 1].added || parts[i - 1].removed);
  const after = i + 1 < parts.length && (parts[i + 1].added || parts[i + 1].removed);
  return Boolean(before && after);
}

function parseBlocks(text: string): StepBlock[] {
  const out: StepBlock[] = [];
  let currentSection: string | null = null;
  let stepIndex = 0; // step counter within the current section
  // Paragraph blocks are separated by blank lines. Section headings (`= Name`)
  // and metadata (`>> key: value`) get their own implicit boundaries.
  const lines = text.split(/\r?\n/);
  const paragraphs: string[][] = [[]];
  for (const raw of lines) {
    if (raw.trim() === "") {
      if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
    } else {
      paragraphs[paragraphs.length - 1].push(raw);
    }
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    const joined = paragraph.join("\n").trim();
    if (!joined) continue;
    const firstLine = paragraph[0].trim();
    if (firstLine.startsWith("=")) {
      // Section heading. Strip leading `=` runs and trailing trim runs.
      const name = firstLine.replace(/^=+\s*/, "").replace(/\s*=+$/, "").trim() || null;
      currentSection = name;
      stepIndex = 0;
      continue;
    }
    if (firstLine.startsWith(">>")) {
      // Metadata line — these are header-y, surfaced separately if needed.
      // Skip from step diff to avoid noisy "metadata changed" entries.
      continue;
    }
    if (firstLine.startsWith(">") && !firstLine.startsWith(">>")) {
      out.push({ kind: "note", section_name: currentSection, step_number: null, text: joined });
      continue;
    }
    stepIndex += 1;
    out.push({ kind: "step", section_name: currentSection, step_number: stepIndex, text: joined });
  }
  return out;
}

function groupBySectionName(blocks: StepBlock[]): Array<{ name: string | null; blocks: StepBlock[] }> {
  const groups: Array<{ name: string | null; blocks: StepBlock[] }> = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (last && sectionKey(last.name) === sectionKey(block.section_name)) {
      last.blocks.push(block);
    } else {
      groups.push({ name: block.section_name, blocks: [block] });
    }
  }
  return groups;
}

function sectionKey(name: string | null): string {
  return name === null ? "__default__" : `name:${name.toLowerCase()}`;
}

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
