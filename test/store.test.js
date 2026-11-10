// Store tests against a real (in-process) Postgres: see test/support/pg.js.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { setupStore } from "./support/pg.js";

let ctx;
before(async () => { ctx = await setupStore(); });
after(async () => { await ctx?.stop(); });

// One step per line, so changes to different steps are separate edits.
const V1 = `---
servings: 2
---
Mix @flour{500%g} and @water{375%g}.

Add @salt{10%g}.

Rest ~{30%min}.`;

async function recipeWithVersion(title, text = V1) {
  const { store } = ctx;
  const { slug } = await store.createRecipe(title);
  await store.updateDraft(slug, { cooklang_text: text });
  await store.releaseDraft(slug, { version_string: "v1.0", changelog: "First" });
  return slug;
}

// "New test…" from the current version, edit, "Save as Test N".
async function makeTest(slug, testing, edit) {
  const { store } = ctx;
  const recipe = await store.getRecipeBySlug(slug);
  const base = recipe.current_version;
  await store.forkVersionToDraft(slug, base.version_string, "main", { testing });
  await store.updateDraft(slug, { cooklang_text: edit(base.cooklang_text) });
  return store.saveTest(slug, {});
}

const get = (slug) => ctx.store.getRecipeBySlug(slug);
const entry = (recipe, label) => recipe.versions.find((v) => v.label === label);

test("a new recipe has a working copy and no version yet", async () => {
  const { slug } = await ctx.store.createRecipe("Empty");
  const recipe = await get(slug);
  assert.equal(recipe.current_version, null);
  assert.equal(recipe.next_version_string, "v1.0");
  assert.equal(recipe.next_test_number, 1);
  assert.equal(recipe.draft.kind, "working_copy");
  assert.equal(recipe.draft.label, "Working copy");
});

test("saving the working copy as a test: numbered, based on the current version, open", async () => {
  const slug = await recipeWithVersion("Save test");
  const saved = await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  assert.deepEqual(saved, { ok: true, version_string: "test-1", test_number: 1, label: "v1.0 · Test 1", test_key: "v1.0-1", created: true, closed: null });

  const recipe = await get(slug);
  const t1 = entry(recipe, "v1.0 · Test 1");
  assert.equal(t1.kind, "test");
  assert.equal(t1.status, "beta");
  assert.equal(t1.testing, "more water");
  assert.equal(t1.base_version, "v1.0");
  assert.equal(t1.open, true);
  assert.deepEqual(recipe.open_tests.map((v) => v.label), ["v1.0 · Test 1"]);
  assert.equal(recipe.next_test_number, 2);
  // The pending Testing line is used up; the working copy now matches Test 1.
  assert.equal(recipe.draft.testing, "");
  assert.equal(recipe.draft_change_label, null);
  assert.equal(recipe.current_version.label, "v1.0");
  assert.equal(recipe.current_version.is_current, true);

  // Saving again without changes returns Test 1 instead of a duplicate.
  const again = await ctx.store.saveTest(slug, {});
  assert.equal(again.created, false);
  assert.equal(again.version_string, "test-1");
});

test("the working copy reports changes only when they're not saved anywhere", async () => {
  const slug = await recipeWithVersion("Working copy changes");
  let recipe = await get(slug);
  assert.equal(recipe.draft_change_label, null);
  await ctx.store.updateDraft(slug, { cooklang_text: V1.replace("10%g", "12%g") });
  recipe = await get(slug);
  assert.equal(recipe.draft_change_label, "Working copy has changes");
  assert.equal(recipe.has_unreleased_changes, true);
  assert.equal(recipe.draft.base_version, "v1.0");
});

test("a working copy older than what it's compared with has no changes of its own", async () => {
  const slug = await recipeWithVersion("Stale working copy");
  await ctx.store.updateDraft(slug, { cooklang_text: V1.replace("10%g", "12%g") });
  assert.equal((await get(slug)).draft_change_label, "Working copy has changes");
  // v1.0 is then fixed in place: the working copy's difference is that fix.
  await ctx.store.updateVersionContent(slug, "v1.0", V1.replace("Rest", "Then rest"));
  assert.equal((await get(slug)).draft_change_label, null);
});

test("renaming or stopping a test doesn't touch its timestamp or hide working-copy changes", async () => {
  const slug = await recipeWithVersion("Bookkeeping");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  const before = entry(await get(slug), "v1.0 · Test 1").updated_at;
  await ctx.store.updateDraft(slug, { cooklang_text: V1.replace("375", "400") });
  await ctx.store.updateTesting(slug, "test-1", "a lot more water");
  await ctx.store.setTestOpen(slug, "test-1", false);
  const recipe = await get(slug);
  assert.equal(entry(recipe, "v1.0 · Test 1").updated_at, before);
  assert.equal(recipe.draft_change_label, "Working copy has changes");
});

test("a test made from a test's cook closes that test as followed, unless kept open; undo reopens it", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Followed");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  const log = await store.createCookLog(slug, { kind: "version", version_string: "test-1" }, { outcome: "Close" });
  await store.forkCookLogToDraft(slug, log.id, "main", { testing: "more salt" });
  await store.updateDraft(slug, { cooklang_text: (await get(slug)).draft.cooklang_text.replace("10%g", "12%g") });
  const saved = await store.saveTest(slug, { close_source: true });
  assert.equal(saved.closed, "v1.0 · Test 1");
  let recipe = await get(slug);
  const t1 = entry(recipe, "v1.0 · Test 1");
  assert.equal(t1.closed_as, "followed");
  assert.equal(t1.followed_by, "v1.0 · Test 2");
  assert.equal(t1.open, false);
  assert.deepEqual(recipe.open_tests.map((t) => t.label), ["v1.0 · Test 2"]);

  // Undoing the save opens Test 1 again.
  await store.undoDraftBeta(slug, saved.version_string, null);
  recipe = await get(slug);
  assert.equal(entry(recipe, "v1.0 · Test 1").closed_as, null);
  assert.equal(entry(recipe, "v1.0 · Test 1").followed_by, null);

  // Kept open: both stay in the Testing list.
  const kept = await store.saveTest(slug, { close_source: false });
  assert.equal(kept.closed, null);
  recipe = await get(slug);
  assert.deepEqual(recipe.open_tests.map((t) => t.label).sort(), ["v1.0 · Test 1", "v1.0 · Test 2"]);

  // A followed test can be reopened like a stopped one.
  await store.undoDraftBeta(slug, kept.version_string, null);
  await store.saveTest(slug, { close_source: true });
  await store.setTestOpen(slug, "test-1", true);
  assert.equal(entry(await get(slug), "v1.0 · Test 1").open, true);
});

test("a test from a version closes nothing", async () => {
  const slug = await recipeWithVersion("Side by side");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  const { store } = ctx;
  await store.forkVersionToDraft(slug, "v1.0", "main", { testing: "less salt" });
  await store.updateDraft(slug, { cooklang_text: V1.replace("10%g", "8%g") });
  const saved = await store.saveTest(slug, { close_source: true });
  assert.equal(saved.closed, null);
  assert.equal((await get(slug)).open_tests.length, 2);
});

test("adopting a test based on the current version takes it as written and closes it", async () => {
  const slug = await recipeWithVersion("Adopt current");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  const log = await ctx.store.createCookLog(slug, { kind: "version", version_string: "test-1" }, { outcome: "Better" });

  const result = await ctx.store.releaseVersion(slug, "test-1", { version_string: "v1.1", changelog: "water 375 → 390 g" });
  assert.equal(result.merged, false);

  const recipe = await get(slug);
  const t1 = entry(recipe, "v1.0 · Test 1");
  const v11 = entry(recipe, "v1.1");
  assert.equal(v11.cooklang_text, V1.replace("375", "390"));
  assert.equal(v11.from_label, "v1.0 · Test 1");
  assert.equal(v11.is_current, true);
  assert.equal(t1.open, false);
  assert.equal(t1.closed_as, "adopted");
  assert.equal(t1.adopted_as, "v1.1");
  assert.equal(t1.cook_count, 1);
  assert.equal(t1.last_outcome, "Better");
  assert.equal(recipe.open_tests.length, 0);
  // The cook still points at the test it was cooked from.
  const after = await ctx.store.getCookLog(slug, log.id);
  assert.equal(after.source_version_string, "test-1");
});

test("adopting a test made from an older version merges it into the current one", async () => {
  const slug = await recipeWithVersion("Adopt stale");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  await makeTest(slug, "more salt", (t) => t.replace("10%g", "12%g"));
  await ctx.store.releaseVersion(slug, "test-2", { version_string: "v1.1" });

  // Test 1 is based on v1.0; v1.1 has the salt change. Copying Test 1 would undo it.
  const result = await ctx.store.releaseVersion(slug, "test-1", { version_string: "v1.2" });
  assert.equal(result.merged, true);
  const v12 = entry(await get(slug), "v1.2");
  assert.match(v12.cooklang_text, /@water\{390%g\}/);
  assert.match(v12.cooklang_text, /@salt\{12%g\}/);
});

test("adopting a test that changes the same line as the current version is refused", async () => {
  const slug = await recipeWithVersion("Adopt conflict");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  await makeTest(slug, "much more water", (t) => t.replace("375", "420"));
  await ctx.store.releaseVersion(slug, "test-2", { version_string: "v1.1" });

  await assert.rejects(
    ctx.store.releaseVersion(slug, "test-1", { version_string: "v1.2" }),
    (error) => error instanceof ctx.store.AdoptConflictError && error.conflicts.length === 1,
  );
  const recipe = await get(slug);
  assert.equal(entry(recipe, "v1.2"), undefined);
  assert.equal(entry(recipe, "v1.0 · Test 1").open, true);
});

test("releasing the working copy without testing merges and removes the working copy", async () => {
  const slug = await recipeWithVersion("Release untested");
  // Working copy based on v1.0 changes the rest; meanwhile a test becomes v1.1.
  await ctx.store.updateDraft(slug, { cooklang_text: V1.replace("30%min", "45%min") });
  const recipe0 = await get(slug);
  const draftText = recipe0.draft.cooklang_text;
  await ctx.store.saveTest(slug, { testing: "longer rest" });
  await ctx.store.forkVersionToDraft(slug, "v1.0");
  await ctx.store.updateDraft(slug, { cooklang_text: V1.replace("500", "520") });
  await ctx.store.releaseDraft(slug, { version_string: "v1.1" });
  // Back on the 45-minute idea, from v1.0, released directly.
  await ctx.store.forkVersionToDraft(slug, "v1.0");
  await ctx.store.updateDraft(slug, { cooklang_text: draftText });
  const result = await ctx.store.releaseDraft(slug, { version_string: "v1.2" });
  assert.equal(result.merged, true);
  const recipe = await get(slug);
  assert.match(entry(recipe, "v1.2").cooklang_text, /@flour\{520%g\}/);
  assert.match(entry(recipe, "v1.2").cooklang_text, /~\{45%min\}/);
  assert.equal(recipe.draft, null);
});

test("re-releasing an old version keeps its text as is", async () => {
  const slug = await recipeWithVersion("Re-release");
  await ctx.store.updateDraft(slug, { cooklang_text: V1.replace("500", "520") });
  await ctx.store.releaseDraft(slug, { version_string: "v1.1" });
  await ctx.store.releaseVersion(slug, "v1.0", { version_string: "v1.2" });
  const recipe = await get(slug);
  assert.equal(entry(recipe, "v1.2").cooklang_text, V1);
  assert.equal(recipe.current_version.label, "v1.2");
});

test("a version name that exists, or a test's name, is refused", async () => {
  const slug = await recipeWithVersion("Name clash");
  await makeTest(slug, "x", (t) => t.replace("500", "510"));
  await assert.rejects(ctx.store.releaseVersion(slug, "test-1", { version_string: "v1.0" }), /version already exists/);
  await assert.rejects(ctx.store.releaseVersion(slug, "test-1", { version_string: "test-7" }), /kept for tests/);
  await assert.rejects(ctx.store.releaseDraft(slug, { version_string: "v1.1", status: "beta" }), /save a test instead/);
});

test("adopting from a cook merges what was done differently into the current version", async () => {
  const slug = await recipeWithVersion("Adopt cook");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  // Cooked Test 1 at 2× and also rested longer.
  const log = await ctx.store.createCookLog(slug, { kind: "version", version_string: "test-1" }, { outcome: "Good", scale: 2 });
  await ctx.store.updateCookLog(slug, log.id, { cooklang_text: log.cooklang_text.replace("30%min", "40%min") });
  // Meanwhile v1.1 changed the salt.
  await makeTest(slug, "more salt", (t) => t.replace("10%g", "12%g"));
  await ctx.store.releaseVersion(slug, "test-2", { version_string: "v1.1" });

  const result = await ctx.store.promoteCookLog(slug, log.id, { version_string: "v1.2" });
  assert.equal(result.merged, true);
  const recipe = await get(slug);
  const v12 = entry(recipe, "v1.2");
  assert.match(v12.cooklang_text, /@water\{390%g\}/, "the test's change, back at 1×");
  assert.match(v12.cooklang_text, /~\{40%min\}/, "the cook's change");
  assert.match(v12.cooklang_text, /@salt\{12%g\}/, "v1.1's change kept");
  assert.equal(v12.from_cook_log_id, log.id);
  assert.equal(v12.from_label, "v1.0 · Test 1");
  assert.equal(entry(recipe, "v1.0 · Test 1").closed_as, "adopted");
});

test("the Testing line can change; stopping and reopening a test", async () => {
  const slug = await recipeWithVersion("Test state");
  await makeTest(slug, "", (t) => t.replace("375", "390"));
  await ctx.store.updateTesting(slug, "test-1", "  more water ");
  let t1 = entry(await get(slug), "v1.0 · Test 1");
  assert.equal(t1.testing, "more water");

  await ctx.store.setTestOpen(slug, "test-1", false);
  t1 = entry(await get(slug), "v1.0 · Test 1");
  assert.equal(t1.closed_as, "stopped");
  assert.equal(t1.open, false);
  await ctx.store.setTestOpen(slug, "test-1", true);
  assert.equal(entry(await get(slug), "v1.0 · Test 1").open, true);

  await ctx.store.releaseVersion(slug, "test-1", { version_string: "v1.1" });
  await assert.rejects(ctx.store.setTestOpen(slug, "test-1", true), /was adopted/);
  await assert.rejects(ctx.store.updateTesting(slug, "v1.0", "x"), /not a test/);
});

test("a new test made from a test remembers it; its base is the version underneath", async () => {
  const slug = await recipeWithVersion("Test from test");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  await ctx.store.forkVersionToDraft(slug, "test-1", "main", { testing: "more water, less salt" });
  let recipe = await get(slug);
  assert.equal(recipe.draft.testing, "more water, less salt");
  assert.equal(recipe.draft.base_version, "v1.0");
  assert.equal(recipe.draft.from_label, "v1.0 · Test 1");
  await ctx.store.updateDraft(slug, { cooklang_text: recipe.draft.cooklang_text.replace("10%g", "8%g") });
  await ctx.store.saveTest(slug, {});
  recipe = await get(slug);
  const t2 = entry(recipe, "v1.0 · Test 2");
  assert.equal(t2.testing, "more water, less salt");
  assert.equal(t2.base_version, "v1.0");
  assert.equal(t2.from_label, "v1.0 · Test 1");
});

test("old clients: advance_beta saves a test, and undo gives its Testing line back", async () => {
  const slug = await recipeWithVersion("Old client");
  await ctx.store.forkVersionToDraft(slug, "v1.0", "main", { testing: "more water" });
  const saved = await ctx.store.updateDraft(slug, { cooklang_text: V1.replace("375", "390") }, { advance_beta: true });
  assert.equal(saved.created_beta, "test-1");
  assert.equal(entry(await get(slug), "v1.0 · Test 1").testing, "more water");

  await ctx.store.undoDraftBeta(slug, "test-1", null);
  const recipe = await get(slug);
  assert.equal(entry(recipe, "v1.0 · Test 1"), undefined);
  assert.equal(recipe.draft.testing, "more water");
});

test("migration: old betas become numbered tests, closed where a version overtook them", async () => {
  const { sql, store } = ctx;
  // An untouched recipe whose open test must not be renumbered or closed.
  const bystander = await recipeWithVersion("Bystander");
  await makeTest(bystander, "x", (t) => t.replace("500", "510"));

  const { slug } = await store.createRecipe("Old shape");
  const [{ branch_id }] = await sql`SELECT b.id AS branch_id FROM branches b JOIN recipes r ON r.id = b.recipe_id WHERE r.slug = ${slug}`;
  const at = (day) => new Date(`2026-05-${String(day).padStart(2, "0")}T12:00:00Z`);
  const insert = (vs, status, text, day, parent = null, changelog = "") => sql`
    INSERT INTO entries (branch_id, version_string, status, cooklang_text, changelog, parent_version, created_at, updated_at)
    VALUES (${branch_id}, ${vs}, ${status}, ${text}, ${changelog}, ${parent}, ${at(day)}, ${at(day)})`;
  await insert("v1.0-beta.1", "beta", V1.replace("500", "480"), 11);
  await insert("v1.0-beta.2", "beta", V1.replace("500", "490"), 13, "v1.0-beta.1");
  await insert("v1.0-beta.3", "archived", V1.replace("500", "495"), 14, "v1.0-beta.2");
  await insert("v1.0-beta.4", "beta", V1, 20, "v1.0-beta.2");
  await insert("v1.0", "released", V1, 21, "v1.0-beta.4", "Even better flavor");
  await insert("v1.1-beta.1", "beta", V1.replace("375", "450"), 25, "v1.0");

  // As after restoring an older backup: the migration already ran once.
  const { applySchema } = await import("../src/db.ts");
  await applySchema();

  let recipe = await get(slug);
  const shape = (label) => {
    const v = entry(recipe, label);
    return [v.version_string, v.closed_as, v.base_version];
  };
  assert.deepEqual(shape("Test 1"), ["v1.0-beta.1", "superseded", null]);
  assert.deepEqual(shape("Test 2"), ["v1.0-beta.2", "superseded", null]);
  assert.deepEqual(shape("Test 3"), ["v1.0-beta.3", "stopped", null]);
  assert.deepEqual(shape("Test 4"), ["v1.0-beta.4", "adopted", null]);
  assert.deepEqual(shape("v1.0 · Test 1"), ["v1.1-beta.1", null, "v1.0"]);
  assert.equal(entry(recipe, "Test 4").adopted_as, "v1.0");
  assert.equal(entry(recipe, "v1.0").from_label, "Test 4");
  assert.equal(recipe.current_version.label, "v1.0");
  assert.deepEqual(recipe.open_tests.map((v) => v.label), ["v1.0 · Test 1"]);
  assert.equal(recipe.next_test_number, 6);
  // Bookkeeping doesn't count as an edit.
  assert.equal(entry(recipe, "v1.0 · Test 1").updated_at, at(25).toISOString());

  const other = await get(bystander);
  assert.deepEqual(other.open_tests.map((v) => [v.label, v.version_string]), [["v1.0 · Test 1", "test-1"]]);

  // A restart doesn't re-run it: a reopened test stays open.
  await store.setTestOpen(slug, "v1.0-beta.1", true);
  await applySchema();
  recipe = await get(slug);
  assert.equal(entry(recipe, "Test 1").open, true);
});

test("a test can be edited until it's cooked or closed, printed or not; a version always", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Fixed test");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  // Saved, and even printed (a print is recorded when the dialog opens): editable.
  await store.recordPrint(slug, "test-1", 1);
  let test1 = entry(await get(slug), "v1.0 · Test 1");
  assert.equal(test1.locked, false);
  assert.ok(test1.last_printed_at);
  await store.updateVersionContent(slug, "test-1", test1.cooklang_text.replace("390", "395"));
  await store.updateVersionNotes(slug, "test-1", "a note");
  test1 = entry(await get(slug), "v1.0 · Test 1");
  assert.match(test1.cooklang_text, /395/);
  assert.match(test1.cooklang_text, /a note/);
  // Cooked: fixed, so its cooks keep matching it.
  await store.createCookLog(slug, { kind: "version", version_string: "test-1" }, { outcome: "" });
  assert.equal(entry(await get(slug), "v1.0 · Test 1").locked, true);
  await assert.rejects(store.updateVersionContent(slug, "test-1", "changed"), /has been cooked/);
  await assert.rejects(store.updateVersionNotes(slug, "test-1", "other"), store.TestFixedError);
  assert.match(entry(await get(slug), "v1.0 · Test 1").cooklang_text, /395/);
  // Closed, never cooked: fixed too.
  await makeTest(slug, "less salt", (t) => t.replace("10%g", "9%g"));
  await store.setTestOpen(slug, "test-2", false);
  await assert.rejects(store.updateVersionContent(slug, "test-2", "changed"), /is closed/);
  // Its Testing line is a label, not part of the sheet.
  await store.updateTesting(slug, "test-1", "much more water");
  assert.equal(entry(await get(slug), "v1.0 · Test 1").testing, "much more water");
  // A typo fix in a version still works.
  await store.updateVersionContent(slug, "v1.0", V1.replace("Rest", "Rest covered"));
  assert.match(entry(await get(slug), "v1.0").cooklang_text, /Rest covered/);
});

test("prints: recorded per sheet and scale, the same day updates instead of adding", async () => {
  const { store, sql } = ctx;
  const slug = await recipeWithVersion("Prints");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));

  const first = await store.recordPrint(slug, "test-1", 2);
  assert.equal(first.created, true);
  const again = await store.recordPrint(slug, "test-1", 2);
  assert.deepEqual([again.created, again.id], [false, first.id]);
  const other = await store.recordPrint(slug, "v1.0", 1);
  assert.equal(other.created, true);

  let recipe = await get(slug);
  assert.deepEqual(recipe.recent_prints.map((p) => [p.label, p.version_string, p.scale]), [["v1.0", "v1.0", 1], ["v1.0 · Test 1", "test-1", 2]]);

  // Yesterday's print of the same sheet is kept; today's is a new one.
  await sql`UPDATE prints SET printed_at = now() - interval '1 day' WHERE id = ${first.id}`;
  const today = await store.recordPrint(slug, "test-1", 2);
  assert.equal(today.created, true);
  recipe = await get(slug);
  assert.equal(recipe.recent_prints.length, 3);
  assert.equal(recipe.recent_prints[0].id, today.id);

  // The working copy isn't a sheet.
  await assert.rejects(store.recordPrint(slug, "draft", 1), /save the working copy as a test/);
  await assert.rejects(store.recordPrint(slug, "v9.9", 1), /version not found/);

  // Deleting a test deletes its prints.
  await store.deleteVersion(slug, "test-1");
  assert.deepEqual((await get(slug)).recent_prints.map((p) => p.label), ["v1.0"]);
});

test("a cook needs nothing to be recorded, and keeps the differences marked 'I meant this'", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Cook screen");
  const log = await store.createCookLog(slug, { kind: "version", version_string: "v1.0" }, { outcome: "", scale: 2 });
  assert.equal(log.outcome, "");
  assert.match(log.cooklang_text, /@water\{750%g\}/);
  assert.deepEqual(log.intended, []);

  const water = { kind: "ingredient", name: "Water", n: 0 };
  const updated = await store.updateCookLog(slug, log.id, {
    intended: [water, water, { kind: "timer", name: "", n: 0 }, { kind: "nope", n: 1 }, { kind: "timer", n: -1 }],
  });
  assert.deepEqual(updated.intended, [{ kind: "ingredient", name: "water", n: 0 }, { kind: "timer", name: "", n: 0 }]);
  const cleared = await store.updateCookLog(slug, log.id, { outcome: "  " });
  assert.equal(cleared.outcome, "");
  assert.equal(cleared.intended.length, 2);
  assert.equal((await store.getCookLog(slug, log.id)).intended.length, 2);
});

test("each sheet knows when a cook of it was last saved, whatever date the cook has", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Recorded at");
  const before = Date.now();
  await store.createCookLog(slug, { kind: "version", version_string: "v1.0" }, { outcome: "", cooked_at: "2026-01-02T12:00:00Z" });
  const v1 = entry(await get(slug), "v1.0");
  assert.equal(v1.last_cooked_at, "2026-01-02T12:00:00.000Z");
  assert.ok(Date.parse(v1.last_recorded_at) >= before - 1000);
});

test("adopting a test as written takes the test, not what its cooks did", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("As written");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  for (const [scale, edit] of [[1, (t) => t.replace("500%g", "502%g")], [2, (t) => t.replace("20%g", "22%g")]]) {
    const log = await store.createCookLog(slug, { kind: "version", version_string: "test-1" }, { outcome: "ok", scale });
    await store.updateCookLog(slug, log.id, { cooklang_text: edit(log.cooklang_text) });
  }
  assert.deepEqual(await store.previewAdopt(slug, "test-1"), { mode: "as-is", current: "v1.0" });
  await store.releaseVersion(slug, "test-1", { version_string: "v1.1" });
  const recipe = await get(slug);
  assert.equal(entry(recipe, "v1.1").cooklang_text, entry(recipe, "v1.0 · Test 1").cooklang_text);
  assert.equal(entry(recipe, "v1.0 · Test 1").adopted_as, "v1.1");
});

test("adopt preview: merges into a newer current version, or says it conflicts", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Preview");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  await makeTest(slug, "more salt", (t) => t.replace("10%g", "12%g"));
  await makeTest(slug, "less water", (t) => t.replace("375", "360"));
  await store.releaseVersion(slug, "test-2", { version_string: "v1.1" });
  assert.deepEqual(await store.previewAdopt(slug, "test-1"), { mode: "merged", current: "v1.1" });
  await store.releaseVersion(slug, "test-1", { version_string: "v1.2" });
  const conflict = await store.previewAdopt(slug, "test-3");
  assert.equal(conflict.mode, "conflict");
  assert.equal(conflict.current, "v1.2");
  assert.equal((await get(slug)).versions.filter((v) => v.kind === "version").length, 3, "a preview makes nothing");
});

test("adopting from a cook takes only the ticked changes; the same cook can be adopted again", async () => {
  const { store } = ctx;
  const { synthesizePromotedRecipe } = await import("../src/compare.ts");
  const { scaleCooklangText } = await import("../src/cooklang.ts");
  const slug = await recipeWithVersion("Ticked");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  const log = await store.createCookLog(slug, { kind: "version", version_string: "test-1" }, { outcome: "ok", scale: 2 });
  // At 2×: more salt (ticked) and a longer rest (not ticked).
  const cooked = log.cooklang_text.replace("20%g", "24%g").replace("30%min", "45%min");
  await store.updateCookLog(slug, log.id, { cooklang_text: cooked });
  const source = scaleCooklangText(log.source_cooklang_text, 2);
  const picked = synthesizePromotedRecipe(source, cooked, new Set(["step-token:0:2:ingredient:0"]));
  const fresh = await store.getCookLog(slug, log.id);
  await store.promoteCookLogWithText(slug, log.id, store.cookLogTextAtRecipeScale(fresh, picked), { version_string: "v1.1" });
  let v11 = entry(await get(slug), "v1.1");
  assert.match(v11.cooklang_text, /@salt\{12%g\}/, "ticked, back at 1×");
  assert.match(v11.cooklang_text, /~\{30%min\}/, "not ticked");
  assert.match(v11.cooklang_text, /@water\{390%g\}/, "the test itself");
  // Adopting the same cook again is allowed (the screen warns first).
  await store.promoteCookLog(slug, log.id, { version_string: "v1.2" });
  const recipe = await get(slug);
  assert.deepEqual(recipe.versions.filter((v) => v.from_cook_log_id === log.id).map((v) => v.label).sort(), ["v1.1", "v1.2"]);
  assert.match(entry(recipe, "v1.2").cooklang_text, /~\{45%min\}/);
});


test("tests are named by the version they're made from, and keep their name", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Names");
  await makeTest(slug, "a", (t) => t.replace("375", "380"));
  await makeTest(slug, "b", (t) => t.replace("375", "385"));
  await store.releaseVersion(slug, "test-2", { version_string: "v1.1" });
  // A new test starts from the current version.
  await makeTest(slug, "c", (t) => t.replace("10%g", "11%g"));
  let recipe;
  // From the older version again: v1.0's numbering carries on.
  await store.forkVersionToDraft(slug, "v1.0", "main", { testing: "d" });
  recipe = await get(slug);
  assert.equal(recipe.next_test_label, "v1.0 · Test 3");
  await store.updateDraft(slug, { cooklang_text: recipe.draft.cooklang_text.replace("500", "490") });
  await store.saveTest(slug, {});
  recipe = await get(slug);
  const names = recipe.versions.filter((v) => v.kind === "test").sort((a, b) => a.test_number - b.test_number).map((v) => [v.label, v.test_key, v.base_version]);
  assert.deepEqual(names, [["v1.0 · Test 1", "v1.0-1", "v1.0"], ["v1.0 · Test 2", "v1.0-2", "v1.0"], ["v1.1 · Test 1", "v1.1-1", "v1.1"], ["v1.0 · Test 3", "v1.0-3", "v1.0"]]);
  // Deleting one renames nothing.
  await store.deleteVersion(slug, "test-1");
  recipe = await get(slug);
  assert.deepEqual(recipe.versions.filter((v) => v.kind === "test").map((v) => v.label).sort(), ["v1.0 · Test 2", "v1.0 · Test 3", "v1.1 · Test 1"]);
  // Before any version, a test is plain "Test N".
  const { slug: fresh } = await store.createRecipe("No version");
  await store.updateDraft(fresh, { cooklang_text: V1 });
  const first = await store.saveTest(fresh, {});
  assert.deepEqual([first.label, first.test_key], ["Test 1", "v0-1"]);
});

test("after adopting, an untouched working copy moves to the new version; one with changes stays", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Moves on");
  await makeTest(slug, "more water", (t) => t.replace("375", "390"));
  await store.releaseVersion(slug, "test-1", { version_string: "v1.1" });
  let recipe = await get(slug);
  assert.equal(recipe.draft.base_version, "v1.1");
  assert.equal(recipe.draft.cooklang_text, entry(recipe, "v1.1").cooklang_text);
  assert.equal(recipe.has_unreleased_changes, false);
  assert.equal(recipe.next_test_label, "v1.1 · Test 1");

  // Work in progress is not touched.
  await makeTest(slug, "more salt", (t) => t.replace("10%g", "12%g"));
  await store.updateDraft(slug, { cooklang_text: (await get(slug)).draft.cooklang_text.replace("Rest", "Rest covered") });
  await store.releaseVersion(slug, "test-2", { version_string: "v1.2" });
  recipe = await get(slug);
  assert.equal(recipe.draft.base_version, "v1.1");
  assert.match(recipe.draft.cooklang_text, /Rest covered/);
  assert.equal(recipe.next_test_label, "v1.1 · Test 2");
});

test("a print keeps how it showed the amounts, and a cook keeps its print's", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Shown as");
  await store.recordPrint(slug, "v1.0", 2, "main", { temp: "C", units: { Flour: "cup", bad: 3 }, junk: true });
  let recipe = await get(slug);
  assert.deepEqual(recipe.recent_prints[0].display, { temp: "C", units: { flour: "cup" } });
  // Printed again the same day in °F: the one record follows.
  await store.recordPrint(slug, "v1.0", 2, "main", { temp: "F" });
  recipe = await get(slug);
  assert.deepEqual([recipe.recent_prints.length, recipe.recent_prints[0].display], [1, { temp: "F" }]);
  const log = await store.createCookLog(slug, { kind: "version", version_string: "v1.0" }, { outcome: "", display: { temp: "C" } });
  assert.deepEqual(log.display, { temp: "C" });
  assert.deepEqual((await store.createCookLog(slug, { kind: "version", version_string: "v1.0" }, { outcome: "" })).display, {});
});

test("a cook's photos belong to it: listed on its sheet, gone with the cook", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Photographed");
  const photo = (name) => ({ filename: name, mime_type: "image/png", data: Buffer.from(name) });
  const older = await store.createCookLog(slug, { kind: "version", version_string: "v1.0" }, { outcome: "", cooked_at: "2026-11-01T12:00:00Z" });
  const newer = await store.createCookLog(slug, { kind: "version", version_string: "v1.0" }, { outcome: "", cooked_at: "2026-11-05T12:00:00Z" });
  assert.deepEqual(older.photos, []);
  await store.attachCookPhoto(slug, older.id, photo("crumb"));
  const withTwo = await store.attachCookPhoto(slug, older.id, photo("crust"));
  assert.equal(withTwo.photos.length, 2);
  await store.attachCookPhoto(slug, newer.id, photo("loaf"));
  // One attached to the sheet itself, from before photos belonged to cooks.
  await store.attachRecipeImage(slug, { ...photo("old"), version_string: "v1.0" });
  const listed = await store.listRecipeImages(slug, "v1.0");
  assert.deepEqual(listed.map((i) => i.filename), ["loaf", "crumb", "crust", "old"]);
  assert.equal(listed[0].cook_log_id, newer.id);
  assert.equal(listed[3].cook_log_id, null);
  // Not the recipe's own photos (no sheet), and every list of cooks carries them.
  assert.deepEqual(await store.listRecipeImages(slug, null), []);
  const logs = await store.listVersionCookLogs(slug, "v1.0");
  assert.deepEqual(logs.map((l) => l.photos.length), [1, 2]);
  await assert.rejects(store.attachCookPhoto(slug, "00000000-0000-0000-0000-000000000000", photo("x")), /cook log not found/);
  await store.deleteCookLog(slug, older.id);
  assert.deepEqual((await store.listRecipeImages(slug, "v1.0")).map((i) => i.filename), ["loaf", "old"]);
});

test("folders group recipes: several per recipe, renamed, emptied, deleted without the recipes", async () => {
  const { store } = ctx;
  const turkey = (await store.createRecipe("Deboned Roast Turkey")).slug;
  const loaf = (await store.createRecipe("Folder Loaf")).slug;
  const butter = (await store.createRecipe("Folder Butter")).slug;

  const holiday = await store.createFolder({ name: "  Thanksgiving ", icon: "🦃" });
  assert.equal(holiday.name, "Thanksgiving");
  assert.equal(holiday.recipe_count, 0);
  await assert.rejects(store.createFolder({ name: "thanksgiving" }), (e) => e.status === 409 && e.message.includes("“Thanksgiving”"));
  await assert.rejects(store.createFolder({ name: " " }), (e) => e.status === 400);
  const baking = await store.createFolder({ name: "Baking", icon: "lucide:wheat" });

  // From the folder: exactly these recipes.
  assert.equal((await store.setFolderRecipes(holiday.id, [turkey, loaf])).recipe_count, 2);
  await assert.rejects(store.setFolderRecipes(holiday.id, ["no-such-recipe"]), (e) => e.status === 404);
  assert.equal((await store.listFolders()).find((f) => f.id === holiday.id).recipe_count, 2, "a refused change changes nothing");
  // From the recipe: exactly these folders, in the order they were added.
  assert.deepEqual(await store.setRecipeFolders(loaf, [holiday.id, baking.id]), [holiday.id, baking.id]);
  assert.deepEqual((await get(loaf)).folder_ids, [holiday.id, baking.id]);
  await assert.rejects(store.setRecipeFolders(loaf, ["00000000-0000-0000-0000-000000000000"]), (e) => e.status === 404);

  const inHoliday = (await store.listRecipes(undefined, holiday.id)).map((r) => r.slug).sort();
  assert.deepEqual(inHoliday, [loaf, turkey].sort());
  assert.deepEqual((await store.listRecipes("loaf", baking.id)).map((r) => r.slug), [loaf]);
  assert.ok((await store.listRecipes()).some((r) => r.slug === butter), "the unfiled are still in All");

  const renamed = await store.updateFolder(holiday.id, { name: "Holidays" });
  assert.equal(renamed.icon, "🦃", "a rename keeps the icon");
  await assert.rejects(store.updateFolder(holiday.id, { name: "BAKING" }), (e) => e.status === 409);
  assert.equal((await store.setFolderRecipes(holiday.id, [])).recipe_count, 0);
  assert.deepEqual((await get(loaf)).folder_ids, [baking.id]);

  await store.deleteFolder(baking.id);
  assert.deepEqual((await get(loaf)).folder_ids, []);
  assert.ok(await get(loaf), "the recipe stays");
  await assert.rejects(store.deleteFolder(baking.id), (e) => e.status === 404);
  await assert.rejects(store.updateFolder("not-a-uuid", { name: "x" }), (e) => e.status === 404);
});

test("a recipe's icon is one emoji or a bundled icon, and isn't versioned", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Icon Loaf");
  const before = (await get(slug)).versions.map((v) => `${v.id} ${v.updated_at}`);
  for (const icon of ["🦃", "👩🏽‍🍳", "🇯🇵", "lucide:cooking-pot", ""]) {
    assert.equal(await store.setRecipeIcon(slug, icon), icon);
  }
  for (const bad of ["turkey", "🦃🦃", "<b>", "lucide:Wheat", "lucide:../x"]) {
    await assert.rejects(store.setRecipeIcon(slug, bad), (e) => e.status === 400, bad);
  }
  await store.setRecipeIcon(slug, " 🍞 ");
  const recipe = await get(slug);
  assert.equal(recipe.icon, "🍞");
  assert.deepEqual(recipe.versions.map((v) => `${v.id} ${v.updated_at}`), before, "no sheet changed");
  assert.equal((await store.listRecipes()).find((r) => r.slug === slug).icon, "🍞");
});

test("a sheet's icon: line is the recipe's icon until one is chosen", async () => {
  const { store } = ctx;
  const slug = await recipeWithVersion("Sheet Icon Loaf", `---\ntitle: Sheet Icon Loaf\nicon: 🥖\n---\n\nMix @flour{500%g}.`);
  let recipe = await get(slug);
  assert.equal(recipe.current_version.icon, "🥖");
  assert.equal(recipe.default_icon, "🥖");
  assert.equal(recipe.icon, "", "nothing chosen");

  // The working copy's line, once it has one, is the newer word.
  await store.updateDraft(slug, { cooklang_text: `---\nicon: lucide:wheat\n---\n\nMix @flour{500%g}.` });
  assert.equal((await get(slug)).default_icon, "lucide:wheat");
  // Not an icon: ignored, so the version's shows.
  await store.updateDraft(slug, { cooklang_text: `---\nicon: bread\n---\n\nMix @flour{500%g}.` });
  recipe = await get(slug);
  assert.equal(recipe.draft.icon, null);
  assert.equal(recipe.default_icon, "🥖");

  await store.setRecipeIcon(slug, "🍞");
  const listed = (await store.listRecipes()).find((r) => r.slug === slug);
  assert.equal(listed.icon, "🍞");
  assert.equal(listed.default_icon, "🥖", "both are there; the chosen one wins on screen");
});
