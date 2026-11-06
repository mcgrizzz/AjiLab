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
      // Always the working copy, unless "Fix a typo in v1.1…" asked for that
      // version. Tests are never edited.
      const target = this.getEditableVersion();
      if (target && target !== this.activeVersion) {
        // Back on the Overview, show the sheet that was there before.
        if (this.activeVersion?.version_string && !this.activeVersion._cookLogId) this.lastSheetKey = this.activeVersion.version_string;
        this.activeVersion = target;
        this.explicitVersionRequest = target.is_draft ? 'draft' : target.version_string;
        this.syncVersionUrl(true);
        this.refreshStatusRow();
      }
    }
    const editable = this.getEditableVersion();
    if (!editable) {
      const current = this.recipe.current_version;
      body.innerHTML = `
        <div class="tab-content">
          <div class="empty-state" style="padding:32px 0">
            <h2>Nothing to edit yet</h2>
            <p>${current ? `Start the working copy from <strong>${escHtml(current.label)}</strong>.` : 'Start writing this recipe.'}</p>
            <button class="btn btn-primary" onclick="RecipeView.${current ? 'forkCurrentBranchHead' : 'startFreshDraft'}()">${current ? `Start from ${escHtml(current.label)}` : 'Start writing'}</button>
          </div>
        </div>`;
      return;
    }
    const isEditingDraft = !!editable?.is_draft;
    const session = this.openEditorSaveSession(editable);
    const text = session.value.text;
    const tags = session.value.tags;
    this.selectedDraftTokenId = null;
    this.draftQuantityTokens = [];
    this.draftPreviewState = null;
    this.draftQuantityAnchor = null;
    const isEditingCookLog = !!editable?._cookLogId;
    // Fixing a version in place (typo/note fixes), with the warning.
    const isFixingVersion = !isEditingCookLog && !isEditingDraft;
    const actions = isEditingCookLog
      ? `<button class="btn btn-sm" onclick="RecipeView.exitCookLogEdit()">← Back to cooks</button>
         <button class="btn btn-sm btn-outline" onclick="RecipeView.openPromoteLogModal('${escJs(editable._cookLogId)}')">Adopt changes…</button>`
      : isFixingVersion
        ? `<button class="btn btn-sm btn-primary" onclick="RecipeView.saveDraft({ advanceBeta: false })">Save changes</button>
           <button class="btn btn-sm" onclick="RecipeView.finishFixingVersion()">Done</button>`
        : `<button id="editor-test-btn" class="btn btn-sm btn-primary" onclick="RecipeView.openSaveTestModal()">Save as ${escHtml(this.recipe.next_test_label)}…</button>
           <button class="btn btn-sm btn-ghost" onclick="RecipeView.openWorkingCopyMenu(event, this)" aria-label="More actions for the working copy" title="More actions">⋯</button>`;
    const targetTitle = isEditingCookLog
      ? 'Edits save to this cook only, not to the working copy or any version.'
      : '';
    const testingLine = isEditingDraft && editable.testing
      ? `<span class="editor-testing">Testing: ${escHtml(editable.testing)}</span>` : '';
    body.innerHTML = `
      <div class="editor-wrap">
        ${isFixingVersion ? `
        <div class="editor-release-warning">
          <span>⚠ You're fixing <strong>${escHtml(editable.label || editable.version_string)}</strong> in place: saving overwrites it, and printouts of it won't match any more. Good for a typo or a note; for a real change, start a new test.</span>
          <button class="btn btn-sm" onclick="RecipeView.openNewTestModal('${escJs(editable.version_string || '')}')">New test from ${escHtml(editable.label || 'this version')}…</button>
        </div>` : ''}
        <div class="editor-head">
          <div class="editor-toolbar">
            <span class="editor-target"${targetTitle ? ` title="${escHtml(targetTitle)}"` : ''}>${escHtml(this.editTargetLabel())}</span>
            ${testingLine}
            <span id="editor-save-pill" class="save-pill" data-state="saved" role="status" aria-live="polite"></span>
            ${isEditingCookLog ? '' : '<span id="editor-title-notice" class="title-check" hidden></span>'}
            <span class="editor-toolbar-spacer"></span>
            <span class="editor-toolbar-actions">${actions}</span>
          </div>
          ${this.editorHelpHtml()}
        </div>
        <div class="editor-split">
          <div class="editor-code">
            <div id="draft-editor" class="editor-surface" aria-label="Cooklang recipe editor"></div>
            <textarea id="draft-text" class="editor-textarea editor-textarea-shadow" placeholder="Start writing your recipe in Cooklang…

@butter{100%g}, @flour{200%g}, @eggs{2}

Cream the @butter{} until soft. Add @flour{} gradually.

Bake in a #oven{} at 180°C for ~{25%minutes}.">${escHtml(text)}</textarea>
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
      </div>`;
    const textarea = document.getElementById('draft-text');
    const editorHost = document.getElementById('draft-editor');
    if (textarea && editorHost && window.CooklangEditor?.createCooklangEditor) {
      this.draftEditor = window.CooklangEditor.createCooklangEditor(editorHost, {
        value: text,
        placeholder: textarea.getAttribute('placeholder') || '',
        textarea,
        onSelection: (offset) => this.followEditorCursor(offset),
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
          onSelection: (offset) => this.followEditorCursor(offset),
        });
      }, { once: true });
    }
    // The panes fill the screen below the sticky head, whatever its height.
    const toolbar = body.querySelector('.editor-head');
    const wrap = body.querySelector('.editor-wrap');
    this.editorToolbarObserver?.disconnect();
    if (toolbar && wrap && typeof ResizeObserver !== 'undefined') {
      this.editorToolbarObserver = new ResizeObserver(() => wrap.style.setProperty('--editor-toolbar-h', `${toolbar.offsetHeight}px`));
      this.editorToolbarObserver.observe(toolbar);
    }
    // Plain-textarea fallback: follow its cursor too.
    for (const type of ['keyup', 'click']) {
      textarea?.addEventListener(type, () => { if (!this.draftEditor) this.followEditorCursor(textarea.selectionStart); });
    }
    this.editorCursorOffset = null;
    document.getElementById('tag-input')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.addTag(); }
    });
    let previewTimer;
    document.getElementById('draft-text')?.addEventListener('input', () => {
      this.selectedDraftTokenId = null;
      this.draftQuantityAnchor = null;
      this.captureEditorChanges(session);
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => this.updatePreview(), 500);
      this.renderDraftQuantityPanel();
    });
    session.onChange = () => this.renderEditorSaveStatus(session);
    this.renderEditorSaveStatus(session);
    if (this.editorScrollPending) {
      this.scrollEditorIntoView(this.editorScrollForce);
    }
    this.editorScrollPending = false;
    this.editorScrollForce = false;
    this.updatePreview();
  },

  // Scroll the page so the editor head pins under the nav and the panes fill
  // the window. Arriving by URL (or a reload) never scrolls back up past where
  // you already are; a tab switch (force) always lands on the panes.
  scrollEditorIntoView(force = false) {
    const head = document.querySelector('.editor-head');
    if (!head) return;
    const nav = document.getElementById('topnav')?.offsetHeight || 0;
    // Measure where the head sits in the page, not where it's stuck on screen.
    const before = head.previousElementSibling;
    const naturalTop = before ? before.getBoundingClientRect().bottom : head.parentElement.getBoundingClientRect().top;
    const target = Math.max(0, Math.round(naturalTop + window.scrollY - nav));
    if (force ? window.scrollY !== target : window.scrollY < target) window.scrollTo({ top: target, behavior: 'auto' });
  },

  openEditorSaveSession(editable) {
    const slug = this.slug;
    const branch = this.branchSlug;
    const kind = editable._cookLogId ? 'cook-log' : (editable.is_draft ? 'draft' : 'version');
    const target = editable._cookLogId || (editable.is_draft ? 'draft' : editable.version_string);
    const base = `/recipes/${encodeURIComponent(slug)}/branches/${encodeURIComponent(branch)}`;
    const endpoint = kind === 'cook-log' ? `${base}/cook-logs/${encodeURIComponent(target)}`
      : kind === 'draft' ? `${base}/draft` : `${base}/versions/${encodeURIComponent(target)}`;
    let storage = null;
    try { storage = window.localStorage; } catch {}
    const session = RecipeEditState.open({
      key: JSON.stringify([slug, branch, kind, target]),
      initial: { text: editable.cooklang_text || '', tags: JSON.parse(editable.tags || '[]') },
      storage,
      autosave: !!editable.is_draft || !!editable._cookLogId,
      write: (value, options) => API.put(endpoint, {
        cooklang_text: value.text, tags: value.tags,
        ...(kind === 'draft' ? { advance_beta: options.advanceBeta === true } : {}),
      }),
    });
    session.target = { slug, branch, kind, key: target };
    session.requestSave = () => this.saveDraft({ silent: true, session });
    this.editorSaveSession = session;
    return session;
  },

  captureEditorChanges(session = this.editorSaveSession) {
    if (!session || session !== this.editorSaveSession) return;
    const textarea = document.getElementById('draft-text');
    if (!textarea) return;
    const tags = [...document.querySelectorAll('#tag-list .tag-chip')].map(el => el.dataset.tag);
    session.update(textarea.value, tags);
  },

  // One status pill: Saved / Saving… / Unsaved, with Retry when a save failed.
  renderEditorSaveStatus(session) {
    if (session !== this.editorSaveSession) return;
    const pill = document.getElementById('editor-save-pill');
    if (!pill) return;
    const view = editorSaveView(session);
    pill.dataset.state = view.state;
    const warn = session.dirty && session.storageFailed;
    pill.title = view.title + (warn ? ' Browser recovery is unavailable, so keep this page open until it saves.' : '');
    pill.innerHTML = `<span class="save-pill-dot" aria-hidden="true"></span><span class="save-pill-text">${escHtml(view.text)}${warn ? ' ⚠' : ''}</span>${view.action
      ? `<button type="button" class="save-pill-action" onclick="RecipeView.saveDraft({ advanceBeta: false })">${escHtml(view.action)}</button>`
      : ''}`;
    this.renderSaveTestButton(session);
  },

  // "Save as Test 5…" is off while the working copy still matches the last
  // test saved from it, or what it started from.
  renderSaveTestButton(session = this.editorSaveSession) {
    const button = document.getElementById('editor-test-btn');
    if (!button || !session) return;
    const reason = this.saveTestBlockedReason(session.value);
    button.disabled = !!reason;
    button.title = reason || `Save the working copy as ${this.recipe?.next_test_label}: a fixed sheet you can print and cook. You keep editing the working copy.`;
  },

  saveTestBlockedReason(value) {
    if (!value.text.trim()) return 'Write something first.';
    const draft = this.recipe?.draft;
    const same = (entry) => entry && entry.cooklang_text === value.text;
    const last = draft?.current_beta_version ? entryByKey(this.recipe, draft.current_beta_version) : null;
    if (same(last)) return `No changes since ${last.label}.`;
    const startedFrom = draft?.parent_version ? entryByKey(this.recipe, draft.parent_version) : null;
    if (same(startedFrom)) return `Nothing changed from ${startedFrom.label} yet.`;
    return '';
  },

  openWorkingCopyMenu(event, btn) {
    const draft = this.recipe?.draft;
    const current = this.recipe?.current_version;
    openActionMenu(event, btn, [
      {
        label: 'Release without testing…',
        title: `Make ${this.recipe?.next_version_string} straight from the working copy, without cooking it first`,
        onClick: () => this.openReleaseModal(),
      },
      draft?.base_version && entryByKey(this.recipe, draft.base_version)
        ? { label: `Reset to ${draft.base_version}…`, onClick: () => this.startNextBetaFrom(draft.base_version) }
        : (current ? { label: `Reset to ${current.label}…`, onClick: () => this.startNextBetaFrom(current.version_string) } : null),
    ]);
  },

  finishFixingVersion() {
    const key = this.fixingVersion;
    this.fixingVersion = null;
    this.activeTab = 'overview';
    this.renderDetail(document.getElementById('view-container'), key, { syncUrl: true, replaceUrl: true });
  },

  // "Save as Test 5…": asks what's being tested (prefilled from "New test…"),
  // saves the working copy as a fixed test, and opens it, ready to print.
  openSaveTestModal() {
    const draft = this.recipe?.draft;
    const reason = this.editorSaveSession ? this.saveTestBlockedReason(this.editorSaveSession.value) : '';
    if (reason) { showToast(reason); return; }
    const number = escHtml(this.recipe.next_test_label);
    showModal(`
      <div class="modal-title">Save as ${number}</div>
      <div class="field-group mt8">
        <label class="field-label" for="save-test-testing">What are you testing?</label>
        <input id="save-test-testing" class="field-input" placeholder="e.g. more water" maxlength="120" value="${escHtml(draft?.testing || '')}" />
        <small style="color:var(--ink2);font-size:0.78rem">One short phrase. It goes on the printout.</small>
      </div>
      <p class="text-muted" style="font-size:0.85rem;margin-top:10px">${number} is fixed once saved, so a printout always matches it. You can keep editing the working copy.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="save-test-go">Save ${number}</button>
      </div>`);
    const input = document.getElementById('save-test-testing');
    const go = () => this.saveAsTest(input?.value.trim() || '');
    document.getElementById('save-test-go')?.addEventListener('click', go);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => input?.select(), 60);
  },

  async saveAsTest(testing) {
    const previous = this.recipe?.draft?.current_beta_version || null;
    if (this.editorSaveSession && !(await this.saveDraft({ silent: true, advanceBeta: false }))) {
      showToast("Couldn't save the working copy first. Nothing was saved as a test.");
      return;
    }
    let saved;
    try {
      saved = await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/tests`, { testing });
    } catch (e) {
      showToast('Error: ' + e.message);
      return;
    }
    closeModal();
    await this.refreshRecipe();
    this.activeTab = 'overview';
    await this.renderDetail(document.getElementById('view-container'), saved.version_string, { syncUrl: true });
    if (!saved.created) { showToast(`No changes since ${saved.label}`); return; }
    showToast(`Saved ${saved.label}`, { action: { label: 'Undo', onClick: () => this.undoDraftBeta(saved.version_string, previous) } });
  },

  async undoDraftBeta(version, previous) {
    const label = entryLabelFor(this.recipe, version);
    try {
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/draft/undo-beta`, {
        version_string: version, previous_beta_version: previous,
      });
      await this.refreshRecipe();
      this.activeTab = 'editor';
      await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
      showToast(`Removed ${label}`);
    } catch (e) {
      showToast(`Couldn't undo: ${e.message}`);
    }
  },

  // Syntax and metadata help, together above the editor. Collapsible; the
  // choice is remembered per browser.
  // Open on the first visit, collapsed after that unless you leave it open.
  editorHelpHtml() {
    let open = true;
    try {
      const stored = window.localStorage.getItem('ajilab:editor-help');
      open = stored === null || stored === 'open';
      if (stored === null) window.localStorage.setItem('ajilab:editor-help', 'closed');
    } catch {}
    // The same list the import prompt teaches (import-prompt.js); the full
    // rule is on hover.
    const codes = (items) => items.filter((item) => item.help)
      .map((item) => `<code title="${escHtml(item.rule)}">${escHtml(item.code)}</code>`).join('');
    // Remember only your clicks (the initial open state also fires 'toggle').
    return `<details class="editor-help"${open ? ' open' : ''}>
      <summary onclick="RecipeView.rememberEditorHelp(!this.parentElement.open)">Syntax</summary>
      <div class="editor-help-body">
        <span class="editor-help-group">${codes(ImportPrompt.SYNTAX)}</span>
        <span class="editor-help-group">
          <span class="editor-help-label">Metadata</span>
          ${codes(ImportPrompt.METADATA)}
        </span>
        <span class="editor-help-note">Metadata goes between <code>---</code> lines at the top. <code>{=…}</code> keeps an amount fixed when scaling.</span>
      </div>
    </details>`;
  },

  rememberEditorHelp(open) {
    try { window.localStorage.setItem('ajilab:editor-help', open ? 'open' : 'closed'); } catch {}
  },

  // ── Preview follows the cursor ───────────────────────────────────────────────
  // Bring the step being edited into view in the preview, when the preview
  // scrolls on its own (side-by-side layout), and mark it.

  followEditorCursor(offset) {
    this.editorCursorOffset = offset;
    cancelAnimationFrame(this.followFrame);
    this.followFrame = requestAnimationFrame(() => this.applyPreviewFollow(true));
  },

  applyPreviewFollow(scroll) {
    const box = document.getElementById('draft-preview');
    const text = document.getElementById('draft-text')?.value;
    if (!box || text == null || this.editorCursorOffset == null) return;
    const spot = cooklangCursorSpot(text, this.editorCursorOffset);
    box.querySelectorAll('.preview-cursor').forEach((el) => el.classList.remove('preview-cursor'));
    const target = findPreviewTarget(box, spot);
    if (!target) return;
    if (target.classList.contains('step-item')) target.classList.add('preview-cursor');
    if (!scroll || box.scrollHeight <= box.clientHeight + 4 || getComputedStyle(box).overflowY === 'visible') return;
    const boxRect = box.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    if (spot.kind === 'frontmatter') {
      if (box.scrollTop > 0) box.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    if (rect.top >= boxRect.top + 8 && rect.bottom <= boxRect.bottom - 8) return; // already in view
    const top = box.scrollTop + (rect.top - boxRect.top) - box.clientHeight / 3;
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  },

  // ── Title check ──────────────────────────────────────────────────────────────
  // The text's `title:` and the recipe's name in AjiLab should agree; offer a
  // one-click fix either way.

  renderTitleNotice(preview) {
    const notice = document.getElementById('editor-title-notice');
    if (!notice) return;
    const written = String(preview?.metadata?.title ?? '').replace(/\s+/g, ' ').trim();
    const name = String(this.recipe?.title || '').replace(/\s+/g, ' ').trim();
    if (!written || !name || written === name) {
      notice.hidden = true;
      notice.innerHTML = '';
      return;
    }
    const wasOpen = notice.querySelector('.title-check-pop') && !notice.querySelector('.title-check-pop').hidden;
    notice.hidden = false;
    notice.innerHTML = `<button type="button" class="title-check-chip" aria-expanded="${wasOpen ? 'true' : 'false'}" onclick="RecipeView.toggleTitleCheck()">⚠ Title differs</button>
      <div class="title-check-pop" role="dialog" aria-label="Title differs"${wasOpen ? '' : ' hidden'}>
        <p>The <code>title:</code> line says <strong>${escHtml(written)}</strong>, but this recipe is called <strong>${escHtml(name)}</strong> in AjiLab.</p>
        <div class="title-check-actions">
          <button class="btn btn-sm" onclick="RecipeView.useRecipeNameInText()">Use “${escHtml(name)}” in the text</button>
          <button class="btn btn-sm" onclick="RecipeView.renameRecipeToText()" title="Its link changes to match the new name">Rename recipe to “${escHtml(written)}”</button>
        </div>
      </div>`;
  },

  toggleTitleCheck(force) {
    const chip = document.querySelector('#editor-title-notice .title-check-chip');
    const pop = document.querySelector('#editor-title-notice .title-check-pop');
    if (!chip || !pop) return;
    const open = typeof force === 'boolean' ? force : pop.hidden;
    pop.hidden = !open;
    chip.setAttribute('aria-expanded', String(open));
    document.removeEventListener('pointerdown', this.titleCheckOutside);
    document.removeEventListener('keydown', this.titleCheckOutside);
    if (!open) return;
    this.titleCheckOutside = (event) => {
      const inside = event.target?.closest?.('#editor-title-notice');
      if ((event.type === 'keydown' && event.key === 'Escape') || (event.type === 'pointerdown' && !inside)) this.toggleTitleCheck(false);
    };
    document.addEventListener('pointerdown', this.titleCheckOutside);
    document.addEventListener('keydown', this.titleCheckOutside);
  },

  useRecipeNameInText() {
    const textarea = document.getElementById('draft-text');
    if (!textarea) return;
    const next = replaceTitleLine(textarea.value, this.recipe.title);
    if (next === textarea.value) return;
    textarea.value = next;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    clearTimeout(this.titlePreviewTimer);
    this.titlePreviewTimer = setTimeout(() => this.updatePreview(), 50);
  },

  async renameRecipeToText() {
    const title = String(this.draftPreviewState?.metadata?.title || '').replace(/\s+/g, ' ').trim();
    if (!title) return;
    // Save first: the edit session is tied to the recipe's current link.
    if (this.editorSaveSession?.dirty && !(await this.saveDraft({ silent: true, advanceBeta: false }))) {
      showToast('Save your changes before renaming');
      return;
    }
    try {
      const res = await API.put(`/recipes/${this.slug}`, { title });
      showToast(`Renamed to ${title}`);
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
        // Amounts in steps follow the Overview's "Amounts in steps" setting.
        html += `<div class="section-head mt16">Steps</div>${CL.renderSteps(preview.steps, 1, preview.metadata, this.showAmounts !== false, {
          temperatureUnit: this.temperatureUnit,
          resolveTimerToken: timerResolver,
          resolveInlineQuantityToken: inlineResolver,
        })}`;
      }
      box.innerHTML = html || '<p class="text-muted" style="font-size:0.88rem">Nothing to preview yet.</p>';
      box.insertAdjacentHTML('beforeend', '<div class="draft-quantity-popover" id="draft-quantity-panel" hidden></div>');
      this.renderDraftQuantityPanel();
      this.renderTitleNotice(preview);
      this.applyPreviewFollow(false);
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
    const session = options.session || this.editorSaveSession;
    if (!session) return false;
    if (session === this.editorSaveSession) this.captureEditorChanges(session);
    const silent = options.silent === true;
    const advanceBeta = options.advanceBeta === true && session.target.kind === 'draft';
    const result = await session.save({ advanceBeta });
    if (!result.ok) {
      if (!silent) showToast('Error saving: ' + result.error.message);
      return false;
    }
    // A delayed response belongs to the captured target, not the current screen.
    if (session.target.slug !== this.slug || session.target.branch !== this.branchSlug || session.dirty) return true;
    const { response, value } = result;
    const text = value.text;
    const tags = value.tags;
    const target = session.target;
    try {
      if (target.kind === 'cook-log') {
        const nextTags = tags.slice();
        const list = this.cookLogs || [];
        const idx = list.findIndex((entry) => entry.id === target.key);
        if (idx >= 0) list[idx] = { ...list[idx], cooklang_text: text, tags: nextTags };
        if (this.activeVersion?._cookLogId === target.key) {
          this.activeVersion = { ...this.activeVersion, cooklang_text: text, tags: JSON.stringify(nextTags) };
        }
        if (session !== this.editorSaveSession || this.activeTab !== 'editor') return true;
        if (silent) return true;
        showToast('Cook saved');
        return true;
      }
      const nextTags = JSON.stringify(tags);
      if (target.kind === 'draft' && this.recipe?.draft) {
        this.recipe.draft = { ...this.recipe.draft, cooklang_text: text, tags: nextTags };
      }
      if (target.kind === 'version') {
        this.recipe.versions = (this.recipe.versions || []).map((version) => (
          version.version_string === target.key
            ? { ...version, cooklang_text: text, tags: nextTags }
            : version
        ));
      }
      if (this.activeVersion && !this.activeVersion._cookLogId
          && (this.activeVersion.is_draft ? 'draft' : this.activeVersion.version_string) === target.key) {
        this.activeVersion = { ...this.activeVersion, cooklang_text: text, tags: nextTags };
      }
      if (session !== this.editorSaveSession || this.activeTab !== 'editor') return true;
      if (silent) { this.maybeShowUnresolvedWarning(response, true); return true; }
      await this.refreshRecipe();
      if (session !== this.editorSaveSession || session.dirty) return true;
      // Stay on what you edited: after a beta snapshot you keep editing the
      // draft (the caller offers Undo).
      const createdBeta = target.kind === 'draft' && advanceBeta ? (response?.created_beta || null) : null;
      if (target.key) {
        await this.renderDetail(document.getElementById('view-container'), target.key, { syncUrl: true, replaceUrl: true });
      }
      if (advanceBeta && target.kind === 'draft') {
        if (!createdBeta) showToast(response?.snapshot_version ? `No changes since ${response.snapshot_version}` : 'Nothing to save yet');
        this.maybeShowUnresolvedWarning(response, false);
        return true;
      }
      if (!silent) showToast(target.kind === 'draft' ? 'Working copy saved' : 'Version saved');
      this.maybeShowUnresolvedWarning(response, false);
      return true;
    } catch (e) {
      if (!silent) showToast('Error saving: ' + e.message);
      return false;
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
    this.captureEditorChanges();
  },

  removeTag(el) {
    el.closest('.tag-chip')?.remove();
    this.captureEditorChanges();
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
