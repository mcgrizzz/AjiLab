// ── 3-way merge for cooklang text (pure) ─────────────────────────────────────
// Used by branch sync: given the common ancestor (base) and the two divergent
// versions (ours, theirs), produce either a merged text or a list of
// conflicting hunks. The algorithm is line-level — we trim the longest matching
// prefix and suffix between base and each side to get a single edit hunk, then
// detect overlapping hunks as conflicts. Identical hunks are not conflicts.
//
// DB-touching wrappers (previewBranchSync, applyBranchSync, syncPreviewContext)
// stay in recipe-store.ts; this file is pure.

export type MergeEdit = { baseStart: number; baseEnd: number; replacement: string[] };

export function lineEdits(base: string, next: string): MergeEdit[] {
  if (base === next) return [];
  const baseLines = base.split("\n");
  const nextLines = next.split("\n");
  let prefix = 0;
  while (prefix < baseLines.length && prefix < nextLines.length && baseLines[prefix] === nextLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < (baseLines.length - prefix) &&
    suffix < (nextLines.length - prefix) &&
    baseLines[baseLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
  ) suffix += 1;
  return [{
    baseStart: prefix,
    baseEnd: baseLines.length - suffix,
    replacement: nextLines.slice(prefix, nextLines.length - suffix),
  }];
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
  const conflicts: Array<Record<string, unknown>> = [];
  for (const ourEdit of ourEdits) {
    for (const theirEdit of theirEdits) {
      if (!editsOverlap(ourEdit, theirEdit)) continue;
      if (JSON.stringify(ourEdit) === JSON.stringify(theirEdit)) continue;
      conflicts.push({
        base_start: ourEdit.baseStart,
        base_end: Math.max(ourEdit.baseEnd, theirEdit.baseEnd),
        ours: ourEdit.replacement.join("\n"),
        theirs: theirEdit.replacement.join("\n"),
      });
    }
  }
  if (conflicts.length) return { status: "conflict" as const, merged_text: null, conflicts };
  return { status: "clean" as const, merged_text: applyEdits(base.split("\n"), [...ourEdits, ...theirEdits]), conflicts: [] };
}
