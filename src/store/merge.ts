// ── 3-way merge for cooklang text (pure) ─────────────────────────────────────
// Used by branch sync and by adopting a test made from an older version:
// given the common ancestor (base) and the two divergent versions (ours,
// theirs), produce either a merged text or a list of conflicting hunks. The algorithm is line-level: each side's line diff
// against base gives its edit hunks, and overlapping hunks are conflicts.
// Identical hunks are not conflicts.
//
// DB-touching wrappers (previewBranchSync, applyBranchSync, syncPreviewContext)
// stay in recipe-store.ts; this file is pure.

import { diffArrays } from "diff";

export type MergeEdit = { baseStart: number; baseEnd: number; replacement: string[] };

// Each separate run of changed lines is its own edit, so changes in different
// steps never collide.
export function lineEdits(base: string, next: string): MergeEdit[] {
  if (base === next) return [];
  const edits: MergeEdit[] = [];
  let position = 0;
  let current: MergeEdit | null = null;
  for (const part of diffArrays(base.split("\n"), next.split("\n"))) {
    const count = part.count ?? part.value.length;
    if (!part.added && !part.removed) {
      if (current) { edits.push(current); current = null; }
      position += count;
      continue;
    }
    if (!current) current = { baseStart: position, baseEnd: position, replacement: [] };
    if (part.removed) {
      position += count;
      current.baseEnd = position;
    } else {
      current.replacement.push(...part.value);
    }
  }
  if (current) edits.push(current);
  return edits;
}

export function editsOverlap(a: MergeEdit, b: MergeEdit): boolean {
  if (a.baseStart === a.baseEnd && b.baseStart === b.baseEnd) return a.baseStart === b.baseStart;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

export function applyEdits(baseLines: string[], edits: MergeEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.baseStart - b.baseStart);
  const out: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    out.push(...baseLines.slice(cursor, edit.baseStart));
    out.push(...edit.replacement);
    cursor = edit.baseEnd;
  }
  out.push(...baseLines.slice(cursor));
  return out.join("\n");
}

export function mergeCooklangText(base: string, ours: string, theirs: string) {
  if (theirs === base) return { status: "noop" as const, merged_text: ours, conflicts: [] };
  if (ours === base || ours === theirs) return { status: "clean" as const, merged_text: theirs, conflicts: [] };
  if (theirs === ours) return { status: "clean" as const, merged_text: ours, conflicts: [] };
  const ourEdits = lineEdits(base, ours);
  const theirEdits = lineEdits(base, theirs);
  // The same edit made on both sides is applied once.
  const same = (a: MergeEdit, b: MergeEdit) => JSON.stringify(a) === JSON.stringify(b);
  const theirOwnEdits = theirEdits.filter((edit) => !ourEdits.some((ours) => same(ours, edit)));
  const conflicts: Array<Record<string, unknown>> = [];
  for (const ourEdit of ourEdits) {
    for (const theirEdit of theirOwnEdits) {
      if (!editsOverlap(ourEdit, theirEdit)) continue;
      conflicts.push({
        base_start: ourEdit.baseStart,
        base_end: Math.max(ourEdit.baseEnd, theirEdit.baseEnd),
        ours: ourEdit.replacement.join("\n"),
        theirs: theirEdit.replacement.join("\n"),
      });
    }
  }
  if (conflicts.length) return { status: "conflict" as const, merged_text: null, conflicts };
  return { status: "clean" as const, merged_text: applyEdits(base.split("\n"), [...ourEdits, ...theirOwnEdits]), conflicts: [] };
}
