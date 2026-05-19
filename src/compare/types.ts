// ── Diff types ───────────────────────────────────────────────────────────────
// Shared types for the three diff systems in this directory:
//   - inline-diff: word-level diff inside paired removed/added lines
//   - step-diff:   section-aware step block diff
//   - classify:    cook-log vs source step classifier
//
// All types are erased at runtime; they live here so feature modules don't
// need to import each other just to share a shape.

import type { QuantityRange } from "../cooklang.ts";

export type DiffToken =
  | { op: "context"; text: string }
  | { op: "added"; text: string }
  | { op: "removed"; text: string };

// Inline step-diff token. `replace` is a single coalesced change region:
// adjacent removed/added pieces (and any short context squished between them)
// merged into one logical swap so the renderer can show `old → new`.
export type InlineDiffToken =
  | { op: "context"; text: string }
  | { op: "replace"; removed: string; added: string };

export type DiffLineEntry =
  | { kind: "header" | "hunk" | "context"; text: string }
  | { kind: "added" | "removed"; prefix: string; tokens: DiffToken[] };

export type StepBlock = {
  kind: "step" | "note";
  section_name: string | null;
  step_number: number | null; // 1-indexed within the section, null for notes
  text: string;
};

export type StepChange =
  | { kind: "modified"; section_name: string | null; step_number: number | null; block_kind: "step" | "note"; inline_tokens: InlineDiffToken[] }
  | { kind: "added"; section_name: string | null; step_number: number | null; block_kind: "step" | "note"; text: string }
  | { kind: "removed"; section_name: string | null; step_number: number | null; block_kind: "step" | "note"; text: string };

export type Classification = "within-spec" | "deviation" | "addition" | "removal" | "notes-only";

export interface TokenDiff {
  kind: "ingredient" | "timer" | "inlineQuantity";
  name: string | null;
  // Index of the source-side token within its step's tokens-of-this-kind list.
  // Needed by the synthesis pass to target updateStepQuantity at the right
  // occurrence when the same step has multiple ingredients / timers / inlines.
  source_token_index: number;
  from_quantity: string | number | null;
  from_units: string;
  from_range: QuantityRange | null;
  to_quantity: string | number | null;
  to_units: string;
  classification: Exclude<Classification, "notes-only">;
}

export type StepClassification =
  | {
      kind: "modified";
      classification: Exclude<Classification, "notes-only" | "addition" | "removal">;
      section_index: number;
      step_number: number;
      log_index: number;
      source_index: number;
      token_diffs: TokenDiff[];
      text_snippet: string;
    }
  | {
      kind: "added";
      classification: "addition";
      section_index: number;
      step_number: number;
      log_index: number;
      text_snippet: string;
    }
  | {
      kind: "removed";
      classification: "removal";
      section_index: number;
      step_number: number;
      // When the log marks `!-` skipped we have a log step; when the source
      // has a step with no log counterpart we only have a source index.
      log_index: number | null;
      source_index: number;
      text_snippet: string;
    };
