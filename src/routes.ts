import * as Diff from "diff";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { parseCooklang, annotateCookLogDiff, annotateIngredientSummaryDiff, applyStepDeviation, updateStepQuantity, insertNoteAfterStep, deleteStep as deleteCooklangStep, insertStepAfterStep, insertStepInSection, insertSectionNote, renameSection, insertRecipeNote } from "./cooklang.ts";
import { buildInlineDiffLines, diffStepBlocks, classifyCookLogVsSource, synthesizePromotedRecipe } from "./compare.ts";
import { diffIngredients } from "./ingredient-compare.js";
import {
  applyBranchSync,
  attachRecipeImage,
  collectUnresolvedReferences,
  createCookLog,
  createRecipe,
  createRecipeBranch,
  deleteCookLog,
  deleteRecipe,
  deleteRecipeImage,
  deleteVersion,
  enrichRecipeReferences,
  forkCookLogToDraft,
  getCookLog,
  forkBranchHeadToDraft,
  forkVersionToDraft,
  getRecipeBranch,
  getRecipeBySlug,
  getVersionByString,
  listBacklinks,
  listBranchCookLogs,
  listRecipeBranches,
  listRecipeImages,
  listRecipes,
  listVersionCookLogs,
  previewBranchSync,
  promoteCookLog,
  promoteCookLogWithText,
  readRecipeImage,
  releaseDraft,
  releaseVersion,
  setRecipeThumbnail,
  updateCookLog,
  updateDraft,
  updateDraftNotes,
  updateRecipeTitle,
  updateVersionContent,
  updateVersionNotes,
} from "./recipe-store.ts";

const api = new Hono();
const allowedImageTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAIN_BRANCH = "main";

async function readImageUpload(c: any) {
  const formData = await c.req.formData();
  const file = formData.get("image") as File | null;
  if (!file) return { error: "image required" };
  if (!allowedImageTypes.includes(file.type)) return { error: "unsupported image type" };
  return {
    file,
    buffer: Buffer.from(await file.arrayBuffer()),
    version: String(formData.get("version") || "").trim() || null,
  };
}

function activeBranch(c: any): string {
  return c.req.param("branch") || MAIN_BRANCH;
}

async function resolveCompareOperand(recipe: any, branch: string, key: string): Promise<any | null> {
  if (key.startsWith("cooklog-source:")) {
    const log = await getCookLog(recipe.slug, key.slice("cooklog-source:".length), branch);
    if (!log) return null;
    return { cooklang_text: log.source_cooklang_text || "", status: "cook-log-source" };
  }
  if (key.startsWith("cooklog:")) {
    const log = await getCookLog(recipe.slug, key.slice("cooklog:".length), branch);
    if (!log) return null;
    return { cooklang_text: log.cooklang_text || "", status: "cook-log" };
  }
  if (key === "draft") return recipe.draft || null;
  return recipe.versions.find((version: any) => version.version_string === key) || null;
}

async function compareVersions(recipe: any, branch: string, fromStr: string, toStr: string) {
  const fromV = await resolveCompareOperand(recipe, branch, fromStr);
  const toV = await resolveCompareOperand(recipe, branch, toStr);
  if (!fromV || !toV) return null;

  const textDiff = Diff.createTwoFilesPatch(fromStr, toStr, fromV.cooklang_text || "", toV.cooklang_text || "", "", "", { context: 3 });
  const fromParsed = parseCooklang(fromV.cooklang_text || "");
  const toParsed = parseCooklang(toV.cooklang_text || "");

  return {
    from: { version: fromStr, status: fromV.status },
    to: { version: toStr, status: toV.status },
    text_diff: textDiff,
    text_diff_lines: buildInlineDiffLines(textDiff),
    ingredient_diff: diffIngredients(fromParsed.ingredients, toParsed.ingredients),
    step_changes: diffStepBlocks(fromV.cooklang_text || "", toV.cooklang_text || ""),
    step_count_from: fromParsed.steps.length,
    step_count_to: toParsed.steps.length,
  };
}

function installBranchRoutes(prefix: string, includeRecipeCrud = false) {
  if (includeRecipeCrud) {
    api.get("/recipes", async (c) => c.json(await listRecipes(c.req.query("q"))));

    api.post("/recipes", async (c) => {
      const body = await c.req.json();
      if (!body.title?.trim()) return c.json({ error: "title required" }, 400);
      return c.json(await createRecipe(body.title.trim()), 201);
    });

    api.get("/recipes/:slug", async (c) => {
      const recipe = await getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH);
      if (!recipe) return c.json({ error: "not found" }, 404);
      return c.json(recipe);
    });

    api.put("/recipes/:slug", async (c) => {
      const recipe = await getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH);
      if (!recipe) return c.json({ error: "not found" }, 404);
      const body = await c.req.json();
      if (body.title?.trim()) return c.json(await updateRecipeTitle(recipe.slug, body.title.trim()));
      return c.json({ ok: true });
    });

    api.delete("/recipes/:slug", async (c) => {
      if (!(await getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH))) return c.json({ error: "not found" }, 404);
      await deleteRecipe(c.req.param("slug"));
      return c.json({ ok: true });
    });

    api.get("/recipes/:slug/branches", async (c) => {
      if (!(await getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH))) return c.json({ error: "not found" }, 404);
      return c.json(await listRecipeBranches(c.req.param("slug")));
    });

    api.post("/recipes/:slug/branches", async (c) => {
      if (!(await getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH))) return c.json({ error: "not found" }, 404);
      const body = await c.req.json();
      if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
      if (!body.source_version?.trim()) return c.json({ error: "source_version required" }, 400);
      try {
        return c.json(await createRecipeBranch(c.req.param("slug"), {
          name: body.name.trim(),
          source_version: body.source_version.trim(),
        }), 201);
      } catch (error: any) {
        return c.json({ error: error?.message || "branch create failed" }, 400);
      }
    });

    api.get("/recipes/:slug/branches/:branch", async (c) => {
      const recipe = await getRecipeBranch(c.req.param("slug"), c.req.param("branch"));
      if (!recipe) return c.json({ error: "not found" }, 404);
      return c.json(recipe);
    });
  }

  api.get(`${prefix}/draft`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    if (!recipe.draft) return c.json({ error: "no draft" }, 404);
    return c.json(recipe.draft);
  });

  api.put(`${prefix}/draft`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    const baseline = recipe.draft || recipe.source_version || recipe.versions[0] || { cooklang_text: "", tags: "[]" };
    const nextText = body.cooklang_text ?? baseline.cooklang_text ?? "";
    const result = await updateDraft(c.req.param("slug"), {
      cooklang_text: nextText,
      tags: body.tags ?? JSON.parse(baseline.tags || "[]"),
    }, { advance_beta: body.advance_beta === true }, activeBranch(c));
    const unresolved = await collectUnresolvedReferences(await enrichRecipeReferences(parseCooklang(nextText)));
    return c.json({
      ...result,
      warnings: unresolved.length ? { unresolved_references: unresolved } : undefined,
    });
  });

  api.post(`${prefix}/draft/fork`, async (c) => {
    try {
      return c.json(await forkBranchHeadToDraft(c.req.param("slug"), activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "fork failed" }, 400);
    }
  });

  api.put(`${prefix}/draft/notes`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    await updateDraftNotes(recipe.slug, body.notes || "", activeBranch(c));
    return c.json({ ok: true });
  });

  api.post(`${prefix}/draft/parse`, async (c) => {
    const body = await c.req.json();
    const parsed = await enrichRecipeReferences(parseCooklang(body.cooklang_text || ""));
    // Optional cook-log diff annotation: when the caller supplies the source
    // recipe text, walk paired steps and mutate per-token diff fields onto
    // `parsed.steps` so the renderer can show "was X" chips.
    if (typeof body.source_cooklang_text === "string" && body.source_cooklang_text) {
      const sourceParsed = parseCooklang(body.source_cooklang_text);
      annotateCookLogDiff(parsed.steps, sourceParsed.steps);
      annotateIngredientSummaryDiff(parsed.ingredient_summary, sourceParsed.ingredient_summary);
    }
    return c.json(parsed);
  });

  api.get(`${prefix}/versions`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    return c.json((recipe.versions || []).filter((version) => !version.is_draft));
  });

  api.get(`${prefix}/versions/:version`, async (c) => {
    const version = await getVersionByString(c.req.param("slug"), c.req.param("version"), activeBranch(c));
    if (!version) return c.json({ error: "version not found" }, 404);
    return c.json(version);
  });

  api.post(`${prefix}/versions/:version/fork`, async (c) => {
    if (!(await getRecipeBySlug(c.req.param("slug"), activeBranch(c)))) return c.json({ error: "not found" }, 404);
    try {
      await forkVersionToDraft(c.req.param("slug"), c.req.param("version"), activeBranch(c));
    } catch (error: any) {
      return c.json({ error: error?.message || "version not found" }, 404);
    }
    return c.json({ ok: true });
  });

  api.put(`${prefix}/versions/:version`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const version = await getVersionByString(recipe.slug, c.req.param("version"), activeBranch(c));
    if (!version) return c.json({ error: "version not found" }, 404);
    if (version.is_draft) return c.json({ error: "use draft endpoint" }, 400);
    const body = await c.req.json();
    await updateVersionContent(
      recipe.slug,
      version.version_string!,
      body.cooklang_text ?? version.cooklang_text,
      body.tags ?? JSON.parse(version.tags || "[]"),
      activeBranch(c),
    );
    return c.json({ ok: true });
  });

  api.put(`${prefix}/versions/:version/notes`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    if (!(await getVersionByString(recipe.slug, c.req.param("version"), activeBranch(c)))) return c.json({ error: "version not found" }, 404);
    const body = await c.req.json();
    await updateVersionNotes(recipe.slug, c.req.param("version"), body.notes || "", activeBranch(c));
    return c.json({ ok: true });
  });

  api.delete(`${prefix}/versions/:version`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    try {
      await deleteVersion(recipe.slug, c.req.param("version"), activeBranch(c));
    } catch (error: any) {
      const message = error?.message || "version not found";
      return c.json({ error: message }, message === "cannot delete draft" ? 400 : 404);
    }
    return c.json({ ok: true });
  });

  api.post(`${prefix}/release`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    const { version_string, status, changelog, source_version } = body;
    if (!version_string?.trim()) return c.json({ error: "version_string required" }, 400);
    if (!["released", "beta", "archived"].includes(status)) return c.json({ error: "invalid status" }, 400);
    try {
      let result;
      let sourceText = "";
      if (source_version && source_version !== "draft") {
        result = await releaseVersion(recipe.slug, source_version, {
          version_string: version_string.trim(), status, changelog,
        }, activeBranch(c));
        sourceText = recipe.versions.find((v) => v.version_string === source_version)?.cooklang_text || "";
      } else {
        result = await releaseDraft(recipe.slug, {
          version_string: version_string.trim(), status, changelog,
        }, activeBranch(c));
        sourceText = recipe.draft?.cooklang_text || "";
      }
      const unresolved = await collectUnresolvedReferences(await enrichRecipeReferences(parseCooklang(sourceText)));
      return c.json({
        ...result,
        warnings: unresolved.length ? { unresolved_references: unresolved } : undefined,
      });
    } catch (error: any) {
      const message = error?.message || "release failed";
      return c.json({ error: message }, message === "version already exists" ? 409 : 400);
    }
  });

  api.get(`${prefix}/compare`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const fromStr = c.req.query("from");
    const toStr = c.req.query("to");
    if (!fromStr || !toStr) return c.json({ error: "from and to required" }, 400);
    const result = await compareVersions(recipe, activeBranch(c), fromStr, toStr);
    if (!result) return c.json({ error: "version not found" }, 404);
    return c.json(result);
  });

  api.get(`${prefix}/images`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const version = c.req.query("version");
    try {
      return c.json(await listRecipeImages(recipe.slug, version || null, activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "version not found" }, 404);
    }
  });

  api.post(`${prefix}/images`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const upload = await readImageUpload(c);
    if ("error" in upload) return c.json({ error: upload.error }, 400);
    try {
      return c.json(await attachRecipeImage(recipe.slug, {
        filename: upload.file.name,
        mime_type: upload.file.type,
        data: upload.buffer,
        version_string: upload.version,
      }, activeBranch(c)), 201);
    } catch (error: any) {
      return c.json({ error: error?.message || "version not found" }, 404);
    }
  });

  api.get(`${prefix}/cook-logs`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    return c.json(await listBranchCookLogs(recipe.slug, activeBranch(c)));
  });

  api.get(`${prefix}/versions/:version/cook-logs`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    return c.json(await listVersionCookLogs(recipe.slug, c.req.param("version"), activeBranch(c)));
  });

  api.post(`${prefix}/cook-logs`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const rawSource = body && typeof body === "object" ? body.source : null;
    const sourceKind = rawSource && rawSource.kind === "draft" ? "draft" : "version";
    const source = sourceKind === "draft"
      ? { kind: "draft" as const }
      : { kind: "version" as const, version_string: String(rawSource?.version_string || "") };
    if (source.kind === "version" && !source.version_string) {
      return c.json({ error: "source.version_string required for version source" }, 400);
    }
    try {
      return c.json(await createCookLog(recipe.slug, source, {
        cooked_at: body.cooked_at,
        outcome: body.outcome,
        what_worked: body.what_worked,
        problems_found: body.problems_found,
        changes_to_try_next: body.changes_to_try_next,
        freeform_notes: body.freeform_notes,
        cooklang_text: body.cooklang_text,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
      }, activeBranch(c)), 201);
    } catch (error: any) {
      return c.json({ error: error?.message || "cook log create failed" }, 400);
    }
  });

  api.post(`${prefix}/versions/:version/cook-logs`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await createCookLog(recipe.slug, { kind: "version", version_string: c.req.param("version") }, {
        cooked_at: body.cooked_at,
        outcome: body.outcome,
        what_worked: body.what_worked,
        problems_found: body.problems_found,
        changes_to_try_next: body.changes_to_try_next,
        freeform_notes: body.freeform_notes,
        cooklang_text: body.cooklang_text,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
      }, activeBranch(c)), 201);
    } catch (error: any) {
      return c.json({ error: error?.message || "cook log create failed" }, 400);
    }
  });

  api.put(`${prefix}/cook-logs/:id`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(await updateCookLog(recipe.slug, c.req.param("id"), {
        cooked_at: body.cooked_at,
        outcome: body.outcome,
        what_worked: body.what_worked,
        problems_found: body.problems_found,
        changes_to_try_next: body.changes_to_try_next,
        freeform_notes: body.freeform_notes,
        cooklang_text: body.cooklang_text,
        tags: Array.isArray(body.tags) ? body.tags : undefined,
      }, activeBranch(c)));
    } catch (error: any) {
      const message = error?.message || "cook log update failed";
      return c.json({ error: message }, message === "cook log not found" ? 404 : 400);
    }
  });

  // Step-level surgical mutations on a cook log's cooklang_text. The action
  // dispatch keeps the surface small while letting the UI hit one endpoint for
  // deviation markers, inline notes, and step deletion.
  api.post(`${prefix}/cook-logs/:id/step-action`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const sectionIndex = Number(body?.section_index);
    const stepNumber = Number(body?.step_number);
    const action = String(body?.action || "");
    if (!Number.isFinite(sectionIndex) || !Number.isFinite(stepNumber)) {
      return c.json({ error: "section_index and step_number required" }, 400);
    }
    const log = await getCookLog(recipe.slug, c.req.param("id"), activeBranch(c));
    if (!log) return c.json({ error: "cook log not found" }, 404);
    const before = log.cooklang_text || "";
    let next = before;
    if (action === "set-deviation") {
      // Only "skipped" is user-toggleable. "added" is set by insert-step-after
      // (auto-prepended `!+ `); "modified" was retired in favor of diffing.
      const deviation = body?.deviation;
      const allowed = deviation === null || deviation === "skipped";
      if (!allowed) return c.json({ error: "invalid deviation" }, 400);
      next = applyStepDeviation(before, sectionIndex, stepNumber, deviation);
    } else if (action === "insert-note") {
      const note = String(body?.note || "").trim();
      if (!note) return c.json({ error: "note required" }, 400);
      next = insertNoteAfterStep(before, sectionIndex, stepNumber, note);
    } else if (action === "insert-step-after") {
      const content = String(body?.content || "").trim();
      if (!content) return c.json({ error: "content required" }, 400);
      next = insertStepAfterStep(before, sectionIndex, stepNumber, content);
    } else if (action === "delete") {
      next = deleteCooklangStep(before, sectionIndex, stepNumber);
    } else if (action === "update-quantity") {
      const kind = String(body?.token_kind || "");
      const tokenIndex = Number(body?.token_index);
      const newQuantity = String(body?.new_quantity ?? "");
      const newUnits = String(body?.new_units ?? "");
      const kindOk = kind === "ingredient" || kind === "timer" || kind === "inlineQuantity";
      if (!kindOk || !Number.isFinite(tokenIndex) || tokenIndex < 0) {
        return c.json({ error: "token_kind + token_index required" }, 400);
      }
      next = updateStepQuantity(before, sectionIndex, stepNumber, kind as any, tokenIndex, newQuantity, newUnits);
    } else {
      return c.json({ error: "unknown action" }, 400);
    }
    if (next === before) return c.json({ error: "step not found" }, 404);
    try {
      return c.json(await updateCookLog(recipe.slug, c.req.param("id"), { cooklang_text: next }, activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "step action failed" }, 400);
    }
  });

  api.post(`${prefix}/cook-logs/:id/section-action`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const sectionIndex = Number(body?.section_index);
    const action = String(body?.action || "");
    if (!Number.isFinite(sectionIndex)) return c.json({ error: "section_index required" }, 400);
    const log = await getCookLog(recipe.slug, c.req.param("id"), activeBranch(c));
    if (!log) return c.json({ error: "cook log not found" }, 404);
    const before = log.cooklang_text || "";
    let next = before;
    if (action === "add-step") {
      const content = String(body?.content || "").trim();
      if (!content) return c.json({ error: "content required" }, 400);
      next = insertStepInSection(before, sectionIndex, content);
    } else if (action === "add-note") {
      const note = String(body?.note || "").trim();
      if (!note) return c.json({ error: "note required" }, 400);
      next = insertSectionNote(before, sectionIndex, note);
    } else if (action === "rename") {
      const name = String(body?.name || "").trim();
      if (!name) return c.json({ error: "name required" }, 400);
      next = renameSection(before, sectionIndex, name);
    } else {
      return c.json({ error: "unknown action" }, 400);
    }
    if (next === before) return c.json({ error: "section not found" }, 404);
    try {
      return c.json(await updateCookLog(recipe.slug, c.req.param("id"), { cooklang_text: next }, activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "section action failed" }, 400);
    }
  });

  api.post(`${prefix}/cook-logs/:id/recipe-action`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const action = String(body?.action || "");
    const log = await getCookLog(recipe.slug, c.req.param("id"), activeBranch(c));
    if (!log) return c.json({ error: "cook log not found" }, 404);
    const before = log.cooklang_text || "";
    let next = before;
    if (action === "add-note") {
      const note = String(body?.note || "").trim();
      if (!note) return c.json({ error: "note required" }, 400);
      next = insertRecipeNote(before, note);
    } else {
      return c.json({ error: "unknown action" }, 400);
    }
    try {
      return c.json(await updateCookLog(recipe.slug, c.req.param("id"), { cooklang_text: next }, activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "recipe action failed" }, 400);
    }
  });

  api.post(`${prefix}/cook-logs/:id/fork-to-draft`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await forkCookLogToDraft(recipe.slug, c.req.param("id"), activeBranch(c)));
    } catch (error: any) {
      const message = error?.message || "fork to draft failed";
      return c.json({ error: message }, message === "cook log not found" ? 404 : 400);
    }
  });

  api.post(`${prefix}/cook-logs/:id/promote`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const versionString = String(body?.version_string || "").trim();
    if (!versionString) return c.json({ error: "version_string required" }, 400);
    const status = body?.status === "beta" || body?.status === "archived" ? body.status : "released";
    try {
      return c.json(await promoteCookLog(recipe.slug, c.req.param("id"), {
        version_string: versionString, status, changelog: body?.changelog || "",
      }, activeBranch(c)));
    } catch (error: any) {
      const message = error?.message || "promote failed";
      return c.json({ error: message }, message === "cook log not found" ? 404 : 400);
    }
  });

  // Classified diff (cook log vs source) — drives the cherry-pick promote UI.
  api.get(`${prefix}/cook-logs/:id/classify`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const log = await getCookLog(recipe.slug, c.req.param("id"), activeBranch(c));
    if (!log) return c.json({ error: "cook log not found" }, 404);
    const logParsed = parseCooklang(log.cooklang_text || "");
    const sourceParsed = parseCooklang(log.source_cooklang_text || "");
    return c.json(classifyCookLogVsSource(logParsed, sourceParsed));
  });

  // Cherry-pick promote — synthesize source + selections into a new version.
  api.post(`${prefix}/cook-logs/:id/promote-cherry-pick`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const versionString = String(body?.version_string || "").trim();
    if (!versionString) return c.json({ error: "version_string required" }, 400);
    const status = body?.status === "beta" || body?.status === "archived" ? body.status : "released";
    const selectionsArr = Array.isArray(body?.selections) ? body.selections.map(String) : [];
    const log = await getCookLog(recipe.slug, c.req.param("id"), activeBranch(c));
    if (!log) return c.json({ error: "cook log not found" }, 404);
    if (!log.source_cooklang_text?.trim()) {
      return c.json({ error: "cook log has no source snapshot to cherry-pick from" }, 400);
    }
    const synthesized = synthesizePromotedRecipe(
      log.source_cooklang_text,
      log.cooklang_text || "",
      new Set<string>(selectionsArr),
    );
    try {
      return c.json(await promoteCookLogWithText(recipe.slug, c.req.param("id"), synthesized, {
        version_string: versionString, status, changelog: body?.changelog || "",
      }, activeBranch(c)));
    } catch (error: any) {
      const message = error?.message || "promote failed";
      return c.json({ error: message }, message === "cook log not found" ? 404 : 400);
    }
  });

  api.delete(`${prefix}/cook-logs/:id`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    await deleteCookLog(recipe.slug, c.req.param("id"), activeBranch(c));
    return c.json({ ok: true });
  });

  api.get(`${prefix}/backlinks`, async (c) => {
    const recipe = await getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    return c.json(await listBacklinks(recipe.slug));
  });

  api.post(`${prefix}/sync/preview`, async (c) => {
    try {
      return c.json(await previewBranchSync(c.req.param("slug"), activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "sync preview failed" }, 400);
    }
  });

  api.post(`${prefix}/sync/apply`, async (c) => {
    try {
      return c.json(await applyBranchSync(c.req.param("slug"), activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "sync apply failed" }, 400);
    }
  });
}

installBranchRoutes("/recipes/:slug", true);
installBranchRoutes("/recipes/:slug/branches/:branch");

api.post("/recipes/:slug/thumbnail", async (c) => {
  const recipe = await getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH);
  if (!recipe) return c.json({ error: "not found" }, 404);
  const upload = await readImageUpload(c);
  if ("error" in upload) return c.json({ error: upload.error }, 400);
  return c.json(await setRecipeThumbnail(recipe.slug, {
    filename: upload.file.name,
    mime_type: upload.file.type,
    data: upload.buffer,
  }), 201);
});

api.delete("/recipes/:slug/thumbnail", async (c) => {
  const recipe = await getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH);
  if (!recipe) return c.json({ error: "not found" }, 404);
  return c.json(await setRecipeThumbnail(recipe.slug, null));
});

api.get("/images/:id", async (c) => {
  const image = await readRecipeImage(c.req.param("id"));
  if (!image) return c.json({ error: "not found" }, 404);
  return new Response(image.data, {
    headers: { "Content-Type": image.mime_type, "Cache-Control": "public, max-age=86400" },
  });
});

api.delete("/images/:id", async (c) => {
  await deleteRecipeImage(c.req.param("id"));
  return c.json({ ok: true });
});

// ── System: restore from a pg_dump backup ────────────────────────────────────
api.post("/system/restore", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("backup") as File | null;
  if (!file) return c.json({ error: "backup file required (field: backup)" }, 400);

  // Verify magic bytes: Postgres custom-format dumps start with "PGDMP"
  const header = await file.slice(0, 5).arrayBuffer();
  if (Buffer.from(header).toString() !== "PGDMP") {
    return c.json({ error: "file does not look like a pg_dump -Fc backup" }, 400);
  }

  const tmpPath = path.join(os.tmpdir(), `ajilab-restore-${Date.now()}.dump`);
  try {
    fs.writeFileSync(tmpPath, Buffer.from(await file.arrayBuffer()));

    const { applySchema } = await import("./db.ts");

    const DATABASE_URL = process.env.DATABASE_URL
      || "postgresql://ajilab:ajilab@ajilab-db:5432/ajilab";

    // --clean --if-exists: pg_restore drops each object before recreating it.
    // This avoids manually wiping the schema (which would invalidate the
    // connection pool's prepared statements).
    const stderr: string[] = [];
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn("pg_restore", [
        "--dbname", DATABASE_URL,
        "--clean", "--if-exists",
        "--no-owner", "--no-acl",
        tmpPath,
      ]);
      child.stderr.on("data", (d) => stderr.push(d.toString()));
      child.on("error", (err) => reject(new Error(`spawn failed: ${err.message} — is postgresql-client-18 installed?`)));
      child.on("exit", (code) => resolve(code ?? 1));
    });

    const stderrText = stderr.join("").trim();
    console.log(`[restore] pg_restore exit ${exitCode}${stderrText ? `\n${stderrText}` : ""}`);

    if (exitCode > 1) {
      throw new Error(`pg_restore failed (exit ${exitCode}): ${stderrText || "unknown error"}`);
    }

    // Ensure any schema additions since the backup are applied
    await applySchema();
    return c.json({ ok: true, warnings: stderrText || null });
  } catch (error: any) {
    return c.json({ error: error?.message || "restore failed" }, 500);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
});

export default api;
