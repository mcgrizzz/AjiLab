// ── Cherry-pick promote ──────────────────────────────────────────────────────
// Two pieces work together for the promote-from-cook-log UI:
//
//   - changeIdsForClassification / tokenChangeId: stable IDs the client renders
//     as checkbox keys. The same IDs come back in the `selections` Set on
//     submit, so the server can apply exactly the picked changes.
//
//   - synthesizePromotedRecipe: starts from the source recipe and replays only
//     the selected changes. Unselected within-spec changes therefore preserve
//     the source's range / scalar by construction.

import {
  parseCooklang,
  resolveDeviationMarkers,
  updateStepQuantity,
  deleteStep as deleteCooklangStep,
  insertStepInSection,
} from "../cooklang.ts";
import type { ParsedRecipe } from "../cooklang.ts";
import { classifyCookLogSteps } from "./classify.ts";
import type { StepClassification, TokenDiff } from "./types.ts";

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
