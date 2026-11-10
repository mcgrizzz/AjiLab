// ── Versions, tests and the working copy (pure) ──────────────────────────────
// Derivations the loader runs over one branch's entries: which version is
// current, what each test (or the working copy) is based on, which tests are
// open, what a test was adopted as. See docs/VERSIONING-DESIGN.md.

import type { VersionRecord } from "./types.ts";
import { incrementVersionString } from "./version-string.ts";
import { testLabel } from "./row-mappers.ts";

// The newest version by creation. Archived versions are old versions, never
// current.
export function currentVersionOf(versions: VersionRecord[]): VersionRecord | null {
  return versions
    .filter((v) => v.kind === "version" && v.status === "released")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] || null;
}

// Walk parent_version until a version: old betas chain beta → beta, and a
// working copy can be based on a test.
export function baseVersionOf(entry: Pick<VersionRecord, "kind" | "parent_version">, versions: VersionRecord[]): string | null {
  const byString = new Map(versions.filter((v) => v.version_string).map((v) => [v.version_string!, v]));
  let parent = entry.parent_version;
  const seen = new Set<string>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const found = byString.get(parent);
    if (!found) return null;
    if (found.kind === "version") return parent;
    parent = found.parent_version;
  }
  return null;
}

export function nextTestNumber(versions: VersionRecord[]): number {
  return versions.reduce((max, v) => Math.max(max, v.test_number || 0), 0) + 1;
}

// The next test made from this version: its number among that version's tests.
export function nextTestSeq(versions: VersionRecord[], base: string | null): number {
  return versions
    .filter((v) => v.kind === "test" && v.test_seq && (v.test_base ?? null) === (base ?? null))
    .reduce((max, v) => Math.max(max, v.test_seq || 0), 0) + 1;
}

export function nextTestLabel(versions: VersionRecord[], base: string | null): string {
  return testLabel(base, nextTestSeq(versions, base));
}

export function nextVersionString(versions: VersionRecord[], current: VersionRecord | null): string {
  let candidate = current?.version_string ? incrementVersionString(current.version_string) : "v1.0";
  while (versions.some((v) => v.version_string === candidate)) candidate = incrementVersionString(candidate);
  return candidate;
}

// Does the working copy hold anything that isn't saved in a test or version?
// It's compared with what it was started from and the last test saved from
// it. Unchanged when it matches one, or when it's older than them: then the
// difference is a later in-place fix to them, not new work.
export function workingCopyChanged(draft: VersionRecord | null, versions: VersionRecord[]): boolean {
  if (!draft?.cooklang_text.trim()) return false;
  const byString = new Map(versions.filter((v) => v.version_string).map((v) => [v.version_string!, v]));
  const references = [draft.current_beta_version, draft.parent_version]
    .map((key) => (key ? byString.get(key) : undefined))
    .filter((v): v is VersionRecord => !!v);
  if (!references.length) {
    const current = currentVersionOf(versions);
    if (current) references.push(current);
  }
  if (!references.length) return true;
  if (references.some((v) => v.cooklang_text === draft.cooklang_text)) return false;
  return references.every((v) => draft.updated_at.localeCompare(v.updated_at) > 0);
}

export interface CookSummary { n: number; cooked_at: string; outcome: string; recorded_at: string }

// Fill in the derived fields on every entry of a branch (mutates and returns
// the same objects).
export function decorateEntries(
  versions: VersionRecord[],
  draft: VersionRecord | null,
  cooks: Map<string, CookSummary>,
): { current: VersionRecord | null; openTests: VersionRecord[] } {
  const current = currentVersionOf(versions);
  const byId = new Map(versions.map((v) => [v.id, v]));
  for (const v of versions) {
    v.is_current = !!current && v.id === current.id;
    v.open = v.kind === "test" && !v.closed_as;
    if (v.kind === "test") {
      // Named tests store their version; older ones are walked to it.
      v.base_version = v.test_seq ? v.test_base : baseVersionOf(v, versions);
      const adopted = versions
        .filter((other) => other.kind === "version" && other.from_entry_id === v.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      v.adopted_as = adopted?.version_string || null;
      // A test made from it, or from one of its cooks, has it as from_entry_id.
      const follower = versions
        .filter((other) => other.kind === "test" && other.from_entry_id === v.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      v.followed_by = follower?.label || null;
    } else {
      v.base_version = v.parent_version;
    }
    const from = v.from_entry_id ? byId.get(v.from_entry_id) : null;
    v.from_label = from ? from.label : null;
    const cook = cooks.get(v.id);
    v.cook_count = cook?.n || 0;
    v.locked = v.kind === "test" && (v.cook_count > 0 || !!v.closed_as);
    v.last_cooked_at = cook?.cooked_at || null;
    v.last_recorded_at = cook?.recorded_at || null;
    v.last_outcome = cook?.outcome ?? null;
  }
  if (draft) {
    draft.base_version = baseVersionOf(draft, versions);
    const from = draft.from_entry_id ? byId.get(draft.from_entry_id) : null;
    draft.from_label = from ? from.label : null;
  }
  const openTests = versions
    .filter((v) => v.open)
    .sort((a, b) => (b.test_number || 0) - (a.test_number || 0));
  return { current, openTests };
}
