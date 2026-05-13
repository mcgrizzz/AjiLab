import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recipevault-store-"));
process.env.DATA_DIR = dataDir;

const {
  attachRecipeImage,
  applyBranchSync,
  createCookLog,
  createRecipe,
  createRecipeBranch,
  deleteCookLog,
  deleteRecipeImage,
  forkBranchHeadToDraft,
  forkCookLogToDraft,
  getCookLog,
  getRecipeBySlug,
  listBranchCookLogs,
  listRecipeImages,
  listRecipes,
  previewBranchSync,
  promoteCookLog,
  readRecipeImage,
  releaseDraft,
  releaseVersion,
  setRecipeThumbnail,
  updateCookLog,
  updateDraft,
  updateVersionContent,
} = await import("../src/recipe-store.ts");

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("saving a draft creates immutable beta snapshots and skips duplicates", () => {
  const created = createRecipe("Snapshot Recipe");

  const firstAuto = updateDraft(created.slug, { cooklang_text: "@flour{200%g}" });
  assert.equal(firstAuto.snapshot_version, null);

  let recipe = getRecipeBySlug(created.slug);
  assert.equal(recipe?.latest_beta, null);

  const first = updateDraft(created.slug, { cooklang_text: "@flour{200%g}" }, { advance_beta: true });
  assert.equal(first.snapshot_version, "v1.0-beta.1");

  recipe = getRecipeBySlug(created.slug);
  assert.equal(recipe?.latest_beta, "v1.0-beta.1");
  assert.deepEqual(
    recipe?.versions.map((version) => version.version_string),
    ["v1.0-beta.1"],
  );

  const autosave = updateDraft(created.slug, { cooklang_text: "@flour{250%g}" });
  assert.equal(autosave.snapshot_version, "v1.0-beta.1");

  recipe = getRecipeBySlug(created.slug);
  assert.deepEqual(
    recipe?.versions.map((version) => version.version_string),
    ["v1.0-beta.1"],
  );
  assert.equal(recipe?.versions[0]?.cooklang_text, "@flour{250%g}");

  const duplicate = updateDraft(created.slug, { cooklang_text: "@flour{250%g}" }, { advance_beta: true });
  assert.equal(duplicate.snapshot_version, "v1.0-beta.1");

  const second = updateDraft(created.slug, { cooklang_text: "@flour{300%g}" }, { advance_beta: true });
  assert.equal(second.snapshot_version, "v1.0-beta.2");

  recipe = getRecipeBySlug(created.slug);
  assert.deepEqual(
    recipe?.versions.map((version) => version.version_string),
    ["v1.0-beta.2", "v1.0-beta.1"],
  );
  assert.equal(recipe?.draft?.cooklang_text, "@flour{300%g}");
});

test("saving after a release starts the next beta line", () => {
  const created = createRecipe("Release Chain Recipe");

  updateDraft(created.slug, { cooklang_text: "@flour{200%g}" }, { advance_beta: true });
  updateDraft(created.slug, { cooklang_text: "@flour{250%g}" }, { advance_beta: true });
  releaseDraft(created.slug, { version_string: "v1.0", status: "released" });

  let recipe = getRecipeBySlug(created.slug);
  assert.equal(recipe?.draft, null);

  const auto = updateDraft(created.slug, { cooklang_text: "@flour{300%g}" });
  assert.equal(auto.snapshot_version, null);

  const next = updateDraft(created.slug, { cooklang_text: "@flour{300%g}" }, { advance_beta: true });
  assert.equal(next.snapshot_version, "v1.1-beta.1");

  recipe = getRecipeBySlug(created.slug);
  assert.equal(recipe?.latest_released, "v1.0");
  assert.equal(recipe?.latest_beta, "v1.1-beta.1");
  assert.equal(recipe?.draft?.parent_version, "v1.0");
  assert.equal(recipe?.versions[0]?.version_string, "v1.1-beta.1");
});

test("beta versions can be edited directly without changing their version string", () => {
  const created = createRecipe("Editable Beta Recipe");

  updateDraft(created.slug, { cooklang_text: "@flour{200%g}" }, { advance_beta: true });
  updateVersionContent(created.slug, "v1.0-beta.1", "@flour{220%g}", ["bagel"]);

  const recipe = getRecipeBySlug(created.slug);
  const beta = recipe?.versions.find((version) => version.version_string === "v1.0-beta.1");
  assert.equal(beta?.cooklang_text, "@flour{220%g}");
  assert.equal(beta?.tags, JSON.stringify(["bagel"]));
});

test("beta versions can be promoted directly to a release", () => {
  const created = createRecipe("Promotable Beta Recipe");

  updateDraft(created.slug, { cooklang_text: "@flour{200%g}" }, { advance_beta: true });
  updateVersionContent(created.slug, "v1.0-beta.1", "@flour{225%g}", ["bagel"]);
  releaseVersion(created.slug, "v1.0-beta.1", { version_string: "v1.0", status: "released" });

  const recipe = getRecipeBySlug(created.slug);
  const released = recipe?.versions.find((version) => version.version_string === "v1.0");
  assert.equal(recipe?.latest_released, "v1.0");
  assert.equal(released?.cooklang_text, "@flour{225%g}");
  assert.equal(released?.tags, JSON.stringify(["bagel"]));
  assert.equal(recipe?.draft, null);
});

test("recipe thumbnails stay separate from version-scoped photos", () => {
  const created = createRecipe("Photo Recipe");

  const thumb = setRecipeThumbnail(created.slug, {
    filename: "thumb.jpg",
    mime_type: "image/jpeg",
    data: Buffer.from("thumb"),
  });
  updateDraft(created.slug, { cooklang_text: "@water{1%cup}" });
  const draftImage = attachRecipeImage(created.slug, {
    filename: "draft.jpg",
    mime_type: "image/jpeg",
    data: Buffer.from("draft"),
    version_string: "draft",
  });
  releaseDraft(created.slug, { version_string: "v1.0", status: "released" });
  const releasedImage = attachRecipeImage(created.slug, {
    filename: "release.jpg",
    mime_type: "image/jpeg",
    data: Buffer.from("release"),
    version_string: "v1.0",
  });

  const recipe = getRecipeBySlug(created.slug);
  assert.equal(recipe?.thumbnail_image_id, thumb.thumbnail_image_id);
  assert.equal(
    fs.existsSync(path.join(dataDir, "recipes", created.slug, "images", `${thumb.thumbnail_image_id}.jpg`)),
    true,
  );
  assert.deepEqual(listRecipeImages(created.slug, "draft").map((image) => image.id), [draftImage.id]);
  assert.equal(
    fs.existsSync(path.join(dataDir, "recipes", created.slug, "branches", "main", "draft", "images", `${draftImage.id}.jpg`)),
    true,
  );
  assert.deepEqual(listRecipeImages(created.slug, "v1.0").map((image) => image.id), [releasedImage.id]);
  assert.equal(
    fs.existsSync(path.join(dataDir, "recipes", created.slug, "branches", "main", "versions", "v1.0", "images", `${releasedImage.id}.jpg`)),
    true,
  );
  assert.equal(readRecipeImage(releasedImage.id)?.data.toString(), "release");

  deleteRecipeImage(releasedImage.id);
  assert.deepEqual(listRecipeImages(created.slug, "v1.0").map((image) => image.id), []);
  assert.equal(
    fs.existsSync(path.join(dataDir, "recipes", created.slug, "branches", "main", "versions", "v1.0", "images", `${releasedImage.id}.jpg`)),
    false,
  );

  setRecipeThumbnail(created.slug, null);
  assert.equal(getRecipeBySlug(created.slug)?.thumbnail_image_id, null);
  assert.equal(
    fs.existsSync(path.join(dataDir, "recipes", created.slug, "images", `${thumb.thumbnail_image_id}.jpg`)),
    false,
  );
});

test("recipe list describes draft changes explicitly", () => {
  const created = createRecipe("Status Label Recipe");

  updateDraft(created.slug, { cooklang_text: "@water{1%cup}" });
  let listing = listRecipes().find((recipe) => recipe.slug === created.slug);
  assert.equal(listing?.draft_change_label, "Draft in progress");

  releaseDraft(created.slug, { version_string: "v1.0", status: "released" });
  updateDraft(created.slug, { cooklang_text: "@water{2%cup}" });
  listing = listRecipes().find((recipe) => recipe.slug === created.slug);
  assert.equal(listing?.draft_change_label, "Draft differs from v1.0");
});

test("older draft than latest beta does not count as dirty", () => {
  const created = createRecipe("Old Draft Recipe");

  updateDraft(created.slug, { cooklang_text: "@water{1%cup}" }, { advance_beta: true });
  updateDraft(created.slug, { cooklang_text: "@water{2%cup}" });
  updateDraft(created.slug, { cooklang_text: "@water{3%cup}" }, { advance_beta: true });

  const listing = listRecipes().find((recipe) => recipe.slug === created.slug);
  assert.equal(listing?.draft_change_label, null);
  assert.equal(listing?.has_unreleased_changes, false);
});

test("creating a branch forks from main without creating a draft", () => {
  const created = createRecipe("Branch Seed Recipe");
  updateDraft(created.slug, { cooklang_text: "@flour{200%g}\nMix well." });
  releaseDraft(created.slug, { version_string: "v1.0", status: "released" });

  const branchRecipe = createRecipeBranch(created.slug, { name: "Sourdough", source_version: "v1.0" });
  const variant = getRecipeBySlug(created.slug, branchRecipe.branch_slug);

  assert.equal(variant?.branch.slug, "sourdough");
  assert.equal(variant?.branch.kind, "variant");
  assert.equal(variant?.draft, null);
  assert.deepEqual(variant?.versions, []);
  assert.equal(variant?.source_version?.version_string, "v1.0");
});

test("branch version strings are only unique within a branch", () => {
  const created = createRecipe("Branch Version Recipe");
  updateDraft(created.slug, { cooklang_text: "@flour{200%g}" });
  releaseDraft(created.slug, { version_string: "v1.0", status: "released" });
  const branchRecipe = createRecipeBranch(created.slug, { name: "Sourdough", source_version: "v1.0" });

  forkBranchHeadToDraft(created.slug, branchRecipe.branch_slug);
  updateDraft(created.slug, { cooklang_text: "@starter{100%g}\n@flour{200%g}" }, {}, branchRecipe.branch_slug);
  releaseDraft(created.slug, { version_string: "v1.0", status: "released" }, branchRecipe.branch_slug);

  const mainRecipe = getRecipeBySlug(created.slug, "main");
  const variant = getRecipeBySlug(created.slug, branchRecipe.branch_slug);
  assert.equal(mainRecipe?.versions.some((version) => version.version_string === "v1.0"), true);
  assert.equal(variant?.versions.some((version) => version.version_string === "v1.0"), true);
});

test("sync preview and apply merge main into a variant draft", () => {
  const created = createRecipe("Sync Recipe");
  updateDraft(created.slug, { cooklang_text: "@flour{200%g}\nMix.\nBake." });
  releaseDraft(created.slug, { version_string: "v1.0", status: "released" });

  const branchRecipe = createRecipeBranch(created.slug, { name: "Sourdough", source_version: "v1.0" });
  forkBranchHeadToDraft(created.slug, branchRecipe.branch_slug);
  updateDraft(created.slug, { cooklang_text: "@starter{100%g}\n@flour{200%g}\nMix.\nBake." }, {}, branchRecipe.branch_slug);

  updateDraft(created.slug, { cooklang_text: "@flour{220%g}\nMix.\nBake.\nCool." });
  releaseDraft(created.slug, { version_string: "v1.1", status: "released" });

  const preview = previewBranchSync(created.slug, branchRecipe.branch_slug);
  assert.equal(preview.status, "clean");
  assert.match(preview.merged_text, /@starter\{100%g\}/);
  assert.match(preview.merged_text, /Cool\./);

  const applied = applyBranchSync(created.slug, branchRecipe.branch_slug);
  assert.equal(applied.ok, true);
  const variant = getRecipeBySlug(created.slug, branchRecipe.branch_slug);
  assert.match(variant?.draft?.cooklang_text || "", /@starter\{100%g\}/);
  assert.match(variant?.draft?.cooklang_text || "", /Cool\./);
});

test("sync preview reports conflicts for overlapping edits", () => {
  const created = createRecipe("Conflict Sync Recipe");
  updateDraft(created.slug, { cooklang_text: "@flour{200%g}\nMix.\nBake." });
  releaseDraft(created.slug, { version_string: "v1.0", status: "released" });

  const branchRecipe = createRecipeBranch(created.slug, { name: "Sourdough", source_version: "v1.0" });
  forkBranchHeadToDraft(created.slug, branchRecipe.branch_slug);
  updateDraft(created.slug, { cooklang_text: "@flour{250%g}\nMix gently.\nBake." }, {}, branchRecipe.branch_slug);

  updateDraft(created.slug, { cooklang_text: "@flour{300%g}\nMix fast.\nBake." });
  releaseDraft(created.slug, { version_string: "v1.1", status: "released" });

  const preview = previewBranchSync(created.slug, branchRecipe.branch_slug);
  assert.equal(preview.status, "conflict");
  assert.ok(preview.conflicts.length > 0);
});

test("createCookLog snapshots cooklang_text from the current draft when source is draft", () => {
  const created = createRecipe("Log From Draft");
  updateDraft(created.slug, { cooklang_text: "@flour{300%g}" });

  const log = createCookLog(created.slug, { kind: "draft" }, { outcome: "good crust" });

  assert.equal(log.source_kind, "draft");
  assert.equal(log.source_version_string, null);
  assert.equal(log.version_string, null);
  assert.equal(log.cooklang_text, "@flour{300%g}");
  assert.equal(log.outcome, "good crust");

  const refetched = getCookLog(created.slug, log.id);
  assert.equal(refetched?.cooklang_text, "@flour{300%g}");
  assert.equal(refetched?.source_kind, "draft");
  assert.equal(refetched?.source_version_string, null);
});

test("createCookLog snapshots cooklang_text from a specified version", () => {
  const created = createRecipe("Log From Version");
  updateDraft(created.slug, { cooklang_text: "@flour{200%g}" });
  releaseDraft(created.slug, { version_string: "v1.0", status: "released" });
  // Move the draft forward so we can prove the version snapshot is independent.
  updateDraft(created.slug, { cooklang_text: "@flour{999%g}" });

  const log = createCookLog(
    created.slug,
    { kind: "version", version_string: "v1.0" },
    { outcome: "as expected" },
  );

  assert.equal(log.source_kind, "version");
  assert.equal(log.source_version_string, "v1.0");
  assert.equal(log.version_string, "v1.0");
  assert.equal(log.cooklang_text, "@flour{200%g}");
  assert.equal(log.source_cooklang_text, "@flour{200%g}");
});

test("source_cooklang_text is frozen at creation and unchanged by later draft edits", () => {
  const created = createRecipe("Frozen Source");
  updateDraft(created.slug, { cooklang_text: "@flour{200%g}" });
  const log = createCookLog(created.slug, { kind: "draft" }, { outcome: "ok" });
  assert.equal(log.source_cooklang_text, "@flour{200%g}");

  // Move the draft forward; the log's source snapshot must NOT change.
  updateDraft(created.slug, { cooklang_text: "@flour{999%g}" });
  // And edit the log's own cooked text; source snapshot still unchanged.
  updateCookLog(created.slug, log.id, { cooklang_text: "@flour{225%g}" });

  const refetched = getCookLog(created.slug, log.id);
  assert.equal(refetched?.source_cooklang_text, "@flour{200%g}");
  assert.equal(refetched?.cooklang_text, "@flour{225%g}");
});

test("updateCookLog persists an edited cooklang_text to both DB and .cook sidecar", () => {
  const created = createRecipe("Log Edit Cooklang");
  updateDraft(created.slug, { cooklang_text: "@flour{200%g}" });
  const log = createCookLog(created.slug, { kind: "draft" }, { outcome: "fine" });

  const cookSidecarPath = path.join(
    dataDir,
    "recipes",
    created.slug,
    "branches",
    "main",
    "cook-logs",
    `${log.id}.cook`,
  );
  assert.equal(fs.existsSync(cookSidecarPath), true);

  const updated = updateCookLog(created.slug, log.id, { cooklang_text: "@flour{225%g}" });
  assert.equal(updated.cooklang_text, "@flour{225%g}");
  assert.equal(fs.readFileSync(cookSidecarPath, "utf8"), "@flour{225%g}");

  const refetched = getCookLog(created.slug, log.id);
  assert.equal(refetched?.cooklang_text, "@flour{225%g}");
});

test("promoteCookLog produces a released version with the log's cooklang_text", () => {
  const created = createRecipe("Log Promote");
  updateDraft(created.slug, { cooklang_text: "@flour{250%g}" });
  const log = createCookLog(created.slug, { kind: "draft" }, { outcome: "great" });

  const result = promoteCookLog(
    created.slug,
    log.id,
    { version_string: "v1.0", status: "released", changelog: "first cook" },
  );
  assert.equal(result.version_string, "v1.0");

  const recipe = getRecipeBySlug(created.slug);
  const released = recipe?.versions.find((version) => version.version_string === "v1.0");
  assert.equal(released?.cooklang_text, "@flour{250%g}");
  assert.equal(released?.status, "released");
});

test("promoting twice with the same version_string throws 'version already exists'", () => {
  const created = createRecipe("Log Promote Conflict");
  updateDraft(created.slug, { cooklang_text: "@flour{250%g}" });
  const log = createCookLog(created.slug, { kind: "draft" }, { outcome: "ok" });
  promoteCookLog(created.slug, log.id, { version_string: "v1.0", status: "released" });

  assert.throws(
    () => promoteCookLog(created.slug, log.id, { version_string: "v1.0", status: "released" }),
    /version already exists/,
  );
});

test("forkCookLogToDraft seeds the draft with the cook log's cooklang and parents it to the log's source", () => {
  const created = createRecipe("Iterate From Log");
  // Beta line: draft → v1.0-beta.1.
  updateDraft(created.slug, { cooklang_text: "@flour{500%g}\n@water{300%g}\nMix.\nBake." }, { advance_beta: true });
  // Cook from that beta, capture the actual measurements.
  const log = createCookLog(
    created.slug,
    { kind: "version", version_string: "v1.0-beta.1" },
    { outcome: "good crust", cooklang_text: "@flour{500%g}\n@water{310%g}\nMix.\nBake." },
  );
  // Fork the log into the draft for the next iteration.
  forkCookLogToDraft(created.slug, log.id);
  const recipe = getRecipeBySlug(created.slug);
  assert.ok(recipe?.draft, "expected a draft after fork");
  assert.equal(recipe?.draft?.cooklang_text, "@flour{500%g}\n@water{310%g}\nMix.\nBake.", "draft text should match the cook log's recipe-as-cooked");
  assert.equal(recipe?.draft?.parent_version, "v1.0-beta.1", "draft parent should be the cook log's source version");
});

test("forkCookLogToDraft overwrites an existing draft so the iteration starts clean", () => {
  const created = createRecipe("Overwrite Draft With Log");
  updateDraft(created.slug, { cooklang_text: "@flour{500%g}" }, { advance_beta: true });
  // User started a new draft after the beta and made unrelated edits.
  updateDraft(created.slug, { cooklang_text: "@flour{999%g}\nthrowaway scratch." });
  const log = createCookLog(
    created.slug,
    { kind: "version", version_string: "v1.0-beta.1" },
    { outcome: "ok", cooklang_text: "@flour{520%g}\nMix briefly." },
  );
  forkCookLogToDraft(created.slug, log.id);
  const recipe = getRecipeBySlug(created.slug);
  assert.equal(recipe?.draft?.cooklang_text, "@flour{520%g}\nMix briefly.", "fork must replace the scratch draft, not merge with it");
});

test("forkCookLogToDraft requires a cook log with non-empty cooklang", () => {
  const created = createRecipe("Empty Log Fork");
  updateDraft(created.slug, { cooklang_text: "@flour{500%g}" }, { advance_beta: true });
  const log = createCookLog(
    created.slug,
    { kind: "version", version_string: "v1.0-beta.1" },
    { outcome: "ok", cooklang_text: "   \n  " },
  );
  assert.throws(() => forkCookLogToDraft(created.slug, log.id), /no recipe text to fork/);
});

test("deleteCookLog removes both the .json file and the .cook sidecar", () => {
  const created = createRecipe("Log Delete");
  updateDraft(created.slug, { cooklang_text: "@flour{200%g}" });
  const log = createCookLog(created.slug, { kind: "draft" }, { outcome: "ok" });

  const jsonPath = path.join(dataDir, "recipes", created.slug, "branches", "main", "cook-logs", `${log.id}.json`);
  const cookPath = path.join(dataDir, "recipes", created.slug, "branches", "main", "cook-logs", `${log.id}.cook`);
  assert.equal(fs.existsSync(jsonPath), true);
  assert.equal(fs.existsSync(cookPath), true);

  deleteCookLog(created.slug, log.id);
  assert.equal(fs.existsSync(jsonPath), false);
  assert.equal(fs.existsSync(cookPath), false);
  assert.equal(listBranchCookLogs(created.slug).length, 0);
});
