import { sql, generateId, slugify } from "../db.ts";
import { MAIN_BRANCH_SLUG, type RecipeRecord } from "./types.ts";
import { loadRecipeRecord, requireRecipe } from "./loader.ts";

export async function uniqueRecipeSlug(title: string, excludeSlug?: string): Promise<string> {
  const base = slugify(title) || "recipe";
  let candidate = base;
  let suffix = 2;
  while (true) {
    const rows = await sql<{ slug: string }[]>`SELECT slug FROM recipes WHERE slug = ${candidate}`;
    if (rows.length === 0 || rows[0].slug === excludeSlug) return candidate;
    candidate = `${base}-${suffix++}`;
  }
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
