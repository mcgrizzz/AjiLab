import * as Diff from "diff";
import { Hono } from "hono";
import { parseCooklang } from "./cooklang.js";
import { diffIngredients } from "./ingredient-compare.js";
import {
  applyBranchSync,
  attachRecipeImage,
  createRecipe,
  createRecipeBranch,
  deleteRecipe,
  deleteRecipeImage,
  deleteVersion,
  forkBranchHeadToDraft,
  forkVersionToDraft,
  getRecipeBranch,
  getRecipeBySlug,
  getVersionByString,
  listRecipeBranches,
  listRecipeImages,
  listRecipes,
  previewBranchSync,
  readRecipeImage,
  releaseDraft,
  releaseVersion,
  setRecipeThumbnail,
  updateDraft,
  updateDraftNotes,
  updateRecipeTitle,
  updateVersionContent,
  updateVersionNotes,
} from "./recipe-store.js";

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

function compareVersions(recipe: any, fromStr: string, toStr: string) {
  const getVersion = (vs: string) => vs === "draft"
    ? recipe.draft
    : recipe.versions.find((version: any) => version.version_string === vs);
  const fromV = getVersion(fromStr) as any;
  const toV = getVersion(toStr) as any;
  if (!fromV || !toV) return null;

  const textDiff = Diff.createTwoFilesPatch(fromStr, toStr, fromV.cooklang_text || "", toV.cooklang_text || "", "", "", { context: 3 });
  const fromParsed = parseCooklang(fromV.cooklang_text || "");
  const toParsed = parseCooklang(toV.cooklang_text || "");

  return {
    from: { version: fromStr, status: fromV.status },
    to: { version: toStr, status: toV.status },
    text_diff: textDiff,
    ingredient_diff: diffIngredients(fromParsed.ingredients, toParsed.ingredients),
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
    const result = updateDraft(c.req.param("slug"), {
      cooklang_text: body.cooklang_text ?? baseline.cooklang_text ?? "",
      tags: body.tags ?? JSON.parse(baseline.tags || "[]"),
    }, {
      advance_beta: body.advance_beta === true,
    }, activeBranch(c));
    return c.json(result);
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
    return c.json(parseCooklang(body.cooklang_text || ""));
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
      if (source_version && source_version !== "draft") {
        return c.json(releaseVersion(recipe.slug, source_version, {
          version_string: version_string.trim(),
          status,
          changelog,
        }, activeBranch(c)));
      }
      return c.json(releaseDraft(recipe.slug, {
        version_string: version_string.trim(),
        status,
        changelog,
      }, activeBranch(c)));
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
    const result = compareVersions(recipe, fromStr, toStr);
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
