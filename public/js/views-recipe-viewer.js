// ── Recipe viewer — body rendering, reading controls, version nav, settings ───
Object.assign(RecipeView, {

  recipeBodyHtml() {
    const parsed = this.parsed || { ingredients: [], ingredient_summary: emptyIngredientSummary(), steps: [], cookwares: [], metadata: {} };
    const version = this.activeVersion;
    const hasIngredients = parsed.ingredients?.length > 0;
    const hasSteps = parsed.steps?.length > 0;
    const hasCookware = parsed.cookwares?.length > 0;
    const hasSidebar = hasIngredients || hasCookware;
    const servings = parsed?.metadata?.servings || parsed?.metadata?.Servings || parsed?.metadata?.yield || '';
    const notes = normalizeNotes(parsed?.metadata?.notes || parsed?.metadata?.Notes || version?.notes || '');
    const notesLabel = version?.is_draft
      ? 'Draft notes'
      : `Notes for ${version?.version_string} (${version?.status})`;
    const photosLabel = version?.is_draft
      ? 'Draft photos'
      : `Photos for ${version?.version_string}`;
    const ingredientToggle = renderIngredientSummaryToggle(parsed, this.ingredientSummaryMode);
    const sidebarHtml = hasSidebar ? `
      <div class="recipe-sidebar">
        ${hasIngredients ? `
        <div class="sidebar-card">
          <div class="section-head">Ingredients</div>
          <div class="scale-control">
            <span class="scale-label">Scale:</span>
            <div class="scale-btns">
              <button class="scale-btn${this.scale === 0.5 ? ' active' : ''}" data-scale="0.5" onclick="RecipeView.setScale(0.5)">½×</button>
              <button class="scale-btn${this.scale === 1 ? ' active' : ''}" data-scale="1" onclick="RecipeView.setScale(1)">1×</button>
              <button class="scale-btn${this.scale === 2 ? ' active' : ''}" data-scale="2" onclick="RecipeView.setScale(2)">2×</button>
              <button class="scale-btn${this.scale === 3 ? ' active' : ''}" data-scale="3" onclick="RecipeView.setScale(3)">3×</button>
            </div>
            ${servings ? `<span class="text-muted" style="font-size:0.8rem">Serves ${escHtml(servings)}</span>` : ''}
          </div>
          ${ingredientToggle}
          <div id="ing-list">${CL.renderIngredientSummary(parsed.ingredient_summary, this.scale, {
            mode: this.ingredientSummaryMode,
          })}</div>
        </div>` : ''}
        ${hasCookware ? `
        <div class="sidebar-card">
          <div class="section-head">Equipment</div>
          ${CL.renderCookware(parsed.cookwares)}
        </div>` : ''}
      </div>` : '';
    const inlineAddNotes = !notes ? `<button class="notes-inline-add" onclick="RecipeView.openNotesModal()" title="Add notes">✎ Add notes</button>` : '';
    const stepsHtml = hasSteps ? `
      <div class="recipe-main">
        <div class="section-head" id="steps-head">
          <span class="section-head-title">Steps</span>
          <div class="steps-toolbar">
            <button class="btn btn-sm" id="amounts-btn" onclick="RecipeView.toggleAmounts()">
              ${this.showAmounts ? '✓ Hide amounts' : '⊕ Show amounts'}
            </button>
            <button class="btn btn-sm" id="temp-btn" onclick="RecipeView.toggleTemperatureUnit()">
              Temps: °${this.temperatureUnit}
            </button>
            <button class="btn btn-sm" id="cook-btn" onclick="RecipeView.toggleCookMode()">
              ${this.cookMode ? '✓ Exit cook mode' : '▶ Cook mode'}
            </button>
            ${inlineAddNotes}
          </div>
        </div>
        <div id="steps-list">${CL.renderSteps(parsed.steps, this.scale, this.cookMode, parsed.metadata, this.showAmounts, {
          temperatureUnit: this.temperatureUnit,
        })}</div>
      </div>` : '';

    const metricsHtml = CL.renderMetrics(parsed.metrics);
    return `
      ${metricsHtml}
      ${notes ? `
        <div class="notes-card">
          <div class="notes-actions">
            <div class="section-head notes-head">${escHtml(notesLabel)}</div>
            <button class="btn btn-sm" onclick="RecipeView.openNotesModal()">Edit notes</button>
          </div>
          <div class="notes-box recipe-notes-display">${formatMultilineText(notes)}</div>
        </div>` : ''}
      ${hasSidebar || hasSteps ? `
        <div class="recipe-grid${!hasSidebar ? ' no-sidebar' : ''}">
          ${sidebarHtml}
          ${stepsHtml}
        </div>` : ''}
      ${!hasIngredients && !hasSteps ? `
        <div class="empty-state" style="padding:32px 0">
          <p>This version is empty. <button class="btn btn-sm" onclick="RecipeView.setTab('editor')">Open Editor →</button></p>
        </div>` : ''}
      <div class="media-strip-card">
        <div class="media-strip-head">
          <div>
            <div class="section-head notes-head">${escHtml(photosLabel)}</div>
            <div class="media-strip-meta">${this.images.length} photo${this.images.length === 1 ? '' : 's'}</div>
          </div>
          <div class="media-strip-actions">
            <button class="btn btn-sm" onclick="document.getElementById('img-file').click()">${this.images.length ? 'Add photo' : 'Upload photo'}</button>
            ${this.images.length ? `<button class="btn btn-sm btn-ghost" onclick="RecipeView.togglePhotosExpanded()">${this.photosToggleLabel()}</button>` : ''}
          </div>
        </div>
        <div id="img-section"></div>
      </div>`;
  },

  renderHeaderThumbnail() {
    const slot = document.getElementById('header-thumb-slot');
    if (!slot) return;
    if (this.recipe?.thumbnail_image_id) {
      slot.innerHTML = `
        <div class="header-thumb-card">
          <img class="header-thumb-image" src="/api/images/${this.recipe.thumbnail_image_id}" alt="${escHtml(this.recipe.title)}" loading="lazy" />
        </div>`;
    } else {
      slot.innerHTML = `
        <div class="header-thumb-card header-thumb-card-empty" aria-hidden="true">
          <span class="header-thumb-glyph">🍽</span>
        </div>`;
    }
  },

  openNotesModal() {
    const version = this.activeVersion;
    const notes = normalizeNotes(this.parsed?.metadata?.notes || this.parsed?.metadata?.Notes || version?.notes || '');
    const title = version?.is_draft ? 'Edit draft notes' : `Edit notes for ${version?.version_string}`;
    showModal(`
      <div class="modal-title">${escHtml(title)}</div>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:12px">
        ${version?.is_draft ? 'These notes apply to the current draft.' : 'These notes update the currently selected version directly.'}
      </p>
      <textarea id="notes-modal-text" class="editor-textarea" style="min-height:180px">${escHtml(notes)}</textarea>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.saveNotes()">Save notes</button>
      </div>`);
  },

  async saveNotes() {
    const notes = document.getElementById('notes-modal-text')?.value ?? '';
    const path = this.activeVersion?.is_draft
      ? `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/draft/notes`
      : `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(this.activeVersion.version_string)}/notes`;
    try {
      await API.put(path, { notes });
      const selected = this.selectedVersionKey();
      await this.refreshRecipe();
      await this.renderDetail(document.getElementById('view-container'), selected, { syncUrl: true, replaceUrl: true });
      closeModal();
      showToast('Notes saved');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  setScale(s) {
    this.scale = s;
    document.querySelectorAll('.scale-btn').forEach((button) => {
      button.classList.toggle('active', parseFloat(button.dataset.scale) === s);
    });
    const ingList = document.getElementById('ing-list');
    if (ingList && this.parsed) {
      ingList.innerHTML = CL.renderIngredientSummary(this.parsed.ingredient_summary, s, { mode: this.ingredientSummaryMode });
    }
    const stepsList = document.getElementById('steps-list');
    if (stepsList && this.parsed) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, s, this.cookMode, this.parsed.metadata, this.showAmounts, { temperatureUnit: this.temperatureUnit });
    }
  },

  setIngredientSummaryMode(mode) {
    const nextMode = resolveIngredientSummaryMode(this.draftPreviewState || this.parsed, mode);
    if (nextMode === this.ingredientSummaryMode) return;
    this.ingredientSummaryMode = nextMode;
    if (document.body.classList.contains('print-route')) {
      Router.dispatch(location.pathname + location.search);
      return;
    }
    if (this.activeTab === 'overview') { this.renderTab(); return; }
    if (this.activeTab === 'editor') this.updatePreview();
  },

  toggleCookMode() {
    this.cookMode = !this.cookMode;
    const button = document.getElementById('cook-btn');
    if (button) button.textContent = this.cookMode ? '✓ Exit cook mode' : '▶ Cook mode';
    const stepsList = document.getElementById('steps-list');
    if (stepsList && this.parsed) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, this.scale, this.cookMode, this.parsed.metadata, this.showAmounts, { temperatureUnit: this.temperatureUnit });
    }
  },

  toggleAmounts() {
    this.showAmounts = !this.showAmounts;
    const button = document.getElementById('amounts-btn');
    if (button) button.textContent = this.showAmounts ? '✓ Hide amounts' : '⊕ Show amounts';
    const stepsList = document.getElementById('steps-list');
    if (stepsList && this.parsed) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, this.scale, this.cookMode, this.parsed.metadata, this.showAmounts, { temperatureUnit: this.temperatureUnit });
    }
  },

  toggleTemperatureUnit() {
    this.temperatureUnit = this.temperatureUnit === 'F' ? 'C' : 'F';
    const button = document.getElementById('temp-btn');
    if (button) button.textContent = `Temps: °${this.temperatureUnit}`;
    const stepsList = document.getElementById('steps-list');
    if (stepsList && this.parsed) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, this.scale, this.cookMode, this.parsed.metadata, this.showAmounts, { temperatureUnit: this.temperatureUnit });
    }
  },

  editIngredientQty(el) {
    const orig = parseFloat(el.dataset.orig);
    if (isNaN(orig) || orig === 0) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ing-qty-input';
    input.value = el.textContent.trim().split(/\s/)[0];
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
    const finish = (apply) => {
      if (apply) {
        const val = parseFloat(input.value);
        if (!isNaN(val) && val > 0) { this.setScale(val / orig); return; }
      }
      this.setScale(this.scale);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(false));
  },

  async switchVersion(value) {
    // Remember the explicit pick so tab renderers (overview, editor) don't
    // override activeVersion back to their default.
    this.explicitVersionRequest = value || null;
    await this.renderDetail(document.getElementById('view-container'), value, { syncUrl: true });
  },

  async switchBranch(value) {
    this.branchSlug = value || 'main';
    this.activeVersion = null;
    this.explicitVersionRequest = null;
    await this.refreshRecipe();
    await this.renderDetail(document.getElementById('view-container'), null, { syncUrl: true });
  },

  async viewVersion(versionString) {
    await this.switchVersion(versionString);
    this.setTab('overview');
  },

  async forkVersionAndEdit(versionString) {
    try {
      const target = versionString || this.activeVersion?.version_string;
      if (!target) { showToast('No version to fork'); return; }
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(target)}/fork`, {});
      await this.refreshRecipe();
      this.activeTab = 'editor';
      await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
      showToast('Forked to draft');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async forkVersion() {
    return this.forkVersionAndEdit(this.activeVersion?.version_string);
  },

  async startNextBetaFrom(versionString) {
    await this.forkVersionAndEdit(versionString);
  },

  async forkCurrentBranchHead() {
    try {
      if (this.activeVersion?.version_string && !this.activeVersion?.is_inherited_source) {
        await this.forkVersion();
        return;
      }
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/draft/fork`, {});
      await this.refreshRecipe();
      this.activeTab = 'editor';
      await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
      showToast('Forked to draft');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async startFreshDraft() {
    if (this.recipe.current_best_release) { await this.forkCurrentBranchHead(); return; }
    this.activeTab = 'editor';
    this.activeVersion = this.recipe.draft;
    await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
  },

  openPrintView() {
    Router.go(this.printPathFor());
  },

  // ── Settings modal ───────────────────────────────────────────────────────────

  openSettingsModal() {
    const recipe = this.recipe;
    const thumb = recipe.thumbnail_image_id
      ? `<img class="settings-thumb-image" src="/api/images/${recipe.thumbnail_image_id}" alt="${escHtml(recipe.title)}" />`
      : `<div class="settings-thumb-empty">No thumbnail set</div>`;
    showModal(`
      <div class="modal-title">Recipe menu</div>
      <div class="settings-actions">
        <button class="btn" onclick="closeModal(); RecipeView.openPrintView()">🖨 Print recipe</button>
      </div>
      <div class="field-group mt8">
        <label class="field-label" for="settings-title">Recipe title</label>
        <input id="settings-title" class="field-input" value="${escHtml(recipe.title)}" />
      </div>
      <div class="modal-actions" style="justify-content:flex-start;margin-top:12px">
        <button class="btn btn-primary" onclick="RecipeView.saveSettings()">Save title</button>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Thumbnail</div>
        <div class="settings-thumb-row">
          ${thumb}
          <div class="settings-thumb-actions">
            <button class="btn btn-sm" onclick="document.getElementById('settings-thumb-file').click()">${recipe.thumbnail_image_id ? 'Replace' : 'Upload'}</button>
            ${recipe.thumbnail_image_id ? `<button class="btn btn-sm btn-ghost" onclick="RecipeView.deleteThumbnail()">Remove</button>` : ''}
          </div>
        </div>
        <input type="file" id="settings-thumb-file" accept="image/*" style="display:none" onchange="RecipeView.uploadThumbnail(this)" />
      </div>
      <div class="settings-section settings-danger">
        <div class="settings-section-title">Danger zone</div>
        <p class="text-muted" style="font-size:0.85rem;margin-bottom:8px">Deleting removes the recipe, all versions, photos, and cook logs.</p>
        <button class="btn btn-danger" onclick="RecipeView.deleteRecipe()">Delete recipe</button>
      </div>
      <div class="modal-actions" style="margin-top:18px">
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
      </div>`);
    setTimeout(() => document.getElementById('settings-title')?.select(), 80);
  },

  async saveSettings() {
    const title = document.getElementById('settings-title')?.value.trim();
    if (!title) return;
    try {
      const res = await API.put(`/recipes/${this.slug}`, { title });
      showToast('Saved');
      if (res.slug && res.slug !== this.slug) {
        this.slug = res.slug;
        Router.go(this.recipePathFor(), true);
        return;
      }
      await this.refreshRecipe();
      this.renderScaffold(document.getElementById('view-container'));
      this.renderHeaderThumbnail();
      this.renderTab();
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async deleteRecipe() {
    if (!confirm(`Delete "${this.recipe.title}"? This cannot be undone.`)) return;
    try {
      await API.delete(`/recipes/${this.slug}`);
      showToast('Recipe deleted');
      Router.go('/');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

});
