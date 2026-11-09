// ── Shared store types ───────────────────────────────────────────────────────
// Record / meta shapes used across the store/ modules and re-exported through
// recipe-store.ts for external callers (routes.ts and tests).

export type RecipeStatus = "draft" | "released" | "beta" | "archived";
export type RecipeBranchKind = "main" | "variant";
export type CookLogSourceKind = "draft" | "version";
// What an entry is in the interface: a version (v1.1), a test (Test 4) or the
// working copy (the draft). Derived; the stored status values don't change.
export type EntryKind = "version" | "test" | "working_copy";
export type TestClosedAs = "adopted" | "stopped" | "rebased" | "superseded";

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
  // Tests and lineage (stored)
  test_number: number | null;
  test_base: string | null;   // the version a test was made from, as stored
  test_seq: number | null;    // its number among that version's tests
  test_key: string | null;    // "v1.1-2", for its page address
  closed_as: TestClosedAs | null;
  closed_at: string | null;
  from_entry_id: string | null;
  from_cook_log_id: string | null;
  // Derived by the loader (defaults set by the row mapper)
  kind: EntryKind;
  label: string;              // "v1.1", "Test 4", "Working copy"
  testing: string;            // a test's "Testing:" line (its changelog); the working copy's pending one
  base_version: string | null; // the version a test or the working copy is based on
  is_current: boolean;
  open: boolean;              // an open test
  adopted_as: string | null;  // a test: the version adopted from it
  from_label: string | null;  // a version: "Test 3"; a test: the test it was made from
  cook_count: number;
  last_printed_at: string | null;
  // A test that can't be edited any more: it has been cooked (its cooks are
  // compared with it) or closed. Until then it can be, even if printed (the
  // app asks first: a print is recorded when the print dialog opens).
  locked: boolean;
  last_cooked_at: string | null;
  last_recorded_at: string | null; // when a cook of it was last saved
  last_outcome: string | null;
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
  // Amounts in cooklang_text are at this scale of source_cooklang_text (2 =
  // cooked at 2×). Fixed at creation.
  scale: number;
  cooked_at: string;
  outcome: string;
  what_worked: string;
  problems_found: string;
  changes_to_try_next: string;
  freeform_notes: string;
  // Differences marked "I meant this".
  intended: CookIntendedKey[];
  // How the paper showed the amounts (from the print it was started from).
  display: SheetDisplay;
  // Its photos' image ids, oldest first (served at /api/images/:id).
  photos: string[];
  created_at: string;
  updated_at: string;
}

// The nth (from 0) value of this kind and name in the sheet, not counting
// added steps. Inline quantities and unnamed timers have name "".
export interface CookIntendedKey {
  kind: "ingredient" | "timer" | "inlineQuantity";
  name: string;
  n: number;
}

// A sheet that went on paper (newest first on the recipe record).
export interface PrintRecord {
  id: string;
  entry_id: string;
  version_string: string;
  label: string;
  scale: number;
  printed_at: string;
  display: SheetDisplay;
}

// How a sheet's amounts were shown on paper: temperatures in °F or °C, and
// ingredients shown in another unit ({ flour: "cup" }).
export interface SheetDisplay {
  temp?: "F" | "C";
  units?: Record<string, string>;
}

export interface BranchCounts {
  releases_count: number;   // versions
  betas_count: number;      // tests
  open_tests_count: number;
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
  // The beta "Save as new beta" would create from the draft (`v1.1-beta.2`).
  next_beta_version: string | null;
  current_best_release: VersionRecord | null;
  active_experiment: VersionRecord | null;
  // The newest version ("current"); null when there's no version yet.
  current_version: VersionRecord | null;
  open_tests: VersionRecord[];
  next_test_number: number;
  // What saving the working copy as a test would call it ("v1.1 · Test 3").
  next_test_label: string;
  // What adopting or releasing would be called by default (v1.2, or v1.0).
  next_version_string: string;
  latest_cook_log: CookLogRecord | null;
  // The branch's latest prints, newest first.
  recent_prints: PrintRecord[];
  counts: BranchCounts;
}

export interface RecipeRecord {
  id: string;
  slug: string;
  title: string;
  thumbnail_image_id: string | null;
  // Shown when there's no thumbnail: an emoji, "lucide:<name>", or ''.
  icon: string;
  // The folders it's in (folders.id), oldest first.
  folder_ids: string[];
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
  // The beta "Save as new beta" would create from the draft (`v1.1-beta.2`).
  next_beta_version: string | null;
  current_best_release: VersionRecord | null;
  active_experiment: VersionRecord | null;
  // The newest version ("current"); null when there's no version yet.
  current_version: VersionRecord | null;
  open_tests: VersionRecord[];
  next_test_number: number;
  // What saving the working copy as a test would call it ("v1.1 · Test 3").
  next_test_label: string;
  // What adopting or releasing would be called by default (v1.2, or v1.0).
  next_version_string: string;
  latest_cook_log: CookLogRecord | null;
  // The branch's latest prints, newest first.
  recent_prints: PrintRecord[];
  counts: BranchCounts;
}
