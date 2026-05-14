/**
 * Restore a pg_dump backup into the running Postgres container.
 *
 * Usage:
 *   npm run restore -- ./backups/ajilab-20260514-020000.dump
 *   npm run restore -- ./backups/latest.dump
 *
 * What it does:
 *   1. Verifies the dump file exists and looks like a Postgres custom-format dump
 *   2. Drops and recreates the public schema in the target database
 *   3. Streams the dump into `pg_restore` inside the `db` container
 *   4. Reports counts of restored rows per table
 *
 * Assumes:
 *   - docker compose stack is running (db service must be up)
 *   - DATABASE_URL points at the db service
 *
 * The app should be stopped (or at least idle) during restore. Restart with
 * `docker compose restart app` afterwards.
 */

import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { sql } from "../src/db.ts";

const dumpFile = process.argv[2];
if (!dumpFile) {
  console.error("Usage: npm run restore -- <path-to-dump-file>");
  process.exit(1);
}

const resolved = path.resolve(dumpFile);
if (!fs.existsSync(resolved)) {
  console.error(`[restore] dump file not found: ${resolved}`);
  process.exit(1);
}

// Verify it's a Postgres custom-format dump (magic bytes: "PGDMP")
const magic = Buffer.alloc(5);
const fd = fs.openSync(resolved, "r");
fs.readSync(fd, magic, 0, 5, 0);
fs.closeSync(fd);
if (magic.toString() !== "PGDMP") {
  console.error(`[restore] file does not look like a Postgres custom-format dump (magic=${magic.toString()})`);
  console.error("[restore] expected output of: pg_dump -Fc");
  process.exit(1);
}

const stats = fs.statSync(resolved);
console.log(`[restore] dump: ${resolved} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

async function main() {
  console.log("[restore] wiping target schema");
  await sql`DROP SCHEMA IF EXISTS public CASCADE`;
  await sql`CREATE SCHEMA public`;
  await sql`GRANT ALL ON SCHEMA public TO recipevault`;
  await sql.end();

  console.log("[restore] streaming dump into pg_restore");
  await new Promise<void>((resolve, reject) => {
    const child = spawn("docker", [
      "compose", "exec", "-T", "db",
      "pg_restore", "-U", "recipevault", "-d", "recipevault",
      "--no-owner", "--no-acl",
    ], { stdio: ["pipe", "inherit", "inherit"] });
    const stream = fs.createReadStream(resolved);
    stream.pipe(child.stdin!);
    child.on("error", reject);
    child.on("exit", (code) => {
      // pg_restore exits 1 even on success if there are non-fatal warnings.
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`pg_restore exited ${code}`));
    });
  });

  console.log("[restore] done. Restart the app: docker compose restart app");
}

main().catch((err) => {
  console.error("[restore] failed:", err);
  process.exit(1);
});
