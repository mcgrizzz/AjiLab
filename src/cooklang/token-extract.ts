// ── Editable token extraction + prose-temperature splitter ──────────────────
// extractEditableTokens enumerates every (ingredient | timer | inlineQuantity)
// annotation in a recipe's raw text and returns a list with `rangeStart` /
// `rangeEnd` offsets the editor uses to drive click-to-edit. The text + parsed
// recipe are both needed: we walk the raw text to find spans, and walk the
// parser output in lockstep to attach display labels and converted numerics.
//
// splitTextIntoParsedSteps recognizes prose temperature mentions (`200°C`,
// `20-22°F`) inside a plain text token and splits them into structured
// inlineQuantity tokens so the renderer can format them and the diff can
// pair them. Used both by parseCooklang's text emission path and by the
// fallback inside temperature.ts::splitTextWithTemperatures.

import {
  getQuantityUnit,
  getQuantityValue,
  ingredient_display_name,
} from "@cooklang/cooklang";
import type { ParsedStep, EditableQuantityToken } from "../cooklang.ts";
import { extractRange } from "../cooklang.ts";
import type { TemperatureExtraction } from "./temperature.ts";

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

export function makeStepId(sectionIndex: number, stepNumber: number): string {
  return `section-${sectionIndex}-step-${stepNumber}`;
}

export function makeSectionId(sectionIndex: number): string {
  return `section-${sectionIndex}`;
}

export function extractEditableTokens(
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
