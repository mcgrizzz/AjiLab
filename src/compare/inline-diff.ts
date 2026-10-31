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
  return snapToNumbers(out);
}

// Widen each change to whole numbers: "for 2[+.5] hours" reads as
// "for [2 → 2.5] hours". Number pieces at the edge of neighbouring context
// move into both sides of the change.
function snapToNumbers(tokens: InlineDiffToken[]): InlineDiffToken[] {
  const numberish = /[\d.]/;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.op !== "replace") continue;
    const prev = tokens[i - 1];
    const startsNumeric = numberish.test(token.removed[0] || "") || numberish.test(token.added[0] || "");
    if (prev?.op === "context" && startsNumeric) {
      const tail = prev.text.match(/\d[\d.]*$/)?.[0] || "";
      if (tail) {
        prev.text = prev.text.slice(0, -tail.length);
        token.removed = token.removed ? tail + token.removed : tail;
        token.added = token.added ? tail + token.added : tail;
      }
    }
    const next = tokens[i + 1];
    const endsNumeric = numberish.test(token.removed.slice(-1)) || numberish.test(token.added.slice(-1));
    if (next?.op === "context" && endsNumeric) {
      const head = next.text.match(/^[\d.]*\d/)?.[0] || "";
      if (head) {
        next.text = next.text.slice(head.length);
        token.removed = token.removed ? token.removed + head : head;
        token.added = token.added ? token.added + head : head;
      }
    }
  }
  return tidyEdges(mergeAcrossSpaces(tokens.filter((token) => token.op !== "context" || token.text !== "")));
}

// Changes split only by a space are one change: "[1 → 240] [cup → ml]" reads
// as "[1 cup → 240 ml]", and "[+,] [+and water (30 g)]" as one added phrase
// instead of a lone-comma chip.
function mergeAcrossSpaces(tokens: InlineDiffToken[]): InlineDiffToken[] {
  const merged: InlineDiffToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const prev = merged[merged.length - 1];
    const next = tokens[i + 1];
    if (token.op === "context" && /^\s{1,2}$/.test(token.text) && prev?.op === "replace" && next?.op === "replace") {
      prev.removed += token.text + next.removed;
      prev.added += token.text + next.added;
      i += 1;
      continue;
    }
    merged.push(token.op === "replace" ? { ...token } : token);
  }
  return merged;
}

// Whitespace both sides of a change share at its edges belongs to the
// surrounding sentence, not the highlighted chip.
function tidyEdges(tokens: InlineDiffToken[]): InlineDiffToken[] {
  const out: InlineDiffToken[] = [];
  const pushContext = (text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.op === "context") last.text += text;
    else out.push({ op: "context", text });
  };
  for (const token of tokens) {
    if (token.op === "context") {
      pushContext(token.text);
      continue;
    }
    let { removed, added } = token;
    let lead = 0;
    while (lead < Math.min(removed.length, added.length) && removed[lead] === added[lead] && /\s/.test(removed[lead])) lead++;
    let trail = 0;
    while (
      trail < Math.min(removed.length, added.length) - lead
      && removed[removed.length - 1 - trail] === added[added.length - 1 - trail]
      && /\s/.test(removed[removed.length - 1 - trail])
    ) trail++;
    pushContext(removed.slice(0, lead));
    const tail = trail ? removed.slice(removed.length - trail) : "";
    removed = removed.slice(lead, removed.length - trail);
    added = added.slice(lead, added.length - trail);
    if (removed || added) out.push({ op: "replace", removed, added });
    pushContext(tail);
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
