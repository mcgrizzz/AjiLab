// ── Section-aware step diff ──────────────────────────────────────────────────
// Groups raw cooklang into ordered blocks (section heads, steps, notes), pairs
// them across versions by section + ordinal, and emits a list of changes —
// each carrying its own context (section name, step number) and a token-level
// intra-step word diff so the surrounding sentence stays readable.

import type { StepBlock, StepChange } from "./types.ts";
import { inlineWordDiff } from "./inline-diff.ts";

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
