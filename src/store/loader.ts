// ── Record assembly (read path) ──────────────────────────────────────────────
// loadRecipeRecord is the canonical read path: one slug + branchSlug in, a
// fully-hydrated RecipeRecord (or null) out. It pulls the recipe row, all of
// its branches, every branch's entries, and per-branch cook-log summaries in
// parallel, then assembles RecipeBranchRecord objects (with derived flags
// like has_unreleased_changes / draft_change_label / active_experiment) and
// picks the requested branch as the surface for routes.
//
// requireRecipe wraps it for the common "throw if missing" case. The other
// helpers (sameDraftState, hasDraftChanges, draftChangeLabel,
// selectActiveExperiment) are the pure derivations the assembly uses.

import { sql } from "../db.ts";
import {
  MAIN_BRANCH_SLUG,
  type RecipeRecord,
  type RecipeBranchRecord,
  type VersionRecord,
} from "./types.ts";
import {
  entryRowToVersion,
  branchRowToMeta,
  cookLogRowToRecord,
  type BranchRow,
  type CookLogRow,
  type EntryRow,
} from "./row-mappers.ts";
import {
  sortVersions,
  latestVersionByStatus,
  latestComparableVersion,
  nextBetaForDraft,
} from "./version-string.ts";
import {
  decorateEntries,
  nextTestNumber,
  nextVersionString,
  workingCopyChanged,
  type CookSummary,
} from "./lineage.ts";

export function sameDraftState(version: VersionRecord | null | undefined, nextText: string, nextTags: string[]): boolean {
  if (!version) return false;
  const currentTags = JSON.parse(version.tags || "[]");
  return version.cooklang_text === nextText
    && JSON.stringify(currentTags) === JSON.stringify(nextTags);
}

export function hasDraftChanges(draft: VersionRecord | null, versions: VersionRecord[]): boolean {
  if (!draft?.cooklang_text.trim()) return false;
  const latestStableOrBeta = latestComparableVersion(versions);
  if (!latestStableOrBeta) return true;
  if (draft.updated_at.localeCompare(latestStableOrBeta.updated_at) <= 0) return false;
  return draft.cooklang_text !== latestStableOrBeta.cooklang_text;
}

export function draftChangeLabel(draft: VersionRecord | null, versions: VersionRecord[]): string | null {
  return workingCopyChanged(draft, versions) ? "Working copy has changes" : null;
}

export function selectActiveExperiment(
  draft: VersionRecord | null,
  versions: VersionRecord[],
  latestReleased: VersionRecord | null,
  latestBeta: VersionRecord | null,
): VersionRecord | null {
  if (draft && hasDraftChanges(draft, versions)) return draft;
  if (latestBeta && (!latestReleased || latestBeta.created_at.localeCompare(latestReleased.created_at) > 0)) return latestBeta;
  return null;
}

// Load a fully-hydrated RecipeRecord with all branches' entries + cook log summaries.
export async function loadRecipeRecord(slug: string, branchSlug: string = MAIN_BRANCH_SLUG): Promise<RecipeRecord | null> {
  const recipeRows = await sql<{
    id: string; slug: string; title: string; created_at: Date; updated_at: Date;
    thumbnail_image_id: string | null;
  }[]>`
    SELECT r.id, r.slug, r.title, r.created_at, r.updated_at,
           (SELECT i.id FROM images i WHERE i.recipe_id = r.id AND i.is_thumbnail LIMIT 1) AS thumbnail_image_id
    FROM recipes r WHERE r.slug = ${slug}
  `;
  if (recipeRows.length === 0) return null;
  const recipe = recipeRows[0];

  // All branches with denormalized version strings for forked_from / last_merged
  const branchRows = await sql<BranchRow[]>`
    SELECT b.id, b.recipe_id, b.slug, b.name, b.kind,
           pb.slug AS parent_branch_slug,
           b.forked_from_entry_id,
           ff.version_string AS forked_from_version_string,
           b.last_merged_upstream_entry_id,
           lm.version_string AS last_merged_upstream_version_string,
           b.archived_at, b.created_at, b.updated_at
    FROM branches b
    LEFT JOIN branches pb ON pb.id = b.parent_branch_id
    LEFT JOIN entries ff ON ff.id = b.forked_from_entry_id
    LEFT JOIN entries lm ON lm.id = b.last_merged_upstream_entry_id
    WHERE b.recipe_id = ${recipe.id}
    ORDER BY b.created_at ASC
  `;
  if (branchRows.length === 0) return null;

  const branchIds = branchRows.map((r) => r.id);
  // Parallel: these three queries are independent.
  const [entryRows, cookLogCounts, latestCookLogs, cooksPerEntry] = await Promise.all([
    sql<EntryRow[]>`
      SELECT e.id, e.branch_id, b.slug AS branch_slug, b.recipe_id,
             e.version_string, e.status, e.cooklang_text, e.changelog,
             e.parent_version, e.current_beta_version, e.tags,
             e.created_at, e.updated_at,
             e.test_number, e.closed_as, e.closed_at, e.from_entry_id, e.from_cook_log_id
      FROM entries e
      JOIN branches b ON b.id = e.branch_id
      WHERE e.branch_id IN ${sql(branchIds)}
    `,
    sql<{ branch_id: string; n: number }[]>`
      SELECT branch_id, COUNT(*)::int AS n FROM cook_logs
      WHERE branch_id IN ${sql(branchIds)} GROUP BY branch_id
    `,
    sql<CookLogRow[]>`
      SELECT DISTINCT ON (cl.branch_id)
             cl.id, cl.branch_id, b.slug AS branch_slug, b.recipe_id,
             cl.source_entry_id, cl.source_kind, cl.source_version,
             cl.cooklang_text, cl.source_cooklang_text, cl.tags, cl.scale,
             cl.cooked_at, cl.outcome, cl.what_worked, cl.problems_found,
             cl.changes_to_try_next, cl.freeform_notes, cl.created_at, cl.updated_at
      FROM cook_logs cl
      JOIN branches b ON b.id = cl.branch_id
      WHERE cl.branch_id IN ${sql(branchIds)}
      ORDER BY cl.branch_id, cl.cooked_at DESC, cl.created_at DESC
    `,
    // Per sheet: how many cooks, and the latest one's outcome.
    sql<{ source_entry_id: string; n: number; cooked_at: Date; outcome: string }[]>`
      SELECT DISTINCT ON (source_entry_id) source_entry_id, outcome, cooked_at,
             (COUNT(*) OVER (PARTITION BY source_entry_id))::int AS n
      FROM cook_logs
      WHERE branch_id IN ${sql(branchIds)} AND source_entry_id IS NOT NULL
      ORDER BY source_entry_id, cooked_at DESC, created_at DESC
    `,
  ]);
  const cooks = new Map<string, CookSummary>(cooksPerEntry.map((row) => [
    row.source_entry_id,
    { n: row.n, cooked_at: row.cooked_at.toISOString(), outcome: row.outcome },
  ]));

  const branches: RecipeBranchRecord[] = branchRows.map((branchRow) => {
    const branchMeta = branchRowToMeta(branchRow);
    const allBranchEntries = entryRows.filter((e) => e.branch_id === branchRow.id).map(entryRowToVersion);
    const draft = allBranchEntries.find((e) => e.version_string === null) || null;
    const versions = sortVersions(allBranchEntries.filter((e) => e.version_string !== null));
    const latestReleased = latestVersionByStatus(versions, "released");
    const latestBeta = latestVersionByStatus(versions, "beta");
    const { current, openTests } = decorateEntries(versions, draft, cooks);

    // Resolve source_version (the entry the branch was forked from)
    let sourceVersion: VersionRecord | null = null;
    if (branchRow.kind === "variant" && branchRow.forked_from_entry_id) {
      const sourceRow = entryRows.find((e) => e.id === branchRow.forked_from_entry_id);
      if (sourceRow) sourceVersion = entryRowToVersion(sourceRow);
    }

    const countsRow = cookLogCounts.find((c) => c.branch_id === branchRow.id);
    const logRow = latestCookLogs.find((c) => c.branch_id === branchRow.id);

    return {
      ...branchMeta,
      versions,
      draft,
      source_version: sourceVersion,
      latest_released: latestReleased?.version_string || null,
      latest_beta: latestBeta?.version_string || null,
      has_unreleased_changes: workingCopyChanged(draft, versions),
      draft_change_label: draftChangeLabel(draft, versions),
      next_beta_version: `Test ${nextTestNumber(versions)}`,
      // Kept one phase for old clients: the current version, and what used to
      // open by default.
      current_best_release: current,
      active_experiment: selectActiveExperiment(draft, versions, latestReleased, latestBeta),
      current_version: current,
      open_tests: openTests,
      next_test_number: nextTestNumber(versions),
      next_version_string: nextVersionString(versions, current),
      latest_cook_log: logRow ? cookLogRowToRecord(logRow) : null,
      counts: {
        releases_count: versions.filter((v) => v.kind === "version").length,
        betas_count: versions.filter((v) => v.kind === "test").length,
        open_tests_count: openTests.length,
        cook_logs_count: countsRow?.n || 0,
      },
    };
  });

  const branch = branches.find((b) => b.slug === branchSlug) || branches.find((b) => b.slug === MAIN_BRANCH_SLUG);
  if (!branch) return null;

  return {
    id: recipe.id,
    slug: recipe.slug,
    title: recipe.title,
    thumbnail_image_id: recipe.thumbnail_image_id,
    created_at: recipe.created_at.toISOString(),
    updated_at: recipe.updated_at.toISOString(),
    branches,
    branch_slug: branch.slug,
    branch,
    versions: branch.versions,
    draft: branch.draft,
    source_version: branch.source_version,
    latest_released: branch.latest_released,
    latest_beta: branch.latest_beta,
    has_unreleased_changes: branch.has_unreleased_changes,
    draft_change_label: branch.draft_change_label,
    next_beta_version: branch.next_beta_version,
    current_best_release: branch.current_best_release,
    active_experiment: branch.active_experiment,
    current_version: branch.current_version,
    open_tests: branch.open_tests,
    next_test_number: branch.next_test_number,
    next_version_string: branch.next_version_string,
    latest_cook_log: branch.latest_cook_log,
    counts: branch.counts,
  };
}

export async function requireRecipe(slug: string, branchSlug = MAIN_BRANCH_SLUG): Promise<RecipeRecord> {
  const recipe = await loadRecipeRecord(slug, branchSlug);
  if (!recipe) throw new Error("not found");
  return recipe;
}
