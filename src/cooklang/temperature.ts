// ── Temperature sigil extension `^{...}` ────────────────────────────────────
// AjiLab adds `^{value%unit}` for temperatures (and `^{20-22%C}` for ranges).
// The upstream Cooklang parser doesn't know `^`, and we don't want to rewrite
// `^` to `%` because if the parser fails to recognize the result it leaks the
// wrong char back to the user. Instead, we extract `^{...}` ourselves before
// parsing, replace each occurrence with a private-use Unicode placeholder
// Cooklang treats as plain text, and splice synthesized temperature tokens
// back into the step output during emission.
//
// extractTemperatures also peels off `%{...}` (the Cooklang spec's generic
// inline-quantity sigil) for the same reason — this WASM build doesn't parse
// it natively. The two share placeholder space; only `^` results get tagged
// `kind: "temperature"`.

import { splitTextIntoParsedSteps } from "../cooklang.ts";
import type { ParsedStep, QuantityRange } from "../cooklang.ts";
import {
  parseInlineQuantityBody,
  formatInlineQuantityDisplay,
} from "./inline-quantity.ts";

export const TEMP_MARK_START = "";
export const TEMP_MARK_END = "";
export const TEMP_PLACEHOLDER_RE = new RegExp(
  `${TEMP_MARK_START}(\\d+)${TEMP_MARK_END}`,
  "g",
);

export interface TemperatureExtraction {
  is_temperature: boolean;  // false for `%{...}` (generic inline quantity)
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
export function parseTemperatureBody(body: string): { quantity: string | number; units: string; range: QuantityRange | null } {
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
export function formatTemperatureDisplay(quantity: string | number, units: string): string {
  const q = String(quantity);
  const u = String(units || "").trim();
  if (!u) return q;
  const lower = u.toLowerCase();
  if (lower === "f" || lower === "°f" || lower === "fahrenheit") return `${q}°F`;
  if (lower === "c" || lower === "°c" || lower === "celsius") return `${q}°C`;
  return `${q} ${u}`;
}

export function extractTemperatures(text: string): { cleaned: string; extractions: TemperatureExtraction[] } {
  const extractions: TemperatureExtraction[] = [];
  // Match both `^{...}` (our temperature/measurement sigil) and `%{...}` (the
  // Cooklang spec's generic inline-quantity sigil, which this version of the
  // WASM library does NOT parse natively). We pull both out into placeholders
  // so the parser sees neutral text, then re-emit them as inlineQuantity
  // tokens with `kind: "temperature"` only on the `^` ones.
  const cleaned = text.replace(/([\^%])\{([^}]*)\}/g, (fullMatch, sigil, body, offset) => {
    const isTemp = sigil === "^";
    const parsed = isTemp ? parseTemperatureBody(body) : parseInlineQuantityBody(body);
    const i = extractions.length;
    const valueText = typeof parsed.quantity === "number" ? String(parsed.quantity) : parsed.quantity;
    const relativeStart = valueText ? fullMatch.indexOf(valueText) : -1;
    const rangeStart = relativeStart >= 0 ? offset + relativeStart : offset;
    const rangeEnd = relativeStart >= 0 ? rangeStart + valueText.length : offset + fullMatch.length;
    extractions.push({
      is_temperature: isTemp,
      rangeStart,
      rangeEnd,
      body,
      quantity: parsed.quantity,
      units: parsed.units,
      range: parsed.range,
      display: isTemp
        ? formatTemperatureDisplay(parsed.quantity, parsed.units)
        : formatInlineQuantityDisplay(parsed.quantity, parsed.units, parsed.range),
    });
    return `${TEMP_MARK_START}${i}${TEMP_MARK_END}`;
  });
  return { cleaned, extractions };
}

// Walks a text item from the parser output, splits on temperature placeholders
// inserted by extractTemperatures, and injects synthesized temperature tokens.
// Surrounding text segments are run through the prose temp splitter so inline
// `200°C` mentions still surface as structured tokens.
export function splitTextWithTemperatures(
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
      const token: ParsedStep = {
        type: "inlineQuantity",
        value: temp.display,
        quantity: temp.quantity,
        units: temp.units,
        range: temp.range,
        ...meta,
      };
      if (temp.is_temperature) token.kind = "temperature";
      tokens.push(token);
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    tokens.push(...splitTextIntoParsedSteps(text.slice(lastIdx), meta));
  }
  return tokens.length ? tokens : splitTextIntoParsedSteps(text, meta);
}
