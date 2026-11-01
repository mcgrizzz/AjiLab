// ── Scaling recipe text ──────────────────────────────────────────────────────
// A cook log records what was actually in the bowl, so a 2× cook logs 2×
// amounts. These helpers move recipe text between scales:
//
//   scaleCooklangText(source, 2)              → the source as it reads at 2×
//   unscaleCooklangText(log, 2, source)       → the log back at the recipe's 1×
//
// Only ingredient amounts scale, as on the Overview. Fixed amounts
// (`@salt{=1%tsp}`), timers, temperatures and inline `%{…}` amounts stay as
// written: a 2× bake doesn't fold for 80 minutes at 900°F.

import { scanAnnotations, findIngredientNameStart } from "./mutations.ts";

type Occurrence = {
  name: string;          // lowercased display name
  ordinal: number;       // nth time this name appears
  open: number;          // index of `{`
  close: number;         // index of `}`
  fixed: boolean;
  quantity: string;      // text before `%`
  units: string;         // text after `%` (trimmed)
  rest: string;          // `%…` suffix exactly as written ("" when no units)
};

// Valid scale factors: positive, finite, at most 100×.
export function normalizeScale(value: unknown): number {
  const n = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  if (!Number.isFinite(n) || n <= 0 || n > 100) return 1;
  return Math.round(n * 1000) / 1000;
}

// Text after the YAML frontmatter, so formula and notes text is never touched.
function bodyStart(text: string): number {
  const m = text.match(/^(\s*---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$))/);
  return m ? m[1].length : 0;
}

function ingredientOccurrences(text: string): Occurrence[] {
  const start = bodyStart(text);
  const body = text.slice(start);
  const seen = new Map<string, number>();
  const out: Occurrence[] = [];
  for (const a of scanAnnotations(body)) {
    if (a.kind !== "ingredient" || a.prose) continue;
    const name = body.slice(findIngredientNameStart(body, a.sigil_start), a.name_end)
      .replace(/^\([^)]*\)/, "")
      .trim()
      .toLowerCase();
    const ordinal = seen.get(name) ?? 0;
    seen.set(name, ordinal + 1);
    const content = body.slice(a.brace_open + 1, a.brace_close);
    const fixed = /^\s*=/.test(content);
    const pct = content.indexOf("%");
    const quantity = (pct >= 0 ? content.slice(0, pct) : content).replace(/^\s*=/, "").trim();
    out.push({
      name,
      ordinal,
      open: start + a.brace_open,
      close: start + a.brace_close,
      fixed,
      quantity,
      units: pct >= 0 ? content.slice(pct + 1).trim() : "",
      rest: pct >= 0 ? content.slice(pct) : "",
    });
  }
  return out;
}

// ── Numbers as Cooklang writes them: 500, 1.5, 1/2, 1 1/2, 2-3 ──

const SINGLE = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d*\.?\d+)`;
const SINGLE_RE = new RegExp(`^${SINGLE}$`);
const RANGE_RE = new RegExp(`^(${SINGLE})\\s*([-–])\\s*(${SINGLE})$`);

function parseSingle(text: string): number | null {
  const t = text.trim();
  if (!SINGLE_RE.test(t)) return null;
  const mixed = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return Number(mixed[3]) ? Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]) : null;
  const frac = t.match(/^(\d+)\/(\d+)$/);
  if (frac) return Number(frac[2]) ? Number(frac[1]) / Number(frac[2]) : null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// [low, high] for a range, [n, n] for a single number, null otherwise.
function parseQuantity(text: string): { values: number[]; dash: string } | null {
  const t = text.trim();
  const range = t.match(RANGE_RE);
  if (range) {
    const a = parseSingle(range[1]);
    const b = parseSingle(range[3]);
    return a === null || b === null ? null : { values: [a, b], dash: range[2] };
  }
  const n = parseSingle(t);
  return n === null ? null : { values: [n], dash: "" };
}

function isFractionText(text: string): boolean {
  return /\d\/\d/.test(text);
}

function decimalsOf(text: string): number {
  const m = text.trim().match(/\.(\d+)/);
  return m ? m[1].length : 0;
}

function trimDecimals(n: number, decimals: number): string {
  return n.toFixed(decimals).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

// Nearest kitchen fraction (halves, thirds, quarters, eighths), or null.
function asFraction(n: number): string | null {
  const whole = Math.floor(n + 1e-9);
  const part = n - whole;
  if (part < 1e-6) return String(whole);
  for (const den of [2, 3, 4, 8]) {
    const num = Math.round(part * den);
    if (num > 0 && num < den && Math.abs(part - num / den) < 0.01) {
      return whole ? `${whole} ${num}/${den}` : `${num}/${den}`;
    }
  }
  return null;
}

// How a scaled amount is written: whole numbers stay whole, fractions stay
// fractions where they land on one, otherwise up to two decimals (as the
// Overview shows it).
function formatScaled(n: number, like: string): string {
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  if (isFractionText(like)) {
    const frac = asFraction(n);
    if (frac) return frac;
  }
  return trimDecimals(n, 2);
}

// Back at 1×: the source's precision, widened if rounding would lose more
// than 5% (1.5 eggs stays 1.5, 233.33 g becomes 233 g).
function formatUnscaled(n: number, reference: string | null): string {
  if (reference && isFractionText(reference)) {
    const frac = asFraction(n);
    if (frac) return frac;
  }
  let decimals = reference !== null ? decimalsOf(reference) : (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2);
  while (decimals < 3) {
    const rounded = Number(n.toFixed(decimals));
    if (n === 0 || Math.abs(rounded - n) / Math.abs(n) <= 0.05) break;
    decimals += 1;
  }
  return trimDecimals(n, decimals);
}

function mapQuantity(text: string, fn: (n: number, part: string) => string): string | null {
  const parsed = parseQuantity(text);
  if (!parsed) return null;
  if (parsed.values.length === 1) return fn(parsed.values[0], text.trim());
  const range = text.trim().match(RANGE_RE)!;
  return `${fn(parsed.values[0], range[1])}${parsed.dash}${fn(parsed.values[1], range[3])}`;
}

function sameNumbers(a: string, b: string): boolean {
  const pa = parseQuantity(a);
  const pb = parseQuantity(b);
  if (!pa || !pb || pa.values.length !== pb.values.length) return false;
  return pa.values.every((v, i) => Math.abs(v - pb.values[i]) <= 1e-9 * Math.max(1, Math.abs(v)));
}

function replaceQuantities(text: string, occurrences: Occurrence[], next: (o: Occurrence) => string | null): string {
  let out = "";
  let cursor = 0;
  for (const o of occurrences) {
    const quantity = next(o);
    if (quantity === null || quantity === o.quantity) continue;
    out += text.slice(cursor, o.open + 1) + (o.fixed ? "=" : "") + quantity + o.rest;
    cursor = o.close;
  }
  return out + text.slice(cursor);
}

function scaledQuantity(quantity: string, factor: number): string | null {
  return mapQuantity(quantity, (n, part) => formatScaled(n * factor, part));
}

export function scaleCooklangText(text: string, factor: number): string {
  const scale = normalizeScale(factor);
  if (scale === 1 || !text) return text;
  return replaceQuantities(text, ingredientOccurrences(text), (o) => (o.fixed ? null : scaledQuantity(o.quantity, scale)));
}

// `text` was written at `factor`× of `sourceText`. Bring its amounts back to
// 1×. An amount that still matches the scaled source comes back exactly as the
// source wrote it; a changed one is divided and rounded to the source's
// precision for that ingredient.
export function unscaleCooklangText(text: string, factor: number, sourceText: string): string {
  const scale = normalizeScale(factor);
  if (scale === 1 || !text) return text;
  const sourceByKey = new Map<string, Occurrence>();
  const sourceByName = new Map<string, Occurrence>();
  for (const o of ingredientOccurrences(sourceText || "")) {
    sourceByKey.set(`${o.name}#${o.ordinal}`, o);
    if (!sourceByName.has(o.name)) sourceByName.set(o.name, o);
  }
  return replaceQuantities(text, ingredientOccurrences(text), (o) => {
    const source = sourceByKey.get(`${o.name}#${o.ordinal}`);
    // Fixed in the log, or in the source (a rewrite may have dropped the `=`).
    if (o.fixed || source?.fixed) return null;
    if (source && !source.fixed && source.units === o.units) {
      const expected = scaledQuantity(source.quantity, scale);
      if (expected !== null && sameNumbers(expected, o.quantity)) return source.quantity;
    }
    const reference = source ?? sourceByName.get(o.name) ?? null;
    const sameUnits = reference && reference.units === o.units && parseQuantity(reference.quantity);
    return mapQuantity(o.quantity, (n) => formatUnscaled(n / scale, sameUnits ? reference!.quantity.split(/\s*[-–]\s*/)[0] : null));
  });
}
