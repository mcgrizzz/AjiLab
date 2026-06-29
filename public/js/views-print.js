// ── View: Print ───────────────────────────────────────────────────────────────
const PrintView = {
  async render(container, slug, opts = {}) {
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const branch = opts.branch || 'main';
      const recipe = await API.get(`/recipes/${slug}/branches/${encodeURIComponent(branch)}`);
      let version = recipe.draft;
      if (opts.version && opts.version !== 'draft') {
        try {
          version = await API.get(`/recipes/${slug}/branches/${encodeURIComponent(branch)}/versions/${opts.version}`);
        } catch {}
      }
      if (!version) {
        const fallback = recipe.latest_released || recipe.latest_beta;
        version = fallback
          ? await API.get(`/recipes/${slug}/branches/${encodeURIComponent(branch)}/versions/${fallback}`)
          : (recipe.draft || recipe.source_version);
      }
      const parsed = version?.cooklang_text
        ? await API.post(`/recipes/${slug}/draft/parse`, { cooklang_text: version.cooklang_text })
        : { ingredients: [], ingredient_summary: emptyIngredientSummary(), steps: [], cookwares: [], metadata: {} };
      const ingredientSummaryMode = resolveIngredientSummaryMode(parsed, RecipeView.ingredientSummaryMode);
      const scale = parseFloat(opts.scale) > 0 ? parseFloat(opts.scale) : 1;
      const images = await API.get(`/recipes/${slug}/branches/${encodeURIComponent(branch)}/images`);
      const notes = normalizeNotes(parsed?.metadata?.notes || parsed?.metadata?.Notes || version?.notes || '');
      const servings = parsed?.metadata?.servings || parsed?.metadata?.Servings || parsed?.metadata?.yield || '';
      container.innerHTML = `
        <div class="print-view">
          <div class="print-actions">
            <button class="btn btn-sm" onclick="Router.go('${escJs(recipePathForSelection(slug, version, branch, scale))}', true)">Back</button>
            <button class="btn btn-sm btn-primary" onclick="triggerPrint()">Print</button>
          </div>
          ${images[0] ? `<img class="print-hero-img" src="/api/images/${images[0].id}" alt="${escHtml(recipe.title)}" />` : ''}
          <h1 class="print-title">${escHtml(recipe.title)}</h1>
          <div class="print-meta">
            <span>${version?.is_draft ? 'Draft' : escHtml(version.version_string)}</span>
            <span>${version?.is_draft ? 'draft' : escHtml(version.status)}</span>
            <span>${fmtDate(version?.updated_at || version?.created_at)}</span>
          </div>
          ${servings ? `<div class="print-servings">Serves ${escHtml(servings)}</div>` : ''}
          ${CL.renderMetrics(parsed.metrics)}
          ${parsed.ingredients?.length ? `<div class="section-head">Ingredients</div>${CL.renderIngredientSummary(parsed.ingredient_summary, scale, { mode: ingredientSummaryMode })}` : ''}
          ${parsed.steps?.length ? `<div class="section-head mt16">Steps</div>${CL.renderSteps(parsed.steps, scale, parsed.metadata, true, {
            temperatureUnit: RecipeView.temperatureUnit,
          })}` : ''}
          ${notes ? `<div class="section-head mt16 print-notes-title">Notes</div><div class="notes-box print-notes">${formatMultilineText(notes)}</div>` : ''}
        </div>`;
      await triggerPrint(container);
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
    }
  },
};
