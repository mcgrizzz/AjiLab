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
              <input class="scale-custom-input${[0.5, 1, 2, 3].includes(this.scale) ? '' : ' active'}" type="number" min="0" step="0.25"
                value="${[0.5, 1, 2, 3].includes(this.scale) ? '' : roundScale(this.scale)}" placeholder="…×" title="Custom multiplier"
                onchange="RecipeView.setScaleCustom(this.value)"
                onkeydown="if(event.key==='Enter'){event.preventDefault();RecipeView.setScaleCustom(this.value);this.blur();}" />
            </div>
            ${servings ? `<span class="text-muted" style="font-size:0.8rem">Serves ${escHtml(servings)}</span>` : ''}
          </div>
          <div id="unit-control">${this.unitControlHtml()}</div>
          ${ingredientToggle}
          <div id="ing-list">${CL.renderIngredientSummary(parsed.ingredient_summary, this.scale, {
            mode: this.ingredientSummaryMode,
            units: this.unitView(),
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
            <button class="btn btn-sm" id="amounts-btn" onclick="RecipeView.toggleAmounts()" aria-pressed="${this.showAmounts}">
              Amounts in steps: ${this.showAmounts ? 'On' : 'Off'}
            </button>
            <button class="btn btn-sm" id="temp-btn" onclick="RecipeView.toggleTemperatureUnit()">
              Temps: °${this.temperatureUnit}
            </button>
            ${inlineAddNotes}
          </div>
        </div>
        <div id="steps-list">${CL.renderSteps(parsed.steps, this.scale, parsed.metadata, this.showAmounts, this.stepRenderOptions())}</div>
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
    this.syncVersionUrl(true);
    document.querySelectorAll('.scale-btn').forEach((button) => {
      button.classList.toggle('active', parseFloat(button.dataset.scale) === s);
    });
    const customInput = document.querySelector('.scale-custom-input');
    if (customInput && document.activeElement !== customInput) {
      const isPreset = [0.5, 1, 2, 3].includes(s);
      customInput.classList.toggle('active', !isPreset);
      customInput.value = isPreset ? '' : roundScale(s);
    }
    this.rerenderAmounts();
  },

  // Re-render everything that shows amounts (scale, unit or toggle changes).
  rerenderAmounts() {
    if (!this.parsed) return;
    const ingList = document.getElementById('ing-list');
    if (ingList) {
      ingList.innerHTML = CL.renderIngredientSummary(this.parsed.ingredient_summary, this.scale, {
        mode: this.ingredientSummaryMode,
        units: this.unitView(),
      });
    }
    const stepsList = document.getElementById('steps-list');
    if (stepsList) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, this.scale, this.parsed.metadata, this.showAmounts, this.stepRenderOptions());
    }
    const unitControl = document.getElementById('unit-control');
    if (unitControl) unitControl.innerHTML = this.unitControlHtml();
  },

  stepRenderOptions() {
    return { temperatureUnit: this.temperatureUnit, units: this.unitView() };
  },

  // ── Unit preferences ──
  // System choice (as written / metric / US) per category is a per-browser
  // preference; per-ingredient overrides ("show the cream in fl oz") come from
  // click-to-scale and last until a different recipe is opened.
  unitView(slug = this.slug) {
    if (!this.unitPrefs) this.unitPrefs = Units.loadPrefs();
    const overrides = this.unitOverrides?.slug === slug ? this.unitOverrides.map : {};
    return { volume: this.unitPrefs.volume, mass: this.unitPrefs.mass, overrides };
  },

  unitControlHtml() {
    const parsed = this.parsed;
    const categories = Units.categoriesIn(parsed?.ingredient_summary?.flat || parsed?.ingredients);
    if (!categories.size) return '';
    const view = this.unitView();
    const select = (category, label) => {
      if (!categories.has(category)) return '';
      const options = [['asis', 'As written'], ['metric', 'Metric'], ['us', 'US']]
        .map(([value, text]) => `<option value="${value}"${view[category] === value ? ' selected' : ''}>${text}</option>`)
        .join('');
      return `<label class="unit-select-label"><span class="unit-select-name">${label}</span>
        <select class="unit-select" onchange="RecipeView.setUnitSystem('${category}', this.value)">${options}</select>
      </label>`;
    };
    const hasOverrides = Object.keys(view.overrides).length > 0;
    return `<div class="unit-control">
      ${select('volume', 'Volume')}
      ${select('mass', 'Weight')}
      ${hasOverrides ? `<button class="btn btn-sm unit-reset-btn" onclick="RecipeView.clearUnitOverrides()" title="Undo per-ingredient units you typed">Reset units</button>` : ''}
    </div>`;
  },

  setUnitSystem(category, system) {
    if (!this.unitPrefs) this.unitPrefs = Units.loadPrefs();
    this.unitPrefs[category] = system;
    Units.savePrefs(this.unitPrefs);
    // Picking a system for a category supersedes per-ingredient overrides in it.
    const map = this.unitOverrides?.slug === this.slug ? this.unitOverrides.map : null;
    if (map) {
      for (const [name, unitKey] of Object.entries(map)) {
        if (Units.UNITS[unitKey]?.category === category) delete map[name];
      }
    }
    this.rerenderAmounts();
  },

  setUnitOverride(name, unitKey) {
    if (this.unitOverrides?.slug !== this.slug) this.unitOverrides = { slug: this.slug, map: {} };
    this.unitOverrides.map[Units.overrideKey(name)] = unitKey;
  },

  clearUnitOverrides() {
    this.unitOverrides = { slug: this.slug, map: {} };
    this.rerenderAmounts();
  },

  setScaleCustom(value) {
    const val = parseFloat(value);
    if (isNaN(val) || val <= 0) { this.setScale(this.scale); return; }
    this.setScale(val);
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

  toggleAmounts() {
    this.showAmounts = !this.showAmounts;
    const button = document.getElementById('amounts-btn');
    if (button) {
      button.textContent = `Amounts in steps: ${this.showAmounts ? 'On' : 'Off'}`;
      button.setAttribute('aria-pressed', String(this.showAmounts));
    }
    this.rerenderAmounts();
  },

  toggleTemperatureUnit() {
    this.temperatureUnit = this.temperatureUnit === 'F' ? 'C' : 'F';
    const button = document.getElementById('temp-btn');
    if (button) button.textContent = `Temps: °${this.temperatureUnit}`;
    this.rerenderAmounts();
  },

  // Click-to-scale: type the amount you want of this ingredient, optionally in
  // another unit ("16 fl oz" against "1 L"). The recipe scales to match and
  // that ingredient keeps showing the unit you typed.
  editIngredientQty(el) {
    const orig = Units.parseQuantity(el.dataset.orig)?.[0];
    if (!(orig > 0)) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ing-qty-input';
    input.value = el.textContent.trim();
    el.textContent = '';
    el.appendChild(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (apply) => {
      if (done) return;
      done = true;
      if (apply) {
        const result = Units.scaleForTarget(orig, el.dataset.unit, el.dataset.shownUnit, Units.parseAmount(input.value));
        if (result.error) {
          showToast(result.error);
        } else {
          if (result.unitKey) this.setUnitOverride(el.dataset.name, result.unitKey);
          this.setScale(result.scale);
          return;
        }
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

  // ── Replacing the draft (fork a version / branch head / cook log) ──
  // These actions overwrite the one draft. Work is at risk when the draft (or
  // the editor's unsaved buffer) holds text that isn't saved in any version;
  // then we ask first. Either way the old draft is kept for an Undo toast.

  versionText(versionString) {
    return (this.recipe?.versions || []).find((v) => !v.is_draft && v.version_string === versionString)?.cooklang_text ?? null;
  },

  // Label for buttons that load a version into the draft.
  draftFromVersionLabel(versionString) {
    return this.draftAtRisk(this.versionText(versionString))
      ? `Replace draft with ${versionString}…`
      : `Start draft from ${versionString}`;
  },

  draftAtRisk(targetText = null) {
    let storage = null;
    try { storage = window.localStorage; } catch {}
    const local = RecipeEditState.unsavedValue(RecipeEditState.draftKey(this.slug, this.branchSlug), storage);
    const text = local ? local.text : (this.recipe?.draft?.cooklang_text || '');
    if (!text.trim() || text === targetText) return false;
    return !(this.recipe?.versions || []).some((v) => !v.is_draft && v.cooklang_text === text);
  },

  // Returns the snapshot to offer Undo with (null if there's no draft worth
  // restoring), or false when the user cancels.
  async confirmReplaceDraft(sourceLabel, targetText = null) {
    let storage = null;
    try { storage = window.localStorage; } catch {}
    const key = RecipeEditState.draftKey(this.slug, this.branchSlug);
    await RecipeEditState.settle(key);
    await this.refreshRecipe();
    const draft = this.recipe?.draft;
    const local = RecipeEditState.unsavedValue(key, storage);
    const text = local ? local.text : (draft?.cooklang_text || '');
    if (!text.trim() || text === targetText) return null;
    const snapshot = {
      cooklang_text: text,
      tags: local ? local.tags : draft?.tags,
      parent_version: draft?.parent_version || null,
      current_beta_version: draft?.current_beta_version || null,
    };
    if (this.draftAtRisk(targetText)) {
      const diff = targetText != null ? RecipeEditState.lineChangeSummary(text, targetText) : null;
      const basedOn = draft?.parent_version ? ` (based on ${escHtml(draft.parent_version)})` : '';
      const ok = await confirmModal({
        title: `Replace the draft with ${sourceLabel}?`,
        bodyHtml: `<p>The current draft${basedOn} has edits that aren't saved in any version${local ? ', including changes the editor hasn\'t saved yet' : ''}.</p>
          ${diff ? `<p class="text-muted">${diff.removed} line${diff.removed === 1 ? '' : 's'} of the draft would be replaced; ${escHtml(sourceLabel)} brings ${diff.added} line${diff.added === 1 ? '' : 's'} the draft doesn't have.</p>` : ''}
          <p class="text-muted">You can undo this from the notice that appears afterwards.</p>`,
        confirmLabel: 'Replace draft',
        danger: true,
      });
      if (!ok) return false;
    }
    RecipeEditState.discard(key, storage);
    return snapshot;
  },

  async afterDraftReplaced(snapshot, message) {
    await this.refreshRecipe();
    this.activeTab = 'editor';
    await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
    if (!snapshot) { showToast(message); return; }
    showToast(message, { action: { label: 'Undo', onClick: () => this.restoreDraft(snapshot) } });
  },

  async restoreDraft(snapshot) {
    try {
      let storage = null;
      try { storage = window.localStorage; } catch {}
      const key = RecipeEditState.draftKey(this.slug, this.branchSlug);
      await RecipeEditState.settle(key);
      RecipeEditState.discard(key, storage);
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/draft/restore`, snapshot);
      await this.refreshRecipe();
      this.activeTab = 'editor';
      await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
      showToast('Previous draft restored');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async forkVersionAndEdit(versionString) {
    try {
      const target = versionString || this.activeVersion?.version_string;
      if (!target) { showToast('No version to fork'); return; }
      const snapshot = await this.confirmReplaceDraft(target, this.versionText(target));
      if (snapshot === false) return;
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(target)}/fork`, {});
      await this.afterDraftReplaced(snapshot, `Draft now starts from ${target}`);
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
      const snapshot = await this.confirmReplaceDraft('the current best');
      if (snapshot === false) return;
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/draft/fork`, {});
      await this.afterDraftReplaced(snapshot, 'Draft now starts from the current best');
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

  // Deleting the whole recipe needs the same typed confirmation as deleting
  // a single version (it removes every version, photo and cook log).
  deleteRecipe() {
    const title = this.recipe.title;
    const counts = this.recipe.counts || {};
    const versionCount = (counts.releases_count || 0) + (counts.betas_count || 0);
    showModal(`
      <div class="modal-title">Delete “${escHtml(title)}”</div>
      <p class="text-muted" style="font-size:0.88rem">
        This permanently removes the recipe with its draft, ${versionCount} version${versionCount === 1 ? '' : 's'},
        ${counts.cook_logs_count || 0} cook log${counts.cook_logs_count === 1 ? '' : 's'} and all photos. It can't be undone.
        Type the recipe name to confirm.
      </p>
      <div class="field-group mt12">
        <label class="field-label" for="delete-recipe-confirm">Recipe name</label>
        <input id="delete-recipe-confirm" class="field-input" placeholder="${escHtml(title)}" autocomplete="off"
          oninput="document.getElementById('delete-recipe-btn').disabled = this.value.trim() !== ${escHtml(JSON.stringify(title.trim()))}" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button id="delete-recipe-btn" class="btn btn-danger" onclick="RecipeView.confirmDeleteRecipe()" disabled>Delete recipe</button>
      </div>`);
    setTimeout(() => document.getElementById('delete-recipe-confirm')?.focus(), 80);
  },

  async confirmDeleteRecipe() {
    const typed = document.getElementById('delete-recipe-confirm')?.value.trim();
    if (typed !== this.recipe.title.trim()) return;
    closeModal();
    try {
      await API.delete(`/recipes/${this.slug}`);
      showToast('Recipe deleted');
      Router.go('/');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

});
