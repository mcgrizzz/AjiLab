// ── View: Print ───────────────────────────────────────────────────────────────
// Shows the sheet with its options; only the Print button opens the
// browser's print dialog. Every sheet is stamped with what it is, and each
// print is recorded so "Record a cook" can start from it. The working copy
// isn't a fixed sheet: it's saved as a test first.
const PrintView = {
  // Screen-only choices; they shape what goes on paper.
  options: { photo: false, notes: true },
  // The sheet on screen: { slug, branch, version_string, scale }, or null for
  // the working copy (which can't be printed as is).
  sheet: null,

  // Called on the browser's beforeprint (the Print button, Ctrl+P, the
  // browser menu): one record per sheet, scale and day.
  recordPrint() {
    const sheet = this.sheet;
    if (!sheet || !document.body.classList.contains('print-route')) return;
    // How the amounts were shown, so the cook screen can show the same.
    const display = { temp: RecipeView.temperatureUnit || 'F', units: { ...RecipeView.unitView(sheet.slug).overrides } };
    API.post(`/recipes/${sheet.slug}/branches/${encodeURIComponent(sheet.branch)}/prints`, {
      version: sheet.version_string, scale: sheet.scale, display,
    }).catch(() => {});
  },

  // The working copy: save it as the next test, then print that.
  async saveTestAndPrint(slug, branch, scale) {
    const input = document.getElementById('print-testing');
    const button = document.getElementById('print-save-test');
    if (button) button.disabled = true;
    try {
      const saved = await API.post(`/recipes/${slug}/branches/${encodeURIComponent(branch)}/tests`, { testing: input?.value.trim() || '' });
      const params = new URLSearchParams({ version: saved.version_string });
      if (branch !== 'main') params.set('branch', branch);
      if (scale !== 1) params.set('scale', String(scale));
      await Router.go(`/recipe/${slug}/print?${params.toString()}`, true);
      showToast(saved.created ? `Saved ${saved.label}` : `No changes since ${saved.label}`);
      triggerPrint();
    } catch (e) {
      if (button) button.disabled = false;
      showToast('Error: ' + e.message);
    }
  },

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
      // A working copy with nothing of its own prints the sheet it matches.
      if (version?.is_draft && !recipe.has_unreleased_changes) {
        const byString = (key) => key && (recipe.versions || []).find((v) => v.version_string === key);
        const same = [version.current_beta_version, version.parent_version].map(byString).find((v) => v && v.cooklang_text === version.cooklang_text)
          || byString(version.current_beta_version) || byString(version.parent_version) || recipe.current_version;
        if (same) version = same;
      }
      if (!version) version = recipe.current_version || recipe.open_tests?.[0] || recipe.draft || recipe.source_version;
      const parsed = version?.cooklang_text
        ? await API.post(`/recipes/${slug}/draft/parse`, { cooklang_text: version.cooklang_text })
        : { ingredients: [], ingredient_summary: emptyIngredientSummary(), steps: [], cookwares: [], metadata: {} };
      const ingredientSummaryMode = resolveIngredientSummaryMode(parsed, RecipeView.ingredientSummaryMode);
      const scale = parseFloat(opts.scale) > 0 ? parseFloat(opts.scale) : 1;
      const images = await API.get(`/recipes/${slug}/branches/${encodeURIComponent(branch)}/images`);
      const notes = normalizeNotes(parsed?.metadata?.notes || parsed?.metadata?.Notes || version?.notes || '');
      const servings = parsed?.metadata?.servings || parsed?.metadata?.Servings || parsed?.metadata?.yield || '';
      const isDraft = !!version?.is_draft;
      this.sheet = isDraft || !version?.version_string ? null : { slug, branch, version_string: version.version_string, scale };
      // The stamp, "v1.0 · Test 4 — more water · 2× · printed Nov 2, 2026",
      // ties the paper to the version or test it was cooked from.
      const label = version?.label || version?.version_string || '';
      const sheet = isDraft
        ? 'Working copy (not a saved test)'
        : version?.kind === 'test'
          ? `${label}${version.testing ? ` — ${version.testing}` : ''}`
          : `${label}${version?.is_current || !recipe.current_version ? '' : ' (not current)'}`;
      const meta = [
        sheet,
        scale !== 1 ? `${roundScale(scale)}×` : null,
        branch !== 'main' ? `branch ${branch}` : null,
        isDraft ? `edited ${fmtDate(version.updated_at)}` : `printed ${fmtDate(new Date().toISOString())}`,
      ].filter(Boolean);
      // What to look for when recording the cook.
      const footer = isDraft ? '' : `Record this cook in AjiLab as: ${recipe.title} · ${label}${scale !== 1 ? ` · ${roundScale(scale)}×` : ''}`;
      const number = recipe.next_test_label;
      const printAction = isDraft
        ? `<div class="print-save-test">
            <span class="print-save-test-note">The working copy changes as you edit. Save it as ${escHtml(number)} so the paper matches what you record.</span>
            <input id="print-testing" class="field-input" placeholder="What are you testing? e.g. more water" maxlength="120" value="${escHtml(version.testing || '')}" aria-label="What are you testing?" />
            <button id="print-save-test" class="btn btn-sm btn-primary" onclick="PrintView.saveTestAndPrint('${escJs(slug)}', '${escJs(branch)}', ${scale})">Save as ${escHtml(number)} and print</button>
          </div>`
        : `<button class="btn btn-sm btn-primary" onclick="triggerPrint()">Print</button>`;
      const classes = ['print-view'];
      if (this.options.photo) classes.push('print-with-photo');
      if (this.options.notes) classes.push('print-with-notes');
      container.innerHTML = `
        <div class="${classes.join(' ')}">
          <div class="print-actions">
            <button class="btn btn-sm" onclick="Router.go('${escJs(recipePathForSelection(slug, version, branch, scale))}', true)">Back</button>
            ${this.optionsHtml(scale)}
            ${isDraft ? '' : printAction}
          </div>
          ${isDraft ? printAction : ''}
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
          ${footer ? `<div class="print-footer">${escHtml(footer)}</div>` : ''}
          </article>
        </div>`;
    } catch (e) {
      this.sheet = null;
      container.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
    }
  },
};

window.addEventListener('beforeprint', () => PrintView.recordPrint());
