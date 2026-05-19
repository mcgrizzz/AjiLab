import { sql, generateId, slugify } from "./db.ts";
import { parseCooklang, parseReferencePath, resolveDeviationMarkers } from "./cooklang.ts";
import type { ParsedRecipe, RecipeReferenceResolution } from "./cooklang.ts";
import { parseVersionMetadata, upsertNotesInCooklang } from "./store/frontmatter.ts";
import {
  incrementVersionString,
  stripBetaSuffix,
  sortVersions,
  latestVersionByStatus,
  latestComparableVersion,
} from "./store/version-string.ts";
import { mergeCooklangText } from "./store/merge.ts";
import {
  MAIN_BRANCH_SLUG,
} from "./store/types.ts";
import {
  entryRowToVersion,
  branchRowToMeta,
  cookLogRowToRecord,
  type EntryRow,
  type BranchRow,
  type CookLogRow,
} from "./store/row-mappers.ts";
import type {
  RecipeStatus,
  RecipeBranchKind,
  CookLogSourceKind,
  RecipeBranchMeta,
  VersionMeta,
  VersionRecord,
  CookLogRecord,
  BranchCounts,
  RecipeBranchRecord,
  RecipeRecord,
} from "./store/types.ts";

export type {
  RecipeStatus,
  RecipeBranchKind,
  CookLogSourceKind,
  RecipeBranchMeta,
  VersionMeta,
  VersionRecord,
  CookLogRecord,
  BranchCounts,
  RecipeBranchRecord,
  RecipeRecord,
};

function nowIso(): string {
  return new Date().toISOString();
}

// ── Internal: record assembly ────────────────────────────────────────────────

function sameDraftState(version: VersionRecord | null | undefined, nextText: string, nextTags: string[]): boolean {
  if (!version) return false;
  const currentTags = JSON.parse(version.tags || "[]");
  return version.cooklang_text === nextText
    && JSON.stringify(currentTags) === JSON.stringify(nextTags);
}

function hasDraftChanges(draft: VersionRecord | null, versions: VersionRecord[]): boolean {
  if (!draft?.cooklang_text.trim()) return false;
  const latestStableOrBeta = latestComparableVersion(versions);
  if (!latestStableOrBeta) return true;
  if (draft.updated_at.localeCompare(latestStableOrBeta.updated_at) <= 0) return false;
  return draft.cooklang_text !== latestStableOrBeta.cooklang_text;
}

function draftChangeLabel(draft: VersionRecord | null, versions: VersionRecord[]): string | null {
  if (!hasDraftChanges(draft, versions)) return null;
  const latestStableOrBeta = latestComparableVersion(versions);
  if (!latestStableOrBeta?.version_string) return "Draft in progress";
  return `Draft differs from ${latestStableOrBeta.version_string}`;
}

function selectActiveExperiment(
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
async function loadRecipeRecord(slug: string, branchSlug: string = MAIN_BRANCH_SLUG): Promise<RecipeRecord | null> {
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
  const [entryRows, cookLogCounts, latestCookLogs] = await Promise.all([
    sql<EntryRow[]>`
      SELECT e.id, e.branch_id, b.slug AS branch_slug, b.recipe_id,
             e.version_string, e.status, e.cooklang_text, e.changelog,
             e.parent_version, e.current_beta_version, e.tags,
             e.created_at, e.updated_at
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
             cl.cooklang_text, cl.source_cooklang_text, cl.tags,
             cl.cooked_at, cl.outcome, cl.what_worked, cl.problems_found,
             cl.changes_to_try_next, cl.freeform_notes, cl.created_at, cl.updated_at
      FROM cook_logs cl
      JOIN branches b ON b.id = cl.branch_id
      WHERE cl.branch_id IN ${sql(branchIds)}
      ORDER BY cl.branch_id, cl.cooked_at DESC, cl.created_at DESC
    `,
  ]);

  const branches: RecipeBranchRecord[] = branchRows.map((branchRow) => {
    const branchMeta = branchRowToMeta(branchRow);
    const allBranchEntries = entryRows.filter((e) => e.branch_id === branchRow.id).map(entryRowToVersion);
    const draft = allBranchEntries.find((e) => e.version_string === null) || null;
    const versions = sortVersions(allBranchEntries.filter((e) => e.version_string !== null));
    const latestReleased = latestVersionByStatus(versions, "released");
    const latestBeta = latestVersionByStatus(versions, "beta");

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
      has_unreleased_changes: hasDraftChanges(draft, versions),
      draft_change_label: draftChangeLabel(draft, versions),
      current_best_release: latestReleased,
      active_experiment: selectActiveExperiment(draft, versions, latestReleased, latestBeta),
      latest_cook_log: logRow ? cookLogRowToRecord(logRow) : null,
      counts: {
        releases_count: versions.filter((v) => v.status === "released").length,
        betas_count: versions.filter((v) => v.status === "beta").length,
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
    current_best_release: branch.current_best_release,
    active_experiment: branch.active_experiment,
    latest_cook_log: branch.latest_cook_log,
    counts: branch.counts,
  };
}

async function requireRecipe(slug: string, branchSlug = MAIN_BRANCH_SLUG): Promise<RecipeRecord> {
  const recipe = await loadRecipeRecord(slug, branchSlug);
  if (!recipe) throw new Error("not found");
  return recipe;
}

async function uniqueRecipeSlug(title: string, excludeSlug?: string): Promise<string> {
  const base = slugify(title) || "recipe";
  let candidate = base;
  let suffix = 2;
  while (true) {
    const rows = await sql<{ slug: string }[]>`SELECT slug FROM recipes WHERE slug = ${candidate}`;
    if (rows.length === 0 || rows[0].slug === excludeSlug) return candidate;
    candidate = `${base}-${suffix++}`;
  }
}

async function uniqueBranchSlug(recipeId: string, name: string): Promise<string> {
  const base = slugify(name) || "branch";
  const existing = await sql<{ slug: string }[]>`SELECT slug FROM branches WHERE recipe_id = ${recipeId}`;
  const taken = new Set(existing.map((r) => r.slug));
  let candidate = base;
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${base}-${suffix++}`;
  return candidate;
}

// ── Reference syncing ────────────────────────────────────────────────────────

function extractReferencesFromText(text: string): Array<{ slug: string; pinned_version: string | null }> {
  const parsed = parseCooklang(text || "");
  const out = new Map<string, { slug: string; pinned_version: string | null }>();
  for (const ingredient of parsed.ingredients || []) {
    if (!ingredient.recipe_reference) continue;
    const key = (ingredient.reference_path && ingredient.reference_path.length > 0)
      ? ingredient.reference_path
      : (ingredient.name || "");
    const { slug, version } = parseReferencePath(key);
    if (!slug) continue;
    const prev = out.get(slug);
    // Keep pinned version if any reference pins it.
    if (!prev || (!prev.pinned_version && version)) {
      out.set(slug, { slug, pinned_version: version || null });
    }
  }
  return Array.from(out.values());
}

async function syncReferencesForEntry(entryId: string, cooklangText: string): Promise<void> {
  const refs = extractReferencesFromText(cooklangText);
  if (refs.length === 0) {
    await sql`DELETE FROM recipe_references WHERE from_entry_id = ${entryId}`;
    return;
  }
  const slugs = refs.map((r) => r.slug);
  // Parallel: the DELETE and the slug→id lookup are independent.
  const [, resolved] = await Promise.all([
    sql`DELETE FROM recipe_references WHERE from_entry_id = ${entryId}`,
    sql<{ slug: string; id: string }[]>`SELECT slug, id FROM recipes WHERE slug IN ${sql(slugs)}`,
  ]);
  const slugToId = new Map(resolved.map((r) => [r.slug, r.id]));
  const rows = refs
    .map((ref) => ({ from_entry_id: entryId, to_recipe_id: slugToId.get(ref.slug), pinned_version: ref.pinned_version }))
    .filter((row): row is { from_entry_id: string; to_recipe_id: string; pinned_version: string | null } => !!row.to_recipe_id);
  if (rows.length === 0) return;
  // Single multi-row INSERT instead of N round trips.
  await sql`
    INSERT INTO recipe_references ${sql(rows, "from_entry_id", "to_recipe_id", "pinned_version")}
    ON CONFLICT (from_entry_id, to_recipe_id) DO UPDATE SET pinned_version = EXCLUDED.pinned_version
  `;
}

// ── Recipe CRUD ──────────────────────────────────────────────────────────────

export async function listRecipes(search?: string) {
  const needle = search?.trim().toLowerCase();
  const recipes = await sql<{ slug: string }[]>`SELECT slug FROM recipes ORDER BY updated_at DESC`;
  const records = (await Promise.all(
    recipes.map((r) => loadRecipeRecord(r.slug, MAIN_BRANCH_SLUG))
  )).filter((r): r is RecipeRecord => !!r);
  return records
    .filter((recipe) => {
      if (!needle) return true;
      const haystack = [
        recipe.title,
        recipe.slug,
        recipe.draft?.cooklang_text || "",
        ...recipe.versions.flatMap((v) => [v.cooklang_text, ...JSON.parse(v.tags || "[]")]),
      ].join("\n").toLowerCase();
      return haystack.includes(needle);
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((recipe) => ({
      id: recipe.id,
      slug: recipe.slug,
      title: recipe.title,
      thumbnail_image_id: recipe.thumbnail_image_id,
      created_at: recipe.created_at,
      updated_at: recipe.updated_at,
      latest_released: recipe.latest_released,
      latest_beta: recipe.latest_beta,
      has_unreleased_changes: recipe.has_unreleased_changes,
      draft_change_label: recipe.draft_change_label,
      current_best_release: recipe.current_best_release ? {
        version_string: recipe.current_best_release.version_string,
        created_at: recipe.current_best_release.created_at,
        changelog: recipe.current_best_release.changelog || "",
      } : null,
      latest_cook_log: recipe.latest_cook_log ? {
        id: recipe.latest_cook_log.id,
        version_string: recipe.latest_cook_log.version_string,
        cooked_at: recipe.latest_cook_log.cooked_at,
        outcome: recipe.latest_cook_log.outcome,
      } : null,
      counts: recipe.counts,
    }));
}

export async function createRecipe(title: string) {
  const slug = await uniqueRecipeSlug(title);
  const recipeId = generateId();
  const branchId = generateId();
  const draftId = generateId();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO recipes (id, slug, title) VALUES (${recipeId}, ${slug}, ${title})`;
    await tx`
      INSERT INTO branches (id, recipe_id, slug, name, kind)
      VALUES (${branchId}, ${recipeId}, ${MAIN_BRANCH_SLUG}, 'Main', 'main')
    `;
    await tx`
      INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, tags)
      VALUES (${draftId}, ${branchId}, NULL, 'draft', '', '{}')
    `;
  });
  return { id: recipeId, slug, title };
}

export async function getRecipeBySlug(slug: string, branchSlug = MAIN_BRANCH_SLUG): Promise<RecipeRecord | null> {
  return loadRecipeRecord(slug, branchSlug);
}

export async function listRecipeBranches(slug: string): Promise<RecipeBranchRecord[]> {
  const recipe = await requireRecipe(slug);
  return recipe.branches;
}

export async function getRecipeBranch(slug: string, branchSlug: string): Promise<RecipeRecord | null> {
  return loadRecipeRecord(slug, branchSlug);
}

export async function getVersionByString(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG): Promise<VersionRecord | null> {
  const recipe = await getRecipeBySlug(slug, branchSlug);
  return recipe?.versions.find((v) => v.version_string === versionString) || null;
}

export async function updateRecipeTitle(slug: string, title: string): Promise<{ slug: string }> {
  const recipe = await requireRecipe(slug);
  const newSlug = await uniqueRecipeSlug(title, slug);
  await sql`UPDATE recipes SET title = ${title}, slug = ${newSlug} WHERE id = ${recipe.id}`;
  return { slug: newSlug };
}

export async function deleteRecipe(slug: string): Promise<void> {
  const recipe = await requireRecipe(slug);
  await sql`DELETE FROM recipes WHERE id = ${recipe.id}`;
}

// ── Branches ─────────────────────────────────────────────────────────────────

export async function createRecipeBranch(slug: string, input: { name: string; source_version: string }) {
  const recipe = await requireRecipe(slug, MAIN_BRANCH_SLUG);
  const source = recipe.versions.find((v) => v.version_string === input.source_version);
  if (!source) throw new Error("source version not found");
  if (!["released", "beta"].includes(source.status)) throw new Error("source version must be released or beta");

  const branchSlug = await uniqueBranchSlug(recipe.id, input.name);
  const branchId = generateId();
  const mainBranchId = recipe.branches.find((b) => b.slug === MAIN_BRANCH_SLUG)!.id;
  await sql`
    INSERT INTO branches (id, recipe_id, slug, name, kind, parent_branch_id, forked_from_entry_id, last_merged_upstream_entry_id)
    VALUES (${branchId}, ${recipe.id}, ${branchSlug}, ${input.name.trim()}, 'variant', ${mainBranchId}, ${source.id}, ${source.id})
  `;
  return loadRecipeRecord(slug, branchSlug);
}

// ── Entries (draft + version unified) ────────────────────────────────────────

async function ensureDraft(recipe: RecipeRecord): Promise<VersionRecord> {
  if (recipe.draft) return recipe.draft;
  const source = latestComparableVersion(recipe.versions) || recipe.source_version;
  const branchId = recipe.branch.id;
  const draftId = generateId();
  const sourceText = source?.cooklang_text || "";
  const sourceTags = source ? JSON.parse(source.tags || "[]") as string[] : [];
  await sql`
    INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, parent_version, tags)
    VALUES (${draftId}, ${branchId}, NULL, 'draft', ${sourceText}, ${source?.version_string ?? null}, ${sourceTags})
  `;
  await syncReferencesForEntry(draftId, sourceText);
  // Construct the draft locally instead of reloading the whole recipe.
  const now = new Date();
  return entryRowToVersion({
    id: draftId,
    branch_id: branchId,
    branch_slug: recipe.branch.slug,
    recipe_id: recipe.id,
    version_string: null,
    status: "draft",
    cooklang_text: sourceText,
    changelog: "",
    parent_version: source?.version_string ?? null,
    current_beta_version: null,
    tags: sourceTags,
    created_at: now,
    updated_at: now,
  });
}

function nextAutoBetaBase(versions: VersionRecord[], draft: VersionRecord, latestReleased: string | null, latestBeta: string | null): string {
  const seed = draft.parent_version
    ? (draft.parent_version.includes("-beta") ? stripBetaSuffix(draft.parent_version) : incrementVersionString(draft.parent_version))
    : (latestReleased ? incrementVersionString(latestReleased) : (latestBeta ? stripBetaSuffix(latestBeta) : "v1.0"));
  let candidate = seed;
  while (versions.some((v) => v.version_string === candidate)) candidate = incrementVersionString(candidate);
  return candidate;
}

function nextAutoBetaVersion(versions: VersionRecord[], base: string): string {
  const prefix = `${base}-beta.`;
  const max = versions
    .map((v) => v.version_string || "")
    .filter((s) => s.startsWith(prefix))
    .map((s) => Number(s.slice(prefix.length)))
    .filter((n) => Number.isFinite(n))
    .reduce((m, n) => Math.max(m, n), 0);
  return `${prefix}${max + 1}`;
}

export async function updateDraft(
  slug: string,
  updates: { cooklang_text?: string; tags?: string[] },
  options: { advance_beta?: boolean } = {},
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  const draft = await ensureDraft(recipe);
  const branchId = recipe.branch.id;
  const nextText = updates.cooklang_text ?? draft.cooklang_text;
  const nextTags = updates.tags ?? JSON.parse(draft.tags || "[]");
  const advanceBeta = options.advance_beta === true;

  let snapshotVersion: string | null = draft.current_beta_version || null;

  if (nextText.trim()) {
    const sameState = sameDraftState(draft, nextText, nextTags);
    if (!sameState || (advanceBeta && !snapshotVersion)) {
      if (!advanceBeta && snapshotVersion) {
        // Update the existing auto-beta in place + resync its refs in one round trip via RETURNING.
        const updated = await sql<{ id: string }[]>`
          UPDATE entries
          SET cooklang_text = ${nextText}, tags = ${nextTags}
          WHERE branch_id = ${branchId} AND version_string = ${snapshotVersion}
          RETURNING id
        `;
        if (updated[0]) await syncReferencesForEntry(updated[0].id, nextText);
      } else if (advanceBeta) {
        const base = nextAutoBetaBase(recipe.versions, draft, recipe.latest_released, recipe.latest_beta);
        const previousBeta = recipe.versions.find((v) => v.version_string?.startsWith(`${base}-beta.`));
        const newVersion = nextAutoBetaVersion(recipe.versions, base);
        const betaId = generateId();
        await sql`
          INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, parent_version, tags)
          VALUES (${betaId}, ${branchId}, ${newVersion}, 'beta', ${nextText},
                  ${previousBeta?.version_string || draft.parent_version || null}, ${nextTags})
        `;
        await syncReferencesForEntry(betaId, nextText);
        snapshotVersion = newVersion;
      }
    }
  }

  await sql`
    UPDATE entries
    SET cooklang_text = ${nextText}, tags = ${nextTags}, current_beta_version = ${snapshotVersion}
    WHERE id = ${draft.id}
  `;
  await syncReferencesForEntry(draft.id, nextText);
  return { ok: true, snapshot_version: snapshotVersion };
}

export async function updateDraftNotes(slug: string, notes: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const draft = recipe.draft;
  if (!draft) throw new Error("no draft");
  const nextText = upsertNotesInCooklang(draft.cooklang_text, notes.trim());
  await updateDraft(slug, { cooklang_text: nextText }, {}, branchSlug);
}

export async function updateVersionContent(slug: string, versionString: string, cooklangText: string, tags?: string[], branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((v) => v.version_string === versionString);
  if (!version) throw new Error("version not found");
  const nextTags = tags ?? JSON.parse(version.tags || "[]");
  await sql`
    UPDATE entries SET cooklang_text = ${cooklangText}, tags = ${nextTags}
    WHERE id = ${version.id}
  `;
  await syncReferencesForEntry(version.id, cooklangText);
}

export async function updateVersionNotes(slug: string, versionString: string, notes: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((v) => v.version_string === versionString);
  if (!version) throw new Error("version not found");
  const nextText = upsertNotesInCooklang(version.cooklang_text, notes.trim());
  await sql`UPDATE entries SET cooklang_text = ${nextText} WHERE id = ${version.id}`;
  await syncReferencesForEntry(version.id, nextText);
}

export async function deleteVersion(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((v) => v.version_string === versionString);
  if (!version) throw new Error("version not found");
  if (version.is_draft) throw new Error("cannot delete draft");
  await sql`DELETE FROM entries WHERE id = ${version.id}`;
}

async function releaseSource(
  recipe: RecipeRecord,
  source: VersionRecord,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
) {
  if (!source.cooklang_text.trim()) throw new Error(source.is_draft ? "draft is empty" : "version is empty");
  if (recipe.versions.some((v) => v.version_string === release.version_string)) {
    throw new Error("version already exists");
  }
  const previousComparable = latestComparableVersion(recipe.versions);
  const branchId = recipe.branch.id;
  const newId = source.is_draft ? generateId() : source.id;

  await sql.begin(async (tx) => {
    if (source.is_draft) {
      // Persist the released entry as a new row; reset the draft to empty so a
      // fresh one is created on demand.
      await tx`
        INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, changelog, parent_version, tags)
        VALUES (${newId}, ${branchId}, ${release.version_string}, ${release.status},
                ${source.cooklang_text}, ${release.changelog || ""},
                ${previousComparable?.version_string || source.parent_version || null},
                ${JSON.parse(source.tags || "[]")})
      `;
      // Delete images on the draft (entry_id = draft.id) — they don't carry over
      await tx`DELETE FROM images WHERE entry_id = ${source.id}`;
      // Delete the draft entry; a new one is recreated lazily by ensureDraft.
      await tx`DELETE FROM entries WHERE id = ${source.id}`;
    } else {
      // Re-release an existing version: insert a new row at the new version_string.
      await tx`
        INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, changelog, parent_version, tags)
        VALUES (${newId}, ${branchId}, ${release.version_string}, ${release.status},
                ${source.cooklang_text}, ${release.changelog || ""},
                ${previousComparable?.version_string || source.parent_version || null},
                ${JSON.parse(source.tags || "[]")})
      `;
    }
  });

  await syncReferencesForEntry(newId, source.cooklang_text);
  return { ok: true, version_string: release.version_string };
}

export async function releaseDraft(
  slug: string,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  if (!recipe.draft) throw new Error("no draft to release");
  return releaseSource(recipe, recipe.draft, release);
}

export async function releaseVersion(
  slug: string,
  sourceVersionString: string,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  const source = recipe.versions.find((v) => v.version_string === sourceVersionString);
  if (!source) throw new Error("version not found");
  return releaseSource(recipe, source, release);
}

export async function forkVersionToDraft(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((v) => v.version_string === versionString);
  if (!version) throw new Error("version not found");
  const branchId = recipe.branch.id;
  const tags = JSON.parse(version.tags || "[]");
  let draftId: string;
  if (recipe.draft) {
    draftId = recipe.draft.id;
    await sql`
      UPDATE entries SET cooklang_text = ${version.cooklang_text}, tags = ${tags},
                          parent_version = ${version.version_string}, current_beta_version = NULL
      WHERE id = ${draftId}
    `;
  } else {
    draftId = generateId();
    await sql`
      INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, parent_version, tags)
      VALUES (${draftId}, ${branchId}, NULL, 'draft', ${version.cooklang_text},
              ${version.version_string}, ${tags})
    `;
  }
  await syncReferencesForEntry(draftId, version.cooklang_text);
}

export async function forkBranchHeadToDraft(slug: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const source = latestComparableVersion(recipe.versions) || recipe.source_version;
  if (!source) throw new Error("no branch head to fork");
  await forkVersionToDraft(slug, source.version_string!, branchSlug);
  return { ok: true };
}

// ── Images ───────────────────────────────────────────────────────────────────

export async function listRecipeImages(slug: string, versionString?: string | null, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  let entryId: string | null = null;
  if (versionString === "draft") {
    if (!recipe.draft) throw new Error("version not found");
    entryId = recipe.draft.id;
  } else if (versionString) {
    const v = recipe.versions.find((e) => e.version_string === versionString);
    if (!v) throw new Error("version not found");
    entryId = v.id;
  }
  const rows = await sql<{
    id: string; recipe_id: string; entry_id: string | null;
    filename: string; mime_type: string; created_at: Date;
  }[]>`
    SELECT id, recipe_id, entry_id, filename, mime_type, created_at
    FROM images
    WHERE recipe_id = ${recipe.id}
      AND ${entryId === null ? sql`entry_id IS NULL` : sql`entry_id = ${entryId}`}
      AND is_thumbnail = false
    ORDER BY created_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    recipe_id: r.recipe_id,
    version_id: r.entry_id,
    branch_slug: branchSlug,
    version_key: versionString || null,
    filename: r.filename,
    mime_type: r.mime_type,
    created_at: r.created_at.toISOString(),
  }));
}

export async function attachRecipeImage(
  slug: string,
  image: { filename: string; mime_type: string; data: Buffer; version_string?: string | null },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  let entryId: string | null = null;
  if (image.version_string === "draft") {
    if (!recipe.draft) throw new Error("version not found");
    entryId = recipe.draft.id;
  } else if (image.version_string) {
    const v = recipe.versions.find((e) => e.version_string === image.version_string);
    if (!v) throw new Error("version not found");
    entryId = v.id;
  }
  const id = generateId();
  await sql`
    INSERT INTO images (id, recipe_id, entry_id, filename, mime_type, data)
    VALUES (${id}, ${recipe.id}, ${entryId}, ${image.filename}, ${image.mime_type}, ${image.data})
  `;
  return {
    id, filename: image.filename, version_id: entryId,
    branch_slug: branchSlug, version_key: image.version_string || null,
  };
}

export async function setRecipeThumbnail(
  slug: string,
  image: { filename: string; mime_type: string; data: Buffer } | null,
) {
  const recipe = await requireRecipe(slug);
  if (!image) {
    await sql`DELETE FROM images WHERE recipe_id = ${recipe.id} AND is_thumbnail`;
    return { ok: true, thumbnail_image_id: null };
  }
  const id = generateId();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM images WHERE recipe_id = ${recipe.id} AND is_thumbnail`;
    await tx`
      INSERT INTO images (id, recipe_id, entry_id, is_thumbnail, filename, mime_type, data)
      VALUES (${id}, ${recipe.id}, NULL, true, ${image.filename}, ${image.mime_type}, ${image.data})
    `;
  });
  return { ok: true, thumbnail_image_id: id };
}

export async function deleteRecipeImage(id: string) {
  await sql`DELETE FROM images WHERE id = ${id}`;
}

export async function readRecipeImage(id: string): Promise<{ data: Buffer; mime_type: string } | null> {
  const rows = await sql<{ data: Buffer; mime_type: string }[]>`
    SELECT data, mime_type FROM images WHERE id = ${id}
  `;
  if (rows.length === 0) return null;
  return { data: rows[0].data, mime_type: rows[0].mime_type };
}

// ── Cook logs ────────────────────────────────────────────────────────────────

function validateCookedAt(raw: string | undefined): string {
  if (!raw) return nowIso();
  const trimmed = String(raw).trim();
  if (!trimmed) return nowIso();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error("invalid cooked_at");
  return parsed.toISOString();
}

interface CookLogInput {
  cooked_at?: string;
  outcome: string;
  what_worked?: string;
  problems_found?: string;
  changes_to_try_next?: string;
  freeform_notes?: string;
  cooklang_text?: string;
  tags?: string[];
}

export type CookLogSourceSpec =
  | { kind: "draft" }
  | { kind: "version"; version_string: string };

async function loadCookLogsForBranch(branchId: string, filter?: { version: string }): Promise<CookLogRow[]> {
  if (filter) {
    return sql<CookLogRow[]>`
      SELECT cl.id, cl.branch_id, b.slug AS branch_slug, b.recipe_id,
             cl.source_entry_id, cl.source_kind, cl.source_version,
             cl.cooklang_text, cl.source_cooklang_text, cl.tags,
             cl.cooked_at, cl.outcome, cl.what_worked, cl.problems_found,
             cl.changes_to_try_next, cl.freeform_notes, cl.created_at, cl.updated_at
      FROM cook_logs cl
      JOIN branches b ON b.id = cl.branch_id
      WHERE cl.branch_id = ${branchId} AND cl.source_version = ${filter.version}
      ORDER BY cl.cooked_at DESC, cl.created_at DESC
    `;
  }
  return sql<CookLogRow[]>`
    SELECT cl.id, cl.branch_id, b.slug AS branch_slug, b.recipe_id,
           cl.source_entry_id, cl.source_kind, cl.source_version,
           cl.cooklang_text, cl.source_cooklang_text, cl.tags,
           cl.cooked_at, cl.outcome, cl.what_worked, cl.problems_found,
           cl.changes_to_try_next, cl.freeform_notes, cl.created_at, cl.updated_at
    FROM cook_logs cl
    JOIN branches b ON b.id = cl.branch_id
    WHERE cl.branch_id = ${branchId}
    ORDER BY cl.cooked_at DESC, cl.created_at DESC
  `;
}

export async function listBranchCookLogs(slug: string, branchSlug: string = MAIN_BRANCH_SLUG): Promise<CookLogRecord[]> {
  const recipe = await requireRecipe(slug, branchSlug);
  const branchId = recipe.branch.id;
  const rows = await loadCookLogsForBranch(branchId);
  return rows.map(cookLogRowToRecord);
}

export async function listVersionCookLogs(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG): Promise<CookLogRecord[]> {
  const recipe = await requireRecipe(slug, branchSlug);
  const branchId = recipe.branch.id;
  const rows = await loadCookLogsForBranch(branchId, { version: versionString });
  return rows.map(cookLogRowToRecord);
}

export async function getCookLog(slug: string, id: string, branchSlug = MAIN_BRANCH_SLUG): Promise<CookLogRecord | null> {
  const recipe = await requireRecipe(slug, branchSlug);
  const branchId = recipe.branch.id;
  const rows = await sql<CookLogRow[]>`
    SELECT cl.id, cl.branch_id, b.slug AS branch_slug, b.recipe_id,
           cl.source_entry_id, cl.source_kind, cl.source_version,
           cl.cooklang_text, cl.source_cooklang_text, cl.tags,
           cl.cooked_at, cl.outcome, cl.what_worked, cl.problems_found,
           cl.changes_to_try_next, cl.freeform_notes, cl.created_at, cl.updated_at
    FROM cook_logs cl
    JOIN branches b ON b.id = cl.branch_id
    WHERE cl.id = ${id} AND cl.branch_id = ${branchId}
  `;
  return rows[0] ? cookLogRowToRecord(rows[0]) : null;
}

export async function createCookLog(
  slug: string,
  source: CookLogSourceSpec,
  input: CookLogInput,
  branchSlug: string = MAIN_BRANCH_SLUG,
): Promise<CookLogRecord> {
  const recipe = await requireRecipe(slug, branchSlug);
  const branchId = recipe.branch.id;

  let sourceEntry: VersionRecord;
  if (source.kind === "draft") {
    if (!recipe.draft) throw new Error("draft not found");
    sourceEntry = recipe.draft;
  } else {
    const v = recipe.versions.find((e) => e.version_string === source.version_string && !e.is_draft);
    if (!v) throw new Error("version not found");
    sourceEntry = v;
  }
  const outcome = String(input.outcome || "").trim();
  if (!outcome) throw new Error("outcome is required");

  const cookedAt = validateCookedAt(input.cooked_at);
  const sourceText = sourceEntry.cooklang_text || "";
  const cooklangText = typeof input.cooklang_text === "string" ? input.cooklang_text : sourceText;
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : JSON.parse(sourceEntry.tags || "[]");
  const id = generateId();

  await sql`
    INSERT INTO cook_logs (
      id, branch_id, source_entry_id, source_kind, source_version,
      cooklang_text, source_cooklang_text, tags, cooked_at,
      outcome, what_worked, problems_found, changes_to_try_next, freeform_notes
    ) VALUES (
      ${id}, ${branchId}, ${sourceEntry.id}, ${source.kind},
      ${source.kind === "version" ? sourceEntry.version_string : null},
      ${cooklangText}, ${sourceText}, ${tags}, ${cookedAt},
      ${outcome}, ${String(input.what_worked || "")},
      ${String(input.problems_found || "")},
      ${String(input.changes_to_try_next || "")},
      ${String(input.freeform_notes || "")}
    )
  `;
  return (await getCookLog(slug, id, branchSlug))!;
}

export async function updateCookLog(
  slug: string,
  id: string,
  patch: Partial<CookLogInput>,
  branchSlug = MAIN_BRANCH_SLUG,
): Promise<CookLogRecord> {
  const existing = await getCookLog(slug, id, branchSlug);
  if (!existing) throw new Error("cook log not found");
  const nextOutcome = patch.outcome !== undefined ? String(patch.outcome).trim() : existing.outcome;
  if (!nextOutcome) throw new Error("outcome is required");
  const next = {
    cooked_at: patch.cooked_at !== undefined ? validateCookedAt(patch.cooked_at) : existing.cooked_at,
    outcome: nextOutcome,
    what_worked: patch.what_worked !== undefined ? String(patch.what_worked) : existing.what_worked,
    problems_found: patch.problems_found !== undefined ? String(patch.problems_found) : existing.problems_found,
    changes_to_try_next: patch.changes_to_try_next !== undefined ? String(patch.changes_to_try_next) : existing.changes_to_try_next,
    freeform_notes: patch.freeform_notes !== undefined ? String(patch.freeform_notes) : existing.freeform_notes,
    cooklang_text: patch.cooklang_text !== undefined ? String(patch.cooklang_text) : existing.cooklang_text,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String) : existing.tags,
  };
  await sql`
    UPDATE cook_logs SET
      cooked_at = ${next.cooked_at},
      outcome = ${next.outcome},
      what_worked = ${next.what_worked},
      problems_found = ${next.problems_found},
      changes_to_try_next = ${next.changes_to_try_next},
      freeform_notes = ${next.freeform_notes},
      cooklang_text = ${next.cooklang_text},
      tags = ${next.tags}
    WHERE id = ${id}
  `;
  return (await getCookLog(slug, id, branchSlug))!;
}

export async function deleteCookLog(slug: string, id: string, branchSlug = MAIN_BRANCH_SLUG): Promise<void> {
  await sql`DELETE FROM cook_logs WHERE id = ${id}`;
}

export async function forkCookLogToDraft(slug: string, logId: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const log = await getCookLog(slug, logId, branchSlug);
  if (!log) throw new Error("cook log not found");
  if (!log.cooklang_text.trim()) throw new Error("cook log has no recipe text to fork");
  const resolvedText = resolveDeviationMarkers(log.cooklang_text);
  const branchId = recipe.branch.id;
  let draftId: string;
  if (recipe.draft) {
    draftId = recipe.draft.id;
    await sql`
      UPDATE entries SET cooklang_text = ${resolvedText}, tags = ${log.tags},
                          parent_version = ${log.source_version_string}, current_beta_version = NULL
      WHERE id = ${draftId}
    `;
  } else {
    draftId = generateId();
    await sql`
      INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, parent_version, tags)
      VALUES (${draftId}, ${branchId}, NULL, 'draft', ${resolvedText},
              ${log.source_version_string}, ${log.tags})
    `;
  }
  await syncReferencesForEntry(draftId, resolvedText);
  return { ok: true };
}

export async function promoteCookLog(
  slug: string,
  logId: string,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  const log = await getCookLog(slug, logId, branchSlug);
  if (!log) throw new Error("cook log not found");
  if (!log.cooklang_text.trim()) throw new Error("cook log has no recipe text to promote");
  if (recipe.versions.some((v) => v.version_string === release.version_string)) {
    throw new Error("version already exists");
  }
  const resolvedText = resolveDeviationMarkers(log.cooklang_text);
  const previous = latestComparableVersion(recipe.versions);
  const branchId = recipe.branch.id;
  const id = generateId();
  await sql`
    INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, changelog, parent_version, tags)
    VALUES (${id}, ${branchId}, ${release.version_string}, ${release.status},
            ${resolvedText}, ${release.changelog || ""},
            ${previous?.version_string || log.source_version_string || null}, ${log.tags})
  `;
  await syncReferencesForEntry(id, resolvedText);
  return { ok: true, version_string: release.version_string };
}

// Cherry-pick promote: caller (route handler) has already synthesized the new
// recipe text from source + selected changes. We just persist it as a new
// version and link it back to the cook log via parent_version.
export async function promoteCookLogWithText(
  slug: string,
  logId: string,
  cooklangText: string,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  const log = await getCookLog(slug, logId, branchSlug);
  if (!log) throw new Error("cook log not found");
  if (!cooklangText.trim()) throw new Error("synthesized recipe text is empty");
  if (recipe.versions.some((v) => v.version_string === release.version_string)) {
    throw new Error("version already exists");
  }
  const previous = latestComparableVersion(recipe.versions);
  const branchId = recipe.branch.id;
  const id = generateId();
  await sql`
    INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, changelog, parent_version, tags)
    VALUES (${id}, ${branchId}, ${release.version_string}, ${release.status},
            ${cooklangText}, ${release.changelog || ""},
            ${previous?.version_string || log.source_version_string || null}, ${log.tags})
  `;
  await syncReferencesForEntry(id, cooklangText);
  return { ok: true, version_string: release.version_string };
}

// ── Branch sync (3-way merge wrappers) ───────────────────────────────────────
// The pure merge algorithm lives in ./store/merge.ts. The wrappers below read
// the relevant entries from the DB and feed their cooklang_text into it.

async function findEntryById(id: string): Promise<VersionRecord | null> {
  const rows = await sql<EntryRow[]>`
    SELECT e.id, e.branch_id, b.slug AS branch_slug, b.recipe_id,
           e.version_string, e.status, e.cooklang_text, e.changelog,
           e.parent_version, e.current_beta_version, e.tags,
           e.created_at, e.updated_at
    FROM entries e JOIN branches b ON b.id = e.branch_id
    WHERE e.id = ${id}
  `;
  return rows[0] ? entryRowToVersion(rows[0]) : null;
}

async function syncPreviewContext(slug: string, branchSlug: string) {
  const recipe = await requireRecipe(slug, branchSlug);
  if (recipe.branch.kind !== "variant" || recipe.branch.upstream_branch_slug !== MAIN_BRANCH_SLUG) {
    throw new Error("only main -> variant sync is supported");
  }
  const main = await requireRecipe(slug, MAIN_BRANCH_SLUG);
  const baseId = recipe.branch.last_merged_upstream_version_id || recipe.branch.forked_from_version_id;
  const base = baseId ? await findEntryById(baseId) : null;
  const theirs = latestComparableVersion(main.versions);
  const ours = recipe.draft || latestComparableVersion(recipe.versions) || recipe.source_version;
  if (!base || !theirs || !ours) throw new Error("sync baseline unavailable");
  return { recipe, base, theirs, ours };
}

export async function previewBranchSync(slug: string, branchSlug: string) {
  const { recipe, base, theirs, ours } = await syncPreviewContext(slug, branchSlug);
  const merged = mergeCooklangText(base.cooklang_text, ours.cooklang_text, theirs.cooklang_text);
  return {
    branch_slug: recipe.branch.slug,
    base_version: base.version_string,
    upstream_version: theirs.version_string,
    branch_version: ours.is_draft ? "draft" : ours.version_string,
    status: merged.status,
    merged_text: merged.merged_text,
    conflicts: merged.conflicts,
  };
}

export async function applyBranchSync(slug: string, branchSlug: string) {
  const preview = await previewBranchSync(slug, branchSlug);
  if (preview.status === "conflict") return preview;
  const recipe = await requireRecipe(slug, branchSlug);
  const draft = await ensureDraft(recipe);
  const main = await requireRecipe(slug, MAIN_BRANCH_SLUG);
  const upstream = main.versions.find((v) => v.version_string === preview.upstream_version);
  if (!upstream) throw new Error("upstream version not found");
  await sql.begin(async (tx) => {
    await tx`
      UPDATE entries SET cooklang_text = ${preview.merged_text || draft.cooklang_text}
      WHERE id = ${draft.id}
    `;
    await tx`
      UPDATE branches SET last_merged_upstream_entry_id = ${upstream.id}
      WHERE id = ${recipe.branch.id}
    `;
  });
  await syncReferencesForEntry(draft.id, preview.merged_text || draft.cooklang_text);
  return { ...preview, ok: true, draft_created: false };
}

// ── Recipe references / backlinks ────────────────────────────────────────────

export interface BacklinkRecord {
  from_slug: string;
  from_title: string;
  from_version: string | null;
  pinned: boolean;
}

async function resolveOne(rawName: string): Promise<RecipeReferenceResolution> {
  const { slug, version, categoryPath } = parseReferencePath(rawName);
  if (!slug) {
    return {
      found: false, slug, raw_path: String(rawName || ""), category_path: categoryPath,
      version_string: version, pinned: !!version, title: null, url: null,
    };
  }
  const recipe = await loadRecipeRecord(slug, MAIN_BRANCH_SLUG);
  if (!recipe) {
    return {
      found: false, slug, raw_path: String(rawName || ""), category_path: categoryPath,
      version_string: version, pinned: !!version, title: null, url: null,
    };
  }
  const target = version || recipe.current_best_release?.version_string || null;
  return {
    found: true, slug, raw_path: String(rawName || ""), category_path: categoryPath,
    version_string: target, pinned: !!version, title: recipe.title,
    url: target ? `/recipe/${slug}/versions/${encodeURIComponent(target)}` : `/recipe/${slug}`,
  };
}

function refKey(entry: { reference_path?: string | null; name?: string }): string {
  return (entry.reference_path && entry.reference_path.length > 0)
    ? entry.reference_path : (entry.name || "");
}

export async function enrichRecipeReferences(parsed: ParsedRecipe): Promise<ParsedRecipe> {
  if (!parsed?.ingredients) return parsed;
  const cache = new Map<string, RecipeReferenceResolution>();
  const resolve = async (rawPath: string): Promise<RecipeReferenceResolution> => {
    if (cache.has(rawPath)) return cache.get(rawPath)!;
    const r = await resolveOne(rawPath);
    cache.set(rawPath, r);
    return r;
  };
  for (const ingredient of parsed.ingredients) {
    if (!ingredient.recipe_reference) continue;
    ingredient.recipe_reference_resolution = await resolve(refKey(ingredient));
  }
  if (parsed.ingredient_summary?.flat) {
    for (const ingredient of parsed.ingredient_summary.flat) {
      if (!ingredient.recipe_reference) continue;
      ingredient.recipe_reference_resolution = await resolve(refKey(ingredient));
    }
  }
  if (parsed.ingredient_summary?.sections) {
    for (const section of parsed.ingredient_summary.sections) {
      for (const ingredient of section.ingredients || []) {
        if (!ingredient.recipe_reference) continue;
        ingredient.recipe_reference_resolution = await resolve(refKey(ingredient));
      }
    }
  }
  if (parsed.steps) {
    for (const stepTokens of parsed.steps) {
      for (const token of stepTokens) {
        if (token.type !== "ingredient" || !token.recipe_reference) continue;
        token.recipe_reference_resolution = await resolve(refKey(token));
      }
    }
  }
  return parsed;
}

export async function collectUnresolvedReferences(parsed: ParsedRecipe): Promise<Array<{ raw_path: string; slug: string }>> {
  const unresolved: Array<{ raw_path: string; slug: string }> = [];
  const seen = new Set<string>();
  for (const ingredient of parsed?.ingredients || []) {
    if (!ingredient.recipe_reference) continue;
    const res = ingredient.recipe_reference_resolution || await resolveOne(refKey(ingredient));
    if (res.found) continue;
    if (seen.has(res.raw_path)) continue;
    seen.add(res.raw_path);
    unresolved.push({ raw_path: res.raw_path, slug: res.slug });
  }
  return unresolved;
}

export async function listBacklinks(slug: string): Promise<BacklinkRecord[]> {
  const recipeRows = await sql<{ id: string }[]>`SELECT id FROM recipes WHERE slug = ${slug}`;
  if (recipeRows.length === 0) throw new Error("not found");
  const recipeId = recipeRows[0].id;

  const rows = await sql<{
    from_recipe_id: string; from_slug: string; from_title: string;
    pinned_version: string | null;
  }[]>`
    SELECT DISTINCT ON (r.id)
           r.id AS from_recipe_id, r.slug AS from_slug, r.title AS from_title,
           rr.pinned_version
    FROM recipe_references rr
    JOIN entries e ON e.id = rr.from_entry_id
    JOIN branches b ON b.id = e.branch_id
    JOIN recipes r ON r.id = b.recipe_id
    WHERE rr.to_recipe_id = ${recipeId} AND r.id <> ${recipeId}
    ORDER BY r.id, e.updated_at DESC
  `;
  return rows.map((row) => ({
    from_slug: row.from_slug,
    from_title: row.from_title,
    from_version: row.pinned_version,
    pinned: !!row.pinned_version,
  }));
}
