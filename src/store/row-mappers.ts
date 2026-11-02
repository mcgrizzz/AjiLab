// ── Row → record mappers ─────────────────────────────────────────────────────
// Postgres returns Date objects, separate columns, and tag arrays in their
// raw shapes; the record types the rest of the app consumes expect ISO
// strings, JSON-stringified tags, and frontmatter-derived notes/servings.
// These mappers do the translation in one place.

import { parseVersionMetadata } from "./frontmatter.ts";
import type {
  CookLogRecord,
  CookIntendedKey,
  CookLogSourceKind,
  RecipeBranchKind,
  RecipeBranchMeta,
  RecipeStatus,
  VersionRecord,
} from "./types.ts";

export type EntryRow = {
  id: string;
  branch_id: string;
  branch_slug: string;
  recipe_id: string;
  version_string: string | null;
  status: RecipeStatus;
  cooklang_text: string;
  changelog: string;
  parent_version: string | null;
  current_beta_version: string | null;
  tags: string[];
  created_at: Date;
  updated_at: Date;
  test_number: number | null;
  closed_as: string | null;
  closed_at: Date | null;
  from_entry_id: string | null;
  from_cook_log_id: string | null;
};

export function entryKind(row: { version_string: string | null; status: string; test_number: number | null }) {
  if (row.version_string === null) return "working_copy" as const;
  if (row.test_number !== null || row.status === "beta") return "test" as const;
  return "version" as const;
}

export function entryLabel(row: { version_string: string | null; status: string; test_number: number | null }): string {
  const kind = entryKind(row);
  if (kind === "working_copy") return "Working copy";
  if (kind === "test") return row.test_number !== null ? `Test ${row.test_number}` : (row.version_string || "Test");
  return row.version_string || "";
}

export function entryRowToVersion(row: EntryRow): VersionRecord {
  const parsed = parseVersionMetadata(row.cooklang_text || "");
  return {
    id: row.id,
    recipe_id: row.recipe_id,
    branch_slug: row.branch_slug,
    version_string: row.version_string,
    status: row.status,
    changelog: row.changelog || "",
    parent_version: row.parent_version,
    current_beta_version: row.current_beta_version,
    tags: JSON.stringify(row.tags || []),
    notes: parsed.notes,
    servings: parsed.servings,
    cooklang_text: row.cooklang_text || "",
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    is_draft: row.version_string === null,
    test_number: row.test_number ?? null,
    closed_as: (row.closed_as as VersionRecord["closed_as"]) ?? null,
    closed_at: row.closed_at ? row.closed_at.toISOString() : null,
    from_entry_id: row.from_entry_id ?? null,
    from_cook_log_id: row.from_cook_log_id ?? null,
    kind: entryKind(row),
    label: entryLabel(row),
    testing: entryKind(row) === "version" ? "" : (row.changelog || ""),
    base_version: null,
    is_current: false,
    open: entryKind(row) === "test" && !row.closed_as,
    adopted_as: null,
    from_label: null,
    cook_count: 0,
    last_cooked_at: null,
    last_recorded_at: null,
    last_outcome: null,
  };
}

export type BranchRow = {
  id: string;
  recipe_id: string;
  slug: string;
  name: string;
  kind: RecipeBranchKind;
  parent_branch_slug: string | null;
  forked_from_entry_id: string | null;
  forked_from_version_string: string | null;
  last_merged_upstream_entry_id: string | null;
  last_merged_upstream_version_string: string | null;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export function branchRowToMeta(row: BranchRow): RecipeBranchMeta {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    upstream_branch_slug: row.parent_branch_slug,
    forked_from_version_id: row.forked_from_entry_id,
    last_merged_upstream_version_id: row.last_merged_upstream_entry_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    archived_at: row.archived_at ? row.archived_at.toISOString() : null,
  };
}

export type CookLogRow = {
  id: string;
  branch_id: string;
  branch_slug: string;
  recipe_id: string;
  source_entry_id: string | null;
  source_kind: CookLogSourceKind;
  source_version: string | null;
  cooklang_text: string;
  source_cooklang_text: string;
  tags: string[];
  scale: number | null;
  cooked_at: Date;
  outcome: string;
  what_worked: string;
  problems_found: string;
  changes_to_try_next: string;
  freeform_notes: string;
  intended: CookIntendedKey[] | null;
  created_at: Date;
  updated_at: Date;
};

export function cookLogRowToRecord(row: CookLogRow): CookLogRecord {
  return {
    id: row.id,
    recipe_id: row.recipe_id,
    branch_slug: row.branch_slug,
    version_string: row.source_version,
    source_kind: row.source_kind,
    source_version_string: row.source_version,
    cooklang_text: row.cooklang_text || "",
    source_cooklang_text: row.source_cooklang_text || "",
    tags: row.tags || [],
    scale: Number(row.scale) > 0 ? Number(row.scale) : 1,
    cooked_at: row.cooked_at.toISOString(),
    outcome: row.outcome || "",
    what_worked: row.what_worked || "",
    problems_found: row.problems_found || "",
    changes_to_try_next: row.changes_to_try_next || "",
    freeform_notes: row.freeform_notes || "",
    intended: Array.isArray(row.intended) ? row.intended : [],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
