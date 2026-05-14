/**
 * One-shot migration from the file-based + legacy SQLite hybrid to PostgreSQL.
 *
 * Usage:
 *   npm run migrate -- --dry-run     # validate, don't commit
 *   npm run migrate -- --force       # run even if target tables aren't empty
 *
 * Reads:
 *   $DATA_DIR/recipes/*               filesystem tree
 *   $DATA_DIR/recipevault.db          legacy SQLite (for cook logs only)
 *
 * Writes:
 *   PostgreSQL via $DATABASE_URL
 */

import fs from "fs";
import path from "path";
// @ts-ignore — node:sqlite is experimental in Node 22, types may not exist
import { DatabaseSync } from "node:sqlite";
import { sql, applySchema } from "../src/db.ts";

const DATA_DIR = process.env.DATA_DIR || "./data";
const RECIPES_DIR = path.join(DATA_DIR, "recipes");
const LEGACY_DB_PATH = path.join(DATA_DIR, "recipevault.db");
const MAIN_BRANCH_SLUG = "main";

const flags = new Set(process.argv.slice(2));
const DRY_RUN = flags.has("--dry-run") || process.env.DRY_RUN === "1";
const FORCE = flags.has("--force") || process.env.FORCE === "1";
if (DRY_RUN) console.log("[migrate] DRY_RUN enabled — no writes will be committed");

interface RecipeMeta {
  id: string;
  slug: string;
  title: string;
  thumbnail_image_id?: string | null;
  created_at: string;
  updated_at: string;
  branches?: Array<{
    id: string;
    slug: string;
    name: string;
    kind: "main" | "variant";
    upstream_branch_slug: string | null;
    forked_from_version_id: string | null;
    last_merged_upstream_version_id: string | null;
    created_at: string;
    updated_at: string;
    archived_at?: string | null;
  }>;
}

interface VersionMeta {
  id: string;
  branch_slug: string;
  version_string: string | null;
  status: "draft" | "released" | "beta" | "archived";
  changelog: string;
  parent_version: string | null;
  current_beta_version?: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_draft: boolean;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

async function assertTargetEmpty(): Promise<void> {
  const [recipes, branches, entries, images, cookLogs] = await Promise.all([
    sql`SELECT COUNT(*)::int AS n FROM recipes`,
    sql`SELECT COUNT(*)::int AS n FROM branches`,
    sql`SELECT COUNT(*)::int AS n FROM entries`,
    sql`SELECT COUNT(*)::int AS n FROM images`,
    sql`SELECT COUNT(*)::int AS n FROM cook_logs`,
  ]);
  const counts = {
    recipes: recipes[0].n, branches: branches[0].n, entries: entries[0].n,
    images: images[0].n, cook_logs: cookLogs[0].n,
  };
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0 && !FORCE) {
    console.error("[migrate] Target tables are not empty:", counts);
    console.error("[migrate] Pass --force to overwrite, or wipe the DB first.");
    process.exit(2);
  }
  if (FORCE && total > 0) {
    console.log("[migrate] --force: wiping target tables");
    await sql`TRUNCATE recipes, branches, entries, images, cook_logs, recipe_references CASCADE`;
  }
}

interface MigrationPlan {
  recipes: Array<{ row: any; meta: RecipeMeta }>;
  branches: Array<{ row: any; sourceVersionId: string | null; lastMergedVersionId: string | null; parentBranchSlug: string | null }>;
  entries: Array<{ row: any; cooklang_text: string }>;
  images: Array<{ row: any; data: Buffer; isThumbnail: boolean }>;
  cookLogs: Array<{ row: any }>;
}

function walkRecipes(): RecipeMeta[] {
  if (!exists(RECIPES_DIR)) return [];
  return fs.readdirSync(RECIPES_DIR)
    .map((slug) => path.join(RECIPES_DIR, slug))
    .filter((dir) => fs.statSync(dir).isDirectory())
    .map((dir) => path.join(dir, "recipe.json"))
    .filter(exists)
    .map((p) => readJson<RecipeMeta>(p));
}

function readVersion(dir: string): { meta: VersionMeta; content: string } | null {
  const metaPath = path.join(dir, "meta.json");
  if (!exists(metaPath)) return null;
  const meta = readJson<VersionMeta>(metaPath);
  const contentPath = path.join(dir, "content.cook");
  const content = exists(contentPath) ? fs.readFileSync(contentPath, "utf8") : "";
  return { meta, content };
}

function collectImageFiles(dir: string): Array<{ id: string; filename: string; data: Buffer }> {
  const imagesDir = path.join(dir, "images");
  if (!exists(imagesDir)) return [];
  return fs.readdirSync(imagesDir)
    .map((file) => ({ file, full: path.join(imagesDir, file) }))
    .filter(({ full }) => fs.statSync(full).isFile())
    .map(({ file, full }) => {
      const id = path.parse(file).name;
      return { id, filename: file, data: fs.readFileSync(full) };
    });
}

async function plan(): Promise<MigrationPlan> {
  const result: MigrationPlan = { recipes: [], branches: [], entries: [], images: [], cookLogs: [] };
  const recipes = walkRecipes();

  // Map of legacy version id → { branch_slug, version_string } for FK resolution
  const versionIdIndex = new Map<string, { recipeSlug: string; branchSlug: string; entryId: string }>();

  for (const recipe of recipes) {
    result.recipes.push({
      row: {
        id: recipe.id,
        slug: recipe.slug,
        title: recipe.title,
        created_at: recipe.created_at,
        updated_at: recipe.updated_at,
      },
      meta: recipe,
    });

    for (const branch of recipe.branches || []) {
      result.branches.push({
        row: {
          id: branch.id,
          recipe_id: recipe.id,
          slug: branch.slug,
          name: branch.name,
          kind: branch.kind,
          archived_at: branch.archived_at || null,
          created_at: branch.created_at,
          updated_at: branch.updated_at,
        },
        sourceVersionId: branch.forked_from_version_id,
        lastMergedVersionId: branch.last_merged_upstream_version_id,
        parentBranchSlug: branch.upstream_branch_slug,
      });

      const branchDir = path.join(RECIPES_DIR, recipe.slug, "branches", branch.slug);

      // Draft
      const draft = readVersion(path.join(branchDir, "draft"));
      if (draft) {
        result.entries.push({
          row: {
            id: draft.meta.id,
            branch_id: branch.id,
            version_string: null,
            status: "draft",
            cooklang_text: draft.content,
            changelog: draft.meta.changelog || "",
            parent_version: draft.meta.parent_version,
            current_beta_version: draft.meta.current_beta_version || null,
            tags: draft.meta.tags || [],
            created_at: draft.meta.created_at,
            updated_at: draft.meta.updated_at,
          },
          cooklang_text: draft.content,
        });
        versionIdIndex.set(draft.meta.id, { recipeSlug: recipe.slug, branchSlug: branch.slug, entryId: draft.meta.id });
        for (const img of collectImageFiles(path.join(branchDir, "draft"))) {
          result.images.push({
            row: {
              id: img.id, recipe_id: recipe.id, entry_id: draft.meta.id,
              is_thumbnail: false, filename: img.filename,
              mime_type: guessMimeType(img.filename),
            },
            data: img.data, isThumbnail: false,
          });
        }
      }

      // Versions
      const versionsRoot = path.join(branchDir, "versions");
      if (exists(versionsRoot)) {
        for (const vSeg of fs.readdirSync(versionsRoot)) {
          const vDir = path.join(versionsRoot, vSeg);
          if (!fs.statSync(vDir).isDirectory()) continue;
          const v = readVersion(vDir);
          if (!v) continue;
          result.entries.push({
            row: {
              id: v.meta.id,
              branch_id: branch.id,
              version_string: v.meta.version_string,
              status: v.meta.status,
              cooklang_text: v.content,
              changelog: v.meta.changelog || "",
              parent_version: v.meta.parent_version,
              current_beta_version: v.meta.current_beta_version || null,
              tags: v.meta.tags || [],
              created_at: v.meta.created_at,
              updated_at: v.meta.updated_at,
            },
            cooklang_text: v.content,
          });
          versionIdIndex.set(v.meta.id, { recipeSlug: recipe.slug, branchSlug: branch.slug, entryId: v.meta.id });
          for (const img of collectImageFiles(vDir)) {
            result.images.push({
              row: {
                id: img.id, recipe_id: recipe.id, entry_id: v.meta.id,
                is_thumbnail: false, filename: img.filename,
                mime_type: guessMimeType(img.filename),
              },
              data: img.data, isThumbnail: false,
            });
          }
        }
      }

      // Branch-level images (no version)
      for (const img of collectImageFiles(branchDir)) {
        result.images.push({
          row: {
            id: img.id, recipe_id: recipe.id, entry_id: null,
            is_thumbnail: false, filename: img.filename,
            mime_type: guessMimeType(img.filename),
          },
          data: img.data, isThumbnail: false,
        });
      }
    }

    // Recipe-level images + thumbnail
    const recipeImagesDir = path.join(RECIPES_DIR, recipe.slug);
    for (const img of collectImageFiles(recipeImagesDir)) {
      const isThumb = recipe.thumbnail_image_id === img.id;
      result.images.push({
        row: {
          id: img.id, recipe_id: recipe.id, entry_id: null,
          is_thumbnail: isThumb, filename: img.filename,
          mime_type: guessMimeType(img.filename),
        },
        data: img.data, isThumbnail: isThumb,
      });
    }
  }

  // Cook logs from legacy SQLite
  if (exists(LEGACY_DB_PATH)) {
    const legacy = new DatabaseSync(LEGACY_DB_PATH, { readOnly: true });
    try {
      const rows = legacy.prepare(`SELECT * FROM cook_logs`).all() as any[];
      for (const row of rows) {
        const branchId = result.branches.find(
          (b) => b.row.recipe_id === row.recipe_id && b.row.slug === row.branch_slug
        )?.row.id;
        if (!branchId) {
          console.warn(`[migrate] cook log ${row.id} references missing branch ${row.recipe_id}/${row.branch_slug}, skipping`);
          continue;
        }
        const sourceEntryId = result.entries.find(
          (e) => e.row.branch_id === branchId
            && (e.row.version_string === row.source_version_string || e.row.version_string === row.version_string)
        )?.row.id || null;
        result.cookLogs.push({
          row: {
            id: row.id,
            branch_id: branchId,
            source_entry_id: sourceEntryId,
            source_kind: row.source_kind || (row.version_string ? "version" : "draft"),
            source_version: row.source_version_string || row.version_string,
            cooklang_text: row.cooklang_text || "",
            source_cooklang_text: row.source_cooklang_text || "",
            tags: JSON.parse(row.tags || "[]"),
            cooked_at: row.cooked_at,
            outcome: row.outcome || "",
            what_worked: row.what_worked || "",
            problems_found: row.problems_found || "",
            changes_to_try_next: row.changes_to_try_next || "",
            freeform_notes: row.freeform_notes || "",
            created_at: row.created_at,
            updated_at: row.updated_at,
          },
        });
      }
    } finally {
      legacy.close();
    }
  }

  return result;
}

function guessMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".jpg": case ".jpeg": return "image/jpeg";
    case ".png": return "image/png";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

async function commitPlan(p: MigrationPlan): Promise<void> {
  await sql.begin(async (tx) => {
    for (const r of p.recipes) {
      await tx`
        INSERT INTO recipes (id, slug, title, created_at, updated_at)
        VALUES (${r.row.id}, ${r.row.slug}, ${r.row.title}, ${r.row.created_at}, ${r.row.updated_at})
      `;
    }
    // Branches without FKs first; resolve forked_from_entry_id / parent_branch_id afterwards
    for (const b of p.branches) {
      await tx`
        INSERT INTO branches (id, recipe_id, slug, name, kind, archived_at, created_at, updated_at)
        VALUES (${b.row.id}, ${b.row.recipe_id}, ${b.row.slug}, ${b.row.name}, ${b.row.kind},
                ${b.row.archived_at}, ${b.row.created_at}, ${b.row.updated_at})
      `;
    }
    for (const e of p.entries) {
      await tx`
        INSERT INTO entries (id, branch_id, version_string, status, cooklang_text,
                             changelog, parent_version, current_beta_version, tags,
                             created_at, updated_at)
        VALUES (${e.row.id}, ${e.row.branch_id}, ${e.row.version_string}, ${e.row.status},
                ${e.row.cooklang_text}, ${e.row.changelog}, ${e.row.parent_version},
                ${e.row.current_beta_version}, ${e.row.tags}, ${e.row.created_at}, ${e.row.updated_at})
      `;
    }
    // Second pass: branches' FK fields and parent_branch_id
    for (const b of p.branches) {
      const parentBranchId = b.parentBranchSlug
        ? p.branches.find((other) => other.row.recipe_id === b.row.recipe_id && other.row.slug === b.parentBranchSlug)?.row.id
        : null;
      await tx`
        UPDATE branches SET
          parent_branch_id = ${parentBranchId || null},
          forked_from_entry_id = ${b.sourceVersionId || null},
          last_merged_upstream_entry_id = ${b.lastMergedVersionId || null}
        WHERE id = ${b.row.id}
      `;
    }
    for (const img of p.images) {
      await tx`
        INSERT INTO images (id, recipe_id, entry_id, is_thumbnail, filename, mime_type, data)
        VALUES (${img.row.id}, ${img.row.recipe_id}, ${img.row.entry_id},
                ${img.row.is_thumbnail}, ${img.row.filename}, ${img.row.mime_type}, ${img.data})
      `;
    }
    for (const log of p.cookLogs) {
      await tx`
        INSERT INTO cook_logs (id, branch_id, source_entry_id, source_kind, source_version,
                               cooklang_text, source_cooklang_text, tags, cooked_at,
                               outcome, what_worked, problems_found, changes_to_try_next,
                               freeform_notes, created_at, updated_at)
        VALUES (${log.row.id}, ${log.row.branch_id}, ${log.row.source_entry_id},
                ${log.row.source_kind}, ${log.row.source_version},
                ${log.row.cooklang_text}, ${log.row.source_cooklang_text},
                ${log.row.tags}, ${log.row.cooked_at},
                ${log.row.outcome}, ${log.row.what_worked}, ${log.row.problems_found},
                ${log.row.changes_to_try_next}, ${log.row.freeform_notes},
                ${log.row.created_at}, ${log.row.updated_at})
      `;
    }
  });
}

async function populateReferences(): Promise<number> {
  // Parsing references requires the cooklang parser. Re-import here to avoid
  // pulling in the entire recipe-store at top level.
  const { parseCooklang, parseReferencePath } = await import("../src/cooklang.ts");
  const entries = await sql<{ id: string; cooklang_text: string }[]>`
    SELECT id, cooklang_text FROM entries WHERE cooklang_text <> ''
  `;
  const recipeBySlug = new Map<string, string>(
    (await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM recipes`)
      .map((r) => [r.slug, r.id])
  );
  let inserted = 0;
  for (const entry of entries) {
    const parsed = parseCooklang(entry.cooklang_text);
    const refs = new Map<string, { recipe_id: string; pinned_version: string | null }>();
    for (const ingredient of parsed.ingredients || []) {
      if (!ingredient.recipe_reference) continue;
      const key = ingredient.reference_path || ingredient.name || "";
      const { slug, version } = parseReferencePath(key);
      if (!slug) continue;
      const recipeId = recipeBySlug.get(slug);
      if (!recipeId) continue;
      const prev = refs.get(recipeId);
      if (!prev || (!prev.pinned_version && version)) {
        refs.set(recipeId, { recipe_id: recipeId, pinned_version: version || null });
      }
    }
    for (const ref of refs.values()) {
      await sql`
        INSERT INTO recipe_references (from_entry_id, to_recipe_id, pinned_version)
        VALUES (${entry.id}, ${ref.recipe_id}, ${ref.pinned_version})
        ON CONFLICT DO NOTHING
      `;
      inserted += 1;
    }
  }
  return inserted;
}

async function main() {
  console.log("[migrate] applying schema");
  await applySchema();
  console.log("[migrate] checking target state");
  await assertTargetEmpty();
  console.log("[migrate] reading filesystem + legacy SQLite");
  const p = await plan();
  console.log("[migrate] plan:", {
    recipes: p.recipes.length,
    branches: p.branches.length,
    entries: p.entries.length,
    images: p.images.length,
    cook_logs: p.cookLogs.length,
  });
  if (DRY_RUN) {
    console.log("[migrate] --dry-run, not committing");
    await sql.end();
    return;
  }
  console.log("[migrate] writing to Postgres");
  await commitPlan(p);
  console.log("[migrate] populating recipe_references");
  const refs = await populateReferences();
  console.log("[migrate] inserted", refs, "references");
  const counts = {
    recipes: (await sql`SELECT COUNT(*)::int AS n FROM recipes`)[0].n,
    branches: (await sql`SELECT COUNT(*)::int AS n FROM branches`)[0].n,
    entries: (await sql`SELECT COUNT(*)::int AS n FROM entries`)[0].n,
    images: (await sql`SELECT COUNT(*)::int AS n FROM images`)[0].n,
    cook_logs: (await sql`SELECT COUNT(*)::int AS n FROM cook_logs`)[0].n,
    references: (await sql`SELECT COUNT(*)::int AS n FROM recipe_references`)[0].n,
  };
  console.log("[migrate] final counts:", counts);
  await sql.end();
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
