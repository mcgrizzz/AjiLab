// ── Computed metrics ──────────────────────────────────────────────────────────
// `>> metric.<display name>: <expression> [| <format unit>]` declares a derived
// value. The expression layer (src/metric-expr.ts) handles arithmetic; we
// supply the ingredient-lookup context here.

import { evaluateExpression } from "../metric-expr.ts";
import { parseSortableNumber } from "../cooklang.ts";
import type {
  ComputedMetric,
  ParsedIngredient,
  ParsedIngredientSummary,
} from "../cooklang.ts";

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

export function extractComputedMetrics(
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
  // Each is [low, high]: a range in the recipe (`@water{365-380%g}`, "choose
  // your hydration") gives a range out. The formula is worked out once with
  // every range at its low end and once at its high end, the recipe as made
  // at either end, so hydration reads 73-76%.
  const metricValues = new Map<string, [number, number]>();

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

    const ctxAt = (end: 0 | 1) => ({
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
          return v[end];
        }
        // Ingredient lookup: path is `[name]` (no unit) or `[name, unit]`.
        if (path.length > 2) {
          return `unknown reference '${path.join(".")}'`;
        }
        const ingredientName = path[0];
        const unit = path[1] || null;
        const ing = lookupByName.get(normalizeMetricIngredientName(ingredientName));
        if (!ing) return null;
        const bounds = quantityBounds(ing.quantity);
        const qty = bounds ? bounds[end] : null;
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
    });

    const low = evaluateExpression(formulaText, ctxAt(0));
    const high = low.ok ? evaluateExpression(formulaText, ctxAt(1)) : low;
    if (!low.ok || !high.ok) {
      const error = !low.ok ? low.error : (high as { error: string }).error;
      metrics.push({ name, formula: formulaText, format_unit: formatUnit, hidden, value: null, display: null, error });
      continue;
    }
    metricValues.set(normalizeMetricIngredientName(name), [low.value, high.value]);
    // A ratio can fall as an amount rises (more flour, lower hydration).
    const min = Math.min(low.value, high.value);
    const max = Math.max(low.value, high.value);
    const display = formatMetricDisplay(min, formatUnit, max);
    const metric: ComputedMetric = {
      name,
      formula: formulaText,
      format_unit: formatUnit,
      hidden,
      value: min,
      display,
      error: null,
    };
    if (display !== formatMetricDisplay(min, formatUnit)) metric.range = { min, max };
    metrics.push(metric);
  }
  return metrics;
}

// A range shows both ends ("73-76%"), or one number when they round alike.
function formatMetricDisplay(value: number, formatUnit: string | null, high: number = value): string {
  const u = formatUnit ? formatUnit.trim() : "";
  const number = (v: number) => {
    if (u === "%") return stripTrailingZeros(v.toFixed(1));
    // Mass/volume display as whole numbers when possible.
    if (METRIC_UNIT_TABLE[metricUnitKey(u)]) return stripTrailingZeros((Math.round(v * 10) / 10).toFixed(1));
    return stripTrailingZeros(v.toFixed(2));
  };
  const shown = number(value) === number(high) ? number(value) : `${number(value)}-${number(high)}`;
  if (u === "%") return `${shown}%`;
  return u ? `${shown} ${u}` : shown;
}

// An amount's low and high ends: [n, n] for one number, [365, 380] for
// "365-380", fractions allowed at either end ("1 1/2-2"). Null if it isn't a
// number at all.
function quantityBounds(quantity: string | number): [number, number] | null {
  const single = parseSortableNumber(quantity);
  if (single !== null) return [single, single];
  const range = String(quantity ?? "").trim().match(/^(.+?)\s*[-–]\s*(.+)$/);
  if (!range) return null;
  const lo = parseSortableNumber(range[1]);
  const hi = parseSortableNumber(range[2]);
  return lo !== null && hi !== null ? [lo, hi] : null;
}

function stripTrailingZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
