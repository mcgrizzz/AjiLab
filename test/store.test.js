// Store tests against a real (in-process) Postgres: see test/support/pg.js.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { setupStore } from "./support/pg.js";

let ctx;
before(async () => { ctx = await setupStore(); });
after(async () => { await ctx?.stop(); });

const V1 = `---
servings: 2
---
Mix @flour{500%g} and @water{375%g}. Rest ~{30%min}.`;

async function recipeWithRelease(title) {
  const { store } = ctx;
  const { slug } = await store.createRecipe(title);
  await store.updateDraft(slug, { cooklang_text: V1 });
  await store.releaseDraft(slug, { version_string: "v1.0", status: "released", changelog: "First" });
  return slug;
}

test("promoting a beta to a release copies it to a new row and keeps the beta", async () => {
  const { store } = ctx;
  const slug = await recipeWithRelease("Promote beta");
  const betaText = V1.replace("@water{375%g}", "@water{390%g}");
  const saved = await store.updateDraft(slug, { cooklang_text: betaText }, { advance_beta: true });
  assert.equal(saved.created_beta, "v1.1-beta.1");

  // A cook against the beta, logged before the promote.
  const log = await store.createCookLog(slug, { kind: "version", version_string: "v1.1-beta.1" }, {
    cooked_at: "2026-10-30T18:00:00.000Z",
    outcome: "Better",
  });

  const result = await store.releaseVersion(slug, "v1.1-beta.1", { version_string: "v1.1", status: "released", changelog: "More water" });
  assert.equal(result.version_string, "v1.1");

  const recipe = await store.getRecipeBySlug(slug);
  const beta = recipe.versions.find((v) => v.version_string === "v1.1-beta.1");
  const release = recipe.versions.find((v) => v.version_string === "v1.1");
  assert.ok(beta, "the beta is still there");
  assert.equal(beta.status, "beta");
  assert.ok(release, "the release exists");
  assert.notEqual(release.id, beta.id);
  assert.equal(release.status, "released");
  assert.equal(release.cooklang_text, betaText);
  assert.equal(release.changelog, "More water");
  assert.equal(recipe.latest_released, "v1.1");

  // The cook still points at the beta it was cooked from.
  const after = await store.getCookLog(slug, log.id);
  assert.equal(after.version_string, "v1.1-beta.1");
  assert.equal(after.source_cooklang_text, betaText);
});

test("re-releasing a release under a new version string works too", async () => {
  const { store } = ctx;
  const slug = await recipeWithRelease("Re-release");
  await store.releaseVersion(slug, "v1.0", { version_string: "v1.0.1", status: "released" });
  const recipe = await store.getRecipeBySlug(slug);
  assert.deepEqual(recipe.versions.map((v) => v.version_string).sort(), ["v1.0", "v1.0.1"]);
});

test("promoting to a version string that exists is refused", async () => {
  const { store } = ctx;
  const slug = await recipeWithRelease("Promote clash");
  await store.updateDraft(slug, { cooklang_text: V1.replace("500", "510") }, { advance_beta: true });
  await assert.rejects(
    store.releaseVersion(slug, "v1.1-beta.1", { version_string: "v1.0", status: "released" }),
    /version already exists/,
  );
});

test("releasing the draft removes it and records the release", async () => {
  const { store } = ctx;
  const slug = await recipeWithRelease("Release draft");
  const recipe = await store.getRecipeBySlug(slug);
  assert.equal(recipe.draft, null);
  assert.equal(recipe.latest_released, "v1.0");
  assert.equal(recipe.versions[0].cooklang_text, V1);
});
