/**
 * Copy all data from one AjiLab Postgres database to another.
 *
 * Usage:
 *   SOURCE_DATABASE_URL=postgres://... npm run transfer
 *
 * TARGET_DATABASE_URL defaults to DATABASE_URL (the current app's database).
 * You can point either direction:
 *
 *   # Remote → local Docker
 *   SOURCE_DATABASE_URL=postgres://user:pass@remote-host/db npm run transfer
 *
 *   # Local → remote
 *   SOURCE_DATABASE_URL=postgres://localhost/ajilab \
 *   TARGET_DATABASE_URL=postgres://user:pass@remote-host/db \
 *   npm run transfer
 *
 * Safe to run multiple times — skips rows that already exist in the target.
 * Pass --overwrite to replace them instead (useful for a full re-sync).
 *
 * The target schema is applied automatically, so the target can be empty.
 */

import postgres from "postgres";
import { applySchema } from "../src/db.ts";

const SOURCE_URL = process.env.SOURCE_DATABASE_URL;
const TARGET_URL = process.env.TARGET_DATABASE_URL
  || process.env.DATABASE_URL
  || "postgresql://ajilab:ajilab@localhost:5432/ajilab";
const OVERWRITE = process.argv.includes("--overwrite");

if (!SOURCE_URL) {
  console.error("Missing SOURCE_DATABASE_URL.\n");
  console.error("  SOURCE_DATABASE_URL=postgres://user:pass@host/db npm run transfer");
  process.exit(1);
}
if (SOURCE_URL === TARGET_URL) {
  console.error("SOURCE and TARGET are the same URL — nothing to do.");
  process.exit(1);
}

const src = postgres(SOURCE_URL, { max: 3, idle_timeout: 20 });

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url.replace(/:([^@]{2})[^@]*@/, ":$1***@");
  }
}

async function copyTable(
  tgt: postgres.Sql,
  table: string,
  columns: string[],
  opts: { batchSize?: number; orderBy?: string } = {},
) {
  const batchSize = opts.batchSize ?? 200;
  const orderBy = opts.orderBy ?? "created_at";
  const conflict = OVERWRITE
    ? `ON CONFLICT DO NOTHING`  // overwrite deletes first (below), then inserts
    : `ON CONFLICT DO NOTHING`;

  let total = 0;
  let offset = 0;

  while (true) {
    const rows = await src.unsafe(
      `SELECT ${columns.map((c) => `"${c}"`).join(", ")}
       FROM "${table}"
       ORDER BY "${orderBy}"
       LIMIT ${batchSize} OFFSET ${offset}`
    ) as Record<string, unknown>[];

    if (rows.length === 0) break;

    if (OVERWRITE && columns.includes("id")) {
      const ids = rows.map((r) => r.id as string);
      await tgt.unsafe(
        `DELETE FROM "${table}" WHERE id = ANY($1)`,
        [ids]
      );
    }

    // postgres.js multi-row insert: sql(rows, col1, col2, ...)
    await tgt`
      INSERT INTO ${tgt(table)} ${tgt(rows, ...columns)}
      ${tgt.unsafe(conflict)}
    `;

    total += rows.length;
    offset += rows.length;
    if (rows.length < batchSize) break;
  }

  console.log(`[transfer]   ${table.padEnd(22)} ${total}`);
  return total;
}

async function main() {
  console.log("[transfer] applying schema to target");
  await applySchema();

  const { sql: tgt } = await import("../src/db.ts");

  console.log(`[transfer] source: ${maskUrl(SOURCE_URL!)}`);
  console.log(`[transfer] target: ${maskUrl(TARGET_URL)}`);
  console.log(`[transfer] mode:   ${OVERWRITE ? "overwrite" : "fill (skip conflicts)"}\n`);

  // 1. Recipes
  await copyTable(tgt, "recipes",
    ["id", "slug", "title", "created_at", "updated_at"]);

  // 2. Branches — insert without the circular entry FKs first
  await copyTable(tgt, "branches",
    ["id", "recipe_id", "slug", "name", "kind", "archived_at", "created_at", "updated_at"]);

  // 3. Entries — depend on branches
  await copyTable(tgt, "entries",
    ["id", "branch_id", "version_string", "status", "cooklang_text",
     "changelog", "parent_version", "current_beta_version", "tags",
     "created_at", "updated_at"]);

  // 4. Backfill branch FK columns now that entries exist
  const branchFks = await src<{
    id: string;
    parent_branch_id: string | null;
    forked_from_entry_id: string | null;
    last_merged_upstream_entry_id: string | null;
  }[]>`SELECT id, parent_branch_id, forked_from_entry_id, last_merged_upstream_entry_id
       FROM branches`;
  for (const b of branchFks) {
    await tgt`
      UPDATE branches SET
        parent_branch_id              = ${b.parent_branch_id},
        forked_from_entry_id          = ${b.forked_from_entry_id},
        last_merged_upstream_entry_id = ${b.last_merged_upstream_entry_id}
      WHERE id = ${b.id}
    `;
  }
  console.log(`[transfer]   ${"branches (FK pass)".padEnd(22)} ${branchFks.length}`);

  // 5. Images — smaller batches because BYTEA can be large
  await copyTable(tgt, "images",
    ["id", "recipe_id", "entry_id", "is_thumbnail", "filename", "mime_type", "data", "created_at"],
    { batchSize: 20 });

  // 6. Cook logs
  await copyTable(tgt, "cook_logs",
    ["id", "branch_id", "source_entry_id", "source_kind", "source_version",
     "cooklang_text", "source_cooklang_text", "tags", "cooked_at",
     "outcome", "what_worked", "problems_found", "changes_to_try_next",
     "freeform_notes", "created_at", "updated_at"]);

  // 7. Recipe references (no id column — use composite PK)
  const refs = await src<{ from_entry_id: string; to_recipe_id: string; pinned_version: string | null }[]>`
    SELECT from_entry_id, to_recipe_id, pinned_version FROM recipe_references
  `;
  if (refs.length > 0) {
    await tgt`
      INSERT INTO recipe_references ${tgt(refs, "from_entry_id", "to_recipe_id", "pinned_version")}
      ON CONFLICT DO NOTHING
    `;
  }
  console.log(`[transfer]   ${"recipe_references".padEnd(22)} ${refs.length}`);

  console.log("\n[transfer] done.");
  await src.end();
  await tgt.end();
}

main().catch((err) => {
  console.error("[transfer] failed:", err.message || err);
  src.end().catch(() => {});
  process.exit(1);
});
