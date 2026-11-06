// ── Metric diff ──────────────────────────────────────────────────────────────
// Computed metrics (hydration, salt %, …) are what a baker reads first, so the
// compare view leads with them. Hidden metrics (`| hidden`, `_name`) are
// intermediates and stay out.

import type { ComputedMetric } from "../cooklang.ts";

export interface MetricChange {
  name: string;
  format_unit: string | null;
  kind: "changed" | "same" | "added" | "removed";
  from_display: string | null;
  to_display: string | null;
  // "+26.7 pts" for percentages, "+12.5%" otherwise; null when not numeric.
  delta_display: string | null;
}

function signed(value: number, suffix: string): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : rounded < 0 ? "−" : "±"}${Math.abs(rounded)}${suffix}`;
}

// Work from the numbers as displayed, so 71.6% → 98.3% reads +26.7 pts rather
// than the +26.6 the unrounded values give.
function shownValue(metric: ComputedMetric): number | null {
  const fromDisplay = parseFloat(String(metric.display ?? ""));
  if (Number.isFinite(fromDisplay)) return fromDisplay;
  return metric.value;
}

function delta(from: ComputedMetric, to: ComputedMetric): string | null {
  // 73-76% → 75%: no one number says how far it moved; the two values do.
  if (from.range || to.range) return null;
  const a = shownValue(from);
  const b = shownValue(to);
  if (a === null || b === null) return null;
  if (to.format_unit === "%") return signed(b - a, " pts");
  if (a === 0) return null;
  return signed(((b - a) / Math.abs(a)) * 100, "%");
}

function shown(metric: ComputedMetric): string | null {
  return metric.display ?? (metric.error ? "error" : null);
}

export function diffMetrics(fromMetrics: ComputedMetric[], toMetrics: ComputedMetric[]): MetricChange[] {
  const visible = (list: ComputedMetric[]) => (list || []).filter((m) => !m.hidden);
  const from = new Map(visible(fromMetrics).map((m) => [m.name, m]));
  const out: MetricChange[] = [];
  for (const to of visible(toMetrics)) {
    const prev = from.get(to.name);
    from.delete(to.name);
    if (!prev) {
      out.push({ name: to.name, format_unit: to.format_unit, kind: "added", from_display: null, to_display: shown(to), delta_display: null });
      continue;
    }
    const same = shown(prev) === shown(to);
    out.push({
      name: to.name,
      format_unit: to.format_unit,
      kind: same ? "same" : "changed",
      from_display: shown(prev),
      to_display: shown(to),
      delta_display: same ? null : delta(prev, to),
    });
  }
  for (const prev of from.values()) {
    out.push({ name: prev.name, format_unit: prev.format_unit, kind: "removed", from_display: shown(prev), to_display: null, delta_display: null });
  }
  return out;
}
