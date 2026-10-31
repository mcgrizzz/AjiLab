// Server access to the shared unit logic in public/js/units.js, so the browser
// and the server convert and compare amounts with one implementation.
import "../public/js/units.js";

export interface Amount {
  quantity?: unknown;
  units?: unknown;
  range?: { min: number; max: number } | null;
}

export type AmountComparison = "same" | "near" | "different";

interface SharedUnits {
  compareAmounts(a: Amount, b: Amount): AmountComparison;
  sameAmount(a: Amount, b: Amount): boolean;
  percentChange(a: Amount, b: Amount): number | null;
  comparableUnits(aUnits: unknown, bUnits: unknown): boolean;
  temperatureKey(unit: unknown): "F" | "C" | null;
}

const Units = (globalThis as unknown as { Units: SharedUnits }).Units;

// Same amount once units are converted (450 °F = ^{450%F} = 232 °C,
// 1 L = 1000 ml, 25 min = 25 minutes). Used so diffs skip pure formatting.
export function sameAmount(a: Amount, b: Amount): boolean {
  return Units.sameAmount(a, b);
}

// 'same' | 'near' (across units within 2%, e.g. 1 cup vs 240 ml) | 'different'.
export function compareAmounts(a: Amount, b: Amount): AmountComparison {
  return Units.compareAmounts(a, b);
}

// Percent change a → b after unit conversion; null when not comparable.
export function percentChange(a: Amount, b: Amount): number | null {
  return Units.percentChange(a, b);
}

export function comparableUnits(aUnits: unknown, bUnits: unknown): boolean {
  return Units.comparableUnits(aUnits, bUnits);
}

export function temperatureKey(unit: unknown): "F" | "C" | null {
  return Units.temperatureKey(unit);
}
