// ── Editor tab — draft editing, inline quantity panel, tags, images ───────────
Object.assign(RecipeView, {

  renderEditorTab(body) {
    let cookLogTarget = null;
    if (this.cookLogEditingId) {
      const log = (this.cookLogs || []).find((entry) => entry.id === this.cookLogEditingId);
      if (log) cookLogTarget = this.cookLogToEditableTarget(log);
      else this.cookLogEditingId = null;
    }
    if (cookLogTarget) {
      this.activeVersion = cookLogTarget;
    } else {
      // Only switch the active version if the current selection isn't editable.
      // A draft or a beta can be edited directly; released/archived versions can't,
      // so we fall back to the editable target (active experiment → draft).
      const isCurrentEditable = !!(this.activeVersion?._cookLogId
        || this.activeVersion?.is_draft
        || this.activeVersion?.status === 'beta');
      if (!isCurrentEditable) {
        const experimentTarget = this.recipe.active_experiment || this.recipe.draft || null;
        if (experimentTarget && experimentTarget !== this.activeVersion) {
          this.activeVersion = experimentTarget;
          // Sync URL + explicit request so the address bar matches what we're editing.
          this.explicitVersionRequest = experimentTarget.is_draft
            ? 'draft'
            : (experimentTarget.version_string || null);
          this.syncVersionUrl(true);
        }
      }
    }
    const editable = this.getEditableVersion();
    if (!editable) {
      const best = this.recipe.current_best_release;
      body.innerHTML = `
        <div class="tab-content">
          <div class="empty-state" style="padding:32px 0">
            <h2>Nothing to edit yet</h2>
            <p>${best ? `Continue from <strong>${escHtml(best.version_string)}</strong>.` : 'Start writing this recipe.'}</p>
            <button class="btn btn-primary" onclick="RecipeView.${best ? 'forkCurrentBranchHead' : 'startFreshDraft'}()">${best ? 'Start from current best' : 'Start writing'}</button>
          </div>
        </div>`;
      return;
    }
    const isEditingDraft = !!editable?.is_draft;
    const text = editable?.cooklang_text || '';
    const tags = JSON.parse(editable?.tags || '[]');
    this.selectedDraftTokenId = null;
    this.draftQuantityTokens = [];
    this.draftPreviewState = null;
    this.draftQuantityAnchor = null;
    const isEditingCookLog = !!editable?._cookLogId;
    body.innerHTML = `
      <div class="editor-wrap">
        <div class="editor-toolbar">
          <span class="editor-hint">@ingredient{qty%unit} &nbsp;#cookware &nbsp;~{time%min}</span>
          <span class="text-muted" style="font-size:0.82rem">${escHtml(this.editTargetLabel())}</span>
          ${isEditingCookLog
            ? `<button class="btn btn-sm" onclick="RecipeView.exitCookLogEdit()">← Back to cook logs</button>
               <button class="btn btn-sm btn-primary" onclick="RecipeView.saveDraft({ advanceBeta: false })">Save</button>`
            : `<button class="btn btn-sm" onclick="RecipeView.saveDraft({ advanceBeta: true })">Save</button>`}
        </div>
        <div class="editor-split">
          <div class="editor-code">
            <div id="draft-editor" class="editor-surface" aria-label="Cooklang recipe editor"></div>
            <textarea id="draft-text" class="editor-textarea editor-textarea-shadow" placeholder="Start writing your recipe in Cooklang…

@butter{100%g}, @flour{200%g}, @eggs{2}

Cream the @butter{} until soft. Add @flour{} gradually.

Bake in a #oven{} at 180°C for ~{25%minutes}.">${escHtml(text)}</textarea>
            <div class="editor-meta-hint">
              <span class="meta-hint-title">Metadata</span>
              <code>&gt;&gt; servings: 4</code>
              <code>&gt;&gt; notes: Your notes</code>
              <code>&gt;&gt; source: URL or book</code>
              <code>&gt;&gt; metric.hydration: water.g / flour.g * 100 | %</code>
            </div>
          </div>
          <div class="editor-preview-pane">
            <div class="editor-preview" id="draft-preview">
              <p class="text-muted" style="font-size:0.88rem">Start typing to see preview…</p>
              <div class="draft-quantity-popover" id="draft-quantity-panel" hidden></div>
            </div>
          </div>
        </div>
        <div class="editor-meta">
          <div class="field-group">
            <label class="field-label">Tags</label>
            <div id="tag-list" class="tag-list mt8">${tags.map((tag) => tagChip(tag)).join('')}</div>
            <div style="display:flex;gap:6px;margin-top:8px">
              <input id="tag-input" class="field-input" style="flex:1" placeholder="Add tag…" />
              <button class="btn btn-sm" onclick="RecipeView.addTag()">Add</button>
            </div>
          </div>
        </div>
        ${isEditingCookLog ? `
        <div style="padding:16px;border-top:1px solid var(--border);background:var(--surface);display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:space-between">
          <div class="text-muted" style="font-size:0.84rem;line-height:1.5">Edits save to this cook log only — not the draft or any release.</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm" onclick="RecipeView.openPromoteLogModal('${escJs(editable._cookLogId)}')">Promote to release…</button>
            <button class="btn btn-sm" onclick="RecipeView.exitCookLogEdit()">Done</button>
          </div>
        </div>` : (isEditingDraft || editable?.status === 'beta') ? `
        <div style="padding:16px;border-top:1px solid var(--border);background:var(--surface)">
          <button class="btn btn-primary" onclick="RecipeView.openReleaseModal()" style="width:100%">${editable?.status === 'beta' ? `Promote ${escHtml(editable.version_string || 'beta')}…` : 'Release version…'}</button>
        </div>` : `
        <div style="padding:16px;border-top:1px solid var(--border);background:var(--surface)">
          <div class="text-muted" style="font-size:0.84rem;line-height:1.5">Beta edits save directly to ${escHtml(editable?.version_string || 'this beta')}. Switch to Draft to create an unreleased working copy.</div>
        </div>`}
        </div>`;
    const textarea = document.getElementById('draft-text');
    const editorHost = document.getElementById('draft-editor');
    if (textarea && editorHost && window.CooklangEditor?.createCooklangEditor) {
      this.draftEditor = window.CooklangEditor.createCooklangEditor(editorHost, {
        value: text,
        placeholder: textarea.getAttribute('placeholder') || '',
        textarea,
      });
    } else {
      textarea?.classList.remove('editor-textarea-shadow');
      window.addEventListener('cooklang-editor-ready', () => {
        if (!textarea || !editorHost || this.activeTab !== 'editor' || this.draftEditor) return;
        if (!window.CooklangEditor?.createCooklangEditor) return;
        textarea.classList.add('editor-textarea-shadow');
        this.draftEditor = window.CooklangEditor.createCooklangEditor(editorHost, {
          value: textarea.value,
          placeholder: textarea.getAttribute('placeholder') || '',
          textarea,
        });
      }, { once: true });
    }
    document.getElementById('tag-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.addTag(); }
    });
    let saveTimer;
    let previewTimer;
    document.getElementById('draft-text')?.addEventListener('input', () => {
      this.selectedDraftTokenId = null;
      this.draftQuantityAnchor = null;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => this.saveDraft({ silent: true, advanceBeta: false }), 1500);
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => this.updatePreview(), 500);
      this.renderDraftQuantityPanel();
    });
    this.updatePreview();
  },

  // ── Inline quantity panel ────────────────────────────────────────────────────

  renderDraftQuantityPanel() {
    const panel = document.getElementById('draft-quantity-panel');
    if (!panel) return;
    const selected = this.draftQuantityTokens.find((token) => token.id === this.selectedDraftTokenId) || null;
    if (!selected || !this.draftQuantityAnchor) {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }
    panel.hidden = false;
    panel.innerHTML = renderDraftQuantityPanel(selected);
    const preview = document.getElementById('draft-preview');
    if (!preview) return;
    const maxLeft = Math.max(12, preview.clientWidth - panel.offsetWidth - 12);
    const left = Math.min(Math.max(12, this.draftQuantityAnchor.left), maxLeft);
    panel.style.left = `${left}px`;
    panel.style.top = `${this.draftQuantityAnchor.top}px`;
  },

  selectDraftQuantity(tokenId, el) {
    if (!tokenId) return;
    if (this.selectedDraftTokenId === tokenId) { this.clearDraftQuantitySelection(); return; }
    this.selectedDraftTokenId = tokenId;
    const preview = document.getElementById('draft-preview');
    if (preview && el) {
      const previewRect = preview.getBoundingClientRect();
      const targetRect = el.getBoundingClientRect();
      this.draftQuantityAnchor = {
        top: (targetRect.bottom - previewRect.top) + preview.scrollTop + 8,
        left: (targetRect.left - previewRect.left) + preview.scrollLeft,
      };
    }
    this.renderDraftQuantityPanel();
  },

  clearDraftQuantitySelection() {
    this.selectedDraftTokenId = null;
    this.draftQuantityAnchor = null;
    this.renderDraftQuantityPanel();
  },

  setDraftQuantityPreset(percent) {
    const input = document.getElementById('draft-custom-percent');
    if (!input) return;
    const current = parseFloat(input.value || '');
    const next = Number.isFinite(current) ? current + percent : percent;
    input.value = formatEditableQuantity(next);
    this.handleDraftQuantityPercentInput();
  },

  scaleDraftQuantityPercent(multiplier, fallbackPercent) {
    const input = document.getElementById('draft-custom-percent');
    if (!input) return;
    const current = parseFloat(input.value || '');
    const next = Number.isFinite(current) ? current * multiplier : fallbackPercent;
    input.value = formatEditableQuantity(next);
    this.handleDraftQuantityPercentInput();
  },

  handleDraftQuantityAbsoluteInput() {
    const percentInput = document.getElementById('draft-custom-percent');
    if (percentInput) percentInput.value = '';
    this.updateDraftQuantityPreview();
  },

  handleDraftQuantityPercentInput() {
    this.updateDraftQuantityPreview();
  },

  getDraftQuantityPendingValue() {
    const token = this.draftQuantityTokens.find((entry) => entry.id === this.selectedDraftTokenId);
    if (!token) return null;
    const percentInput = document.getElementById('draft-custom-percent');
    const percent = parseFloat(percentInput?.value || '');
    if (Number.isFinite(percent) && token.numericValue !== null) {
      return formatEditableQuantity(token.numericValue * (1 + (percent / 100)));
    }
    const absoluteInput = document.getElementById('draft-override-value');
    const absolute = absoluteInput?.value.trim();
    if (absolute) return absolute;
    return token.quantityText;
  },

  updateDraftQuantityPreview() {
    const token = this.draftQuantityTokens.find((entry) => entry.id === this.selectedDraftTokenId);
    const preview = document.getElementById('draft-pending-preview');
    if (!token || !preview) return;
    preview.textContent = this.getDraftQuantityPendingValue() || token.quantityText;
  },

  applyDraftQuantityPending() {
    const textarea = document.getElementById('draft-text');
    const token = this.draftQuantityTokens.find((entry) => entry.id === this.selectedDraftTokenId);
    const nextValue = this.getDraftQuantityPendingValue();
    if (!textarea || !token) return;
    const formatted = typeof nextValue === 'number' ? formatEditableQuantity(nextValue) : String(nextValue || '').trim();
    if (!formatted) return;
    const text = textarea.value;
    textarea.value = text.slice(0, token.rangeStart) + formatted + text.slice(token.rangeEnd);
    this.selectedDraftTokenId = null;
    this.draftQuantityAnchor = null;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  },

  // ── Preview ──────────────────────────────────────────────────────────────────

  async updatePreview() {
    const text = document.getElementById('draft-text')?.value || '';
    const box = document.getElementById('draft-preview');
    if (!box) return;
    if (!text.trim()) {
      this.draftQuantityTokens = [];
      this.draftPreviewState = null;
      this.draftQuantityAnchor = null;
      box.innerHTML = '<p class="text-muted" style="font-size:0.88rem">Start typing to see preview…</p>';
      box.insertAdjacentHTML('beforeend', '<div class="draft-quantity-popover" id="draft-quantity-panel" hidden></div>');
      this.renderDraftQuantityPanel();
      return;
    }
    try {
      const preview = await API.post(`/recipes/${this.slug}/draft/parse`, { cooklang_text: text });
      if (preview.error) {
        this.draftQuantityTokens = [];
        this.draftPreviewState = null;
        this.draftQuantityAnchor = null;
        box.innerHTML = `<div class="parse-error">Parse error: ${escHtml(preview.error)}</div>`;
        box.insertAdjacentHTML('beforeend', '<div class="draft-quantity-popover" id="draft-quantity-panel" hidden></div>');
        this.renderDraftQuantityPanel();
        return;
      }
      this.draftQuantityTokens = preview.editable_tokens || [];
      this.draftPreviewState = preview;
      this.ingredientSummaryMode = resolveIngredientSummaryMode(preview, this.ingredientSummaryMode);
      if (!this.draftQuantityTokens.some((token) => token.id === this.selectedDraftTokenId)) {
        this.selectedDraftTokenId = null;
      }
      const ingredientResolver = makeDraftTokenResolver(
        buildDraftIngredientTokenOrder(
          preview,
          this.draftQuantityTokens.filter((token) => token.kind === 'ingredient'),
          this.ingredientSummaryMode,
        )
      );
      const timerResolver = makeDraftTokenResolver(this.draftQuantityTokens.filter((token) => token.kind === 'timer'));
      const inlineResolver = makeDraftTokenResolver(this.draftQuantityTokens.filter((token) => token.kind === 'inlineQuantity'));
      const meta = preview.metadata || {};
      const notes = normalizeNotes(meta.notes || meta.Notes || '');
      const servings = meta.servings || meta.Servings || meta.yield || '';
      let html = '';
      html += CL.renderMetrics(preview.metrics);
      if (notes) html += `<div class="notes-box" style="margin-bottom:12px">${formatMultilineText(notes)}</div>`;
      if (servings) html += `<p class="text-muted" style="font-size:0.85rem;margin-bottom:12px">Serves ${escHtml(servings)}</p>`;
      if (preview.ingredients?.length) {
        html += `<div class="ingredient-summary-head">
          <div class="section-head">Ingredients</div>
          ${renderIngredientSummaryToggle(preview, this.ingredientSummaryMode)}
        </div>${CL.renderIngredientSummary(preview.ingredient_summary, 1, {
          mode: this.ingredientSummaryMode,
          resolveIngredientToken: ingredientResolver,
        })}`;
      }
      if (preview.cookwares?.length) html += `<div class="section-head mt16">Equipment</div>${CL.renderCookware(preview.cookwares)}`;
      if (preview.steps?.length) {
        html += `<div class="section-head mt16">Steps</div>${CL.renderSteps(preview.steps, 1, preview.metadata, false, {
          temperatureUnit: this.temperatureUnit,
          resolveTimerToken: timerResolver,
          resolveInlineQuantityToken: inlineResolver,
        })}`;
      }
      box.innerHTML = html || '<p class="text-muted" style="font-size:0.88rem">Nothing to preview yet.</p>';
      box.insertAdjacentHTML('beforeend', '<div class="draft-quantity-popover" id="draft-quantity-panel" hidden></div>');
      this.renderDraftQuantityPanel();
    } catch (e) {
      this.draftQuantityTokens = [];
      this.draftPreviewState = null;
      this.draftQuantityAnchor = null;
      box.innerHTML = `<div class="parse-error">Error: ${escHtml(e.message)}</div>`;
      box.insertAdjacentHTML('beforeend', '<div class="draft-quantity-popover" id="draft-quantity-panel" hidden></div>');
      this.renderDraftQuantityPanel();
    }
  },

  // ── Save ─────────────────────────────────────────────────────────────────────

  async saveDraft(options = {}) {
    const editable = this.getEditableVersion();
    const silent = options.silent === true;
    const advanceBeta = options.advanceBeta === true;
    const text = document.getElementById('draft-text')?.value ?? '';
    const tags = [...document.querySelectorAll('#tag-list .tag-chip')].map((el) => el.dataset.tag);
    let response = null;
    try {
      if (editable?._cookLogId) {
        await API.put(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(editable._cookLogId)}`, { cooklang_text: text, tags });
        const nextTags = tags.slice();
        const list = this.cookLogs || [];
        const idx = list.findIndex((entry) => entry.id === editable._cookLogId);
        if (idx >= 0) list[idx] = { ...list[idx], cooklang_text: text, tags: nextTags };
        this.activeVersion = { ...this.activeVersion, cooklang_text: text, tags: JSON.stringify(nextTags) };
        if (silent) return;
        showToast('Cook log saved');
        return;
      }
      if (editable?.is_draft) {
        response = await API.put(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/draft`, { cooklang_text: text, tags, advance_beta: advanceBeta });
      } else if (editable?.status === 'beta' && editable?.version_string) {
        await API.put(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(editable.version_string)}`, { cooklang_text: text, tags });
      } else {
        throw new Error('No editable version selected');
      }
      const nextTags = JSON.stringify(tags);
      if (editable?.is_draft && this.recipe?.draft) {
        this.recipe.draft = { ...this.recipe.draft, cooklang_text: text, tags: nextTags };
      }
      if (editable?.status === 'beta' && editable?.version_string) {
        this.recipe.versions = (this.recipe.versions || []).map((version) => (
          version.version_string === editable.version_string
            ? { ...version, cooklang_text: text, tags: nextTags }
            : version
        ));
      }
      if (this.activeVersion) {
        this.activeVersion = { ...this.activeVersion, cooklang_text: text, tags: nextTags };
      }
      if (silent) { this.maybeShowUnresolvedWarning(response, true); return; }
      await this.refreshRecipe();
      const versionKey = editable?.is_draft ? 'draft' : editable?.version_string;
      if (versionKey) {
        await this.renderDetail(document.getElementById('view-container'), versionKey, { syncUrl: true, replaceUrl: true });
      }
      if (!silent) showToast(editable?.is_draft ? 'Draft saved' : 'Version saved');
      this.maybeShowUnresolvedWarning(response, false);
    } catch (e) {
      if (!silent) showToast('Error saving: ' + e.message);
    }
  },

  maybeShowUnresolvedWarning(response, silent) {
    const list = response?.warnings?.unresolved_references;
    if (!Array.isArray(list) || list.length === 0) return;
    const names = list.map((entry) => entry.slug || entry.raw_path).filter(Boolean);
    if (!names.length) return;
    showToast(`Unresolved references: ${names.join(', ')}`);
  },

  // ── Tags ─────────────────────────────────────────────────────────────────────

  addTag() {
    const input = document.getElementById('tag-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    const existing = [...document.querySelectorAll('#tag-list .tag-chip')].map((el) => el.dataset.tag);
    if (existing.includes(val)) { input.value = ''; return; }
    const list = document.getElementById('tag-list');
    const chip = document.createElement('div');
    chip.innerHTML = tagChip(val);
    list.appendChild(chip.firstElementChild);
    input.value = '';
  },

  removeTag(el) {
    el.closest('.tag-chip')?.remove();
  },

  // ── Images ───────────────────────────────────────────────────────────────────

  togglePhotosExpanded() {
    this.photosExpanded = !this.photosExpanded;
    this.renderImageManager();
  },

  photosToggleLabel() {
    return this.photosExpanded ? 'Hide photos' : 'Show photos';
  },

  renderImageManager() {
    const section = document.getElementById('img-section');
    if (!section) return;
    const versionKey = this.activeImageVersionKey() || 'draft';
    if (this.photosExpandedVersionKey !== versionKey) {
      this.photosExpanded = false;
      this.photosExpandedVersionKey = versionKey;
    }
    const previewImages = this.images.slice(0, 4).map((img) => `
      <a class="image-thumb image-thumb-link image-thumb-compact" href="/api/images/${img.id}" target="_blank" rel="noreferrer">
        <img src="/api/images/${img.id}" alt="${escHtml(img.filename)}" loading="lazy" />
      </a>`).join('');
    const grid = this.images.map((img) => `
      <div class="image-thumb" id="img-${img.id}">
        <img src="/api/images/${img.id}" alt="${escHtml(img.filename)}" loading="lazy" />
        <button class="del-img" onclick="RecipeView.deleteImage('${escJs(img.id)}')" aria-label="Delete image">✕</button>
      </div>`).join('');
    if (!this.images.length) {
      section.innerHTML = `
        <input type="file" id="img-file" accept="image/*" style="display:none" onchange="RecipeView.uploadImage(this)" />
        <div class="media-strip-empty">No photos attached to ${escHtml(this.imageTargetLabel())} yet.</div>`;
      return;
    }
    section.innerHTML = `
      <input type="file" id="img-file" accept="image/*" style="display:none" onchange="RecipeView.uploadImage(this)" />
      <div class="media-strip-preview">${previewImages}</div>
      ${this.photosExpanded ? `<div class="image-grid media-strip-grid">${grid}</div>` : ''}`;
  },

  activeImageVersionKey() {
    if (this.activeVersion?.is_draft) return 'draft';
    return this.activeVersion?.version_string || null;
  },

  async uploadVersionImage(file) {
    if (!file) return;
    const fd = new FormData();
    fd.append('image', file);
    const versionKey = this.activeImageVersionKey();
    if (versionKey) fd.append('version', versionKey);
    try {
      await API.postForm(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/images`, fd);
      await this.loadImages();
      this.photosExpanded = true;
      this.renderImageManager();
      showToast('Image uploaded');
    } catch (e) {
      showToast('Upload error: ' + e.message);
    }
  },

  async uploadImage(input) {
    await this.uploadVersionImage(input.files[0]);
    input.value = '';
  },

  async handleDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag');
    await this.uploadVersionImage(e.dataTransfer.files[0]);
  },

  async uploadThumbnail(input) {
    await this.saveThumbnailFile(input.files[0]);
    input.value = '';
  },

  async handleThumbnailDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag');
    await this.saveThumbnailFile(e.dataTransfer.files[0]);
  },

  async saveThumbnailFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const fd = new FormData();
    fd.append('image', file);
    try {
      await API.postForm(`/recipes/${this.slug}/thumbnail`, fd);
      await this.refreshRecipe();
      this.renderHeaderThumbnail();
      showToast('Thumbnail updated');
    } catch (e) {
      showToast('Upload error: ' + e.message);
    }
  },

  async deleteThumbnail() {
    try {
      await API.delete(`/recipes/${this.slug}/thumbnail`);
      await this.refreshRecipe();
      this.renderHeaderThumbnail();
      showToast('Thumbnail removed');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async deleteImage(id) {
    try {
      await API.delete(`/images/${id}`);
      await this.loadImages();
      this.renderImageManager();
      showToast('Image deleted');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

});
