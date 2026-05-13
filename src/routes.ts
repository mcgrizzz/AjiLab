import * as Diff from "diff";
import { Hono } from "hono";
import { parseCooklang } from "./cooklang.ts";
import { buildInlineDiffLines, diffStepBlocks } from "./compare.ts";
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

function resolveCompareOperand(recipe: any, branch: string, key: string): any | null {
  // Cook log operands. Two flavours:
  //   - "cooklog:<id>"        → the log's current (editable) cooklang_text
  //   - "cooklog-source:<id>" → the immutable snapshot the log was forked from
  // Both are treated as synthetic version-like objects so the rest of the diff
  // pipeline works unchanged.
  if (key.startsWith("cooklog-source:")) {
    const log = getCookLog(recipe.slug, key.slice("cooklog-source:".length), branch);
    if (!log) return null;
    return {
      cooklang_text: log.source_cooklang_text || "",
      status: "cook-log-source",
    };
  }
  if (key.startsWith("cooklog:")) {
    const log = getCookLog(recipe.slug, key.slice("cooklog:".length), branch);
    if (!log) return null;
    return {
      cooklang_text: log.cooklang_text || "",
      status: "cook-log",
    };
  }
  if (key === "draft") return recipe.draft || null;
  return recipe.versions.find((version: any) => version.version_string === key) || null;
}

function compareVersions(recipe: any, branch: string, fromStr: string, toStr: string) {
  const fromV = resolveCompareOperand(recipe, branch, fromStr);
  const toV = resolveCompareOperand(recipe, branch, toStr);
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
    api.get("/recipes", (c) => c.json(listRecipes(c.req.query("q"))));

    api.post("/recipes", async (c) => {
      const body = await c.req.json();
      if (!body.title?.trim()) return c.json({ error: "title required" }, 400);
      return c.json(createRecipe(body.title.trim()), 201);
    });

    api.get("/recipes/:slug", (c) => {
      const recipe = getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH);
      if (!recipe) return c.json({ error: "not found" }, 404);
      return c.json(recipe);
    });

    api.put("/recipes/:slug", async (c) => {
      const recipe = getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH);
      if (!recipe) return c.json({ error: "not found" }, 404);
      const body = await c.req.json();
      if (body.title?.trim()) return c.json(updateRecipeTitle(recipe.slug, body.title.trim()));
      return c.json({ ok: true });
    });

    api.delete("/recipes/:slug", (c) => {
      if (!getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH)) return c.json({ error: "not found" }, 404);
      deleteRecipe(c.req.param("slug"));
      return c.json({ ok: true });
    });

    api.get("/recipes/:slug/branches", (c) => {
      if (!getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH)) return c.json({ error: "not found" }, 404);
      return c.json(listRecipeBranches(c.req.param("slug")));
    });

    api.post("/recipes/:slug/branches", async (c) => {
      if (!getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH)) return c.json({ error: "not found" }, 404);
      const body = await c.req.json();
      if (!body.name?.trim()) return c.json({ error: "name required" }, 400);
      if (!body.source_version?.trim()) return c.json({ error: "source_version required" }, 400);
      try {
        return c.json(createRecipeBranch(c.req.param("slug"), {
          name: body.name.trim(),
          source_version: body.source_version.trim(),
        }), 201);
      } catch (error: any) {
        return c.json({ error: error?.message || "branch create failed" }, 400);
      }
    });

    api.get("/recipes/:slug/branches/:branch", (c) => {
      const recipe = getRecipeBranch(c.req.param("slug"), c.req.param("branch"));
      if (!recipe) return c.json({ error: "not found" }, 404);
      return c.json(recipe);
    });
  }

  api.get(`${prefix}/draft`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    if (!recipe.draft) return c.json({ error: "no draft" }, 404);
    return c.json(recipe.draft);
  });

  api.put(`${prefix}/draft`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    const baseline = recipe.draft || recipe.source_version || recipe.versions[0] || { cooklang_text: "", tags: "[]" };
    const nextText = body.cooklang_text ?? baseline.cooklang_text ?? "";
    const result = updateDraft(c.req.param("slug"), {
      cooklang_text: nextText,
      tags: body.tags ?? JSON.parse(baseline.tags || "[]"),
    }, {
      advance_beta: body.advance_beta === true,
    }, activeBranch(c));
    const unresolved = collectUnresolvedReferences(enrichRecipeReferences(parseCooklang(nextText)));
    return c.json({
      ...result,
      warnings: unresolved.length ? { unresolved_references: unresolved } : undefined,
    });
  });

  api.post(`${prefix}/draft/fork`, (c) => {
    try {
      return c.json(forkBranchHeadToDraft(c.req.param("slug"), activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "fork failed" }, 400);
    }
  });

  api.put(`${prefix}/draft/notes`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    updateDraftNotes(recipe.slug, body.notes || "", activeBranch(c));
    return c.json({ ok: true });
  });

  api.post(`${prefix}/draft/parse`, async (c) => {
    const body = await c.req.json();
    return c.json(enrichRecipeReferences(parseCooklang(body.cooklang_text || "")));
  });

  api.get(`${prefix}/versions`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    return c.json((recipe.versions || []).filter((version) => !version.is_draft));
  });

  api.get(`${prefix}/versions/:version`, (c) => {
    const version = getVersionByString(c.req.param("slug"), c.req.param("version"), activeBranch(c));
    if (!version) return c.json({ error: "version not found" }, 404);
    return c.json(version);
  });

  api.post(`${prefix}/versions/:version/fork`, (c) => {
    if (!getRecipeBySlug(c.req.param("slug"), activeBranch(c))) return c.json({ error: "not found" }, 404);
    try {
      forkVersionToDraft(c.req.param("slug"), c.req.param("version"), activeBranch(c));
    } catch (error: any) {
      return c.json({ error: error?.message || "version not found" }, 404);
    }
    return c.json({ ok: true });
  });

  api.put(`${prefix}/versions/:version`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const version = getVersionByString(recipe.slug, c.req.param("version"), activeBranch(c));
    if (!version) return c.json({ error: "version not found" }, 404);
    if (version.is_draft) return c.json({ error: "use draft endpoint" }, 400);
    const body = await c.req.json();
    updateVersionContent(
      recipe.slug,
      version.version_string!,
      body.cooklang_text ?? version.cooklang_text,
      body.tags ?? JSON.parse(version.tags || "[]"),
      activeBranch(c),
    );
    return c.json({ ok: true });
  });

  api.put(`${prefix}/versions/:version/notes`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    if (!getVersionByString(recipe.slug, c.req.param("version"), activeBranch(c))) return c.json({ error: "version not found" }, 404);
    const body = await c.req.json();
    updateVersionNotes(recipe.slug, c.req.param("version"), body.notes || "", activeBranch(c));
    return c.json({ ok: true });
  });

  api.delete(`${prefix}/versions/:version`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    try {
      deleteVersion(recipe.slug, c.req.param("version"), activeBranch(c));
    } catch (error: any) {
      const message = error?.message || "version not found";
      return c.json({ error: message }, message === "cannot delete draft" ? 400 : 404);
    }
    return c.json({ ok: true });
  });

  api.post(`${prefix}/release`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json();
    const { version_string, status, changelog, source_version } = body;
    if (!version_string?.trim()) return c.json({ error: "version_string required" }, 400);
    if (!["released", "beta", "archived"].includes(status)) return c.json({ error: "invalid status" }, 400);
    try {
      let result;
      let sourceText = "";
      if (source_version && source_version !== "draft") {
        result = releaseVersion(recipe.slug, source_version, {
          version_string: version_string.trim(),
          status,
          changelog,
        }, activeBranch(c));
        sourceText = recipe.versions.find((v) => v.version_string === source_version)?.cooklang_text || "";
      } else {
        result = releaseDraft(recipe.slug, {
          version_string: version_string.trim(),
          status,
          changelog,
        }, activeBranch(c));
        sourceText = recipe.draft?.cooklang_text || "";
      }
      const unresolved = collectUnresolvedReferences(enrichRecipeReferences(parseCooklang(sourceText)));
      return c.json({
        ...result,
        warnings: unresolved.length ? { unresolved_references: unresolved } : undefined,
      });
    } catch (error: any) {
      const message = error?.message || "release failed";
      return c.json({ error: message }, message === "version already exists" ? 409 : 400);
    }
  });

  api.get(`${prefix}/compare`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const fromStr = c.req.query("from");
    const toStr = c.req.query("to");
    if (!fromStr || !toStr) return c.json({ error: "from and to required" }, 400);
    const result = compareVersions(recipe, activeBranch(c), fromStr, toStr);
    if (!result) return c.json({ error: "version not found" }, 404);
    return c.json(result);
  });

  api.get(`${prefix}/images`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const version = c.req.query("version");
    try {
      return c.json(listRecipeImages(recipe.slug, version || null, activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "version not found" }, 404);
    }
  });

  api.post(`${prefix}/images`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const upload = await readImageUpload(c);
    if ("error" in upload) return c.json({ error: upload.error }, 400);
    try {
      return c.json(attachRecipeImage(recipe.slug, {
        filename: upload.file.name,
        mime_type: upload.file.type,
        data: upload.buffer,
        version_string: upload.version,
      }, activeBranch(c)), 201);
    } catch (error: any) {
      return c.json({ error: error?.message || "version not found" }, 404);
    }
  });

  api.get(`${prefix}/cook-logs`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    return c.json(listBranchCookLogs(recipe.slug, activeBranch(c)));
  });

  api.get(`${prefix}/versions/:version/cook-logs`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    return c.json(listVersionCookLogs(recipe.slug, c.req.param("version"), activeBranch(c)));
  });

  api.post(`${prefix}/cook-logs`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
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
      return c.json(createCookLog(recipe.slug, source, {
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
      const message = error?.message || "cook log create failed";
      return c.json({ error: message }, 400);
    }
  });

  // Back-compat shim: legacy version-scoped create. Forwards to the branch-scoped
  // handler with source = { kind: 'version', version_string: <route param> }.
  api.post(`${prefix}/versions/:version/cook-logs`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(createCookLog(recipe.slug, { kind: "version", version_string: c.req.param("version") }, {
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
      const message = error?.message || "cook log create failed";
      return c.json({ error: message }, 400);
    }
  });

  api.put(`${prefix}/cook-logs/:id`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(updateCookLog(recipe.slug, c.req.param("id"), {
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

  api.post(`${prefix}/cook-logs/:id/fork-to-draft`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    try {
      return c.json(forkCookLogToDraft(recipe.slug, c.req.param("id"), activeBranch(c)));
    } catch (error: any) {
      const message = error?.message || "fork to draft failed";
      return c.json({ error: message }, message === "cook log not found" ? 404 : 400);
    }
  });

  api.post(`${prefix}/cook-logs/:id/promote`, async (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const versionString = String(body?.version_string || "").trim();
    if (!versionString) return c.json({ error: "version_string required" }, 400);
    const status = body?.status === "beta" || body?.status === "archived" ? body.status : "released";
    try {
      return c.json(promoteCookLog(recipe.slug, c.req.param("id"), {
        version_string: versionString,
        status,
        changelog: body?.changelog || "",
      }, activeBranch(c)));
    } catch (error: any) {
      const message = error?.message || "promote failed";
      return c.json({ error: message }, message === "cook log not found" ? 404 : 400);
    }
  });

  api.delete(`${prefix}/cook-logs/:id`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    deleteCookLog(recipe.slug, c.req.param("id"), activeBranch(c));
    return c.json({ ok: true });
  });

  api.get(`${prefix}/backlinks`, (c) => {
    const recipe = getRecipeBySlug(c.req.param("slug"), activeBranch(c));
    if (!recipe) return c.json({ error: "not found" }, 404);
    return c.json(listBacklinks(recipe.slug));
  });

  api.post(`${prefix}/sync/preview`, (c) => {
    try {
      return c.json(previewBranchSync(c.req.param("slug"), activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "sync preview failed" }, 400);
    }
  });

  api.post(`${prefix}/sync/apply`, (c) => {
    try {
      return c.json(applyBranchSync(c.req.param("slug"), activeBranch(c)));
    } catch (error: any) {
      return c.json({ error: error?.message || "sync apply failed" }, 400);
    }
  });
}

installBranchRoutes("/recipes/:slug", true);
installBranchRoutes("/recipes/:slug/branches/:branch");

api.post("/recipes/:slug/thumbnail", async (c) => {
  const recipe = getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH);
  if (!recipe) return c.json({ error: "not found" }, 404);
  const upload = await readImageUpload(c);
  if ("error" in upload) return c.json({ error: upload.error }, 400);
  return c.json(setRecipeThumbnail(recipe.slug, {
    filename: upload.file.name,
    mime_type: upload.file.type,
    data: upload.buffer,
  }), 201);
});

api.delete("/recipes/:slug/thumbnail", (c) => {
  const recipe = getRecipeBySlug(c.req.param("slug"), MAIN_BRANCH);
  if (!recipe) return c.json({ error: "not found" }, 404);
  return c.json(setRecipeThumbnail(recipe.slug, null));
});

api.get("/images/:id", (c) => {
  const image = readRecipeImage(c.req.param("id"));
  if (!image) return c.json({ error: "not found" }, 404);
  return new Response(image.data, {
    headers: { "Content-Type": image.mime_type, "Cache-Control": "public, max-age=86400" },
  });
});

api.delete("/images/:id", (c) => {
  deleteRecipeImage(c.req.param("id"));
  return c.json({ ok: true });
});

export default api;
