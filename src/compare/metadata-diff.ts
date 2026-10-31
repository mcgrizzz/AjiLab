// ── Metadata diff ────────────────────────────────────────────────────────────
// Frontmatter (`---` YAML block) and legacy `>> key: value` lines are recipe
// metadata, not method. The compare view lists their changes in a collapsed
// "Metadata" group instead of as a phantom "Step 1".

import { inlineWordDiff } from "./inline-diff.ts";
import type { InlineDiffToken } from "./types.ts";

export interface MetadataChange {
  key: string;
  kind: "changed" | "added" | "removed";
  from: string | null;
  to: string | null;
  // For "changed": word-level diff, so only AP_flour → Bread_flour lights up
  // inside a long formula.
  inline_tokens?: InlineDiffToken[];
}

// Split a leading `---` … `---` frontmatter block off the recipe text.
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const lines = String(text || "").split(/\r?\n/);
  let start = 0;
  while (start < lines.length && lines[start].trim() === "") start++;
  if (lines[start]?.trim() !== "---") return { frontmatter: null, body: String(text || "") };
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      return {
        frontmatter: lines.slice(start + 1, i).join("\n"),
        body: lines.slice(i + 1).join("\n"),
      };
    }
  }
  return { frontmatter: null, body: String(text || "") };
}

// Top-level `key: value` entries of a frontmatter block. Indented lines
// continue the previous key (block scalars like `notes: |-`).
function frontmatterEntries(frontmatter: string): Array<[string, string]> {
  const entries: Array<[string, string[]]> = [];
  for (const line of frontmatter.split("\n")) {
    const m = line.match(/^([^\s#][^:]*):(?:\s+(.*))?$/);
    if (m) {
      const first = (m[2] ?? "").trim();
      entries.push([m[1].trim(), /^[|>][-+]?$/.test(first) ? [] : [first]]);
    } else if (entries.length) {
      entries[entries.length - 1][1].push(line.trim());
    }
  }
  return entries.map(([key, parts]) => [key, parts.join("\n").trim()]);
}

export function metadataEntries(text: string): Map<string, string> {
  const { frontmatter, body } = splitFrontmatter(text);
  const out = new Map<string, string>();
  if (frontmatter !== null) {
    for (const [key, value] of frontmatterEntries(frontmatter)) out.set(key, value);
  }
  for (const line of body.split(/\r?\n/)) {
    const m = line.trim().match(/^>>\s*([^:]+):\s*(.*)$/);
    if (m) out.set(m[1].trim(), m[2].trim());
  }
  return out;
}

export function diffMetadata(fromText: string, toText: string): MetadataChange[] {
  const from = metadataEntries(fromText);
  const to = metadataEntries(toText);
  const out: MetadataChange[] = [];
  for (const [key, value] of from) {
    if (!to.has(key)) out.push({ key, kind: "removed", from: value, to: null });
    else if (to.get(key) !== value) {
      const next = to.get(key) ?? "";
      out.push({ key, kind: "changed", from: value, to: next, inline_tokens: inlineWordDiff(value, next) });
    }
  }
  for (const [key, value] of to) {
    if (!from.has(key)) out.push({ key, kind: "added", from: null, to: value });
  }
  return out;
}
