import {
  CooklangParser,
  getQuantityValue,
  getQuantityUnit,
  grouped_quantity_display,
  quantity_display,
  ingredient_display_name,
  cookware_display_name,
} from "@cooklang/cooklang";
import { extractComputedMetrics } from "./cooklang/metrics.ts";
import {
  extractTemperatures,
  splitTextWithTemperatures,
} from "./cooklang/temperature.ts";
import type { TemperatureExtraction } from "./cooklang/temperature.ts";
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

const parser = new CooklangParser();

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

function emptyIngredientSummary(): ParsedIngredientSummary {
  return {
    mode_default: "flat",
    flat: [],
    sections: [],
    has_multiple_sections: false,
  };
}

function ingredientReferencePath(ingredient: any, annotations: ComponentAnnotation | undefined): string | null {
  const nativePath = ingredient?.reference?.name;
  if (typeof nativePath === "string" && nativePath) return nativePath;
  if (annotations?.recipe && typeof ingredient?.name === "string" && ingredient.name) return ingredient.name;
  return null;
}

function toParsedIngredient(ingredient: any): ParsedIngredient {
  return {
    name: ingredient_display_name(ingredient),
    quantity: extractQty(ingredient.quantity),
    units: getQuantityUnit(ingredient.quantity) || "",
    range: extractRange(ingredient.quantity),
    note: ingredientNote(ingredient),
  };
}

function ingredientNote(ingredient: any): string | null {
  const raw = ingredient?.note;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function cookwareNote(cookware: any): string | null {
  const raw = cookware?.note;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function toParsedIngredientWithAnnotations(ingredient: any, annotations: ComponentAnnotation | undefined): ParsedIngredient {
  const refPath = ingredientReferencePath(ingredient, annotations);
  return {
    ...toParsedIngredient(ingredient),
    optional: annotations?.optional || false,
    recipe_reference: !!refPath || (annotations?.recipe || false),
    intermediate: annotations?.intermediate || false,
    reference_path: refPath,
  };
}

interface ComponentAnnotation {
  hidden: boolean;
  optional: boolean;
  recipe: boolean;
  intermediate: boolean;
}

function defaultAnnotation(): ComponentAnnotation {
  return {
    hidden: false,
    optional: false,
    recipe: false,
    intermediate: false,
  };
}

function collectComponentAnnotations(
  text: string,
  sigil: "@" | "#",
): ComponentAnnotation[] {
  const annotations: ComponentAnnotation[] = [];
  let index = 0;

  while (index < text.length) {
    if (text[index] !== sigil) {
      index += 1;
      continue;
    }
    const annotation = defaultAnnotation();
    index += 1;

    while (index < text.length && "@&?+-".includes(text[index])) {
      const modifier = text[index];
      if (modifier === "-") annotation.hidden = true;
      if (modifier === "?") annotation.optional = true;
      if (modifier === "@") annotation.recipe = true;
      // NOTE: plain `&` is the cooklang "reference" modifier (merges totals
      // with a prior `@flour{}`). It is NOT the intermediate-preparation
      // marker — only `&` followed by `(...)` (e.g. `@&(~1)dough{}`) is, and
      // that gets flagged below where we consume the parens. So a regular
      // `@&flour{100%g}` in a section keeps `intermediate = false` and stays
      // visible in that section's ingredient list, just like the canonical
      // cooklang spec describes.
      index += 1;
    }

    // Path-style recipe reference: @./<path>{} or @/<path>{} flags as recipe reference
    if (sigil === "@" && text[index] === "." && text[index + 1] === "/") {
      annotation.recipe = true;
    } else if (sigil === "@" && text[index] === "/") {
      annotation.recipe = true;
    }

    if (text[index] === "(") {
      annotation.intermediate = true;
      index += 1;
      while (index < text.length && text[index] !== ")") index += 1;
      if (text[index] === ")") index += 1;
    }

    while (index < text.length) {
      const ch = text[index];
      if (ch === "{") {
        index += 1;
        while (index < text.length && text[index] !== "}") index += 1;
        if (text[index] === "}") index += 1;
        break;
      }
      if (ch === "\n" || ch === "\r" || ch === "." || ch === "," || ch === ";" || ch === ":" || ch === "!" || ch === "?") {
        break;
      }
      index += 1;
    }

    annotations.push(annotation);
  }

  return annotations;
}

function shouldIncludeIngredientSummaryItem(annotation: ComponentAnnotation | undefined): boolean {
  return !annotation?.hidden && !annotation?.intermediate;
}

// Section view is a per-section "what gets used here" list, so intermediate
// prep references (e.g. `@&(=1)previous sakadane{30%g}` — using something
// produced in section 1) belong in the consuming section's row even though
// they're excluded from the flat totals (the original definition already
// covers that ingredient there).
function shouldIncludeInSectionSummary(annotation: ComponentAnnotation | undefined): boolean {
  return !annotation?.hidden;
}

function toGroupedParsedIngredient(ingredient: any, groupedQuantity: any, annotation: ComponentAnnotation | undefined): ParsedIngredient {
  const parsed = toParsedIngredientWithAnnotations(ingredient, annotation);
  const normalized = normalizeGroupedQuantity(groupedQuantity);
  if (!normalized) return parsed;
  return {
    ...parsed,
    quantity: normalized.quantity,
    units: normalized.units,
    range: normalized.range,
  };
}

function normalizeGroupedQuantity(groupedQuantity: any): { quantity: string | number; units: string; range: QuantityRange | null } | null {
  if (!groupedQuantity) return null;
  const known = groupedQuantity.known || {};
  const knownValues = [
    known.mass,
    known.volume,
    known.length,
    known.temperature,
    known.time,
  ].filter(Boolean);
  const unknownValues = Object.values(groupedQuantity.unknown || {});

  if (knownValues.length === 1 && unknownValues.length === 0 && !groupedQuantity.no_unit && !(groupedQuantity.other || []).length) {
    return {
      quantity: extractQty(knownValues[0]),
      units: getQuantityUnit(knownValues[0]) || "",
      range: extractRange(knownValues[0]),
    };
  }
  if (knownValues.length === 0 && unknownValues.length === 0 && groupedQuantity.no_unit && !(groupedQuantity.other || []).length) {
    return {
      quantity: extractQty(groupedQuantity.no_unit),
      units: getQuantityUnit(groupedQuantity.no_unit) || "",
      range: extractRange(groupedQuantity.no_unit),
    };
  }
  return {
    quantity: grouped_quantity_display(groupedQuantity),
    units: "",
    range: null,
  };
}

function sortIngredientsByAmount(ingredients: ParsedIngredient[]): ParsedIngredient[] {
  return ingredients
    .map((ingredient, index) => ({
      ingredient,
      index,
      amount: toSortableAmount(ingredient),
    }))
    .sort((a, b) => {
      const aHasAmount = a.amount !== null;
      const bHasAmount = b.amount !== null;
      if (aHasAmount && bHasAmount && a.amount !== b.amount) {
        return b.amount - a.amount;
      }
      if (aHasAmount !== bHasAmount) {
        return aHasAmount ? -1 : 1;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.ingredient);
}

function toSortableAmount(ingredient: ParsedIngredient): number | null {
  const quantity = parseSortableNumber(ingredient.quantity);
  if (quantity === null) return null;
  const unit = normalizeUnit(ingredient.units);
  const converted = convertToSortableBase(quantity, unit);
  return converted ?? quantity;
}

export function parseSortableNumber(value: string | number): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;
  const mixed = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) {
    const whole = Number(mixed[1]);
    const numerator = Number(mixed[2]);
    const denominator = Number(mixed[3]);
    if (denominator) return whole + (numerator / denominator);
  }
  const fraction = trimmed.match(/^(\d+)\/(\d+)$/);
  if (fraction) {
    const numerator = Number(fraction[1]);
    const denominator = Number(fraction[2]);
    if (denominator) return numerator / denominator;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUnit(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function convertToSortableBase(quantity: number, unit: string): number | null {
  const unitMap: Record<string, number> = {
    kg: 1000,
    kilogram: 1000,
    kilograms: 1000,
    g: 1,
    gram: 1,
    grams: 1,
    mg: 0.001,
    milligram: 0.001,
    milligrams: 0.001,
    l: 1000,
    liter: 1000,
    liters: 1000,
    litre: 1000,
    litres: 1000,
    ml: 1,
    milliliter: 1,
    milliliters: 1,
    millilitre: 1,
    millilitres: 1,
  };
  return unitMap[unit] ? quantity * unitMap[unit] : null;
}

function extractQty(quantity: any): string | number {
  if (!quantity) return "";
  // Ranges: getQuantityValue returns the start only, which silently truncates
  // "1-2" to "1". Detect range values and fall through to the display path so
  // we preserve both ends.
  if (quantity.value?.type !== "range") {
    const n = getQuantityValue(quantity);
    if (n !== null && !isNaN(n)) return n;
  }
  // Fallback for fractions/ranges/text: use display string but strip the unit
  // (unit is tracked separately) to avoid "1/8 tsp" + "tsp" → "1/8 tsp tsp"
  const display = quantity_display(quantity);
  if (!display) return "";
  const unit = getQuantityUnit(quantity);
  if (unit && display.endsWith(unit)) {
    return display.slice(0, -unit.length).trim() || display;
  }
  return display;
}

// Returns { min, max } when the underlying Cooklang Value is a range, else null.
// Accepts either a Quantity (has `.value`) or a raw Value object.
// The Cooklang WASM library nests range endpoints as `{ type: "regular",
// value: <num> }` — earlier draft read the wrong field and always got NaN.
function extractRange(quantity: any): QuantityRange | null {
  const value = quantity?.value ?? null;
  if (!value || value.type !== "range") return null;
  const r = value.value;
  const min = Number(r?.start?.value ?? r?.start);
  const max = Number(r?.end?.value ?? r?.end);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}


// Cook log deviation markers: `!+ ` (added) and `!- ` (skipped) at the start
// of a step. The marker is stripped from the rendered text and surfaced as a
// `deviation` tag on every token in the step. Modifications aren't marked —
// they're detected later by diffing the cook log step against its source.
function detectDeviation(items: any[]): "added" | "skipped" | undefined {
  const first = items?.[0];
  if (!first || first.type !== "text" || typeof first.value !== "string") return undefined;
  const m = first.value.match(/^\s*!([+\-])\s+/);
  if (!m) return undefined;
  first.value = first.value.slice(m[0].length);
  return m[1] === "+" ? "added" : "skipped";
}

// ── Inline quantity edits (cook log click-to-edit) ───────────────────────────
// Rewrite the Nth annotation of a given kind within a single step. Used by
// the cook-log inline-edit UI: the user clicks a quantity, types a new
// value, and we surgically patch the cooklang source rather than re-emit it.
//
// Special case: kind="ingredient" + newQuantity="0" strips the @annotation
// entirely (leaves the bare word as plain text) — the user said "set to 0 to
// remove". Timers and inline quantities just accept 0 as a literal value.
//
// Returns the updated text, or the input unchanged if no match was found.

export function parseCooklang(text: string): ParsedRecipe {
  if (!text || !text.trim()) {
    return {
      ingredients: [],
      ingredient_summary: emptyIngredientSummary(),
      cookwares: [],
      metadata: {},
      metrics: [],
      steps: [],
      editable_tokens: [],
    };
  }
  try {
    const { cleaned, extractions: temperatureExtractions } = extractTemperatures(text);
    const [recipe] = parser.parse(cleaned);
    // Annotation scans use the ORIGINAL text — `@` / `#` patterns are
    // untouched by temperature extraction.
    const ingredientAnnotations = collectComponentAnnotations(text, "@");
    const cookwareAnnotations = collectComponentAnnotations(text, "#");

    // Build metadata as plain object from rawMetadata Map. Skip null/undefined
    // values — otherwise `String(null)` leaks the literal "null" into the UI,
    // which is how a bare YAML key (`servings:` with nothing after) and a
    // recipe.servings of null both ended up rendering as "Serves null".
    const metadata: Record<string, string> = {};
    for (const [key, value] of recipe.rawMetadata) {
      if (value == null) continue;
      metadata[String(key)] = String(value);
    }
    if (recipe.servings != null && !metadata.servings) {
      metadata.servings = String(recipe.servings);
    }
    if (recipe.description && !metadata.description) {
      metadata.description = recipe.description;
    }
    // Expose custom_metadata entries (e.g. notes) that rawMetadata may key differently
    for (const [key, value] of recipe.custom_metadata) {
      if (value == null) continue;
      const k = String(key);
      if (!metadata[k]) metadata[k] = String(value);
    }

    const ingredients: ParsedIngredient[] = recipe.ingredients.map((ing: any, index: number) =>
      toParsedIngredientWithAnnotations(ing, ingredientAnnotations[index])
    );
    // Mirror the section-emission filter below: skip empty unnamed sections
    // so the per-section ingredient summary matches the step section indexing.
    const ingredientSections: ParsedIngredientSection[] = recipe.sections
      .filter((section: any) => !!section.name || (section.content || []).length > 0)
      .map((section: any) => {
        const sectionIngredients: ParsedIngredient[] = [];
        for (const content of section.content) {
          if (content.type !== "step") continue;
          for (const item of content.value.items) {
            if (item.type !== "ingredient") continue;
            const annotation = ingredientAnnotations[item.index];
            if (!shouldIncludeInSectionSummary(annotation)) continue;
            sectionIngredients.push(toParsedIngredientWithAnnotations(recipe.ingredients[item.index], annotation));
          }
        }
        return {
          name: section.name ? String(section.name) : null,
          ingredients: sortIngredientsByAmount(sectionIngredients),
        };
      });
    const groupedFlatIngredients: ParsedIngredient[] = recipe.groupedIngredients
      .map(([ingredient, groupedQuantity]: [any, any]) => {
        const annotation = ingredientAnnotations[recipe.ingredients.indexOf(ingredient)];
        if (!shouldIncludeIngredientSummaryItem(annotation)) return null;
        return toGroupedParsedIngredient(ingredient, groupedQuantity, annotation);
      })
      .filter(Boolean) as ParsedIngredient[];
    const ingredientSummary: ParsedIngredientSummary = {
      mode_default: ingredientSections.length > 1 ? "sectioned" : "flat",
      flat: sortIngredientsByAmount(groupedFlatIngredients),
      sections: ingredientSections,
      has_multiple_sections: ingredientSections.length > 1,
    };

    const cookwares: string[] = recipe.cookware
      .filter((_: any, index: number) => !cookwareAnnotations[index]?.hidden)
      .map((cw: any) => cookware_display_name(cw));
    const editableTokens = extractEditableTokens(text, recipe, temperatureExtractions);

    // Flatten sections → step token arrays (same shape the client expects).
    //
    // Section indexing here must agree with findStepLineRange's source-text
    // walker — both should yield the SAME (section_index, step_number) for a
    // given step. The walker counts user-visible sections only (sections with
    // a heading OR content), so we skip empty unnamed sections the Cooklang
    // library inserts when the recipe starts with `>>` metadata before the
    // first `= heading`. Without this, the first real step ends up at
    // section_index=1 in the renderer but section_index=0 in any source-text
    // edit, and the inline edit / promote routes return "step not found".
    const steps: ParsedStep[][] = [];
    let sectionIndex = -1;
    for (const section of recipe.sections) {
      const hasName = !!section.name;
      const hasContent = (section.content || []).length > 0;
      if (!hasName && !hasContent) continue;
      sectionIndex = sectionIndex < 0 ? 0 : sectionIndex + 1;
      if (section.name) {
        steps.push([{
          type: "text",
          value: `= ${section.name}`,
          section_index: sectionIndex,
          section_id: makeSectionId(sectionIndex),
        }]);
      }
      for (const content of section.content) {
        if (content.type === "text") {
          steps.push([{ type: "comment", value: content.value }]);
        } else if (content.type === "step") {
          const stepNumber = content.value.number;
          const stepId = makeStepId(sectionIndex, stepNumber);
          // Detect a deviation marker at the start of the step. The marker
          // lives in the first text item; strip it and tag every emitted
          // token so the renderer can style the whole step.
          const deviation = detectDeviation(content.value.items);
          const tokens: ParsedStep[] = content.value.items.flatMap((item: any) => {
            switch (item.type) {
              case "text":
                return splitTextWithTemperatures(item.value, {
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                }, temperatureExtractions);
              case "ingredient": {
                const ing = recipe.ingredients[item.index];
                const annotation = ingredientAnnotations[item.index];
                const relation = ing.relation?.relation || null;
                const referenceTarget = ing.relation?.reference_target || null;
                const referenceStepNumber = referenceTarget === "step" && relation?.type === "reference"
                  ? resolveReferenceStepNumber(section, Number(relation.references_to))
                  : undefined;
                const referenceStepId = referenceStepNumber ? makeStepId(sectionIndex, referenceStepNumber) : undefined;
                const referenceSectionIndex = referenceTarget === "section" && relation?.type === "reference"
                  ? Number(relation.references_to)
                  : undefined;
                const referenceSectionId = (typeof referenceSectionIndex === "number" && Number.isFinite(referenceSectionIndex))
                  ? makeSectionId(referenceSectionIndex)
                  : undefined;
                const referenceSectionName = (typeof referenceSectionIndex === "number" && Number.isFinite(referenceSectionIndex))
                  ? (recipe.sections[referenceSectionIndex]?.name ?? null)
                  : null;
                const refPath = ingredientReferencePath(ing, annotation);
                const isIntermediate = referenceTarget === "step" || referenceTarget === "section";
                return [{
                  type: "ingredient",
                  value: ingredient_display_name(ing),
                  name: ingredient_display_name(ing),
                  note: ingredientNote(ing),
                  optional: annotation?.optional || false,
                  intermediate: isIntermediate,
                  quantity: extractQty(ing.quantity),
                  units: getQuantityUnit(ing.quantity) || "",
                  range: extractRange(ing.quantity),
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                  reference_target: referenceTarget,
                  reference_step_number: referenceStepNumber,
                  reference_step_id: referenceStepId,
                  reference_section_index: referenceSectionIndex,
                  reference_section_id: referenceSectionId,
                  reference_section_name: referenceSectionName,
                  recipe_reference: !!refPath || (annotation?.recipe || false),
                  reference_path: refPath,
                }];
              }
              case "cookware": {
                const cw = recipe.cookware[item.index];
                return [{
                  type: "cookware",
                  value: cookware_display_name(cw),
                  name: cookware_display_name(cw),
                  note: cookwareNote(cw),
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                }];
              }
              case "timer": {
                const tm = recipe.timers[item.index];
                const range = extractRange(tm.quantity);
                const u = getQuantityUnit(tm.quantity) || "";
                const displayQty = tm.quantity ? quantity_display(tm.quantity) : "";
                // Ranges: prefer the display string so we don't silently truncate to start.
                const quantity = range
                  ? displayQty
                  : ((): string | number => {
                      const n = getQuantityValue(tm.quantity);
                      return n !== null ? n : displayQty;
                    })();
                return [{
                  type: "timer",
                  value: displayQty,
                  quantity,
                  units: u,
                  range,
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                }];
              }
              case "inlineQuantity": {
                const iq = recipe.inlineQuantities[item.index];
                const range = extractRange(iq);
                const display = quantity_display(iq);
                const quantity: string | number = range
                  ? display
                  : (getQuantityValue(iq.value) ?? display);
                return [{
                  type: "inlineQuantity",
                  value: display,
                  quantity,
                  units: getQuantityUnit(iq) || "",
                  range,
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                }];
              }
              default:
                return [{ type: "text" as const, value: "" }];
            }
          });
          if (deviation) {
            for (const t of tokens) t.deviation = deviation;
          }
          steps.push(tokens);
        }
      }
    }

    const metrics = extractComputedMetrics(metadata, ingredientSummary);

    return {
      ingredients,
      ingredient_summary: ingredientSummary,
      cookwares,
      metadata,
      metrics,
      steps,
      editable_tokens: editableTokens,
    };
  } catch (e: any) {
    return {
      ingredients: [],
      ingredient_summary: emptyIngredientSummary(),
      cookwares: [],
      metadata: {},
      metrics: [],
      steps: [],
      editable_tokens: [],
      error: e?.message || "Parse error",
    };
  }
}

export function splitTextIntoParsedSteps(text: string, meta: Partial<ParsedStep> = {}): ParsedStep[] {
  if (!text) return [{ type: "text", value: "", ...meta }];
  const tokens: ParsedStep[] = [];
  // Matches single temps (`200°C`) and ranges with a trailing unit (`20-22°C`).
  // A two-unit form like `20°C-22°C` falls back to two separate scalar tokens.
  const pattern = /(\d+(?:\.\d+)?)(?:\s*([-–])\s*(\d+(?:\.\d+)?))?\s*(°|º)\s*([FCfc])\b/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, match.index), ...meta });
    }
    const value = match[0];
    const startVal = Number(match[1]);
    const endVal = match[3] ? Number(match[3]) : null;
    const unit = `°${match[5].toUpperCase()}`;
    const isRange = endVal !== null && Number.isFinite(endVal);
    tokens.push({
      type: "inlineQuantity",
      value,
      quantity: isRange ? `${match[1]}${match[2] || "-"}${match[3]}` : startVal,
      units: unit,
      range: isRange ? { min: startVal, max: endVal as number } : null,
      kind: "temperature",
      ...meta,
    });
    lastIndex = match.index + value.length;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: "text", value: text.slice(lastIndex), ...meta });
  }

  return tokens.length ? tokens : [{ type: "text", value: text, ...meta }];
}

function makeStepId(sectionIndex: number, stepNumber: number): string {
  return `section-${sectionIndex}-step-${stepNumber}`;
}

function makeSectionId(sectionIndex: number): string {
  return `section-${sectionIndex}`;
}

function resolveReferenceStepNumber(section: any, referenceIndex: number | null | undefined): number | undefined {
  if (!Number.isInteger(referenceIndex) || referenceIndex === null || referenceIndex === undefined) {
    return undefined;
  }
  const content = section?.content?.[referenceIndex];
  if (content?.type === "step") {
    return Number(content.value.number);
  }
  return undefined;
}

function extractEditableTokens(
  text: string,
  recipe: any,
  temperatureExtractions: TemperatureExtraction[] = [],
): EditableQuantityToken[] {
  const ingredientMatches = collectQuantityMatches(text, /@([^{}]+?)\{([^}]*)\}/g);
  const timerMatches = collectQuantityMatches(text, /~\{([^}]*)\}/g);
  // Both `^{...}` and `%{...}` are extracted by extractTemperatures before the
  // Cooklang parser runs (the WASM lib in use doesn't natively recognize
  // `%{}`), so `recipe.inlineQuantities` is always empty and we drive inline
  // tokens entirely from the temperatureExtractions list.

  const tokens: EditableQuantityToken[] = [];
  let ingredientIndex = 0;
  let timerIndex = 0;

  for (const ingredient of recipe.ingredients) {
    if (!ingredient.quantity) continue;
    const match = ingredientMatches[ingredientIndex++];
    if (!match) continue;
    tokens.push({
      id: `ingredient:${ingredientIndex - 1}`,
      kind: "ingredient",
      label: ingredient_display_name(ingredient),
      quantityText: match.quantityText,
      units: getQuantityUnit(ingredient.quantity) || match.units,
      numericValue: getQuantityValue(ingredient.quantity),
      range: extractRange(ingredient.quantity),
      rangeStart: match.rangeStart,
      rangeEnd: match.rangeEnd,
    });
  }

  for (const timer of recipe.timers) {
    if (!timer.quantity) continue;
    const match = timerMatches[timerIndex++];
    if (!match) continue;
    tokens.push({
      id: `timer:${timerIndex - 1}`,
      kind: "timer",
      label: timer.name || "Timer",
      quantityText: match.quantityText,
      units: getQuantityUnit(timer.quantity) || match.units,
      numericValue: getQuantityValue(timer.quantity),
      range: extractRange(timer.quantity),
      rangeStart: match.rangeStart,
      rangeEnd: match.rangeEnd,
    });
  }

  for (let i = 0; i < temperatureExtractions.length; i++) {
    const temp = temperatureExtractions[i];
    const quantityText = typeof temp.quantity === "number" ? String(temp.quantity) : temp.quantity;
    const token: EditableQuantityToken = {
      id: `${temp.is_temperature ? "temperature" : "inlineQuantity"}:${i}`,
      kind: "inlineQuantity",
      label: temp.is_temperature ? "Temperature" : "Inline quantity",
      quantityText,
      units: temp.units,
      numericValue: typeof temp.quantity === "number" ? temp.quantity : null,
      range: temp.range,
      rangeStart: temp.rangeStart,
      rangeEnd: temp.rangeEnd,
    };
    if (temp.is_temperature) token.measurementKind = "temperature";
    tokens.push(token);
  }

  return tokens.sort((a, b) => a.rangeStart - b.rangeStart);
}

function collectQuantityMatches(text: string, pattern: RegExp) {
  const matches: Array<{
    quantityText: string;
    units: string;
    rangeStart: number;
    rangeEnd: number;
  }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const payload = String(match[2] || match[1] || "");
    const parsed = parseQuantityPayload(payload);
    if (!parsed) continue;
    const relativeStart = match[0].indexOf(parsed.quantityText);
    if (relativeStart < 0) continue;
    matches.push({
      quantityText: parsed.quantityText,
      units: parsed.units,
      rangeStart: match.index + relativeStart,
      rangeEnd: match.index + relativeStart + parsed.quantityText.length,
    });
  }
  return matches;
}

function parseQuantityPayload(payload: string): { quantityText: string; units: string } | null {
  const trimmed = String(payload || "").trim();
  if (!trimmed || !trimmed.includes("%")) return null;
  const split = trimmed.indexOf("%");
  const quantityText = trimmed.slice(0, split).trim();
  const units = trimmed.slice(split + 1).trim();
  if (!quantityText) return null;
  return { quantityText, units };
}

export function scaleIngredient(
  quantity: string | number,
  factor: number
): string {
  if (quantity === "" || quantity === null || quantity === undefined) return "";
  const n = parseFloat(String(quantity));
  if (isNaN(n)) return String(quantity);
  const scaled = n * factor;
  // Nice fractions for small numbers
  if (scaled === Math.floor(scaled)) return String(scaled);
  const rounded = Math.round(scaled * 8) / 8;
  return rounded % 1 === 0 ? String(rounded) : rounded.toFixed(2).replace(/\.?0+$/, "");
}
