// ── View: Print ───────────────────────────────────────────────────────────────
// Shows the sheet with its options; only the Print button opens the
// browser's print dialog.
const PrintView = {
  // Screen-only choices; they shape what goes on paper.
  options: { photo: false, notes: true },

  // Scale changes the amounts, so it re-renders through the URL.
  setScale(value) {
    const params = new URLSearchParams(location.search);
    if (value === 1) params.delete('scale'); else params.set('scale', String(value));
    Router.go(`${location.pathname}?${params.toString()}`, true);
  },

  setTemperature(unit) {
    RecipeView.temperatureUnit = unit;
    Router.dispatch(location.pathname + location.search);
  },

  toggle(name, on) {
    this.options[name] = on;
    document.querySelector('.print-view')?.classList.toggle(`print-with-${name}`, on);
  },

  optionsHtml(scale) {
    const scales = [0.5, 1, 2, 3];
    const temp = RecipeView.temperatureUnit || 'F';
    return `<div class="print-options" role="group" aria-label="Print options">
      <span class="print-option">
        <span class="print-option-label">Scale</span>
        ${scales.map((v) => `<button type="button" class="scale-btn${v === scale ? ' active' : ''}" aria-pressed="${v === scale}" onclick="PrintView.setScale(${v})">${v === 0.5 ? '½' : v}×</button>`).join('')}
        ${scales.includes(scale) ? '' : `<span class="scale-btn active">${roundScale(scale)}×</span>`}
      </span>
      <span class="print-option">
        <span class="print-option-label">Temps</span>
        ${['F', 'C'].map((u) => `<button type="button" class="scale-btn${u === temp ? ' active' : ''}" aria-pressed="${u === temp}" onclick="PrintView.setTemperature('${u}')">°${u}</button>`).join('')}
      </span>
      <label class="print-option"><input type="checkbox" ${this.options.photo ? 'checked' : ''} onchange="PrintView.toggle('photo', this.checked)" /> Photo</label>
      <label class="print-option"><input type="checkbox" ${this.options.notes ? 'checked' : ''} onchange="PrintView.toggle('notes', this.checked)" /> Notes</label>
    </div>`;
  },

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
      // "v1.1-beta.1 · beta · 2× · Oct 31, 2026": ties a printed sheet to
      // the version (and cook log) it was cooked from.
      const meta = [
        version?.is_draft ? 'Draft' : version.version_string,
        version?.is_draft ? null : version.status,
        scale !== 1 ? `${roundScale(scale)}×` : null,
        branch !== 'main' ? `branch ${branch}` : null,
        fmtDate(version?.updated_at || version?.created_at),
      ].filter(Boolean);
      const classes = ['print-view'];
      if (this.options.photo) classes.push('print-with-photo');
      if (this.options.notes) classes.push('print-with-notes');
      container.innerHTML = `
        <div class="${classes.join(' ')}">
          <div class="print-actions">
            <button class="btn btn-sm" onclick="Router.go('${escJs(recipePathForSelection(slug, version, branch, scale))}', true)">Back</button>
            ${this.optionsHtml(scale)}
            <button class="btn btn-sm btn-primary" onclick="triggerPrint()">Print</button>
          </div>
          <article class="print-sheet">
          ${images[0] ? `<img class="print-hero-img" src="/api/images/${images[0].id}" alt="${escHtml(recipe.title)}" />` : ''}
          <h1 class="print-title">${escHtml(recipe.title)}</h1>
          <div class="print-meta">${meta.map((m) => `<span>${escHtml(m)}</span>`).join('<span aria-hidden="true">·</span>')}</div>
          ${servings ? `<div class="print-servings">Serves ${escHtml(servings)}</div>` : ''}
          ${CL.renderMetrics(parsed.metrics)}
          ${parsed.ingredients?.length ? `<div class="section-head">Ingredients</div>${CL.renderIngredientSummary(parsed.ingredient_summary, scale, { mode: ingredientSummaryMode, units: RecipeView.unitView(slug) })}` : ''}
          ${parsed.steps?.length ? `<div class="section-head mt16">Steps</div>${CL.renderSteps(parsed.steps, scale, parsed.metadata, true, {
            temperatureUnit: RecipeView.temperatureUnit,
            units: RecipeView.unitView(slug),
          })}` : ''}
          ${notes ? `<div class="print-notes-block"><div class="section-head mt16 print-notes-title">Notes</div><div class="notes-box print-notes">${formatMultilineText(notes)}</div></div>` : ''}
          </article>
        </div>`;
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
    }
  },
};
