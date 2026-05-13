// @ts-ignore — node:sqlite is experimental in Node 22, types may not exist
import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";

export const DATA_DIR = process.env.DATA_DIR || "./data";
const DB_PATH = path.join(DATA_DIR, "recipevault.db");

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode = WAL`);
db.exec(`PRAGMA foreign_keys = ON`);

db.exec(`
  CREATE TABLE IF NOT EXISTS recipes (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS recipe_versions (
    id              TEXT PRIMARY KEY,
    recipe_id       TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    version_string  TEXT,
    status          TEXT NOT NULL DEFAULT 'draft',
    cooklang_text   TEXT NOT NULL DEFAULT '',
    changelog       TEXT NOT NULL DEFAULT '',
    parent_version  TEXT,
    tags            TEXT NOT NULL DEFAULT '[]',
    servings        TEXT,
    notes           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    is_draft        INTEGER NOT NULL DEFAULT 1,
    UNIQUE(recipe_id, version_string)
  );

  CREATE TABLE IF NOT EXISTS recipe_images (
    id          TEXT PRIMARY KEY,
    recipe_id   TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    version_id  TEXT REFERENCES recipe_versions(id) ON DELETE SET NULL,
    branch_slug TEXT,
    version_key TEXT,
    filename    TEXT NOT NULL,
    mime_type   TEXT NOT NULL,
    data        BLOB NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cook_logs (
    id                    TEXT PRIMARY KEY,
    recipe_id             TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    branch_slug           TEXT NOT NULL,
    version_string        TEXT,
    source_kind           TEXT NOT NULL DEFAULT 'version',
    source_version_string TEXT,
    cooklang_text         TEXT NOT NULL DEFAULT '',
    source_cooklang_text  TEXT NOT NULL DEFAULT '',
    tags                  TEXT NOT NULL DEFAULT '[]',
    cooked_at             TEXT NOT NULL,
    outcome               TEXT NOT NULL DEFAULT '',
    what_worked           TEXT NOT NULL DEFAULT '',
    problems_found        TEXT NOT NULL DEFAULT '',
    changes_to_try_next   TEXT NOT NULL DEFAULT '',
    freeform_notes        TEXT NOT NULL DEFAULT '',
    created_at            TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_versions_recipe ON recipe_versions(recipe_id);
  CREATE INDEX IF NOT EXISTS idx_versions_status ON recipe_versions(status);
  CREATE INDEX IF NOT EXISTS idx_images_recipe ON recipe_images(recipe_id);
  CREATE INDEX IF NOT EXISTS idx_cook_logs_branch_version ON cook_logs(recipe_id, branch_slug, version_string);
  CREATE INDEX IF NOT EXISTS idx_cook_logs_branch_recent ON cook_logs(recipe_id, branch_slug, cooked_at DESC);
`);

const recipeColumns = db.prepare(`PRAGMA table_info(recipes)`).all() as Array<{ name: string }>;
if (!recipeColumns.some((column) => column.name === "thumbnail_image_id")) {
  db.exec(`ALTER TABLE recipes ADD COLUMN thumbnail_image_id TEXT`);
}

const recipeImageColumns = db.prepare(`PRAGMA table_info(recipe_images)`).all() as Array<{ name: string }>;
if (!recipeImageColumns.some((column) => column.name === "branch_slug")) {
  db.exec(`ALTER TABLE recipe_images ADD COLUMN branch_slug TEXT`);
}
if (!recipeImageColumns.some((column) => column.name === "version_key")) {
  db.exec(`ALTER TABLE recipe_images ADD COLUMN version_key TEXT`);
}
db.exec(`
  UPDATE recipe_images
  SET branch_slug = 'main'
  WHERE branch_slug IS NULL
`);
db.exec(`
  UPDATE recipe_images
  SET version_key = (
    SELECT recipe_versions.version_string
    FROM recipe_versions
    WHERE recipe_versions.id = recipe_images.version_id
  )
  WHERE version_key IS NULL
    AND version_id IS NOT NULL
`);

// Cook-logs schema upgrade (one-shot): adds cooklang snapshot fields, makes
// version_string nullable, and wipes any legacy narrative-only rows. Existing
// rows are intentionally dropped — per the redesign, cook logs are now per-
// batch records of the recipe-as-cooked and the old narrative-only rows can't
// be backfilled into that model.
export const cookLogsMigrationApplied = (() => {
  const columns = db.prepare(`PRAGMA table_info(cook_logs)`).all() as Array<{ name: string }>;
  const hasNewShape = columns.some((c) => c.name === "cooklang_text")
    && columns.some((c) => c.name === "source_cooklang_text");
  if (hasNewShape) return false;
  db.exec(`BEGIN`);
  try {
    db.exec(`DELETE FROM cook_logs`);
    db.exec(`
      CREATE TABLE cook_logs_new (
        id                    TEXT PRIMARY KEY,
        recipe_id             TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
        branch_slug           TEXT NOT NULL,
        version_string        TEXT,
        source_kind           TEXT NOT NULL DEFAULT 'version',
        source_version_string TEXT,
        cooklang_text         TEXT NOT NULL DEFAULT '',
        source_cooklang_text  TEXT NOT NULL DEFAULT '',
        tags                  TEXT NOT NULL DEFAULT '[]',
        cooked_at             TEXT NOT NULL,
        outcome               TEXT NOT NULL DEFAULT '',
        what_worked           TEXT NOT NULL DEFAULT '',
        problems_found        TEXT NOT NULL DEFAULT '',
        changes_to_try_next   TEXT NOT NULL DEFAULT '',
        freeform_notes        TEXT NOT NULL DEFAULT '',
        created_at            TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    db.exec(`DROP TABLE cook_logs`);
    db.exec(`ALTER TABLE cook_logs_new RENAME TO cook_logs`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cook_logs_branch_version ON cook_logs(recipe_id, branch_slug, version_string)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cook_logs_branch_recent ON cook_logs(recipe_id, branch_slug, cooked_at DESC)`);
    db.exec(`COMMIT`);
    return true;
  } catch (error) {
    db.exec(`ROLLBACK`);
    throw error;
  }
})();

function prep(sql: string) {
  return db.prepare(sql);
}

export const q = {
  recipeBySlug: prep(`SELECT * FROM recipes WHERE slug = ?`),
  recipeById: prep(`SELECT * FROM recipes WHERE id = ?`),
  insertRecipe: prep(`INSERT INTO recipes (id, slug, title, thumbnail_image_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`),
  updateRecipeTitle: prep(`UPDATE recipes SET title = ?, slug = ?, updated_at = ? WHERE id = ?`),
  updateRecipeThumbnail: prep(`UPDATE recipes SET thumbnail_image_id = ?, updated_at = ? WHERE id = ?`),
  clearRecipeThumbnailByImage: prep(`UPDATE recipes SET thumbnail_image_id = NULL WHERE thumbnail_image_id = ?`),
  deleteRecipe: prep(`DELETE FROM recipes WHERE id = ?`),
  touchRecipeTime: prep(`UPDATE recipes SET updated_at = ? WHERE id = ?`),

  imagesByRecipeAndBranchAndVersion: prep(`SELECT id, recipe_id, version_id, branch_slug, version_key, filename, mime_type, created_at FROM recipe_images WHERE recipe_id = ? AND branch_slug = ? AND ((? IS NULL AND version_key IS NULL) OR version_key = ?) ORDER BY created_at DESC`),
  imageById: prep(`SELECT recipe_images.*, recipes.slug FROM recipe_images JOIN recipes ON recipes.id = recipe_images.recipe_id WHERE recipe_images.id = ?`),
  insertImage: prep(`INSERT INTO recipe_images (id, recipe_id, version_id, branch_slug, version_key, filename, mime_type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, zeroblob(0), datetime('now'))`),
  clearImageData: prep(`UPDATE recipe_images SET data = zeroblob(0) WHERE id = ?`),
  deleteImage: prep(`DELETE FROM recipe_images WHERE id = ?`),
  imagesNeedingMigration: prep(`SELECT recipe_images.id, recipe_images.recipe_id, recipe_images.version_id, recipe_images.branch_slug, recipe_images.version_key, recipe_images.filename, recipe_images.mime_type, recipe_images.data, recipes.slug FROM recipe_images JOIN recipes ON recipes.id = recipe_images.recipe_id WHERE length(recipe_images.data) > 0`),

  legacyRecipes: prep(`SELECT * FROM recipes ORDER BY updated_at DESC`),
  legacyVersionsByRecipe: prep(`SELECT * FROM recipe_versions WHERE recipe_id = ? ORDER BY created_at DESC`),
  legacyVersionByString: prep(`SELECT * FROM recipe_versions WHERE recipe_id = ? AND version_string = ?`),

  insertCookLog: prep(`INSERT INTO cook_logs (id, recipe_id, branch_slug, version_string, source_kind, source_version_string, cooklang_text, source_cooklang_text, tags, cooked_at, outcome, what_worked, problems_found, changes_to_try_next, freeform_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateCookLog: prep(`UPDATE cook_logs SET cooked_at = ?, outcome = ?, what_worked = ?, problems_found = ?, changes_to_try_next = ?, freeform_notes = ?, cooklang_text = ?, tags = ?, updated_at = ? WHERE id = ?`),
  deleteCookLog: prep(`DELETE FROM cook_logs WHERE id = ?`),
  cookLogById: prep(`SELECT * FROM cook_logs WHERE id = ?`),
  cookLogsByBranch: prep(`SELECT * FROM cook_logs WHERE recipe_id = ? AND branch_slug = ? ORDER BY cooked_at DESC, created_at DESC`),
  cookLogsByBranchVersion: prep(`SELECT * FROM cook_logs WHERE recipe_id = ? AND branch_slug = ? AND (version_string = ? OR source_version_string = ?) ORDER BY cooked_at DESC, created_at DESC`),
  latestCookLogForBranch: prep(`SELECT * FROM cook_logs WHERE recipe_id = ? AND branch_slug = ? ORDER BY cooked_at DESC, created_at DESC LIMIT 1`),
  cookLogCountByBranch: prep(`SELECT COUNT(*) AS n FROM cook_logs WHERE recipe_id = ? AND branch_slug = ?`),
  cookLogsForMigration: prep(`SELECT * FROM cook_logs WHERE recipe_id = ? AND branch_slug = ?`),
};

export function generateId(): string {
  return crypto.randomUUID();
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
