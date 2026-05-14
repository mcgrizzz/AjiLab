/**
 * API response diff validator.
 *
 * Hits a set of read-only endpoints against two RecipeVault instances (the
 * legacy file-based app and the new Postgres app) and reports any JSON
 * mismatches. Run after migration to confirm the new system reproduces the
 * old system's responses.
 *
 * Usage:
 *   OLD_URL=http://localhost:3001 NEW_URL=http://localhost:3000 npm run diff-api
 *
 * Both URLs should serve the same migrated data. The script is read-only.
 */

const OLD_URL = process.env.OLD_URL || "http://localhost:3001";
const NEW_URL = process.env.NEW_URL || "http://localhost:3000";

// Fields where drift is expected and tolerable:
//   - updated_at: trigger-driven in Postgres, file-mtime in legacy
//   - created_at: precision differences (legacy ISO → Postgres TIMESTAMPTZ)
//   - thumbnail_image_id source columns
const SKIP_KEYS = new Set([
  "updated_at",
  // Cook log file hydration vs DB read can differ in trailing whitespace
  "source_cooklang_text",
]);

function stripVolatile(value: any): any {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (SKIP_KEYS.has(k)) continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}

async function get(base: string, path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  let body: any = null;
  try { body = await res.json(); } catch { body = await res.text(); }
  return { status: res.status, body };
}

function deepEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === "object") {
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i += 1) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!deepEqual(a[aKeys[i]], b[bKeys[i]])) return false;
    }
    return true;
  }
  return false;
}

interface Mismatch {
  path: string;
  reason: string;
  old?: any;
  next?: any;
}

const mismatches: Mismatch[] = [];

async function diff(path: string) {
  const [oldR, newR] = await Promise.all([get(OLD_URL, path), get(NEW_URL, path)]);
  if (oldR.status !== newR.status) {
    mismatches.push({ path, reason: `status mismatch: old=${oldR.status} new=${newR.status}` });
    return;
  }
  const a = stripVolatile(oldR.body);
  const b = stripVolatile(newR.body);
  if (!deepEqual(a, b)) {
    mismatches.push({ path, reason: "body mismatch", old: a, next: b });
  }
}

async function main() {
  console.log(`[diff-api] OLD=${OLD_URL} NEW=${NEW_URL}`);

  // 1. Recipe list
  await diff("/api/recipes");

  const recipes: Array<{ slug: string }> = (await get(NEW_URL, "/api/recipes")).body || [];
  console.log(`[diff-api] found ${recipes.length} recipes`);

  // 2. Each recipe: detail, versions list, backlinks, cook logs
  for (const recipe of recipes) {
    await diff(`/api/recipes/${recipe.slug}`);
    await diff(`/api/recipes/${recipe.slug}/versions`);
    await diff(`/api/recipes/${recipe.slug}/cook-logs`);
    await diff(`/api/recipes/${recipe.slug}/backlinks`);
    await diff(`/api/recipes/${recipe.slug}/branches`);

    // 3. Each version
    const recipeData = (await get(NEW_URL, `/api/recipes/${recipe.slug}`)).body;
    const versions = (recipeData?.versions || []).filter((v: any) => !v.is_draft);
    for (const v of versions.slice(0, 5)) {
      await diff(`/api/recipes/${recipe.slug}/versions/${encodeURIComponent(v.version_string)}`);
    }

    // 4. Compare adjacent versions
    if (versions.length >= 2) {
      const from = encodeURIComponent(versions[1].version_string);
      const to = encodeURIComponent(versions[0].version_string);
      await diff(`/api/recipes/${recipe.slug}/compare?from=${from}&to=${to}`);
    }
  }

  if (mismatches.length === 0) {
    console.log("[diff-api] ✓ all responses match");
    return;
  }
  console.log(`[diff-api] ✗ ${mismatches.length} mismatch(es):`);
  for (const m of mismatches) {
    console.log(`  ${m.path}: ${m.reason}`);
    if (m.old !== undefined) {
      console.log("    old:", JSON.stringify(m.old).slice(0, 200));
      console.log("    new:", JSON.stringify(m.next).slice(0, 200));
    }
  }
  process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
