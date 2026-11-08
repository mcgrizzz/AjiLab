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
      ? 'Working copy notes'
      : `Notes for ${version?.label || version?.version_string}`;
    const photosLabel = version?.is_draft
      ? 'Working copy photos'
      : `Photos for ${version?.label || version?.version_string}`;
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
            temperatureUnit: this.temperatureUnit,
            units: this.unitView(),
          })}</div>
        </div>` : ''}
        ${hasCookware ? `
        <div class="sidebar-card">
          <div class="section-head">Equipment</div>
          ${CL.renderCookware(parsed.cookwares)}
        </div>` : ''}
      </div>` : '';
    // A cooked or closed test is locked, notes included (they print);
    // everything else takes notes.
    const notesFixed = this.activeVersion?.kind === 'test' && this.activeVersion.locked;
    const inlineAddNotes = !notes && !notesFixed ? `<button class="notes-inline-add" onclick="RecipeView.openNotesModal()" title="Add notes">✎ Add notes</button>` : '';
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
            ${notesFixed ? '' : '<button class="btn btn-sm" onclick="RecipeView.openNotesModal()">Edit notes</button>'}
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
      ${version?.is_draft && !this.images.length ? '' : `
      <div class="media-strip-card">
        <div class="media-strip-head">
          <div>
            <div class="section-head notes-head">${escHtml(photosLabel)}</div>
            ${this.images.length ? `<div class="media-strip-meta">${this.images.length} photo${this.images.length === 1 ? '' : 's'}</div>` : ''}
          </div>
          ${this.images.length ? `<div class="media-strip-actions">
            <button class="btn btn-sm btn-ghost" id="photos-toggle" aria-expanded="${this.photosExpanded}" onclick="RecipeView.togglePhotosExpanded()">${this.photosToggleLabel()}</button>
          </div>` : ''}
        </div>
        <div id="img-section"></div>
      </div>`}`;
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
    this.closeQtyPopover();
    if (!this.parsed) return;
    const ingList = document.getElementById('ing-list');
    if (ingList) {
      ingList.innerHTML = CL.renderIngredientSummary(this.parsed.ingredient_summary, this.scale, {
        mode: this.ingredientSummaryMode,
        temperatureUnit: this.temperatureUnit,
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
    return { temperatureUnit: this.temperatureUnit, units: this.unitView(), timers: true };
  },

  // ── Per-ingredient display units ──
  // Picked from the amount popover ("show the cream in fl oz"); they last
  // until a different recipe is opened. Steps and print follow them too.
  unitView(slug = this.slug) {
    const overrides = this.unitOverrides?.slug === slug ? this.unitOverrides.map : {};
    return { overrides };
  },

  unitControlHtml() {
    const count = Object.keys(this.unitView().overrides).length;
    if (!count) return '';
    return `<div class="unit-reset-line">
      ${count} ingredient${count === 1 ? '' : 's'} shown in other units ·
      <button class="link-btn" onclick="RecipeView.clearUnitOverrides()">Use recipe units</button>
    </div>`;
  },

  setUnitOverride(name, unitKey) {
    if (this.unitOverrides?.slug !== this.slug) this.unitOverrides = { slug: this.slug, map: {} };
    this.unitOverrides.map[Units.overrideKey(name)] = unitKey;
  },

  clearUnitOverride(name) {
    if (this.unitOverrides?.slug === this.slug) delete this.unitOverrides.map[Units.overrideKey(name)];
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

  // ── Amount popover (ingredient list) ──
  // Clicking an amount offers (a) the same amount in other units — pick one
  // to show this ingredient that way — and (b) a field to type the amount you
  // have, in any unit ("16 fl oz"), which scales the whole recipe to match.
  editIngredientQty(el) {
    const orig = Units.parseQuantity(el.dataset.orig)?.[0];
    if (!(orig > 0)) return;
    if (this.qtyPopover?.anchorName === el.dataset.name) { this.closeQtyPopover(); return; }
    this.closeQtyPopover();
    const name = el.dataset.name || '';
    const writtenUnit = el.dataset.unit || '';
    const options = Units.alternatives(el.dataset.orig, writtenUnit, this.scale, this.unitView(), name);
    const pop = document.createElement('div');
    pop.className = 'qty-popover';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Amount of ${name}`);
    pop.innerHTML = `
      ${options.length > 1 ? `
      <div class="qty-popover-label">Show ${escHtml(name)} in</div>
      <div class="qty-popover-units">${options.map((o) => `
        <button type="button" class="unit-chip${o.active ? ' active' : ''}" data-unit="${escHtml(o.unitKey)}" aria-pressed="${o.active}">
          ${amountHtml(o.text)}${o.written ? '<span class="unit-chip-note">recipe</span>' : ''}
        </button>`).join('')}
      </div>` : ''}
      <form class="qty-popover-scale">
        <label class="qty-popover-label" for="qty-popover-input">Scale recipe to this much</label>
        <div class="qty-popover-row">
          <input id="qty-popover-input" class="field-input" value="${escHtml(el.textContent.trim())}" autocomplete="off" spellcheck="false" />
          <button type="submit" class="btn btn-sm btn-primary">Scale</button>
        </div>
        <div class="qty-popover-hint" role="alert">Any unit works, e.g. 16 fl oz.</div>
      </form>`;
    document.body.appendChild(pop);
    // Open below the amount, or above it when there's more room there; then
    // clamp so the whole popover (including any error text) stays on screen.
    const place = () => {
      const r = el.getBoundingClientRect();
      const viewH = document.documentElement.clientHeight;
      const viewW = document.documentElement.clientWidth;
      const h = pop.offsetHeight;
      const below = viewH - r.bottom - 6;
      const above = r.top - 6;
      let top = (h <= below || below >= above) ? r.bottom + 6 : r.top - 6 - h;
      top = Math.max(8, Math.min(top, viewH - h - 8));
      const left = Math.max(8, Math.min(r.left, viewW - pop.offsetWidth - 8));
      pop.style.top = `${top + window.scrollY}px`;
      pop.style.left = `${left + window.scrollX}px`;
    };
    place();

    const refocus = () => {
      const selector = `.ing-qty-editable[data-name="${cssEscape(name)}"]`;
      document.querySelector(selector)?.focus();
    };
    pop.querySelectorAll('.unit-chip').forEach((chip) => chip.addEventListener('click', () => {
      const unitKey = chip.dataset.unit;
      if (unitKey === Units.key(writtenUnit)) this.clearUnitOverride(name);
      else this.setUnitOverride(name, unitKey);
      this.closeQtyPopover();
      this.rerenderAmounts();
      refocus();
    }));
    const input = pop.querySelector('#qty-popover-input');
    pop.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const result = Units.scaleForTarget(orig, writtenUnit, el.dataset.shownUnit, Units.parseAmount(input.value), name);
      if (result.error) {
        const hint = pop.querySelector('.qty-popover-hint');
        hint.textContent = result.error;
        hint.classList.add('qty-popover-error');
        place();
        input.focus();
        return;
      }
      if (result.unitKey) {
        if (result.unitKey === Units.key(writtenUnit)) this.clearUnitOverride(name);
        else this.setUnitOverride(name, result.unitKey);
      }
      this.closeQtyPopover();
      this.setScale(result.scale);
      refocus();
    });
    pop.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); this.closeQtyPopover(); el.focus(); }
    });
    // Registered synchronously: the mousedown that opened us has already
    // happened. Only ever closes *this* popover.
    const onOutside = (e) => {
      if (this.qtyPopover?.pop !== pop) { document.removeEventListener('mousedown', onOutside); return; }
      if (!pop.contains(e.target) && !el.contains(e.target)) this.closeQtyPopover();
    };
    document.addEventListener('mousedown', onOutside);
    this.qtyPopover = { pop, anchorName: el.dataset.name, cleanup: () => document.removeEventListener('mousedown', onOutside) };
    input.focus();
    input.select();
  },

  closeQtyPopover() {
    if (!this.qtyPopover) return;
    this.qtyPopover.cleanup();
    this.qtyPopover.pop.remove();
    this.qtyPopover = null;
  },

  async switchVersion(value) {
    // In the Editor, the pick is what to edit: the working copy, a test not
    // cooked yet, or a version (fixed in place, with the warning). A cooked
    // test can't be edited, so it opens on the Overview.
    if (this.activeTab === 'editor' && !this.cookLogEditingId) {
      const entry = value && value !== 'draft' ? entryByKey(this.recipe, value) : null;
      if (!entry) {
        this.fixingVersion = null;
        this.setTab('editor');
        this.refreshStatusRow();
        return;
      }
      if (!entry.locked) {
        if (!(await this.fixTypo(value))) this.refreshStatusRow();
        return;
      }
      showToast(`${entry.label} has been ${entry.cook_count ? 'cooked' : 'closed'}, so it can’t be edited. Make a new test from it instead.`);
      this.fixingVersion = null;
      this.explicitVersionRequest = value;
      await this.renderDetail(document.getElementById('view-container'), value, { syncUrl: true });
      this.setTab('overview');
      return;
    }
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

  // ── Resetting the working copy (new test from a version / test / cook) ──
  // These actions overwrite the one working copy (stored as the draft). Work
  // is at risk when it (or the editor's unsaved buffer) holds text that isn't
  // saved in any version or test; then we ask first. Either way the old one
  // is kept for an Undo toast.

  versionText(versionString) {
    return (this.recipe?.versions || []).find((v) => !v.is_draft && v.version_string === versionString)?.cooklang_text ?? null;
  },

  // Would resetting the working copy lose work? Yes when the editor holds
  // unsaved text, or the server says the working copy has changes of its own
  // (a stale one, older than what it's compared with, has none).
  draftAtRisk(targetText = null) {
    let storage = null;
    try { storage = window.localStorage; } catch {}
    const local = RecipeEditState.unsavedValue(RecipeEditState.draftKey(this.slug, this.branchSlug), storage);
    const text = local ? local.text : (this.recipe?.draft?.cooklang_text || '');
    if (!text.trim() || text === targetText) return false;
    if (!local && !this.recipe?.has_unreleased_changes) return false;
    return !(this.recipe?.versions || []).some((v) => !v.is_draft && v.cooklang_text === text);
  },

  // Replace the draft via `request` (a function doing the server call):
  // confirm if work is at risk, and only drop the editor's unsaved buffer once
  // the server has actually replaced the draft — a failed request leaves both
  // the server draft and the local buffer untouched.
  async replaceDraft({ sourceLabel, targetText = null, request, message }) {
    let storage = null;
    try { storage = window.localStorage; } catch {}
    const key = RecipeEditState.draftKey(this.slug, this.branchSlug);
    const snapshot = await this.confirmReplaceDraft(sourceLabel, targetText);
    if (snapshot === false) return false;
    try {
      await request();
    } catch (e) {
      showToast(`Couldn't reset the working copy: ${e.message}. Nothing was changed.`);
      return false;
    }
    RecipeEditState.discard(key, storage);
    await this.afterDraftReplaced(snapshot, message);
    return true;
  },

  // Returns the snapshot to offer Undo with (null if there's no draft worth
  // restoring), or false when the user cancels. Doesn't modify anything.
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
      testing: draft?.testing || '',
      from_entry_id: draft?.from_entry_id || null,
      from_cook_log_id: draft?.from_cook_log_id || null,
    };
    if (this.draftAtRisk(targetText)) {
      const diff = targetText != null ? RecipeEditState.lineChangeSummary(text, targetText) : null;
      const basedOn = draft?.base_version ? ` (based on ${escHtml(draft.base_version)})` : '';
      const ok = await confirmModal({
        title: `Reset the working copy to ${sourceLabel}?`,
        bodyHtml: `<p>The working copy${basedOn} has edits that aren't saved in any version or test${local ? ', including changes the editor hasn\'t saved yet' : ''}.</p>
          ${diff ? `<p class="text-muted">${diff.removed} line${diff.removed === 1 ? '' : 's'} of the working copy would be replaced; ${escHtml(sourceLabel)} brings ${diff.added} line${diff.added === 1 ? '' : 's'} it doesn't have.</p>` : ''}
          <p class="text-muted">You can undo this from the notice that appears afterwards.</p>`,
        confirmLabel: 'Reset working copy',
        danger: true,
      });
      if (!ok) return false;
    }
    return snapshot;
  },

  async afterDraftReplaced(snapshot, message) {
    await this.refreshRecipe();
    const replacedText = this.recipe?.draft?.cooklang_text ?? '';
    this.activeTab = 'editor';
    await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
    if (!snapshot) { showToast(message); return; }
    showToast(message, { action: { label: 'Undo', onClick: () => this.restoreDraft(snapshot, replacedText) } });
  },

  // replacedText: the draft right after the replacement. If it has changed
  // since (typing in the editor, saved or not), ask before throwing that away.
  async restoreDraft(snapshot, replacedText = null) {
    try {
      let storage = null;
      try { storage = window.localStorage; } catch {}
      const key = RecipeEditState.draftKey(this.slug, this.branchSlug);
      await RecipeEditState.settle(key);
      await this.refreshRecipe();
      const local = RecipeEditState.unsavedValue(key, storage);
      const current = local ? local.text : (this.recipe?.draft?.cooklang_text ?? '');
      if (replacedText !== null && current !== replacedText) {
        const ok = await confirmModal({
          title: 'Undo and lose your newer edits?',
          bodyHtml: '<p>You\'ve edited the working copy since it was reset. Undoing brings back the previous one and discards those edits.</p>',
          confirmLabel: 'Undo anyway',
          danger: true,
        });
        if (!ok) return;
      }
      // Stop the open editor from autosaving over the restore.
      this.destroyDraftEditor();
      await RecipeEditState.settle(key);
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/draft/restore`, snapshot);
      RecipeEditState.discard(key, storage);
      await this.refreshRecipe();
      this.activeTab = 'editor';
      await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
      showToast('Previous working copy restored');
    } catch (e) {
      showToast(`Couldn't undo: ${e.message}`);
      // The editor may have been torn down above; bring it back with whatever
      // is still in its buffer.
      if (this.activeTab === 'editor') {
        await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true }).catch(() => {});
      }
    }
  },

  async forkVersionAndEdit(versionString) {
    try {
      const target = versionString || this.activeVersion?.version_string;
      if (!target) { showToast('Nothing to start from'); return; }
      const label = entryLabelFor(this.recipe, target);
      await this.replaceDraft({
        sourceLabel: label,
        targetText: this.versionText(target),
        request: () => API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(target)}/fork`, {}),
        message: `Working copy reset to ${label}`,
      });
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
      await this.replaceDraft({
        sourceLabel: 'the current version',
        request: () => API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/draft/fork`, {}),
        message: 'Working copy reset to the current version',
      });
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async startFreshDraft() {
    if (this.recipe.current_version) { await this.forkCurrentBranchHead(); return; }
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
    showModal(`
      <div class="modal-title">Delete “${escHtml(title)}”</div>
      <p class="text-muted" style="font-size:0.88rem">
        This permanently removes the recipe with its working copy, ${counts.releases_count || 0} version${counts.releases_count === 1 ? '' : 's'},
        ${counts.betas_count || 0} test${counts.betas_count === 1 ? '' : 's'}, ${counts.cook_logs_count || 0} cook${counts.cook_logs_count === 1 ? '' : 's'} and all photos. It can't be undone.
        Type the recipe name to confirm.
      </p>
      <div class="field-group mt12">
        <label class="field-label" for="delete-recipe-confirm">Recipe name</label>
        <input id="delete-recipe-confirm" class="field-input" placeholder="${escHtml(title)}" autocomplete="off"
          oninput="document.getElementById('delete-recipe-btn').disabled = this.value.trim() !== ${escHtml(JSON.stringify(title.trim()))}" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button id="delete-recipe-btn" class="btn btn-danger-solid" onclick="RecipeView.confirmDeleteRecipe()" disabled>Delete recipe</button>
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
