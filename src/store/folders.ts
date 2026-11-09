import { sql } from "../db.ts";
import { requireRecipe } from "./loader.ts";

// ── Folders and icons ────────────────────────────────────────────────────────
// Both belong to the recipe, not to its text, so changing them makes no
// version, no diff and nothing to test.

export interface FolderRecord {
  id: string;
  name: string;
  icon: string;
  recipe_count: number;
}

// A refused folder or icon change, with the HTTP status the route returns.
export class FolderError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = "FolderError";
  }
}

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

// '' (none), one emoji ("🦃", "👩🏽‍🍳", "🇯🇵"), or a bundled icon
// ("lucide:wheat"). Anything else is refused; the client shows unknown
// icon names as no icon.
export function normalizeIcon(raw: unknown): string {
  const icon = String(raw ?? "").trim();
  if (!icon) return "";
  if (/^lucide:[a-z0-9-]{1,40}$/.test(icon)) return icon;
  const single = icon.length <= 32 && [...graphemes.segment(icon)].length === 1;
  if (single && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(icon)) return icon;
  throw new FolderError("An icon is one emoji or one of the bundled icons.", 400);
}

function folderName(raw: unknown): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new FolderError("A folder needs a name.", 400);
  if (name.length > 60) throw new FolderError("A folder name is at most 60 characters.", 400);
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === "23505";
}

async function nameTaken(name: string): Promise<FolderError> {
  const [row] = await sql<{ name: string }[]>`SELECT name FROM folders WHERE lower(name) = lower(${name})`;
  return new FolderError(`There's already a folder called “${row?.name || name}”.`, 409);
}

export async function listFolders(): Promise<FolderRecord[]> {
  return sql<FolderRecord[]>`
    SELECT f.id::text AS id, f.name, f.icon,
           (SELECT count(*)::int FROM recipe_folders rf WHERE rf.folder_id = f.id) AS recipe_count
    FROM folders f
    ORDER BY lower(f.name)
  `;
}

async function requireFolder(id: string): Promise<FolderRecord> {
  const uuid = /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  const rows = uuid ? (await listFolders()).filter((f) => f.id === uuid) : [];
  if (!rows.length) throw new FolderError("No such folder.", 404);
  return rows[0];
}

export async function createFolder(input: { name?: unknown; icon?: unknown }): Promise<FolderRecord> {
  const name = folderName(input.name);
  const icon = normalizeIcon(input.icon);
  try {
    const [row] = await sql<{ id: string }[]>`INSERT INTO folders (name, icon) VALUES (${name}, ${icon}) RETURNING id::text AS id`;
    return requireFolder(row.id);
  } catch (error) {
    if (isUniqueViolation(error)) throw await nameTaken(name);
    throw error;
  }
}

export async function updateFolder(id: string, input: { name?: unknown; icon?: unknown }): Promise<FolderRecord> {
  const folder = await requireFolder(id);
  const name = input.name === undefined ? folder.name : folderName(input.name);
  const icon = input.icon === undefined ? folder.icon : normalizeIcon(input.icon);
  try {
    await sql`UPDATE folders SET name = ${name}, icon = ${icon} WHERE id = ${folder.id}`;
  } catch (error) {
    if (isUniqueViolation(error)) throw await nameTaken(name);
    throw error;
  }
  return requireFolder(folder.id);
}

// The recipes in it stay, in their other folders or none.
export async function deleteFolder(id: string): Promise<void> {
  const folder = await requireFolder(id);
  await sql`DELETE FROM folders WHERE id = ${folder.id}`;
}

// Makes the folder hold exactly these recipes. A recipe already in it keeps
// its place (added_at); unknown slugs are refused before anything changes.
export async function setFolderRecipes(id: string, slugs: unknown): Promise<FolderRecord> {
  const folder = await requireFolder(id);
  const wanted = [...new Set((Array.isArray(slugs) ? slugs : []).map(String))];
  const rows = wanted.length
    ? await sql<{ id: string; slug: string }[]>`SELECT id::text AS id, slug FROM recipes WHERE slug = ANY(${wanted})`
    : [];
  const missing = wanted.filter((slug) => !rows.some((r) => r.slug === slug));
  if (missing.length) throw new FolderError(`No recipe “${missing[0]}”.`, 404);
  const ids = rows.map((r) => r.id);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM recipe_folders WHERE folder_id = ${folder.id} AND NOT (recipe_id::text = ANY(${ids}))`;
    for (const recipeId of ids) {
      await tx`INSERT INTO recipe_folders (recipe_id, folder_id) VALUES (${recipeId}, ${folder.id}) ON CONFLICT DO NOTHING`;
    }
  });
  return requireFolder(folder.id);
}

// Puts the recipe in exactly these folders.
export async function setRecipeFolders(slug: string, folderIds: unknown): Promise<string[]> {
  const recipe = await requireRecipe(slug);
  const wanted = [...new Set((Array.isArray(folderIds) ? folderIds : []).map(String))];
  const known = new Set((await listFolders()).map((f) => f.id));
  if (wanted.some((id) => !known.has(id))) throw new FolderError("No such folder.", 404);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM recipe_folders WHERE recipe_id = ${recipe.id} AND NOT (folder_id::text = ANY(${wanted}))`;
    for (const folderId of wanted) {
      await tx`INSERT INTO recipe_folders (recipe_id, folder_id) VALUES (${recipe.id}, ${folderId}) ON CONFLICT DO NOTHING`;
    }
  });
  const rows = await sql<{ id: string }[]>`
    SELECT folder_id::text AS id FROM recipe_folders WHERE recipe_id = ${recipe.id} ORDER BY added_at
  `;
  return rows.map((r) => r.id);
}

export async function setRecipeIcon(slug: string, raw: unknown): Promise<string> {
  const recipe = await requireRecipe(slug);
  const icon = normalizeIcon(raw);
  await sql`UPDATE recipes SET icon = ${icon} WHERE id = ${recipe.id}`;
  return icon;
}
