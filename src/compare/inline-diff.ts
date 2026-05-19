// ── Inline word-level diff (text-patch style) ───────────────────────────────
// Two related but distinct outputs:
//
//   - buildInlineDiffLines: walks a unified-patch string and, for each paired
//     removed/added line block, runs a word diff so the renderer can highlight
//     just the substrings that differ.
//
//   - inlineWordDiff: takes two raw strings (one step's "from" and "to" text)
//     and returns a coalesced stream of context + `replace` regions, where
//     each replace is one logical "old → new" swap with any short shared
//     context (`°C`, `:`) folded into the change. Used by the step-diff
//     module to produce per-step inline_tokens.

import * as Diff from "diff";
import type { DiffToken, InlineDiffToken, DiffLineEntry } from "./types.ts";

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

// Produces a coalesced inline stream: alternating context segments and
// single `replace` items. Each replace is one contiguous change region —
// all the removed text on one side, all the added text on the other,
// including any short shared context between them (e.g. `°C` between
// `28°C-30°C` and `26.5°C`). Renderer draws each replace as `old → new`.
export function inlineWordDiff(oldStr: string, newStr: string): InlineDiffToken[] {
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
