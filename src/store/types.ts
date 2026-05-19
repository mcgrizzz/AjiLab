// ── Shared store types ───────────────────────────────────────────────────────
// Record / meta shapes used across the store/ modules and re-exported through
// recipe-store.ts for external callers (routes.ts and tests).

export type RecipeStatus = "draft" | "released" | "beta" | "archived";
export type RecipeBranchKind = "main" | "variant";
export type CookLogSourceKind = "draft" | "version";

export const MAIN_BRANCH_SLUG = "main";

// ── Types preserved for routes.ts compatibility ──────────────────────────────

export interface RecipeBranchMeta {
  id: string;
  slug: string;
  name: string;
  kind: RecipeBranchKind;
  upstream_branch_slug: string | null;
  forked_from_version_id: string | null;
  last_merged_upstream_version_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface VersionMeta {
  id: string;
  branch_slug: string;
  version_string: string | null;
  status: RecipeStatus;
  changelog: string;
  parent_version: string | null;
  current_beta_version: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_draft: boolean;
}

export interface VersionRecord {
  id: string;
  recipe_id: string;
  branch_slug: string;
  version_string: string | null;
  status: RecipeStatus;
  changelog: string;
  parent_version: string | null;
  current_beta_version: string | null;
  tags: string;            // JSON-stringified for routes.ts compat
  notes: string | null;    // derived from cooklang frontmatter
  servings: string | null; // derived from cooklang frontmatter
  cooklang_text: string;
  created_at: string;
  updated_at: string;
  is_draft: boolean;
}

export interface CookLogRecord {
  id: string;
  recipe_id: string;
  branch_slug: string;
  version_string: string | null;
  source_kind: CookLogSourceKind;
  source_version_string: string | null;
  cooklang_text: string;
  source_cooklang_text: string;
  tags: string[];
  cooked_at: string;
  outcome: string;
  what_worked: string;
  problems_found: string;
  changes_to_try_next: string;
  freeform_notes: string;
  created_at: string;
  updated_at: string;
}

export interface BranchCounts {
  releases_count: number;
  betas_count: number;
  cook_logs_count: number;
}

export interface RecipeBranchRecord extends RecipeBranchMeta {
  versions: VersionRecord[];
  draft: VersionRecord | null;
  source_version: VersionRecord | null;
  latest_released: string | null;
  latest_beta: string | null;
  has_unreleased_changes: boolean;
  draft_change_label: string | null;
  current_best_release: VersionRecord | null;
  active_experiment: VersionRecord | null;
  latest_cook_log: CookLogRecord | null;
  counts: BranchCounts;
}

export interface RecipeRecord {
  id: string;
  slug: string;
  title: string;
  thumbnail_image_id: string | null;
  created_at: string;
  updated_at: string;
  branches: RecipeBranchRecord[];
  branch_slug: string;
  branch: RecipeBranchRecord;
  versions: VersionRecord[];
  draft: VersionRecord | null;
  source_version: VersionRecord | null;
  latest_released: string | null;
  latest_beta: string | null;
  has_unreleased_changes: boolean;
  draft_change_label: string | null;
  current_best_release: VersionRecord | null;
  active_experiment: VersionRecord | null;
  latest_cook_log: CookLogRecord | null;
  counts: BranchCounts;
}
