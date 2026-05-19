// ── Inline quantity sigil `%{...}` ───────────────────────────────────────────
// The Cooklang spec defines `%{value%unit}` as a generic inline quantity
// (a number-with-unit that isn't an ingredient, cookware, or timer). The WASM
// build we use does not parse it natively, so extractTemperatures (in
// temperature.ts) peels these out alongside `^{...}` and we re-emit them as
// inlineQuantity tokens — without the `kind: "temperature"` tag.

import type { QuantityRange } from "../cooklang.ts";

// Parses `%{...}` body. Accepts `<value>%<unit>` and bare value forms.
// Ranges like `180-200` produce a structured range with shared units.
export function parseInlineQuantityBody(body: string): { quantity: string | number; units: string; range: QuantityRange | null } {
  const trimmed = String(body || "").trim();
  if (!trimmed) return { quantity: "", units: "", range: null };
  const [rawQty, rawUnit = ""] = trimmed.split("%", 2);
  const units = rawUnit.trim();
  const qty = rawQty.trim();
  const rangeMatch = qty.match(/^(-?\d+(?:\.\d+)?)\s*[-–]\s*(-?\d+(?:\.\d+)?)$/);
  if (rangeMatch) {
    const min = Number(rangeMatch[1]);
    const max = Number(rangeMatch[2]);
    return { quantity: qty, units, range: { min, max } };
  }
  const n = Number(qty);
  if (Number.isFinite(n) && qty !== "") {
    return { quantity: n, units, range: null };
  }
  return { quantity: qty, units, range: null };
}

export function formatInlineQuantityDisplay(quantity: string | number, units: string, range: QuantityRange | null): string {
  const qty = range
    ? (range.min === range.max ? String(range.min) : `${range.min}-${range.max}`)
    : (quantity == null ? "" : String(quantity));
  if (!qty && !units) return "";
  if (!units) return qty;
  return `${qty} ${units}`;
}
