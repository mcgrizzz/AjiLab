// ── Section-aware step diff ──────────────────────────────────────────────────
// Groups raw cooklang into ordered blocks (steps, notes) per section, pairs
// them across versions by section and word similarity, and emits a list of changes —
// each carrying its own context (section name, step number) and a token-level
// intra-step word diff so the surrounding sentence stays readable.
//
// Both sides are compared as the reader sees them, not as written:
// `@flour{45%g}` reads "flour (45 g)", `^{450%F}` and plain "450 °F" both read
// "450°F". So a step only shows as changed when what it says changed.
// Step numbers count across the whole recipe, matching the Overview.

import type { StepBlock, StepChange } from "./types.ts";
import { inlineWordDiff } from "./inline-diff.ts";
import { splitFrontmatter } from "./metadata-diff.ts";
import { parseCooklang } from "../cooklang.ts";
import type { ParsedStep } from "../cooklang.ts";
import { temperatureKey } from "../quantity.ts";

type Group = { name: string | null; blocks: StepBlock[] };

export interface StepDiffOptions {
  // Show (and compare) every temperature in this unit, as the Overview's
  // Temps toggle does. Omit to keep each side as written.
  temperatureUnit?: "C" | "F" | null;
}

export function diffStepBlocks(fromText: string, toText: string, options: StepDiffOptions = {}): StepChange[] {
  const fromGroups = groupBySectionName(parseBlocks(fromText, options));
  const toGroups = groupBySectionName(parseBlocks(toText, options));
  const out: StepChange[] = [];
  for (const [fromGroup, toGroup] of pairGroups(fromGroups, toGroups)) {
    if (fromGroup && toGroup) {
      if (sectionKey(fromGroup.name) !== sectionKey(toGroup.name)) {
        out.push({ kind: "section-renamed", section_name: toGroup.name, from_section_name: fromGroup.name });
      }
      diffSectionBlocks(toGroup.name, fromGroup.blocks, toGroup.blocks, out);
    } else if (fromGroup) {
      for (const block of fromGroup.blocks) out.push(blockChange("removed", fromGroup.name, block));
    } else if (toGroup) {
      for (const block of toGroup.blocks) out.push(blockChange("added", toGroup.name, block));
    }
  }
  return out;
}

function blockChange(kind: "added" | "removed", sectionName: string | null, block: StepBlock): StepChange {
  return { kind, section_name: sectionName, step_number: block.step_number, block_kind: block.kind, text: block.text };
}

// Pair sections across versions in reading order (of the newer side). Same
// name pairs first; a leftover section sitting where a leftover section was
// (same neighbour before it) is a rename ("Day before" → "1-3 Days before").
function pairGroups(fromGroups: Group[], toGroups: Group[]): Array<[Group | null, Group | null]> {
  const toMatch: number[] = toGroups.map(() => -1);
  const fromUsed = new Set<number>();
  toGroups.forEach((toGroup, j) => {
    const i = fromGroups.findIndex((g, idx) => !fromUsed.has(idx) && sectionKey(g.name) === sectionKey(toGroup.name));
    if (i >= 0) {
      toMatch[j] = i;
      fromUsed.add(i);
    }
  });
  toGroups.forEach((_, j) => {
    if (toMatch[j] >= 0) return;
    const i = j === 0 ? 0 : toMatch[j - 1] + 1;
    if ((j === 0 || toMatch[j - 1] >= 0) && i < fromGroups.length && !fromUsed.has(i)) {
      toMatch[j] = i;
      fromUsed.add(i);
    }
  });

  const pairs: Array<[Group | null, Group | null]> = [];
  const emitted = new Set<number>();
  let next = 0;
  toGroups.forEach((toGroup, j) => {
    const i = toMatch[j];
    if (i >= 0) {
      // Sections dropped before this one read best right where they were.
      for (; next < i; next++) {
        if (!fromUsed.has(next) && !emitted.has(next)) {
          pairs.push([fromGroups[next], null]);
          emitted.add(next);
        }
      }
      pairs.push([fromGroups[i], toGroup]);
      next = Math.max(next, i + 1);
    } else {
      pairs.push([null, toGroup]);
    }
  });
  fromGroups.forEach((group, i) => {
    if (!fromUsed.has(i) && !emitted.has(i)) pairs.push([group, null]);
  });
  return pairs;
}

function diffSectionBlocks(
  sectionName: string | null,
  fromBlocks: StepBlock[],
  toBlocks: StepBlock[],
  out: StepChange[],
) {
  for (const [f, t] of alignBlocks(fromBlocks, toBlocks)) {
    if (f && t) {
      if (f.text === t.text) continue; // unchanged
      out.push({
        kind: "modified",
        section_name: sectionName,
        step_number: t.step_number,
        from_step_number: f.step_number,
        block_kind: t.kind,
        inline_tokens: inlineWordDiff(f.text, t.text),
      });
    } else if (f) {
      out.push(blockChange("removed", sectionName, f));
    } else if (t) {
      out.push(blockChange("added", sectionName, t));
    }
  }
}

// ── Pairing steps by similarity ──
// A step inserted mid-section should read as one added step, not as every
// later step "changed" into the next one. Blocks pair in order, maximizing
// the total word overlap; a pair needs at least MATCH_THRESHOLD in common,
// otherwise the old block reads as removed and the new one as added.

const MATCH_THRESHOLD = 0.3;

function blockWords(text: string): Set<string> {
  // Letters only: amounts and numbers change between versions of the same step.
  return new Set(text.toLowerCase().match(/[a-z]+/g) || []);
}

function wordOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function blockSimilarity(a: StepBlock, b: StepBlock, aWords: Set<string>, bWords: Set<string>): number {
  if (a.kind !== b.kind) return 0;
  if (a.text === b.text) return 1.5; // identical blocks anchor the alignment
  return wordOverlap(aWords, bWords);
}

export function alignBlocks(from: StepBlock[], to: StepBlock[]): Array<[StepBlock | null, StepBlock | null]> {
  const n = from.length;
  const m = to.length;
  const fromWords = from.map((b) => blockWords(b.text));
  const toWords = to.map((b) => blockWords(b.text));
  const sim = (i: number, j: number) => blockSimilarity(from[i], to[j], fromWords[i], toWords[j]);
  // best[i][j]: best total for from[i..] against to[j..].
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const s = sim(i, j);
      const match = s >= MATCH_THRESHOLD ? s + best[i + 1][j + 1] : -Infinity;
      best[i][j] = Math.max(match, best[i + 1][j], best[i][j + 1]);
    }
  }
  const pairs: Array<[StepBlock | null, StepBlock | null]> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m) {
      const s = sim(i, j);
      if (s >= MATCH_THRESHOLD && s + best[i + 1][j + 1] >= best[i][j] - 1e-9) {
        pairs.push([from[i++], to[j++]]);
        continue;
      }
      // Removed before added, so a replaced step reads old → new.
      if (best[i + 1][j] >= best[i][j + 1]) pairs.push([from[i++], null]);
      else pairs.push([null, to[j++]]);
    } else if (i < n) {
      pairs.push([from[i++], null]);
    } else {
      pairs.push([null, to[j++]]);
    }
  }
  return pairs;
}

function parseBlocks(text: string, options: StepDiffOptions): StepBlock[] {
  const out: StepBlock[] = [];
  let currentSection: string | null = null;
  let stepNumber = 0; // counts across the whole recipe, like the Overview
  // Paragraph blocks are separated by blank lines. Section headings (`= Name`)
  // and metadata (`>> key: value`) get their own implicit boundaries.
  const lines = splitFrontmatter(text).body.split(/\r?\n/);
  const paragraphs: string[][] = [[]];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith(">>")) {
      if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
      continue;
    }
    if (line.startsWith("=")) {
      // A heading ends the paragraph before it and stands alone, so a step
      // written on the next line ("= Day before\nDo a refeed…") is kept.
      if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
      paragraphs[paragraphs.length - 1].push(raw);
      paragraphs.push([]);
      continue;
    }
    paragraphs[paragraphs.length - 1].push(raw);
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    const joined = paragraph.join("\n").trim();
    if (!joined) continue;
    const firstLine = paragraph[0].trim();
    if (firstLine.startsWith("=")) {
      currentSection = firstLine.replace(/^=+\s*/, "").replace(/\s*=+$/, "").trim() || null;
      continue;
    }
    if (firstLine.startsWith(">") || firstLine.startsWith("--")) {
      out.push({ kind: "note", section_name: currentSection, step_number: null, text: readableText(joined, options.temperatureUnit) });
      continue;
    }
    stepNumber += 1;
    out.push({ kind: "step", section_name: currentSection, step_number: stepNumber, text: readableText(joined, options.temperatureUnit) });
  }
  return out;
}

// ── Readable text ──

function quantityText(quantity: unknown, units: string): string {
  let qty = String(quantity ?? "").trim();
  if (units && qty.endsWith(units)) qty = qty.slice(0, -units.length).trim();
  return qty.replace(/\s*[-–]\s*/g, "-");
}

function temperatureText(quantity: unknown, units: string): string {
  return `${quantityText(quantity, units)}°${temperatureKey(units)}`;
}

function tokenText(token: ParsedStep): string {
  switch (token.type) {
    case "ingredient": {
      const qty = quantityText(token.quantity, token.units || "");
      const amount = qty ? ` (${[qty, token.units].filter(Boolean).join(" ")})` : "";
      const note = token.note ? ` (${token.note})` : "";
      return `${token.name || token.value}${amount}${note}${token.optional ? " (optional)" : ""}`;
    }
    case "cookware":
      return token.name || token.value;
    case "inlineQuantity":
      if (token.kind === "temperature" || temperatureKey(token.units)) return temperatureText(token.quantity, token.units || "");
      return token.value;
    default:
      return token.value || "";
  }
}

// Same rounding as the Overview (cooklang-render.js formatTemperatureNumber).
function temperatureNumber(value: number): string {
  const rounded = Math.abs(value - Math.round(value)) < 0.05 ? Math.round(value) : Number(value.toFixed(1));
  return String(rounded);
}

function convertTemperature(value: number, from: string, to: string): number {
  if (from === to) return value;
  return to === "F" ? (value * 9) / 5 + 32 : ((value - 32) * 5) / 9;
}

// Write temperatures one way however they were typed: "450 °F" → "450°F",
// "23°C–25°C" → "23-25°C"; then into `unit` if one was picked.
function normalizeTemperatures(text: string, unit: "C" | "F" | null | undefined): string {
  const tidy = text
    .replace(/(\d+(?:\.\d+)?)\s*°\s*([CF])\b/g, "$1°$2")
    .replace(/(\d+(?:\.\d+)?)°([CF])\s*[-–]\s*(\d+(?:\.\d+)?)°\2/g, "$1-$3°$2");
  if (!unit) return tidy;
  return tidy.replace(/(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?°([CF])\b/g, (match, a, b, from) => {
    if (from === unit) return match;
    const first = temperatureNumber(convertTemperature(parseFloat(a), from, unit));
    const second = b === undefined ? null : temperatureNumber(convertTemperature(parseFloat(b), from, unit));
    return `${first}${second === null ? "" : `-${second}`}°${unit}`;
  });
}

// The block as the reader sees it in the Overview. Falls back to the raw text
// if it doesn't parse.
export function readableText(raw: string, temperatureUnit: "C" | "F" | null = null): string {
  let text = raw;
  try {
    const parsed = parseCooklang(raw);
    if (!parsed.error && parsed.steps.length) {
      text = parsed.steps.map((step) => step.map(tokenText).join("")).join(" ");
    }
  } catch {
    // keep raw
  }
  return normalizeTemperatures(text.replace(/\s+/g, " ").trim(), temperatureUnit);
}

function groupBySectionName(blocks: StepBlock[]): Group[] {
  const groups: Group[] = [];
  for (const block of blocks) {
    const last = groups[groups.length - 1];
    if (last && sectionKey(last.name) === sectionKey(block.section_name)) {
      last.blocks.push(block);
    } else {
      groups.push({ name: block.section_name, blocks: [block] });
    }
  }
  return groups;
}

function sectionKey(name: string | null): string {
  return name === null ? "__default__" : `name:${name.toLowerCase()}`;
}
