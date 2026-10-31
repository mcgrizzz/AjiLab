// Server access to the shared unit logic in public/js/units.js, so the browser
// and the server convert and compare amounts with one implementation.
import "../public/js/units.js";

export interface Amount {
  quantity?: unknown;
  units?: unknown;
  range?: { min: number; max: number } | null;
}

interface SharedUnits {
  sameAmount(a: Amount, b: Amount): boolean;
  temperatureKey(unit: unknown): "F" | "C" | null;
}

const Units = (globalThis as unknown as { Units: SharedUnits }).Units;

// Same amount once units are converted (450 °F = ^{450%F} = 232 °C,
// 1 L = 1000 ml, 25 min = 25 minutes). Used so diffs skip pure formatting.
export function sameAmount(a: Amount, b: Amount): boolean {
  return Units.sameAmount(a, b);
}
