import {
  CooklangParser,
  getQuantityValue,
  getQuantityUnit,
  grouped_quantity_display,
  quantity_display,
  ingredient_display_name,
  cookware_display_name,
} from "@cooklang/cooklang";

const parser = new CooklangParser();

export interface ParsedIngredient {
  name: string;
  quantity: string | number;
  units: string;
  optional?: boolean;
  recipe_reference?: boolean;
  intermediate?: boolean;
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
  quantity?: string | number;
  units?: string;
  step_id?: string;
  step_number?: number;
  section_index?: number;
  reference_target?: "ingredient" | "step" | "section" | null;
  reference_step_number?: number;
  reference_step_id?: string;
}

export interface EditableQuantityToken {
  id: string;
  kind: "ingredient" | "timer" | "inlineQuantity";
  label: string;
  quantityText: string;
  units: string;
  numericValue: number | null;
  rangeStart: number;
  rangeEnd: number;
}

export interface ParsedRecipe {
  ingredients: ParsedIngredient[];
  ingredient_summary: ParsedIngredientSummary;
  cookwares: string[];
  metadata: Record<string, string>;
  steps: ParsedStep[][];
  editable_tokens: EditableQuantityToken[];
  error?: string;
}

function emptyIngredientSummary(): ParsedIngredientSummary {
  return {
    mode_default: "flat",
    flat: [],
    sections: [],
    has_multiple_sections: false,
  };
}

function toParsedIngredient(ingredient: any): ParsedIngredient {
  return {
    name: ingredient_display_name(ingredient),
    quantity: extractQty(ingredient.quantity),
    units: getQuantityUnit(ingredient.quantity) || "",
  };
}

function toParsedIngredientWithAnnotations(ingredient: any, annotations: ComponentAnnotation | undefined): ParsedIngredient {
  return {
    ...toParsedIngredient(ingredient),
    optional: annotations?.optional || false,
    recipe_reference: annotations?.recipe || false,
    intermediate: annotations?.intermediate || false,
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
      if (modifier === "&") annotation.intermediate = true;
      index += 1;
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

function toGroupedParsedIngredient(ingredient: any, groupedQuantity: any, annotation: ComponentAnnotation | undefined): ParsedIngredient {
  const parsed = toParsedIngredientWithAnnotations(ingredient, annotation);
  const normalized = normalizeGroupedQuantity(groupedQuantity);
  if (!normalized) return parsed;
  return {
    ...parsed,
    quantity: normalized.quantity,
    units: normalized.units,
  };
}

function normalizeGroupedQuantity(groupedQuantity: any): { quantity: string | number; units: string } | null {
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
    };
  }
  if (knownValues.length === 0 && unknownValues.length === 0 && groupedQuantity.no_unit && !(groupedQuantity.other || []).length) {
    return {
      quantity: extractQty(groupedQuantity.no_unit),
      units: getQuantityUnit(groupedQuantity.no_unit) || "",
    };
  }
  return {
    quantity: grouped_quantity_display(groupedQuantity),
    units: "",
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
  const n = getQuantityValue(quantity);
  if (n !== null && !isNaN(n)) return n;
  // Fallback for fractions/text: use display string but strip the unit
  // (unit is tracked separately) to avoid "1/8 tsp" + "tsp" → "1/8 tsp tsp"
  const display = quantity_display(quantity);
  if (!display) return "";
  const unit = getQuantityUnit(quantity);
  if (unit && display.endsWith(unit)) {
    return display.slice(0, -unit.length).trim() || display;
  }
  return display;
}

export function parseCooklang(text: string): ParsedRecipe {
  if (!text || !text.trim()) {
    return {
      ingredients: [],
      ingredient_summary: emptyIngredientSummary(),
      cookwares: [],
      metadata: {},
      steps: [],
      editable_tokens: [],
    };
  }
  try {
    const [recipe] = parser.parse(text);
    const ingredientAnnotations = collectComponentAnnotations(text, "@");
    const cookwareAnnotations = collectComponentAnnotations(text, "#");

    // Build metadata as plain object from rawMetadata Map
    const metadata: Record<string, string> = {};
    for (const [key, value] of recipe.rawMetadata) {
      metadata[String(key)] = String(value);
    }
    if (recipe.servings !== undefined && !metadata.servings) {
      metadata.servings = String(recipe.servings);
    }
    if (recipe.description && !metadata.description) {
      metadata.description = recipe.description;
    }
    // Expose custom_metadata entries (e.g. notes) that rawMetadata may key differently
    for (const [key, value] of recipe.custom_metadata) {
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
          if (!shouldIncludeIngredientSummaryItem(annotation)) continue;
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
    const editableTokens = extractEditableTokens(text, recipe);

    // Flatten sections → step token arrays (same shape the client expects)
    const steps: ParsedStep[][] = [];
    let sectionIndex = 0;
    for (const section of recipe.sections) {
      if (section.name) {
        steps.push([{ type: "text", value: `= ${section.name}` }]);
      }
      for (const content of section.content) {
        if (content.type === "text") {
          steps.push([{ type: "comment", value: content.value }]);
        } else if (content.type === "step") {
          const stepNumber = content.value.number;
          const stepId = makeStepId(sectionIndex, stepNumber);
          const tokens: ParsedStep[] = content.value.items.flatMap((item: any) => {
            switch (item.type) {
              case "text":
                return splitTextIntoParsedSteps(item.value, {
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                });
              case "ingredient": {
                const ing = recipe.ingredients[item.index];
                const relation = ing.relation?.relation || null;
                const referenceTarget = ing.relation?.reference_target || null;
                const referenceStepNumber = referenceTarget === "step" && relation?.type === "reference"
                  ? resolveReferenceStepNumber(section, Number(relation.references_to))
                  : undefined;
                const referenceStepId = referenceStepNumber ? makeStepId(sectionIndex, referenceStepNumber) : undefined;
                return [{
                  type: "ingredient",
                  value: ingredient_display_name(ing),
                  name: ingredient_display_name(ing),
                  quantity: extractQty(ing.quantity),
                  units: getQuantityUnit(ing.quantity) || "",
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                  reference_target: referenceTarget,
                  reference_step_number: referenceStepNumber,
                  reference_step_id: referenceStepId,
                }];
              }
              case "cookware": {
                const cw = recipe.cookware[item.index];
                return [{
                  type: "cookware",
                  value: cookware_display_name(cw),
                  name: cookware_display_name(cw),
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                }];
              }
              case "timer": {
                const tm = recipe.timers[item.index];
                const q = getQuantityValue(tm.quantity);
                const u = getQuantityUnit(tm.quantity) || "";
                return [{
                  type: "timer",
                  value: tm.quantity ? quantity_display(tm.quantity) : "",
                  quantity: q !== null ? q : (tm.quantity ? quantity_display(tm.quantity) : ""),
                  units: u,
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                }];
              }
              case "inlineQuantity": {
                const iq = recipe.inlineQuantities[item.index];
                return [{
                  type: "inlineQuantity",
                  value: quantity_display(iq),
                  quantity: getQuantityValue(iq.value) ?? quantity_display(iq),
                  units: getQuantityUnit(iq) || "",
                  step_id: stepId,
                  step_number: stepNumber,
                  section_index: sectionIndex,
                }];
              }
              default:
                return [{ type: "text" as const, value: "" }];
            }
          });
          steps.push(tokens);
        }
      }
      sectionIndex += 1;
    }

    return {
      ingredients,
      ingredient_summary: ingredientSummary,
      cookwares,
      metadata,
      steps,
      editable_tokens: editableTokens,
    };
  } catch (e: any) {
    return {
      ingredients: [],
      ingredient_summary: emptyIngredientSummary(),
      cookwares: [],
      metadata: {},
      steps: [],
      editable_tokens: [],
      error: e?.message || "Parse error",
    };
  }
}

function splitTextIntoParsedSteps(text: string, meta: Partial<ParsedStep> = {}): ParsedStep[] {
  if (!text) return [{ type: "text", value: "", ...meta }];
  const tokens: ParsedStep[] = [];
  const pattern = /(\d+(?:\.\d+)?)\s*(°|º)\s*([FCfc])\b/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) {
      tokens.push({ type: "text", value: text.slice(lastIndex, match.index), ...meta });
    }
    const value = match[0];
    const quantity = Number(match[1]);
    const unit = `°${match[3].toUpperCase()}`;
    tokens.push({
      type: "inlineQuantity",
      value,
      quantity,
      units: unit,
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

function extractEditableTokens(text: string, recipe: any): EditableQuantityToken[] {
  const ingredientMatches = collectQuantityMatches(text, /@([^{}]+?)\{([^}]*)\}/g);
  const timerMatches = collectQuantityMatches(text, /~\{([^}]*)\}/g);
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
      rangeStart: match.rangeStart,
      rangeEnd: match.rangeEnd,
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
