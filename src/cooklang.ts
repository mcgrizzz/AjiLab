// Public surface for the cooklang/ feature directory. Routes, the store,
// compare, and tests all import from this barrel; individual feature modules
// import from each other via their direct paths under ./cooklang/.

export interface RecipeReferenceResolution {
  found: boolean;
  slug: string;
  raw_path: string;
  category_path: string[];
  version_string: string | null;
  pinned: boolean;
  title: string | null;
  url: string | null;
}

export interface QuantityRange {
  min: number;
  max: number;
}

export interface ParsedIngredient {
  name: string;
  quantity: string | number;
  units: string;
  range?: QuantityRange | null;
  note?: string | null;
  optional?: boolean;
  recipe_reference?: boolean;
  intermediate?: boolean;
  reference_path?: string | null;
  recipe_reference_resolution?: RecipeReferenceResolution | null;
  // Diff annotations attached by annotateIngredientSummaryDiff when this
  // ingredient's quantity/units/range differ from the paired source list.
  source_quantity?: string | number | null;
  source_units?: string;
  source_range?: QuantityRange | null;
}

export interface ParsedIngredientSection {
  name: string | null;
  ingredients: ParsedIngredient[];
}

export interface ParsedIngredientSummary {
  mode_default: "sectioned" | "flat";
  flat: ParsedIngredient[];
  sections: ParsedIngredientSection[];
  has_multiple_sections: boolean;
}

export interface ParsedStep {
  type: "text" | "comment" | "ingredient" | "cookware" | "timer" | "inlineQuantity";
  value: string;
  name?: string;
  note?: string | null;
  optional?: boolean;
  intermediate?: boolean;
  quantity?: string | number;
  units?: string;
  range?: QuantityRange | null;
  kind?: "temperature";
  // Cook log deviation marker — set on every token in a step prefixed with
  // `!+ ` (added) or `!- ` (skipped). The prefix is stripped from the rendered
  // text. Modifications are detected by diffing against source, not marked.
  deviation?: "added" | "skipped";
  // Diff annotations attached by annotateCookLogDiff when this token's
  // quantity/units/range differ from the source recipe's paired token. The
  // cook log renderer reads these to draw a "was X" chip.
  source_quantity?: string | number | null;
  source_units?: string;
  source_range?: QuantityRange | null;
  source_value?: string | null;
  step_id?: string;
  step_number?: number;
  section_index?: number;
  section_id?: string;
  reference_target?: "ingredient" | "step" | "section" | null;
  reference_step_number?: number;
  reference_step_id?: string;
  reference_section_index?: number;
  reference_section_id?: string;
  reference_section_name?: string | null;
  recipe_reference?: boolean;
  reference_path?: string | null;
  recipe_reference_resolution?: RecipeReferenceResolution | null;
}

export interface EditableQuantityToken {
  id: string;
  kind: "ingredient" | "timer" | "inlineQuantity";
  label: string;
  quantityText: string;
  units: string;
  numericValue: number | null;
  range?: QuantityRange | null;
  measurementKind?: "temperature";
  rangeStart: number;
  rangeEnd: number;
}

export interface ComputedMetric {
  name: string;             // 'hydration', 'salt pct' …
  formula: string;          // raw expression body (no format-unit tail)
  format_unit: string | null; // '%', 'g', null
  hidden: boolean;          // computed but not rendered as a chip — useful as
                            // an intermediate referenced by later metrics
  value: number | null;     // null when error is set
  display: string | null;   // pre-formatted '70%' / '850 g' / '0.7'
  error: string | null;     // human-readable cause when evaluation fails
}

export interface ParsedRecipe {
  ingredients: ParsedIngredient[];
  ingredient_summary: ParsedIngredientSummary;
  cookwares: string[];
  metadata: Record<string, string>;
  metrics: ComputedMetric[];
  steps: ParsedStep[][];
  editable_tokens: EditableQuantityToken[];
  error?: string;
}

export function parseReferencePath(raw: string): { slug: string; version: string | null; categoryPath: string[] } {
  const cleaned = String(raw || "").replace(/^\.?\//, "").replace(/\/+$/, "");
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length === 0) return { slug: "", version: null, categoryPath: [] };
  const last = segments[segments.length - 1];
  const versionPattern = /^v\d+(?:\.\d+){0,2}(?:-beta\.\d+)?$/i;
  let version: string | null = null;
  if (segments.length >= 2 && versionPattern.test(last)) {
    version = last;
    segments.pop();
  }
  const slug = segments.pop() || "";
  return { slug, version, categoryPath: segments };
}

export { parseCooklang, parseSortableNumber, extractRange } from "./cooklang/parse.ts";

export {
  findStepLineRange,
  findAllSections,
  findSectionLineRange,
  updateStepQuantity,
  resolveDeviationMarkers,
  applyStepDeviation,
  insertNoteAfterStep,
  deleteStep,
  insertStepAfterStep,
  insertStepInSection,
  insertSectionNote,
  renameSection,
  insertRecipeNote,
} from "./cooklang/mutations.ts";
export type { StepLineRange, SectionLineRange } from "./cooklang/mutations.ts";

export {
  pairCookLogStepsToSource,
  annotateCookLogDiff,
  annotateIngredientSummaryDiff,
} from "./cooklang/diff.ts";
export type { StepPairReason, StepPair } from "./cooklang/diff.ts";

export {
  splitTextIntoParsedSteps,
  scaleIngredient,
} from "./cooklang/token-extract.ts";
