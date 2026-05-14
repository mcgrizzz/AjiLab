import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL
  || "postgresql://ajilab:ajilab@localhost:5432/ajilab";

export const sql = postgres(DATABASE_URL, {
  max: parseInt(process.env.DATABASE_POOL_MAX || "10"),
  idle_timeout: 30,
  connect_timeout: 10,
  transform: { undefined: null },
});

export async function applySchema(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = path.join(here, "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await sql.unsafe(schemaSql);
}

export function generateId(): string {
  return crypto.randomUUID();
}

export function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
