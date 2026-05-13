import * as Diff from "diff";

export { diffIngredients } from "./ingredient-compare.js";

export type DiffToken =
  | { op: "context"; text: string }
  | { op: "added"; text: string }
  | { op: "removed"; text: string };

// Inline step-diff token. `replace` is a single coalesced change region:
// adjacent removed/added pieces (and any short context squished between them)
// merged into one logical swap so the renderer can show `old → new`.
export type InlineDiffToken =
  | { op: "context"; text: string }
  | { op: "replace"; removed: string; added: string };

export type DiffLineEntry =
  | { kind: "header" | "hunk" | "context"; text: string }
  | { kind: "added" | "removed"; prefix: string; tokens: DiffToken[] };

// Walks a unified patch and, for each consecutive `-` / `+` block, pairs the
// changed lines and runs an intra-line word diff so the renderer can highlight
// just the substrings that actually differ. Unpaired removals / additions
// (e.g. a pure deletion or insertion) fall through with a single token.
export function buildInlineDiffLines(patch: string): DiffLineEntry[] {
  const lines = patch.split("\n");
  const out: DiffLineEntry[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("---") || line.startsWith("+++")) {
      out.push({ kind: "header", text: line });
      i += 1;
      continue;
    }
    if (line.startsWith("@@")) {
      out.push({ kind: "hunk", text: line });
      i += 1;
      continue;
    }
    if (line.startsWith("\\")) {
      out.push({ kind: "context", text: line });
      i += 1;
      continue;
    }
    if (line.startsWith("-")) {
      const removed: string[] = [];
      const added: string[] = [];
      while (i < lines.length && lines[i].startsWith("-") && !lines[i].startsWith("---")) {
        removed.push(lines[i].slice(1));
        i += 1;
      }
      while (i < lines.length && lines[i].startsWith("+") && !lines[i].startsWith("+++")) {
        added.push(lines[i].slice(1));
        i += 1;
      }
      const pairs = Math.min(removed.length, added.length);
      for (let j = 0; j < pairs; j++) {
        const [removedTokens, addedTokens] = wordDiffTokens(removed[j], added[j]);
        out.push({ kind: "removed", prefix: "-", tokens: removedTokens });
        out.push({ kind: "added", prefix: "+", tokens: addedTokens });
      }
      for (let j = pairs; j < removed.length; j++) {
        out.push({ kind: "removed", prefix: "-", tokens: [{ op: "removed", text: removed[j] }] });
      }
      for (let j = pairs; j < added.length; j++) {
        out.push({ kind: "added", prefix: "+", tokens: [{ op: "added", text: added[j] }] });
      }
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ kind: "added", prefix: "+", tokens: [{ op: "added", text: line.slice(1) }] });
      i += 1;
      continue;
    }
    out.push({ kind: "context", text: line });
    i += 1;
  }
  return out;
}

function wordDiffTokens(oldStr: string, newStr: string): [DiffToken[], DiffToken[]] {
  const parts = (Diff as any).diffWordsWithSpace(oldStr, newStr);
  const removed: DiffToken[] = [];
  const added: DiffToken[] = [];
  for (const part of parts) {
    if (part.added) {
      added.push({ op: "added", text: part.value });
    } else if (part.removed) {
      removed.push({ op: "removed", text: part.value });
    } else {
      removed.push({ op: "context", text: part.value });
      added.push({ op: "context", text: part.value });
    }
  }
  return [removed, added];
}

// ── Step-level diff ──────────────────────────────────────────────────────────
// Groups raw cooklang into ordered blocks (section heads, steps, notes), pairs
// them across versions by section + ordinal, and emits a list of changes —
// each carrying its own context (section name, step number) and a token-level
// intra-step word diff so the surrounding sentence stays readable.

export type StepBlock = {
  kind: "step" | "note";
  section_name: string | null;
  step_number: number | null; // 1-indexed within the section, null for notes
  text: string;
};

export type StepChange =
  | { kind: "modified"; section_name: string | null; step_number: number | null; block_kind: "step" | "note"; inline_tokens: InlineDiffToken[] }
  | { kind: "added"; section_name: string | null; step_number: number | null; block_kind: "step" | "note"; text: string }
  | { kind: "removed"; section_name: string | null; step_number: number | null; block_kind: "step" | "note"; text: string };

export function diffStepBlocks(fromText: string, toText: string): StepChange[] {
  const fromGroups = groupBySectionName(parseBlocks(fromText));
  const toGroups = groupBySectionName(parseBlocks(toText));
  const out: StepChange[] = [];
  const usedToKeys = new Set<string>();
  // Walk from-sections in source order so the diff matches reading order.
  for (const { name: sectionName, blocks: fromBlocks } of fromGroups) {
    const key = sectionKey(sectionName);
    const toEntry = toGroups.find((g) => sectionKey(g.name) === key);
    if (!toEntry) {
      for (const block of fromBlocks) {
        out.push({ kind: "removed", section_name: sectionName, step_number: block.step_number, block_kind: block.kind, text: block.text });
      }
      continue;
    }
    usedToKeys.add(key);
    diffSectionBlocks(sectionName, fromBlocks, toEntry.blocks, out);
  }
  for (const { name: sectionName, blocks: toBlocks } of toGroups) {
    if (usedToKeys.has(sectionKey(sectionName))) continue;
    for (const block of toBlocks) {
      out.push({ kind: "added", section_name: sectionName, step_number: block.step_number, block_kind: block.kind, text: block.text });
    }
  }
  return out;
}

function diffSectionBlocks(
  sectionName: string | null,
  fromBlocks: StepBlock[],
  toBlocks: StepBlock[],
  out: StepChange[],
) {
  // Pair blocks positionally within the section. Real recipes rarely reorder
  // steps; LCS would be overkill and brittle for short lists.
  const pairs = Math.min(fromBlocks.length, toBlocks.length);
  for (let i = 0; i < pairs; i++) {
    const f = fromBlocks[i];
    const t = toBlocks[i];
    if (f.text === t.text) continue; // unchanged
    out.push({
      kind: "modified",
      section_name: sectionName,
      step_number: f.step_number,
      block_kind: f.kind,
      inline_tokens: inlineWordDiff(f.text, t.text),
    });
  }
  for (let i = pairs; i < fromBlocks.length; i++) {
    const b = fromBlocks[i];
    out.push({ kind: "removed", section_name: sectionName, step_number: b.step_number, block_kind: b.kind, text: b.text });
  }
  for (let i = pairs; i < toBlocks.length; i++) {
    const b = toBlocks[i];
    out.push({ kind: "added", section_name: sectionName, step_number: b.step_number, block_kind: b.kind, text: b.text });
  }
}

// Produces a coalesced inline stream: alternating context segments and
// single `replace` items. Each replace is one contiguous change region —
// all the removed text on one side, all the added text on the other,
// including any short shared context between them (e.g. `°C` between
// `28°C-30°C` and `26.5°C`). Renderer draws each replace as `old → new`.
function inlineWordDiff(oldStr: string, newStr: string): InlineDiffToken[] {
  const parts = (Diff as any).diffWordsWithSpace(oldStr, newStr) as Array<{ value: string; added?: boolean; removed?: boolean }>;
  const out: InlineDiffToken[] = [];
  let i = 0;
  while (i < parts.length) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      // Plain context. Will get pulled into a change region downstream if it
      // sits between two changes and is short; otherwise emit as-is.
      if (isShortBoundary(part.value) && hasChangeAround(parts, i)) {
        // Fall through to the change-collector below.
      } else {
        out.push({ op: "context", text: part.value });
        i += 1;
        continue;
      }
    }
    // Start a change region. Greedily extend through any removed/added and
    // any short context that's flanked by more change content.
    let removed = "";
    let added = "";
    while (i < parts.length) {
      const cur = parts[i];
      if (cur.removed) { removed += cur.value; i += 1; continue; }
      if (cur.added) { added += cur.value; i += 1; continue; }
      // Context. Fold into the region if it's a short bridge between changes.
      if (isShortBoundary(cur.value)) {
        const next = findNextChange(parts, i + 1);
        if (next !== -1 && onlyShortContextBetween(parts, i, next)) {
          for (let k = i; k < next; k++) {
            removed += parts[k].value;
            added += parts[k].value;
          }
          i = next;
          continue;
        }
      }
      break;
    }
    out.push({ op: "replace", removed, added });
  }
  return out;
}

function isShortBoundary(text: string): boolean {
  // A "short bridge" is something like `°C`, `%`, `:` — too short to be a
  // meaningful piece of preserved sentence context. We require no whitespace
  // so we don't accidentally absorb a real word.
  return text.length > 0 && text.length <= 4 && !/\s/.test(text);
}

function findNextChange(parts: Array<{ added?: boolean; removed?: boolean }>, from: number): number {
  for (let i = from; i < parts.length; i++) {
    if (parts[i].added || parts[i].removed) return i;
  }
  return -1;
}

function onlyShortContextBetween(parts: Array<{ value: string; added?: boolean; removed?: boolean }>, from: number, to: number): boolean {
  for (let i = from; i < to; i++) {
    if (parts[i].added || parts[i].removed) return false;
    if (!isShortBoundary(parts[i].value)) return false;
  }
  return true;
}

function hasChangeAround(parts: Array<{ added?: boolean; removed?: boolean }>, i: number): boolean {
  const before = i > 0 && (parts[i - 1].added || parts[i - 1].removed);
  const after = i + 1 < parts.length && (parts[i + 1].added || parts[i + 1].removed);
  return Boolean(before && after);
}

function parseBlocks(text: string): StepBlock[] {
  const out: StepBlock[] = [];
  let currentSection: string | null = null;
  let stepIndex = 0; // step counter within the current section
  // Paragraph blocks are separated by blank lines. Section headings (`= Name`)
  // and metadata (`>> key: value`) get their own implicit boundaries.
  const lines = text.split(/\r?\n/);
  const paragraphs: string[][] = [[]];
  for (const raw of lines) {
    if (raw.trim() === "") {
      if (paragraphs[paragraphs.length - 1].length > 0) paragraphs.push([]);
    } else {
      paragraphs[paragraphs.length - 1].push(raw);
    }
  }
  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) continue;
    const joined = paragraph.join("\n").trim();
    if (!joined) continue;
    const firstLine = paragraph[0].trim();
    if (firstLine.startsWith("=")) {
      // Section heading. Strip leading `=` runs and trailing trim runs.
      const name = firstLine.replace(/^=+\s*/, "").replace(/\s*=+$/, "").trim() || null;
      currentSection = name;
      stepIndex = 0;
      continue;
    }
    if (firstLine.startsWith(">>")) {
      // Metadata line — these are header-y, surfaced separately if needed.
      // Skip from step diff to avoid noisy "metadata changed" entries.
      continue;
    }
    if (firstLine.startsWith(">") && !firstLine.startsWith(">>")) {
      out.push({ kind: "note", section_name: currentSection, step_number: null, text: joined });
      continue;
    }
    stepIndex += 1;
    out.push({ kind: "step", section_name: currentSection, step_number: stepIndex, text: joined });
  }
  return out;
}

function groupBySectionName(blocks: StepBlock[]): Array<{ name: string | null; blocks: StepBlock[] }> {
  const groups: Array<{ name: string | null; blocks: StepBlock[] }> = [];
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
