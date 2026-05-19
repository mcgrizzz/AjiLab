// ── Row → record mappers ─────────────────────────────────────────────────────
// Postgres returns Date objects, separate columns, and tag arrays in their
// raw shapes; the record types the rest of the app consumes expect ISO
// strings, JSON-stringified tags, and frontmatter-derived notes/servings.
// These mappers do the translation in one place.

import { parseVersionMetadata } from "./frontmatter.ts";
import type {
  CookLogRecord,
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
};

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
  cooked_at: Date;
  outcome: string;
  what_worked: string;
  problems_found: string;
  changes_to_try_next: string;
  freeform_notes: string;
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
    cooked_at: row.cooked_at.toISOString(),
    outcome: row.outcome || "",
    what_worked: row.what_worked || "",
    problems_found: row.problems_found || "",
    changes_to_try_next: row.changes_to_try_next || "",
    freeform_notes: row.freeform_notes || "",
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
