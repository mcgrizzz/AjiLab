import {
  CooklangParser,
  getQuantityValue,
  getQuantityUnit,
  grouped_quantity_display,
  quantity_display,
  ingredient_display_name,
  cookware_display_name,
} from "@cooklang/cooklang";
import { evaluateExpression } from "./metric-expr.ts";

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
  // `!+ ` / `!~ ` / `!- `. The prefix is stripped from the rendered text.
  deviation?: "added" | "modified" | "skipped";
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

function parseSortableNumber(value: string | number): number | null {
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
function extractRange(quantity: any): QuantityRange | null {
  const value = quantity?.value ?? null;
  if (!value || value.type !== "range") return null;
  const r = value.value;
  const min = Number(r?.start);
  const max = Number(r?.end);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max };
}

// `^{...}` is our extension for explicit temperature/measurement specs. The
// Cooklang parser doesn't know `^`, and we don't want to rewrite `^` to `%`
// because if the parser fails to recognize the result it leaks the wrong char
// back to the user. Instead, we extract `^{...}` ourselves before parsing,
// replace each occurrence with a private-use Unicode placeholder Cooklang
// treats as plain text, and splice synthesized temperature tokens back into
// the step output during emission.
const TEMP_MARK_START = "";
const TEMP_MARK_END = "";
const TEMP_PLACEHOLDER_RE = new RegExp(`${TEMP_MARK_START}(\\d+)${TEMP_MARK_END}`, "g");

interface TemperatureExtraction {
  rangeStart: number;
  rangeEnd: number;
  body: string;
  quantity: string | number;
  units: string;
  range: QuantityRange | null;
  display: string;
}

// Parses the body of a `^{...}` token. Accepts canonical `value%unit` form and
// natural notation like `550°F`, `20-22°C`, `200 fahrenheit`.
function parseTemperatureBody(body: string): { quantity: string | number; units: string; range: QuantityRange | null } {
  const trimmed = String(body || "").trim();
  if (!trimmed) return { quantity: "", units: "", range: null };
  let valuePart = trimmed;
  let unitPart = "";
  const pctIdx = trimmed.indexOf("%");
  if (pctIdx >= 0) {
    valuePart = trimmed.slice(0, pctIdx).trim();
    unitPart = trimmed.slice(pctIdx + 1).trim();
  } else {
    const m = trimmed.match(/^\s*([\d.]+(?:\s*[-–]\s*[\d.]+)?)\s*(.+?)\s*$/);
    if (m) {
      valuePart = m[1].trim();
      unitPart = m[2].trim();
    }
  }
  const rangeMatch = valuePart.match(/^([\d.]+)\s*[-–]\s*([\d.]+)$/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    if (Number.isFinite(min) && Number.isFinite(max)) {
      return { quantity: valuePart, units: unitPart, range: { min, max } };
    }
  }
  const num = Number(valuePart);
  return {
    quantity: Number.isFinite(num) && valuePart !== "" ? num : valuePart,
    units: unitPart,
    range: null,
  };
}

// Build the human-readable string we render in step text. For known temperature
// units we normalize to `°F` / `°C` regardless of how the source spelled it; for
// other units we space-separate. The raw `^{540-550%F}` source becomes `540-550°F`
// on screen, not the literal body with `%`.
function formatTemperatureDisplay(quantity: string | number, units: string): string {
  const q = String(quantity);
  const u = String(units || "").trim();
  if (!u) return q;
  const lower = u.toLowerCase();
  if (lower === "f" || lower === "°f" || lower === "fahrenheit") return `${q}°F`;
  if (lower === "c" || lower === "°c" || lower === "celsius") return `${q}°C`;
  return `${q} ${u}`;
}

// Cook log deviation markers: `!+ ` (added) / `!~ ` (modified) / `!- ` (skipped)
// at the start of a step. `~` is Cooklang's timer sigil, so a literal `!~ ` at
// line start gets mangled by the parser (`~ rest of line` becomes a timer).
// preprocessDeviationMarkers swaps `!~ ` → `! ` before parsing so the
// parser sees plain text; detectDeviation accepts the swapped char as well.
const DEVIATION_MOD_MARKER = "";

function preprocessDeviationMarkers(text: string): string {
  // Only swap when followed by whitespace — `!~name` (no space) isn't a
  // deviation marker and shouldn't be touched.
  return text.replace(/^!~(?=\s)/gm, `!${DEVIATION_MOD_MARKER}`);
}

function detectDeviation(items: any[]): "added" | "modified" | "skipped" | undefined {
  const first = items?.[0];
  if (!first || first.type !== "text" || typeof first.value !== "string") return undefined;
  const m = first.value.match(/^\s*!([+\-])\s+/);
  if (!m) return undefined;
  first.value = first.value.slice(m[0].length);
  return m[1] === "+" ? "added" : m[1] === DEVIATION_MOD_MARKER ? "modified" : "skipped";
}

function extractTemperatures(text: string): { cleaned: string; extractions: TemperatureExtraction[] } {
  const extractions: TemperatureExtraction[] = [];
  const cleaned = text.replace(/\^\{([^}]*)\}/g, (fullMatch, body, offset) => {
    const parsed = parseTemperatureBody(body);
    const i = extractions.length;
    // Locate the quantity text inside the original match so editable tokens
    // can replace just the number rather than the whole `^{...}` block.
    const valueText = typeof parsed.quantity === "number" ? String(parsed.quantity) : parsed.quantity;
    const relativeStart = valueText ? fullMatch.indexOf(valueText) : -1;
    const rangeStart = relativeStart >= 0 ? offset + relativeStart : offset;
    const rangeEnd = relativeStart >= 0 ? rangeStart + valueText.length : offset + fullMatch.length;
    extractions.push({
      rangeStart,
      rangeEnd,
      body,
      quantity: parsed.quantity,
      units: parsed.units,
      range: parsed.range,
      display: formatTemperatureDisplay(parsed.quantity, parsed.units),
    });
    return `${TEMP_MARK_START}${i}${TEMP_MARK_END}`;
  });
  return { cleaned, extractions };
}

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
    const { cleaned: tempCleaned, extractions: temperatureExtractions } = extractTemperatures(text);
    // `!~ ` at line start would otherwise be eaten by Cooklang's `~` timer
    // sigil. Swap to a private-use char (offset-preserved) so the parser sees
    // plain text; detectDeviation reads the marker back at step emission time.
    const cleaned = preprocessDeviationMarkers(tempCleaned);
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
    const ingredientSections: ParsedIngredientSection[] = recipe.sections.map((section: any) => {
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

    // Flatten sections → step token arrays (same shape the client expects)
    const steps: ParsedStep[][] = [];
    let sectionIndex = 0;
    for (const section of recipe.sections) {
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
      sectionIndex += 1;
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

// ── Computed metrics ──────────────────────────────────────────────────────────
// `>> metric.<display name>: <expression> [| <format unit>]` declares a derived
// value. The expression layer (src/metric-expr.ts) handles arithmetic; we
// supply the ingredient-lookup context here.

const METRIC_UNIT_TABLE: Record<string, { category: "mass" | "volume"; factor: number }> = {
  g: { category: "mass", factor: 1 },
  gram: { category: "mass", factor: 1 },
  grams: { category: "mass", factor: 1 },
  kg: { category: "mass", factor: 1000 },
  kilogram: { category: "mass", factor: 1000 },
  kilograms: { category: "mass", factor: 1000 },
  mg: { category: "mass", factor: 0.001 },
  milligram: { category: "mass", factor: 0.001 },
  milligrams: { category: "mass", factor: 0.001 },
  ml: { category: "volume", factor: 1 },
  milliliter: { category: "volume", factor: 1 },
  milliliters: { category: "volume", factor: 1 },
  millilitre: { category: "volume", factor: 1 },
  millilitres: { category: "volume", factor: 1 },
  l: { category: "volume", factor: 1000 },
  liter: { category: "volume", factor: 1000 },
  liters: { category: "volume", factor: 1000 },
  litre: { category: "volume", factor: 1000 },
  litres: { category: "volume", factor: 1000 },
};

function metricUnitKey(unit: string | null | undefined): string {
  return String(unit || "").trim().toLowerCase().replace(/\.$/, "");
}

// Canonical key for ingredient-name comparison in metric formulas. Whitespace
// collapses to a single `_` so `@whole wheat flour{}` is addressable as
// `whole_wheat_flour` in expressions. Case-insensitive.
function normalizeMetricIngredientName(name: string): string {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, "_");
}

function convertMetricQuantity(qty: number, fromUnit: string, toUnit: string): number | null {
  const f = METRIC_UNIT_TABLE[metricUnitKey(fromUnit)];
  const t = METRIC_UNIT_TABLE[metricUnitKey(toUnit)];
  if (!f || !t) return null;
  if (f.category !== t.category) return null;
  return (qty * f.factor) / t.factor;
}

function extractComputedMetrics(
  metadata: Record<string, string>,
  ingredientSummary: ParsedIngredientSummary,
): ComputedMetric[] {
  const prefix = "metric.";
  const metricKeys = Object.keys(metadata).filter((k) => k.toLowerCase().startsWith(prefix));
  if (metricKeys.length === 0) return [];

  // Pull aggregated ingredients into a case-insensitive, underscore-normalized
  // map so multi-word ingredient names like `@whole wheat flour{}` are
  // addressable from formulas as `whole_wheat_flour` — no braces required, so
  // metrics work cleanly inside YAML front matter too. Each `flat` entry
  // already represents one *cooklang* grouping (e.g. `@flour{200%g}` +
  // `@&flour{300%g}` → one entry with quantity 500); duplicate names without
  // `@&` are intentionally distinct ingredients per spec.
  const lookupByName = new Map<string, ParsedIngredient>();
  for (const ing of ingredientSummary.flat) {
    lookupByName.set(normalizeMetricIngredientName(ing.name), ing);
  }

  // Previously-computed metric values, keyed by normalized name. Lets later
  // metrics reference earlier ones via `metric.<name>` in their formula —
  // resolved in declaration order, so forward refs fail.
  const metricValues = new Map<string, number>();

  const metrics: ComputedMetric[] = [];
  for (const rawKey of metricKeys) {
    const name = rawKey.slice(prefix.length).trim();
    const rawValue = String(metadata[rawKey] || "");
    delete metadata[rawKey]; // strip so it doesn't leak into step-text metadata filter
    if (!name) continue;

    // `<formula> | <flag-or-unit> | <flag-or-unit>...`
    // First segment is the expression. Each `|`-separated tail piece is either
    // the special flag `hidden` or the (single) format unit.
    const segments = rawValue.split("|").map((s) => s.trim());
    const formulaText = segments[0] || "";
    let formatUnit: string | null = null;
    let hidden = false;
    for (let i = 1; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      if (seg.toLowerCase() === "hidden") { hidden = true; continue; }
      if (formatUnit === null) { formatUnit = seg; continue; }
      // additional segments are ignored — keep it simple
    }

    if (!formulaText) {
      metrics.push({ name, formula: "", format_unit: formatUnit, hidden, value: null, display: null, error: "empty formula" });
      continue;
    }

    const ctx = {
      lookup(path: string[]): number | string | null {
        // Metric reference: `metric.<name>` resolves to a previously-computed
        // metric. The metric must have been declared earlier in the file.
        if (path.length >= 2 && path[0].toLowerCase() === "metric") {
          const metricKey = normalizeMetricIngredientName(path.slice(1).join("_"));
          const v = metricValues.get(metricKey);
          if (v === undefined) {
            // Distinguish "doesn't exist" from "declared later" to help
            // the user spot ordering bugs without trial and error.
            const declaredLater = metricKeys.some(
              (k) => normalizeMetricIngredientName(k.slice(prefix.length)) === metricKey,
            );
            return declaredLater
              ? `metric '${path.slice(1).join(".")}' is referenced before it's defined`
              : `unknown metric '${path.slice(1).join(".")}'`;
          }
          return v;
        }
        // Ingredient lookup: path is `[name]` (no unit) or `[name, unit]`.
        if (path.length > 2) {
          return `unknown reference '${path.join(".")}'`;
        }
        const ingredientName = path[0];
        const unit = path[1] || null;
        const ing = lookupByName.get(normalizeMetricIngredientName(ingredientName));
        if (!ing) return null;
        const qty = parseSortableNumber(ing.quantity);
        if (qty === null) {
          return `ingredient '${ingredientName}' has no numeric quantity`;
        }
        if (!unit) return qty;
        const source = ing.units || "";
        if (!source) {
          return `ingredient '${ingredientName}' has no unit, cannot convert to ${unit}`;
        }
        const converted = convertMetricQuantity(qty, source, unit);
        if (converted === null) {
          return `cannot convert ${source} → ${unit} for '${ingredientName}'`;
        }
        return converted;
      },
    };

    const evald = evaluateExpression(formulaText, ctx);
    if (!evald.ok) {
      metrics.push({ name, formula: formulaText, format_unit: formatUnit, hidden, value: null, display: null, error: evald.error });
      continue;
    }
    metricValues.set(normalizeMetricIngredientName(name), evald.value);
    metrics.push({
      name,
      formula: formulaText,
      format_unit: formatUnit,
      hidden,
      value: evald.value,
      display: formatMetricDisplay(evald.value, formatUnit),
      error: null,
    });
  }
  return metrics;
}

function formatMetricDisplay(value: number, formatUnit: string | null): string {
  const u = formatUnit ? formatUnit.trim() : "";
  if (u === "%") return `${stripTrailingZeros(value.toFixed(1))}%`;
  // Mass/volume display as whole numbers when possible.
  if (METRIC_UNIT_TABLE[metricUnitKey(u)]) {
    const rounded = Math.round(value * 10) / 10;
    return `${stripTrailingZeros(rounded.toFixed(1))} ${u}`;
  }
  if (u) return `${stripTrailingZeros(value.toFixed(2))} ${u}`;
  return stripTrailingZeros(value.toFixed(2));
}

function stripTrailingZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

// Walks a text item from the parser output, splits on temperature placeholders
// inserted by extractTemperatures, and injects synthesized temperature tokens.
// Surrounding text segments are run through the prose temp splitter so inline
// `200°C` mentions still surface as structured tokens.
function splitTextWithTemperatures(
  text: string,
  meta: Partial<ParsedStep>,
  extractions: TemperatureExtraction[],
): ParsedStep[] {
  if (!text) return [{ type: "text", value: "", ...meta }];
  const tokens: ParsedStep[] = [];
  TEMP_PLACEHOLDER_RE.lastIndex = 0;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = TEMP_PLACEHOLDER_RE.exec(text))) {
    if (m.index > lastIdx) {
      tokens.push(...splitTextIntoParsedSteps(text.slice(lastIdx, m.index), meta));
    }
    const temp = extractions[Number(m[1])];
    if (temp) {
      tokens.push({
        type: "inlineQuantity",
        value: temp.display,
        quantity: temp.quantity,
        units: temp.units,
        range: temp.range,
        kind: "temperature",
        ...meta,
      });
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    tokens.push(...splitTextIntoParsedSteps(text.slice(lastIdx), meta));
  }
  return tokens.length ? tokens : splitTextIntoParsedSteps(text, meta);
}

function splitTextIntoParsedSteps(text: string, meta: Partial<ParsedStep> = {}): ParsedStep[] {
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
  // Only `%{...}` survives into recipe.inlineQuantities — `^{...}` is extracted
  // separately by extractTemperatures before parsing.
  const inlineMatches = collectQuantityMatches(text, /%\{([^}]*)\}/g);

  const tokens: EditableQuantityToken[] = [];
  let ingredientIndex = 0;
  let timerIndex = 0;
  let inlineIndex = 0;

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

  for (const inlineQuantity of recipe.inlineQuantities) {
    const match = inlineMatches[inlineIndex++];
    if (!match) continue;
    tokens.push({
      id: `inlineQuantity:${inlineIndex - 1}`,
      kind: "inlineQuantity",
      label: "Inline quantity",
      quantityText: match.quantityText,
      units: getQuantityUnit(inlineQuantity) || match.units,
      numericValue: getQuantityValue(inlineQuantity),
      range: extractRange(inlineQuantity),
      rangeStart: match.rangeStart,
      rangeEnd: match.rangeEnd,
    });
  }

  for (let i = 0; i < temperatureExtractions.length; i++) {
    const temp = temperatureExtractions[i];
    const quantityText = typeof temp.quantity === "number" ? String(temp.quantity) : temp.quantity;
    tokens.push({
      id: `temperature:${i}`,
      kind: "inlineQuantity",
      measurementKind: "temperature",
      label: "Temperature",
      quantityText,
      units: temp.units,
      numericValue: typeof temp.quantity === "number" ? temp.quantity : null,
      range: temp.range,
      rangeStart: temp.rangeStart,
      rangeEnd: temp.rangeEnd,
    });
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
