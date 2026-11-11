import { sql, generateId, slugify } from "./db.ts";
import { parseCooklang, parseReferencePath, resolveDeviationMarkers, scaleCooklangText, unscaleCooklangText, normalizeScale } from "./cooklang.ts";
import type { ParsedRecipe, RecipeReferenceResolution } from "./cooklang.ts";
import { parseVersionMetadata, upsertNotesInCooklang } from "./store/frontmatter.ts";
import {
  incrementVersionString,
  stripBetaSuffix,
  sortVersions,
  latestVersionByStatus,
  latestComparableVersion,
  nextAutoBetaBase,
  nextAutoBetaVersion,
} from "./store/version-string.ts";
import { mergeCooklangText } from "./store/merge.ts";
import { baseVersionOf, nextTestSeq } from "./store/lineage.ts";
import {
  MAIN_BRANCH_SLUG,
} from "./store/types.ts";
import {
  entryRowToVersion,
  testLabel,
  testKey,
  branchRowToMeta,
  cookLogRowToRecord,
  type EntryRow,
  type BranchRow,
  type CookLogRow,
} from "./store/row-mappers.ts";
import {
  loadRecipeRecord,
  requireRecipe,
  sameDraftState,
  hasDraftChanges,
  draftChangeLabel,
  selectActiveExperiment,
} from "./store/loader.ts";
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
  CookIntendedKey,
  SheetDisplay,
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

export {
  listRecipes,
  createRecipe,
  getRecipeBySlug,
  updateRecipeTitle,
  deleteRecipe,
} from "./store/recipes.ts";

export {
  FolderError,
  normalizeIcon,
  listFolders,
  createFolder,
  updateFolder,
  deleteFolder,
  setFolderRecipes,
  setRecipeFolders,
  setRecipeIcon,
} from "./store/folders.ts";
export type { FolderRecord } from "./store/folders.ts";

function nowIso(): string {
  return new Date().toISOString();
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

// ── Branches ─────────────────────────────────────────────────────────────────

export async function listRecipeBranches(slug: string): Promise<RecipeBranchRecord[]> {
  const recipe = await requireRecipe(slug);
  return recipe.branches;
}

export async function getRecipeBranch(slug: string, branchSlug: string): Promise<RecipeRecord | null> {
  return loadRecipeRecord(slug, branchSlug);
}

export async function getVersionByString(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG): Promise<VersionRecord | null> {
  const recipe = await loadRecipeRecord(slug, branchSlug);
  return recipe?.versions.find((v) => v.version_string === versionString) || null;
}


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
  // The working copy starts from the current version; with no version yet,
  // from the newest open test.
  const source = recipe.current_version || recipe.open_tests[0] || latestComparableVersion(recipe.versions) || recipe.source_version;
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
    test_number: null,
    closed_as: null,
    closed_at: null,
    from_entry_id: null,
    from_cook_log_id: null,
  });
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

  // Ordinary (auto)saves change only the working copy. advance_beta (old
  // clients' "Save as new beta") saves it as a test.
  if (advanceBeta && nextText.trim()) {
    await sql`UPDATE entries SET cooklang_text = ${nextText}, tags = ${nextTags} WHERE id = ${draft.id}`;
    await syncReferencesForEntry(draft.id, nextText);
    const saved = await saveTest(slug, { testing: draft.testing }, branchSlug);
    return { ok: true, snapshot_version: saved.version_string, created_beta: saved.created ? saved.version_string : null };
  }
  const snapshotVersion: string | null = draft.current_beta_version || null;
  const createdBeta: string | null = null;

  await sql`
    UPDATE entries
    SET cooklang_text = ${nextText}, tags = ${nextTags}, current_beta_version = ${snapshotVersion}
    WHERE id = ${draft.id}
  `;
  await syncReferencesForEntry(draft.id, nextText);
  return { ok: true, snapshot_version: snapshotVersion, created_beta: createdBeta };
}

// ── Tests ────────────────────────────────────────────────────────────────────

// Save the working copy as the next test: a fixed sheet with a "Testing:"
// line. If it still matches the last test saved from it, that test is
// returned instead of a duplicate. With close_source, the open test the
// working copy was started from (or from one of whose cooks) is closed as
// followed: the new test carries on from it.
export async function saveTest(
  slug: string,
  input: { testing?: string; close_source?: boolean },
  branchSlug = MAIN_BRANCH_SLUG,
): Promise<{ ok: true; version_string: string; test_number: number; label: string; test_key: string | null; created: boolean; closed: string | null }> {
  const recipe = await requireRecipe(slug, branchSlug);
  const draft = recipe.draft;
  if (!draft?.cooklang_text.trim()) throw new Error("the working copy is empty");
  const testing = String(input.testing ?? draft.testing ?? "").trim();
  const last = draft.current_beta_version
    ? recipe.versions.find((v) => v.version_string === draft.current_beta_version)
    : null;
  if (last && last.kind === "test" && sameDraftState(last, draft.cooklang_text, JSON.parse(draft.tags || "[]"))) {
    if (testing && testing !== last.testing) await sql`UPDATE entries SET changelog = ${testing} WHERE id = ${last.id}`;
    return { ok: true, version_string: last.version_string!, test_number: last.test_number!, label: last.label, test_key: last.test_key, created: false, closed: null };
  }
  const source = input.close_source ? followedSource(recipe.versions, draft) : null;
  const branchId = recipe.branch.id;
  const id = generateId();
  const number = recipe.next_test_number;
  const versionString = `test-${number}`;
  // Named by the version it's made from: "v1.1 · Test 2".
  const base = draft.base_version ?? null;
  const seq = nextTestSeq(recipe.versions, base);
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, changelog, parent_version, tags,
                           test_number, test_base, test_seq, from_entry_id, from_cook_log_id)
      VALUES (${id}, ${branchId}, ${versionString}, 'beta', ${draft.cooklang_text}, ${testing},
              ${draft.base_version}, ${JSON.parse(draft.tags || "[]")},
              ${number}, ${base}, ${seq}, ${draft.from_entry_id}, ${draft.from_cook_log_id})
    `;
    // The working copy remembers its last test; the pending Testing line is used up.
    await tx`UPDATE entries SET current_beta_version = ${versionString}, changelog = '' WHERE id = ${draft.id}`;
    if (source) await tx`UPDATE entries SET closed_as = 'followed', closed_at = now() WHERE id = ${source.id} AND closed_as IS NULL`;
  });
  await syncReferencesForEntry(id, draft.cooklang_text);
  return { ok: true, version_string: versionString, test_number: number, label: testLabel(base, seq), test_key: testKey(base, seq), created: true, closed: source?.label || null };
}

// The open test a new test from this working copy would carry on from.
function followedSource(versions: VersionRecord[], draft: VersionRecord | null): VersionRecord | null {
  const source = draft?.from_entry_id ? versions.find((v) => v.id === draft.from_entry_id) : null;
  return source && source.kind === "test" && source.open ? source : null;
}

function findTest(recipe: RecipeRecord, versionString: string): VersionRecord {
  const test = recipe.versions.find((v) => v.version_string === versionString);
  if (!test) throw new Error("version not found");
  if (test.kind !== "test") throw new Error("not a test");
  return test;
}

// The "Testing:" line is a label, not part of the sheet, so it can change.
export async function updateTesting(slug: string, versionString: string, testing: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const test = findTest(recipe, versionString);
  await sql`UPDATE entries SET changelog = ${String(testing || "").trim()} WHERE id = ${test.id}`;
  return { ok: true };
}

// Stop testing, or reopen a stopped, superseded or followed test. Stopping
// a test that a later test was made from closes it as followed.
export async function setTestOpen(slug: string, versionString: string, open: boolean, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const test = findTest(recipe, versionString);
  if (open) {
    if (test.closed_as === "adopted" || test.closed_as === "rebased") throw new Error(`${test.label} was ${test.closed_as}`);
    await sql`UPDATE entries SET closed_as = NULL, closed_at = NULL WHERE id = ${test.id}`;
  } else if (!test.closed_as) {
    const as = test.followed_by ? "followed" : "stopped";
    await sql`UPDATE entries SET closed_as = ${as}, closed_at = now() WHERE id = ${test.id}`;
  }
  return { ok: true };
}

// ── Adopting: making the next version ────────────────────────────────────────

export class AdoptConflictError extends Error {
  conflicts: Array<Record<string, unknown>>;
  constructor(message: string, conflicts: Array<Record<string, unknown>>) {
    super(message);
    this.conflicts = conflicts;
  }
}

// What a sheet was based on: a version is its own base; a test or the
// working copy has a base version (null if it was made before any version).
function baseTextFor(recipe: RecipeRecord, entry: VersionRecord | null): string | null {
  if (!entry) return null;
  if (entry.kind === "version") return entry.cooklang_text;
  const base = baseVersionOf(entry, recipe.versions);
  return base ? recipe.versions.find((v) => v.version_string === base)?.cooklang_text ?? null : null;
}

// The text the next version gets. Changes made against an older version are
// merged into the current one, so adopting never undoes what was adopted
// since. Without a current version (or a base) it's the text as is.
export function adoptedText(baseText: string | null, currentText: string | null, text: string): {
  text: string; mode: "as-is" | "merged";
} {
  if (currentText === null || baseText === null || baseText === currentText) return { text, mode: "as-is" };
  const merged = mergeCooklangText(baseText, currentText, text);
  if (merged.status === "conflict") {
    throw new AdoptConflictError("conflicts with the current version", merged.conflicts);
  }
  return { text: merged.merged_text!, mode: "merged" };
}

async function insertVersion(
  recipe: RecipeRecord,
  input: {
    version_string: string; changelog?: string; text: string; tags: string[];
    from_entry_id?: string | null; from_cook_log_id?: string | null;
    close_test_id?: string | null; delete_entry_id?: string | null;
  },
) {
  const versionString = input.version_string.trim();
  if (!versionString) throw new Error("version_string required");
  if (recipe.versions.some((v) => v.version_string === versionString)) throw new Error("version already exists");
  if (/^test-\d+$/.test(versionString)) throw new Error("that name is kept for tests");
  if (!input.text.trim()) throw new Error("version is empty");
  const id = generateId();
  const parent = recipe.current_version?.version_string ?? null;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, changelog, parent_version, tags,
                           from_entry_id, from_cook_log_id)
      VALUES (${id}, ${recipe.branch.id}, ${versionString}, 'released', ${input.text}, ${input.changelog || ""},
              ${parent}, ${input.tags}, ${input.from_entry_id ?? null}, ${input.from_cook_log_id ?? null})
    `;
    if (input.close_test_id) {
      await tx`UPDATE entries SET closed_as = 'adopted', closed_at = now() WHERE id = ${input.close_test_id}`;
    }
    if (input.delete_entry_id) {
      // The working copy: recreated lazily from the new version.
      await tx`DELETE FROM images WHERE entry_id = ${input.delete_entry_id}`;
      await tx`DELETE FROM entries WHERE id = ${input.delete_entry_id}`;
    }
  });
  await syncReferencesForEntry(id, input.text);
  // A working copy with nothing of its own (no changes, no pending Testing
  // line) moves onto the new version, so the next test is made, and named,
  // from it. One with changes is left as it is.
  const draft = recipe.draft;
  if (draft && draft.id !== input.delete_entry_id && !recipe.has_unreleased_changes && !draft.testing.trim()) {
    await sql`
      UPDATE entries SET cooklang_text = ${input.text}, tags = ${input.tags}, parent_version = ${versionString},
             current_beta_version = NULL, from_entry_id = NULL, from_cook_log_id = NULL
      WHERE id = ${draft.id}
    `;
    await syncReferencesForEntry(draft.id, input.text);
  }
  return id;
}

// Undo "Save as new beta": remove that beta and point the draft back at the
// previous one. Only while nothing depends on it yet.
export async function undoDraftBeta(
  slug: string,
  versionString: string,
  previousBeta: string | null,
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  const draft = recipe.draft;
  const beta = recipe.versions.find((v) => v.version_string === versionString);
  if (!draft || !beta) throw new Error("version not found");
  if (beta.status !== "beta" || draft.current_beta_version !== versionString) {
    throw new Error("only the draft's latest beta snapshot can be undone");
  }
  if (recipe.versions.some((v) => v.parent_version === versionString)) {
    throw new Error(`a later version builds on ${versionString}`);
  }
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM cook_logs WHERE source_entry_id = ${beta.id}
  `;
  if (n > 0) throw new Error(`${versionString} has cook logs`);
  const previous = previousBeta && recipe.versions.some((v) => v.version_string === previousBeta) ? previousBeta : null;
  // A test it closed as followed opens again, unless another test follows it.
  const followed = beta.from_entry_id
    ? recipe.versions.find((v) => v.id === beta.from_entry_id && v.closed_as === "followed"
      && !recipe.versions.some((o) => o.id !== beta.id && o.kind === "test" && o.from_entry_id === v.id))
    : null;
  await sql.begin(async (tx) => {
    await tx`DELETE FROM entries WHERE id = ${beta.id}`;
    // Give the Testing line back to the working copy for the next save.
    await tx`UPDATE entries SET current_beta_version = ${previous}, changelog = ${beta.testing || ""} WHERE id = ${draft.id}`;
    if (followed) await tx`UPDATE entries SET closed_as = NULL, closed_at = NULL WHERE id = ${followed.id}`;
  });
  return { ok: true, current_beta_version: previous };
}

export async function updateDraftNotes(slug: string, notes: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const draft = recipe.draft;
  if (!draft) throw new Error("no draft");
  const nextText = upsertNotesInCooklang(draft.cooklang_text, notes.trim());
  await updateDraft(slug, { cooklang_text: nextText }, {}, branchSlug);
}

// A test can be edited until it's cooked (its cooks are compared with it) or
// closed. After that, changing it means a new test.
export class TestFixedError extends Error {
  constructor(test: VersionRecord) {
    super(test.cook_count > 0
      ? `${test.label} has been cooked, so it stays as cooked. Make a new test from it instead.`
      : `${test.label} is closed. Make a new test from it instead.`);
  }
}

function editableVersion(recipe: RecipeRecord, versionString: string): VersionRecord {
  const version = recipe.versions.find((v) => v.version_string === versionString);
  if (!version) throw new Error("version not found");
  if (version.locked) throw new TestFixedError(version);
  return version;
}

export async function updateVersionContent(slug: string, versionString: string, cooklangText: string, tags?: string[], branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const version = editableVersion(recipe, versionString);
  const nextTags = tags ?? JSON.parse(version.tags || "[]");
  await sql`
    UPDATE entries SET cooklang_text = ${cooklangText}, tags = ${nextTags}
    WHERE id = ${version.id}
  `;
  await syncReferencesForEntry(version.id, cooklangText);
}

export async function updateVersionNotes(slug: string, versionString: string, notes: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const version = editableVersion(recipe, versionString);
  const nextText = upsertNotesInCooklang(version.cooklang_text, notes.trim());
  await sql`UPDATE entries SET cooklang_text = ${nextText} WHERE id = ${version.id}`;
  await syncReferencesForEntry(version.id, nextText);
}

// ── Prints ───────────────────────────────────────────────────────────────────

// Only the parts of a display we understand: "F"/"C", ingredient → unit,
// and the rounding of converted temperatures.
export function normalizeDisplay(raw: unknown): SheetDisplay {
  const out: SheetDisplay = {};
  const temp = (raw as any)?.temp;
  if (temp === "F" || temp === "C") out.temp = temp;
  const round = (raw as any)?.round;
  if (round === "whole" || round === "five") out.round = round;
  const units = (raw as any)?.units;
  if (units && typeof units === "object" && !Array.isArray(units)) {
    const clean: Record<string, string> = {};
    for (const [name, unit] of Object.entries(units)) {
      const key = String(name).trim().toLowerCase();
      if (key && typeof unit === "string" && unit.trim() && unit.length <= 20) clean[key] = unit.trim();
    }
    if (Object.keys(clean).length) out.units = clean;
  }
  return out;
}

// Record that a version or test went on paper at a scale, and how its
// amounts were shown. The same sheet at the same scale on the same day
// updates its record (with the latest display) rather than adding one.
export async function recordPrint(
  slug: string,
  versionString: string,
  scale: number,
  branchSlug = MAIN_BRANCH_SLUG,
  display: unknown = {},
): Promise<{ ok: true; id: string; created: boolean }> {
  const recipe = await requireRecipe(slug, branchSlug);
  if (!versionString || versionString === "draft") throw new Error("save the working copy as a test to print it");
  const entry = recipe.versions.find((v) => v.version_string === versionString);
  if (!entry) throw new Error("version not found");
  const s = normalizeScale(scale);
  const [same] = await sql<{ id: string }[]>`
    SELECT id FROM prints
    WHERE entry_id = ${entry.id} AND scale = ${s} AND printed_at::date = now()::date
    ORDER BY printed_at DESC LIMIT 1
  `;
  const shown = normalizeDisplay(display);
  if (same) {
    await sql`UPDATE prints SET printed_at = now(), display = ${sql.json(shown as any)} WHERE id = ${same.id}`;
    return { ok: true, id: same.id, created: false };
  }
  const id = generateId();
  await sql`INSERT INTO prints (id, entry_id, scale, display) VALUES (${id}, ${entry.id}, ${s}, ${sql.json(shown as any)})`;
  return { ok: true, id, created: true };
}

export async function deleteVersion(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((v) => v.version_string === versionString);
  if (!version) throw new Error("version not found");
  if (version.is_draft) throw new Error("cannot delete draft");
  await sql`DELETE FROM entries WHERE id = ${version.id}`;
}

// Make the next version from the working copy ("Release without testing"),
// a test ("Adopt"), or an old version (re-release, as is). The status
// argument is accepted for old clients; anything but a version is refused.
async function releaseSource(
  recipe: RecipeRecord,
  source: VersionRecord,
  release: { version_string: string; status?: string; changelog?: string },
) {
  if (release.status && release.status !== "released") throw new Error("only versions can be released; save a test instead");
  if (!source.cooklang_text.trim()) throw new Error(source.is_draft ? "the working copy is empty" : "version is empty");
  const current = recipe.current_version;
  const { text, mode } = source.kind === "version"
    ? { text: source.cooklang_text, mode: "as-is" as const }
    : adoptedText(baseTextFor(recipe, source), current?.cooklang_text ?? null, source.cooklang_text);
  await insertVersion(recipe, {
    version_string: release.version_string,
    changelog: release.changelog,
    text,
    tags: JSON.parse(source.tags || "[]"),
    from_entry_id: source.kind === "test" ? source.id : (source.is_draft ? source.from_entry_id : null),
    from_cook_log_id: source.is_draft ? source.from_cook_log_id : null,
    close_test_id: source.kind === "test" ? source.id : null,
    delete_entry_id: source.is_draft ? source.id : null,
  });
  return { ok: true, version_string: release.version_string.trim(), merged: mode === "merged" };
}

// What adopting a test (or releasing the working copy) would do, without
// doing it: take it as written, merge it into the current version, or
// conflict with it.
export async function previewAdopt(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG): Promise<{
  mode: "as-is" | "merged" | "conflict"; current: string | null; conflicts?: Array<Record<string, unknown>>;
}> {
  const recipe = await requireRecipe(slug, branchSlug);
  const source = versionString === "draft" ? recipe.draft : recipe.versions.find((v) => v.version_string === versionString);
  if (!source) throw new Error("version not found");
  const current = recipe.current_version;
  if (source.kind === "version") return { mode: "as-is", current: current?.label ?? null };
  try {
    const { mode } = adoptedText(baseTextFor(recipe, source), current?.cooklang_text ?? null, source.cooklang_text);
    return { mode, current: current?.label ?? null };
  } catch (error) {
    if (error instanceof AdoptConflictError) return { mode: "conflict", current: current?.label ?? null, conflicts: error.conflicts };
    throw error;
  }
}

export async function releaseDraft(
  slug: string,
  release: { version_string: string; status?: string; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  if (!recipe.draft) throw new Error("no draft to release");
  return releaseSource(recipe, recipe.draft, release);
}

export async function releaseVersion(
  slug: string,
  sourceVersionString: string,
  release: { version_string: string; status?: string; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = await requireRecipe(slug, branchSlug);
  const source = recipe.versions.find((v) => v.version_string === sourceVersionString);
  if (!source) throw new Error("version not found");
  return releaseSource(recipe, source, release);
}

// Reset the working copy to a version or a test ("New test…", "New test from
// Test 4"). `testing` is the pending Testing line for the test it becomes.
export async function forkVersionToDraft(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG, options: { testing?: string } = {}) {
  const recipe = await requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((v) => v.version_string === versionString);
  if (!version) throw new Error("version not found");
  await writeDraft(recipe, {
    text: version.cooklang_text,
    tags: JSON.parse(version.tags || "[]"),
    parent_version: version.version_string,
    from_entry_id: version.kind === "test" ? version.id : null,
    from_cook_log_id: null,
    testing: String(options.testing || "").trim(),
  });
}

async function writeDraft(recipe: RecipeRecord, input: {
  text: string; tags: string[]; parent_version: string | null;
  from_entry_id: string | null; from_cook_log_id: string | null; testing: string;
}) {
  let draftId: string;
  if (recipe.draft) {
    draftId = recipe.draft.id;
    await sql`
      UPDATE entries SET cooklang_text = ${input.text}, tags = ${input.tags},
                          parent_version = ${input.parent_version}, current_beta_version = NULL,
                          changelog = ${input.testing},
                          from_entry_id = ${input.from_entry_id}, from_cook_log_id = ${input.from_cook_log_id}
      WHERE id = ${draftId}
    `;
  } else {
    draftId = generateId();
    await sql`
      INSERT INTO entries (id, branch_id, version_string, status, cooklang_text, parent_version, tags,
                           changelog, from_entry_id, from_cook_log_id)
      VALUES (${draftId}, ${recipe.branch.id}, NULL, 'draft', ${input.text}, ${input.parent_version}, ${input.tags},
              ${input.testing}, ${input.from_entry_id}, ${input.from_cook_log_id})
    `;
  }
  await syncReferencesForEntry(draftId, input.text);
}

export async function forkBranchHeadToDraft(slug: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  const source = recipe.current_version || recipe.open_tests[0] || latestComparableVersion(recipe.versions) || recipe.source_version;
  if (!source) throw new Error("no branch head to fork");
  await forkVersionToDraft(slug, source.version_string!, branchSlug);
  return { ok: true };
}

export interface DraftSnapshot {
  cooklang_text?: unknown;
  tags?: unknown;
  parent_version?: unknown;
  current_beta_version?: unknown;
  testing?: unknown;
  from_entry_id?: unknown;
  from_cook_log_id?: unknown;
}

// Undo for the fork-to-draft actions: the client captures the draft before
// overwriting it and can put it back here. Lineage pointers are restored only
// when they still name a version on this branch.
export async function restoreDraftSnapshot(slug: string, snapshot: DraftSnapshot, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = await requireRecipe(slug, branchSlug);
  if (!recipe.draft) throw new Error("no draft to restore into");
  if (typeof snapshot.cooklang_text !== "string") throw new Error("cooklang_text is required");
  const text = snapshot.cooklang_text;
  let tags: string[] = [];
  try {
    const raw = typeof snapshot.tags === "string" ? JSON.parse(snapshot.tags) : snapshot.tags;
    if (Array.isArray(raw)) tags = raw.filter((t): t is string => typeof t === "string");
  } catch {}
  const known = new Set(recipe.versions.map((v) => v.version_string).filter(Boolean));
  const lineage = (value: unknown) => (typeof value === "string" && known.has(value) ? value : null);
  const entryIds = new Set(recipe.versions.map((v) => v.id));
  const fromEntry = typeof snapshot.from_entry_id === "string" && entryIds.has(snapshot.from_entry_id) ? snapshot.from_entry_id : null;
  const fromCook = typeof snapshot.from_cook_log_id === "string"
    && (await sql`SELECT 1 FROM cook_logs WHERE id = ${snapshot.from_cook_log_id} AND branch_id = ${recipe.branch.id}`).length
    ? snapshot.from_cook_log_id : null;
  await sql`
    UPDATE entries SET cooklang_text = ${text}, tags = ${tags},
                        parent_version = ${lineage(snapshot.parent_version)},
                        current_beta_version = ${lineage(snapshot.current_beta_version)},
                        changelog = ${typeof snapshot.testing === "string" ? snapshot.testing : ""},
                        from_entry_id = ${fromEntry}, from_cook_log_id = ${fromCook}
    WHERE id = ${recipe.draft.id}
  `;
  await syncReferencesForEntry(recipe.draft.id, text);
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
  // A sheet's photos: its cooks' photos, newest cook first, then any
  // attached to the sheet itself (before photos belonged to cooks).
  const rows = await sql<{
    id: string; recipe_id: string; entry_id: string | null; cook_log_id: string | null;
    cooked_at: Date | null; filename: string; mime_type: string; created_at: Date;
  }[]>`
    SELECT i.id, i.recipe_id, i.entry_id, i.cook_log_id, cl.cooked_at, i.filename, i.mime_type, i.created_at
    FROM images i
    LEFT JOIN cook_logs cl ON cl.id = i.cook_log_id
    WHERE i.recipe_id = ${recipe.id}
      AND ${entryId === null
        ? sql`i.entry_id IS NULL AND i.cook_log_id IS NULL`
        : sql`(i.entry_id = ${entryId} OR cl.source_entry_id = ${entryId})`}
      AND i.is_thumbnail = false
    ORDER BY (i.cook_log_id IS NULL), cl.cooked_at DESC, i.created_at
  `;
  return rows.map((r) => ({
    id: r.id,
    recipe_id: r.recipe_id,
    version_id: r.entry_id,
    cook_log_id: r.cook_log_id,
    cooked_at: r.cooked_at ? r.cooked_at.toISOString() : null,
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

// A photo of a cook. Returns the cook, with its photos.
export async function attachCookPhoto(
  slug: string,
  cookLogId: string,
  image: { filename: string; mime_type: string; data: Buffer },
  branchSlug = MAIN_BRANCH_SLUG,
): Promise<CookLogRecord> {
  const log = await getCookLog(slug, cookLogId, branchSlug);
  if (!log) throw new Error("cook log not found");
  await sql`
    INSERT INTO images (id, recipe_id, cook_log_id, filename, mime_type, data)
    VALUES (${generateId()}, ${log.recipe_id}, ${log.id}, ${image.filename}, ${image.mime_type}, ${image.data})
  `;
  return (await getCookLog(slug, cookLogId, branchSlug))!;
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
  intended?: unknown;
  // Only read on create: how the paper showed the amounts.
  display?: unknown;
  // Only read on create: the log's amounts are at this scale of the source.
  scale?: number;
}

// Keep only well-formed "I meant this" keys, once each.
export function normalizeIntended(raw: unknown): CookIntendedKey[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CookIntendedKey[] = [];
  for (const item of raw) {
    const kind = (item as any)?.kind;
    const n = Number((item as any)?.n);
    if (!["ingredient", "timer", "inlineQuantity"].includes(kind) || !Number.isInteger(n) || n < 0) continue;
    const key: CookIntendedKey = { kind, name: String((item as any)?.name ?? "").trim().toLowerCase(), n };
    const id = JSON.stringify(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out;
}

// The source as it read at the log's scale — what a log is compared with, so
// an unchanged 2× cook shows no differences.
export function cookLogSourceAtLogScale(log: Pick<CookLogRecord, "source_cooklang_text" | "scale">): string {
  return scaleCooklangText(log.source_cooklang_text || "", log.scale || 1);
}

// The log's recipe back at the recipe's own scale, deviation markers
// resolved — what goes into a draft or a promoted version.
export function cookLogTextAtRecipeScale(log: Pick<CookLogRecord, "cooklang_text" | "source_cooklang_text" | "scale">, text = log.cooklang_text): string {
  return unscaleCooklangText(resolveDeviationMarkers(text || ""), log.scale || 1, log.source_cooklang_text || "");
}

export type CookLogSourceSpec =
  | { kind: "draft" }
  | { kind: "version"; version_string: string };

async function loadCookLogsForBranch(branchId: string, filter?: { version: string }): Promise<CookLogRow[]> {
  if (filter) {
    return sql<CookLogRow[]>`
      SELECT cl.id, cl.branch_id, b.slug AS branch_slug, b.recipe_id,
             cl.source_entry_id, cl.source_kind, cl.source_version,
             cl.cooklang_text, cl.source_cooklang_text, cl.tags, cl.scale,
             cl.cooked_at, cl.outcome, cl.what_worked, cl.problems_found,
             cl.changes_to_try_next, cl.freeform_notes, cl.intended, cl.display, cl.created_at, cl.updated_at,
           ARRAY(SELECT i.id FROM images i WHERE i.cook_log_id = cl.id ORDER BY i.created_at) AS photo_ids
      FROM cook_logs cl
      JOIN branches b ON b.id = cl.branch_id
      WHERE cl.branch_id = ${branchId} AND cl.source_version = ${filter.version}
      ORDER BY cl.cooked_at DESC, cl.created_at DESC
    `;
  }
  return sql<CookLogRow[]>`
    SELECT cl.id, cl.branch_id, b.slug AS branch_slug, b.recipe_id,
           cl.source_entry_id, cl.source_kind, cl.source_version,
           cl.cooklang_text, cl.source_cooklang_text, cl.tags, cl.scale,
           cl.cooked_at, cl.outcome, cl.what_worked, cl.problems_found,
           cl.changes_to_try_next, cl.freeform_notes, cl.intended, cl.display, cl.created_at, cl.updated_at,
           ARRAY(SELECT i.id FROM images i WHERE i.cook_log_id = cl.id ORDER BY i.created_at) AS photo_ids
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
           cl.cooklang_text, cl.source_cooklang_text, cl.tags, cl.scale,
           cl.cooked_at, cl.outcome, cl.what_worked, cl.problems_found,
           cl.changes_to_try_next, cl.freeform_notes, cl.intended, cl.display, cl.created_at, cl.updated_at,
           ARRAY(SELECT i.id FROM images i WHERE i.cook_log_id = cl.id ORDER BY i.created_at) AS photo_ids
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
  // Nothing is required: a cook exists from its first change, and the
  // outcome often comes last.
  const outcome = String(input.outcome || "").trim();

  const cookedAt = validateCookedAt(input.cooked_at);
  const sourceText = sourceEntry.cooklang_text || "";
  const scale = normalizeScale(input.scale ?? 1);
  const cooklangText = typeof input.cooklang_text === "string" ? input.cooklang_text : scaleCooklangText(sourceText, scale);
  const tags = Array.isArray(input.tags) ? input.tags.map(String) : JSON.parse(sourceEntry.tags || "[]");
  const id = generateId();

  await sql`
    INSERT INTO cook_logs (
      id, branch_id, source_entry_id, source_kind, source_version,
      cooklang_text, source_cooklang_text, tags, scale, cooked_at,
      outcome, what_worked, problems_found, changes_to_try_next, freeform_notes, intended, display
    ) VALUES (
      ${id}, ${branchId}, ${sourceEntry.id}, ${source.kind},
      ${source.kind === "version" ? sourceEntry.version_string : null},
      ${cooklangText}, ${sourceText}, ${tags}, ${scale}, ${cookedAt},
      ${outcome}, ${String(input.what_worked || "")},
      ${String(input.problems_found || "")},
      ${String(input.changes_to_try_next || "")},
      ${String(input.freeform_notes || "")},
      ${sql.json(normalizeIntended(input.intended) as any)},
      ${sql.json(normalizeDisplay(input.display) as any)}
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
  const next = {
    cooked_at: patch.cooked_at !== undefined ? validateCookedAt(patch.cooked_at) : existing.cooked_at,
    outcome: nextOutcome,
    what_worked: patch.what_worked !== undefined ? String(patch.what_worked) : existing.what_worked,
    problems_found: patch.problems_found !== undefined ? String(patch.problems_found) : existing.problems_found,
    changes_to_try_next: patch.changes_to_try_next !== undefined ? String(patch.changes_to_try_next) : existing.changes_to_try_next,
    freeform_notes: patch.freeform_notes !== undefined ? String(patch.freeform_notes) : existing.freeform_notes,
    cooklang_text: patch.cooklang_text !== undefined ? String(patch.cooklang_text) : existing.cooklang_text,
    tags: Array.isArray(patch.tags) ? patch.tags.map(String) : existing.tags,
    intended: patch.intended !== undefined ? normalizeIntended(patch.intended) : existing.intended,
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
      tags = ${next.tags},
      intended = ${sql.json(next.intended as any)}
    WHERE id = ${id}
  `;
  return (await getCookLog(slug, id, branchSlug))!;
}

export async function deleteCookLog(slug: string, id: string, branchSlug = MAIN_BRANCH_SLUG): Promise<void> {
  await sql`DELETE FROM cook_logs WHERE id = ${id}`;
}

// "New test from this cook": the working copy becomes the cook as cooked,
// back at 1×.
export async function forkCookLogToDraft(slug: string, logId: string, branchSlug = MAIN_BRANCH_SLUG, options: { testing?: string } = {}) {
  const recipe = await requireRecipe(slug, branchSlug);
  const log = await getCookLog(slug, logId, branchSlug);
  if (!log) throw new Error("cook log not found");
  if (!log.cooklang_text.trim()) throw new Error("cook log has no recipe text to fork");
  const sheet = recipe.versions.find((v) => v.version_string === log.source_version_string) || null;
  await writeDraft(recipe, {
    text: cookLogTextAtRecipeScale(log),
    tags: log.tags,
    parent_version: log.source_version_string,
    from_entry_id: sheet?.kind === "test" ? sheet.id : null,
    from_cook_log_id: log.id,
    testing: String(options.testing || "").trim(),
  });
  return { ok: true };
}

// Adopt a cook: the sheet it was cooked from plus what was done differently
// (all of it, or the cherry-picked text), merged into the current version.
async function adoptCook(
  slug: string,
  logId: string,
  text: string,
  release: { version_string: string; status?: string; changelog?: string },
  branchSlug: string,
) {
  if (release.status && release.status !== "released") throw new Error("only versions can be made from a cook");
  const recipe = await requireRecipe(slug, branchSlug);
  const log = await getCookLog(slug, logId, branchSlug);
  if (!log) throw new Error("cook log not found");
  if (!text.trim()) throw new Error("cook log has no recipe text to promote");
  const sheet = recipe.versions.find((v) => v.version_string === log.source_version_string && log.source_kind === "version") || null;
  const baseText = sheet ? baseTextFor(recipe, sheet) : (log.source_cooklang_text || null);
  const { text: finalText, mode } = adoptedText(baseText, recipe.current_version?.cooklang_text ?? null, text);
  await insertVersion(recipe, {
    version_string: release.version_string,
    changelog: release.changelog,
    text: finalText,
    tags: log.tags,
    from_entry_id: sheet?.kind === "test" ? sheet.id : null,
    from_cook_log_id: log.id,
    close_test_id: sheet?.kind === "test" && sheet.open ? sheet.id : null,
  });
  return { ok: true, version_string: release.version_string.trim(), merged: mode === "merged" };
}

export async function promoteCookLog(
  slug: string,
  logId: string,
  release: { version_string: string; status?: string; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const log = await getCookLog(slug, logId, branchSlug);
  if (!log) throw new Error("cook log not found");
  return adoptCook(slug, logId, log.cooklang_text.trim() ? cookLogTextAtRecipeScale(log) : "", release, branchSlug);
}

// Cherry-pick: the route has already built the text from the sheet plus the
// picked changes.
export async function promoteCookLogWithText(
  slug: string,
  logId: string,
  cooklangText: string,
  release: { version_string: string; status?: string; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  return adoptCook(slug, logId, cooklangText, release, branchSlug);
}

// ── Branch sync (3-way merge wrappers) ───────────────────────────────────────
// The pure merge algorithm lives in ./store/merge.ts. The wrappers below read
// the relevant entries from the DB and feed their cooklang_text into it.

async function findEntryById(id: string): Promise<VersionRecord | null> {
  const rows = await sql<EntryRow[]>`
    SELECT e.id, e.branch_id, b.slug AS branch_slug, b.recipe_id,
           e.version_string, e.status, e.cooklang_text, e.changelog,
           e.parent_version, e.current_beta_version, e.tags,
           e.created_at, e.updated_at,
           e.test_number, e.test_base, e.test_seq, e.closed_as, e.closed_at, e.from_entry_id, e.from_cook_log_id
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
