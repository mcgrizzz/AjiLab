// ── View: Recipe Index ────────────────────────────────────────────────────────
const IndexView = {
  async render(container) {
    container.innerHTML = `
      <div class="search-bar">
        <div class="search-wrap">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.3"/>
            <path d="M10 10L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          <input type="search" id="search-input" placeholder="Search recipes…" autocomplete="off" />
        </div>
      </div>
      <div id="recipe-list" class="recipe-list"></div>`;

    let debounce;
    document.getElementById('search-input').addEventListener('input', e => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.loadList(e.target.value.trim()), 280);
    });

    await this.loadList('');
  },

  async handleBackupFile(input) {
    const file = input.files?.[0];
    console.log('[import] file:', file?.name, file?.size);
    if (!file) return;

    const setStatus = (msg, isError = false) => {
      // Re-query each time in case the DOM changed
      const el = document.getElementById('backup-status');
      console.log('[import]', isError ? 'error:' : 'status:', msg, '| el found:', !!el);
      if (el) { el.style.color = isError ? 'var(--red,#c0392b)' : ''; el.textContent = msg; }
      else if (isError) alert('Import error: ' + msg);
    };

    setStatus('Importing… this may take a moment.');

    try {
      console.log('[import] building FormData');
      const form = new FormData();
      form.append('backup', file);

      console.log('[import] sending to /api/system/restore');
      const res = await fetch('/api/system/restore', { method: 'POST', body: form });
      console.log('[import] response:', res.status);

      const json = await res.json();
      console.log('[import] body:', json);

      if (!res.ok) throw new Error(json.error || `Server returned ${res.status}`);

      setStatus('Import complete — loading your recipes…');
      await this.loadList('');
    } catch (e) {
      console.error('[import] failed:', e);
      setStatus(e.message, true);
    }
  },

  async loadList(q) {
    const list = document.getElementById('recipe-list');
    list.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const recipes = await API.get(`/recipes${q ? '?q=' + encodeURIComponent(q) : ''}`);
      if (recipes.length === 0) {
        list.innerHTML = q
          ? `<div class="empty-state"><h2>No results</h2><p>Try a different search.</p></div>`
          : `<div class="empty-state">
              <h2>No recipes yet</h2>
              <p>Tap + to add your first recipe, or import from a backup.</p>
              <label for="backup-file-input" class="btn btn-sm mt12" style="cursor:pointer;display:inline-block">
                Import from backup
              </label>
              <input type="file" id="backup-file-input" accept=".dump"
                style="opacity:0;position:absolute;width:1px;height:1px;overflow:hidden"
                onchange="IndexView.handleBackupFile(this)" />
              <p id="backup-status" style="margin-top:12px;font-size:0.85rem;color:var(--ink3)"></p>
            </div>`;
        return;
      }
      list.innerHTML = recipes.map(r => {
        const badges = [];
        if (r.latest_released) badges.push(`<span class="badge badge-released">${escHtml(r.latest_released)}</span>`);
        if (r.latest_beta) badges.push(`<span class="badge badge-beta">${escHtml(r.latest_beta)} beta</span>`);
        if (!r.latest_released && !r.latest_beta) badges.push(`<span class="badge badge-draft">Draft</span>`);
        if (r.draft_change_label) badges.push(`<span class="badge badge-unsaved">${escHtml(r.draft_change_label)}</span>`);
        const thumb = r.thumbnail_image_id
          ? `<img src="/api/images/${r.thumbnail_image_id}" alt="${escHtml(r.title)}" loading="lazy" />`
          : '🍽';
        return `<div class="recipe-card" onclick="Router.go('/recipe/${escHtml(r.slug)}')">
          <div class="recipe-thumb">${thumb}</div>
          <div class="recipe-info">
            <div class="recipe-title">${escHtml(r.title)}</div>
            <div class="recipe-meta">${badges.join('')}</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="color:var(--ink3);flex-shrink:0">
            <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
        </div>`;
      }).join('');
    } catch (e) {
      list.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
    }
  },
};

// ── View: Recipe Detail ───────────────────────────────────────────────────────
const RecipeView = {
  slug: null,
  branchSlug: 'main',
  recipe: null,
  activeVersion: null,
  parsed: null,
  images: [],
  photosExpanded: false,
  photosExpandedVersionKey: null,
  scale: 1,
  activeTab: 'overview',
  cookMode: false,
  showAmounts: true,
  temperatureUnit: 'F',
  ingredientSummaryMode: null,
  draftEditor: null,
  draftQuantityTokens: [],
  selectedDraftTokenId: null,
  draftPreviewState: null,
  draftQuantityAnchor: null,
  cookLogs: [],
  cookLogsFilterVersion: null,
  historyFocusVersion: null,
  explicitVersionRequest: null,
  backlinks: [],

  async render(container, slug, opts = {}) {
    this.slug = slug;
    this.branchSlug = opts.branch || 'main';
    this.activeTab = opts.tab || 'overview';
    this.scale = 1;
    this.cookMode = false;
    this.showAmounts = true;
    this.temperatureUnit = 'F';
    this.ingredientSummaryMode = null;
    this.images = [];
    this.photosExpanded = false;
    this.photosExpandedVersionKey = null;
    this.draftQuantityTokens = [];
    this.selectedDraftTokenId = null;
    this.draftPreviewState = null;
    this.draftQuantityAnchor = null;
    this.cookLogs = [];
    this.cookLogsFilterVersion = null;
    this.historyFocusVersion = null;
    this.explicitVersionRequest = opts.version || null;
    this.backlinks = [];
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      await this.refreshRecipe();
    } catch {
      container.innerHTML = `<div class="empty-state"><p>Recipe not found.</p></div>`;
      return;
    }
    await this.renderDetail(container, opts.version || null);
  },

  async refreshRecipe() {
    this.recipe = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}`);
    this.branchSlug = this.recipe.branch_slug || this.branchSlug || 'main';
    try {
      this.backlinks = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/backlinks`);
    } catch {
      this.backlinks = [];
    }
  },

  selectedVersionKey() {
    if (!this.activeVersion) return this.recipe?.latest_released || this.recipe?.latest_beta || 'draft';
    return this.activeVersion.is_draft ? 'draft' : this.activeVersion.version_string;
  },

  recipePathFor(versionKey = this.selectedVersionKey()) {
    const base = versionKey && versionKey !== 'draft'
      ? `/recipe/${this.slug}/versions/${encodeURIComponent(versionKey)}`
      : `/recipe/${this.slug}`;
    return this.branchSlug && this.branchSlug !== 'main'
      ? `${base}?branch=${encodeURIComponent(this.branchSlug)}`
      : base;
  },

  printPathFor(versionKey = this.selectedVersionKey()) {
    const params = new URLSearchParams({ version: versionKey || 'draft' });
    if (this.branchSlug && this.branchSlug !== 'main') params.set('branch', this.branchSlug);
    return `/recipe/${this.slug}/print?${params.toString()}`;
  },

  syncVersionUrl(replace = false) {
    const nextPath = this.recipePathFor();
    const currentPath = location.pathname + location.search;
    if (currentPath === nextPath) return;
    if (replace) history.replaceState({}, '', nextPath);
    else history.pushState({}, '', nextPath);
  },

  async fetchVersion(versionStr) {
    if (versionStr === 'draft') return this.recipe.draft;
    if (versionStr) {
      try {
        return await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${versionStr}`);
      } catch {}
    }
    return this.defaultActiveVersion();
  },

  defaultActiveVersion() {
    if (this.activeTab === 'editor') {
      return this.recipe.active_experiment || this.recipe.draft || this.recipe.current_best_release || (this.recipe.source_version ? { ...this.recipe.source_version, is_inherited_source: true } : null);
    }
    return this.recipe.active_experiment
      || this.recipe.current_best_release
      || this.recipe.draft
      || (this.recipe.source_version ? { ...this.recipe.source_version, is_inherited_source: true } : null);
  },

  async loadParsed() {
    if (this.activeVersion?.cooklang_text) {
      this.parsed = await API.post(`/recipes/${this.slug}/draft/parse`, { cooklang_text: this.activeVersion.cooklang_text });
      this.ingredientSummaryMode = resolveIngredientSummaryMode(this.parsed, this.ingredientSummaryMode);
      return;
    }
    this.parsed = { ingredients: [], ingredient_summary: emptyIngredientSummary(), steps: [], cookwares: [], metadata: {} };
    this.ingredientSummaryMode = resolveIngredientSummaryMode(this.parsed, this.ingredientSummaryMode);
  },

  async loadImages() {
    const versionKey = this.activeVersion?.is_draft ? 'draft' : this.activeVersion?.version_string;
    try {
      this.images = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/images?version=${encodeURIComponent(versionKey || 'draft')}`);
    } catch {
      this.images = [];
    }
  },

  async renderDetail(container, versionStr, opts = {}) {
    this.activeVersion = await this.fetchVersion(versionStr);
    await this.loadParsed();
    await this.loadImages();
    if (opts.syncUrl) this.syncVersionUrl(!!opts.replaceUrl);
    this.renderScaffold(container);
    this.renderHeaderThumbnail();
    this.renderTab();
  },

  renderScaffold(container) {
    const recipe = this.recipe;
    const branches = recipe.branches || [];
    const branchOptions = branches.map((entry) => `
      <option value="${escHtml(entry.slug)}" ${entry.slug === this.branchSlug ? 'selected' : ''}>
        ${escHtml(entry.name)}${entry.kind === 'main' ? ' (main)' : ''}
      </option>`).join('');
    const branchSelect = branches.length > 1
      ? `<select class="version-select" onchange="RecipeView.switchBranch(this.value)">${branchOptions}</select>`
      : '';
    const statusBits = this.headerStatusBits();
    const tabCount = (n) => n > 0 ? `<span class="tab-count">· ${n}</span>` : '';
    const historyCount = recipe.counts ? (recipe.counts.releases_count + recipe.counts.betas_count) : 0;
    const cookLogsCount = recipe.counts?.cook_logs_count || 0;
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'editor', label: 'Editor' },
      { id: 'history', label: `History${tabCount(historyCount)}` },
      { id: 'cook-logs', label: `Cook Logs${tabCount(cookLogsCount)}` },
    ];

    container.innerHTML = `
      <div class="recipe-header">
        <div class="recipe-header-main">
          <div id="header-thumb-slot" class="header-thumb-slot"></div>
          <div class="recipe-header-copy">
            <h1 class="recipe-title-lg">${escHtml(recipe.title)}</h1>
            <div class="recipe-status-row">
              ${statusBits}
              ${branchSelect}
            </div>
          </div>
          <div class="recipe-header-actions">
            <button class="header-gear-btn" onclick="RecipeView.openSettingsModal()" aria-label="Recipe menu" title="Recipe menu">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3"></circle>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
              </svg>
            </button>
          </div>
        </div>
        <div class="tab-bar" role="tablist">
          ${tabs.map((tab) => `
            <button class="tab ${this.activeTab === tab.id ? 'active' : ''}" data-tab="${tab.id}" role="tab" onclick="RecipeView.setTab('${tab.id}')">${tab.label}</button>
          `).join('')}
        </div>
      </div>
      <div id="tab-body"></div>`;
  },

  headerStatusBits() {
    const recipe = this.recipe;
    const bits = [];
    const best = recipe.current_best_release;
    if (best) {
      bits.push(`<span class="badge badge-released">Best: ${escHtml(best.version_string || '')}</span>`);
    }
    if (!best && !recipe.active_experiment) {
      bits.push('<span class="badge badge-draft">No releases yet</span>');
    }
    return bits.join('');
  },

  setTab(tab) {
    // Leaving the editor tab exits cook-log edit mode so the next entry
    // doesn't re-bind to a stale log.
    if (tab !== 'editor' && this.cookLogEditingId) {
      this.cookLogEditingId = null;
      this.activeVersion = null;
    }
    this.activeTab = tab;
    if (tab !== 'history') this.historyFocusVersion = null;
    document.querySelectorAll('.tab[data-tab]').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    this.syncTabUrl();
    this.renderTab();
  },

  syncTabUrl() {
    const params = new URLSearchParams(location.search);
    if (this.activeTab && this.activeTab !== 'overview') params.set('tab', this.activeTab);
    else params.delete('tab');
    if (this.branchSlug && this.branchSlug !== 'main') params.set('branch', this.branchSlug);
    else params.delete('branch');
    const search = params.toString();
    const nextPath = location.pathname + (search ? `?${search}` : '');
    if (location.pathname + location.search === nextPath) return;
    history.replaceState({}, '', nextPath);
  },

  renderTab() {
    const body = document.getElementById('tab-body');
    if (!body) return;
    this.destroyDraftEditor();
    switch (this.activeTab) {
      case 'overview': this.renderOverviewTab(body); break;
      case 'editor': this.renderEditorTab(body); break;
      case 'history': this.renderHistoryTab(body); break;
      case 'cook-logs': this.renderCookLogsTab(body); break;
      default: this.renderOverviewTab(body);
    }
  },

  destroyDraftEditor() {
    if (this.draftEditor?.destroy) this.draftEditor.destroy();
    this.draftEditor = null;
  },

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
    const title = version?.is_draft
      ? 'Edit draft notes'
      : `Edit notes for ${version?.version_string}`;
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
    const scaleVal = document.getElementById('scale-val');
    if (scaleVal) scaleVal.textContent = `${s}×`;
    document.querySelectorAll('.scale-btn').forEach((button) => {
      button.classList.toggle('active', parseFloat(button.dataset.scale) === s);
    });
    const ingList = document.getElementById('ing-list');
    if (ingList && this.parsed) {
      ingList.innerHTML = CL.renderIngredientSummary(this.parsed.ingredient_summary, s, {
        mode: this.ingredientSummaryMode,
      });
    }
    const stepsList = document.getElementById('steps-list');
    if (stepsList && this.parsed) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, s, this.cookMode, this.parsed.metadata, this.showAmounts, {
        temperatureUnit: this.temperatureUnit,
      });
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
    if (this.activeTab === 'overview') {
      this.renderTab();
      return;
    }
    if (this.activeTab === 'editor') {
      this.updatePreview();
    }
  },

  toggleCookMode() {
    this.cookMode = !this.cookMode;
    const button = document.getElementById('cook-btn');
    if (button) button.textContent = this.cookMode ? '✓ Exit cook mode' : '▶ Cook mode';
    const stepsList = document.getElementById('steps-list');
    if (stepsList && this.parsed) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, this.scale, this.cookMode, this.parsed.metadata, this.showAmounts, {
        temperatureUnit: this.temperatureUnit,
      });
    }
  },

  toggleAmounts() {
    this.showAmounts = !this.showAmounts;
    const button = document.getElementById('amounts-btn');
    if (button) button.textContent = this.showAmounts ? '✓ Hide amounts' : '⊕ Show amounts';
    const stepsList = document.getElementById('steps-list');
    if (stepsList && this.parsed) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, this.scale, this.cookMode, this.parsed.metadata, this.showAmounts, {
        temperatureUnit: this.temperatureUnit,
      });
    }
  },

  toggleTemperatureUnit() {
    this.temperatureUnit = this.temperatureUnit === 'F' ? 'C' : 'F';
    const button = document.getElementById('temp-btn');
    if (button) {
      button.textContent = `Temps: °${this.temperatureUnit}`;
    }
    const stepsList = document.getElementById('steps-list');
    if (stepsList && this.parsed) {
      stepsList.innerHTML = CL.renderSteps(this.parsed.steps, this.scale, this.cookMode, this.parsed.metadata, this.showAmounts, {
        temperatureUnit: this.temperatureUnit,
      });
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
        if (!isNaN(val) && val > 0) {
          this.setScale(val / orig);
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
    await this.renderDetail(document.getElementById('view-container'), value, { syncUrl: true });
  },

  async switchBranch(value) {
    this.branchSlug = value || 'main';
    this.activeVersion = null;
    await this.refreshRecipe();
    await this.renderDetail(document.getElementById('view-container'), null, { syncUrl: true });
  },

  getEditableVersion() {
    if (this.activeVersion?._cookLogId) return this.activeVersion;
    if (this.activeVersion?.is_draft || this.activeVersion?.status === 'beta') {
      return this.activeVersion;
    }
    return this.recipe?.draft || null;
  },

  editTargetLabel() {
    const editable = this.getEditableVersion();
    if (!editable) return 'No editable version';
    if (editable._cookLogId) {
      const log = editable._cookLog;
      const sourceLabel = log?.source_kind === 'draft'
        ? 'draft'
        : (log?.source_version_string || 'unknown source');
      return `Editing cook log${log?.outcome ? ` — ${log.outcome}` : ''} (from ${sourceLabel})`;
    }
    if (editable.is_draft) return 'Editing Draft';
    if (editable.status === 'beta') return `Editing ${editable.version_string}`;
    return `Editing ${editable.version_string || 'version'}`;
  },

  cookLogToEditableTarget(log) {
    return {
      _cookLogId: log.id,
      _cookLog: log,
      cooklang_text: log.cooklang_text || '',
      tags: JSON.stringify(log.tags || []),
      is_draft: false,
      status: 'cook-log',
      version_string: null,
    };
  },

  editCookLogRecipe(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) {
      showToast('Cook log not found');
      return;
    }
    this.cookLogEditingId = logId;
    this.activeVersion = this.cookLogToEditableTarget(log);
    this.setTab('editor');
  },

  exitCookLogEdit() {
    this.cookLogEditingId = null;
    this.activeVersion = null;
    this.setTab('cook-logs');
  },

  releaseSourceVersionKey() {
    if (this.activeVersion?.status === 'beta' && this.activeVersion?.version_string) {
      return this.activeVersion.version_string;
    }
    return 'draft';
  },

  imageTargetLabel() {
    const target = this.activeVersion;
    if (!target) return 'this version';
    if (target.is_draft) return 'Draft';
    return `${target.version_string} (${target.status})`;
  },

  async viewVersion(versionString) {
    await this.switchVersion(versionString);
    this.setTab('overview');
  },

  async forkVersionAndEdit(versionString) {
    try {
      const target = versionString || this.activeVersion?.version_string;
      if (!target) {
        showToast('No version to fork');
        return;
      }
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
    if (this.recipe.current_best_release) {
      await this.forkCurrentBranchHead();
      return;
    }
    this.activeTab = 'editor';
    this.activeVersion = this.recipe.draft;
    await this.renderDetail(document.getElementById('view-container'), 'draft', { syncUrl: true, replaceUrl: true });
  },

  openPrintView() {
    Router.go(this.printPathFor());
  },

  async editVersion() {
    const version = this.activeVersion;
    if (!version || version.is_draft) return;
    showModal(`
      <div class="modal-title">Edit ${escHtml(version.version_string)}</div>
      <p class="text-muted" style="font-size:0.85rem;margin-bottom:12px">
        This will permanently modify the released version. This cannot be undone.
      </p>
      <textarea id="edit-ver-text" class="editor-textarea" style="min-height:200px">${escHtml(version.cooklang_text)}</textarea>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-danger" onclick="RecipeView.saveVersion()">Save changes</button>
      </div>`);
  },

  async saveVersion() {
    const text = document.getElementById('edit-ver-text')?.value;
    if (text === undefined) return;
    try {
      await API.put(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(this.activeVersion.version_string)}`, { cooklang_text: text });
      closeModal();
      await this.refreshRecipe();
      await this.renderDetail(document.getElementById('view-container'), this.activeVersion.version_string, { syncUrl: true, replaceUrl: true });
      showToast('Version updated');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  renderVersionsListHtml() {
    const versions = (this.recipe.versions || []).filter((entry) => !entry.is_draft);
    if (versions.length === 0) {
      return `<div class="empty-state" style="padding:40px 0">
        <p>No released versions yet. Open the Editor to start writing.</p>
        <button class="btn mt12" onclick="RecipeView.setTab('editor')">Open Editor</button>
      </div>`;
    }
    return `<div id="versions-list">${versions.map((version) => `
      <div class="version-item${this.historyFocusVersion === version.version_string ? ' version-item-focus' : ''}" data-version="${escHtml(version.version_string)}">
        <div class="version-dot ${version.status}"></div>
        <div style="flex:1">
          <div class="version-label">${escHtml(version.version_string)}</div>
          <div class="version-date">${fmtDate(version.created_at)} · <span class="badge badge-${version.status}">${version.status}</span></div>
          ${version.changelog ? `<div class="version-changelog">${escHtml(version.changelog)}</div>` : ''}
        </div>
        <div class="version-actions">
          <button class="btn btn-sm" onclick="RecipeView.viewVersion('${escJs(version.version_string)}')">View</button>
          <button class="btn btn-sm" onclick="RecipeView.startNextBetaFrom('${escJs(version.version_string)}')" title="Start next beta from this release">Iterate</button>
          <button class="btn btn-sm btn-danger" onclick="RecipeView.openDeleteVersionModal('${escJs(version.version_string)}')">Delete</button>
        </div>
      </div>`).join('')}</div>`;
  },

  openDeleteVersionModal(versionString) {
    showModal(`
      <div class="modal-title">Delete ${escHtml(versionString)}</div>
      <p class="text-muted" style="font-size:0.85rem">
        This removes the stored snapshot for ${escHtml(versionString)}. Type the exact version string to enable deletion.
      </p>
      <div class="field-group mt12">
        <label class="field-label">Confirm version string</label>
        <input id="delete-version-confirm" class="field-input" placeholder="${escHtml(versionString)}" oninput="RecipeView.toggleDeleteVersionConfirm('${escJs(versionString)}')" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button id="delete-version-btn" class="btn btn-danger" onclick="RecipeView.confirmDeleteVersion('${escJs(versionString)}')" disabled>Delete version</button>
      </div>`);
  },

  toggleDeleteVersionConfirm(versionString) {
    const input = document.getElementById('delete-version-confirm');
    const button = document.getElementById('delete-version-btn');
    if (!input || !button) return;
    button.disabled = input.value !== versionString;
  },

  async confirmDeleteVersion(versionString) {
    const wasSelected = this.selectedVersionKey() === versionString;
    try {
      await API.delete(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(versionString)}`);
      closeModal();
      const previousFallback = this.recipe.draft ? 'draft' : null;
      await this.refreshRecipe();
      const fallback = wasSelected
        ? (this.recipe.draft ? 'draft' : (this.recipe.latest_released || this.recipe.latest_beta || this.recipe.versions?.[0]?.version_string || null))
        : this.selectedVersionKey();
      await this.renderDetail(document.getElementById('view-container'), fallback || previousFallback, { syncUrl: true, replaceUrl: true });
      showToast('Version deleted');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  compareSectionHtml() {
    const versions = (this.recipe.versions || []).filter((entry) => !entry.is_draft);
    const options = [
      ...(this.recipe.draft ? [{ val: 'draft', label: 'Draft' }] : []),
      ...versions.map((version) => ({ val: version.version_string, label: `${version.version_string} (${version.status})` })),
    ];
    if (options.length < 2) {
      return `<div class="text-muted" style="padding:12px 0;font-size:0.88rem">Need at least 2 versions to compare.</div>`;
    }
    const opts = (selected) => options.map((option) => `
      <option value="${escHtml(option.val)}" ${option.val === selected ? 'selected' : ''}>${escHtml(option.label)}</option>`).join('');
    const fromVal = options.length >= 2 ? options[options.length - 2].val : options[0].val;
    const toVal = this.selectedVersionKey() || options[0].val;
    return `
      <div class="compare-selectors">
        <select id="cmp-from">${opts(fromVal)}</select>
        <span class="vs">→</span>
        <select id="cmp-to">${opts(toVal)}</select>
        <button class="btn btn-sm" onclick="RecipeView.runCompare()">Compare</button>
      </div>
      <div id="compare-result"><div class="loading"><div class="spinner"></div></div></div>`;
  },

  async runCompare() {
    const from = document.getElementById('cmp-from')?.value;
    const to = document.getElementById('cmp-to')?.value;
    const result = document.getElementById('compare-result');
    if (!from || !to || !result) return;
    result.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const cmp = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      this.renderCompareResult(result, cmp);
    } catch (e) {
      result.innerHTML = `<div class="tab-content"><p class="text-muted">Error: ${escHtml(e.message)}</p></div>`;
    }
  },

  renderCompareResult(el, cmp) {
    const renderGroup = (title, rows, renderRow) => {
      if (!rows.length) return '';
      return `
        <div class="diff-group">
          <div class="diff-subtitle">${escHtml(title)}</div>
          ${rows.map(renderRow).join('')}
        </div>`;
    };

    const idiff = cmp.ingredient_diff || { changed: [], removed: [], added: [] };
    const ingHtml = (!idiff.changed?.length && !idiff.removed?.length && !idiff.added?.length)
      ? '<p class="text-muted" style="font-size:0.88rem">No ingredient changes.</p>'
      : [
        renderGroup('Changes', idiff.changed || [], (row) => {
          const suffix = row.percent_change === null ? '[CHANGED]' : formatPercentChange(row.percent_change);
          return `<div class="diff-changed">${escHtml(row.name)} ${escHtml(row.from_display)} → ${escHtml(row.to_display)} <span class="diff-row-meta">${escHtml(suffix)}</span></div>`;
        }),
        renderGroup('Removals', idiff.removed || [], (row) => (
          `<div class="diff-removed">- ${escHtml(row.from_display)} ${escHtml(row.name)}</div>`
        )),
        renderGroup('Additions', idiff.added || [], (row) => (
          `<div class="diff-added">+ ${escHtml(row.to_display)} ${escHtml(row.name)}</div>`
        )),
      ].join('');

    const stepChanges = Array.isArray(cmp.step_changes) ? cmp.step_changes : [];
    const stepChangesHtml = stepChanges.length === 0
      ? '<p class="text-muted" style="font-size:0.88rem">No step changes.</p>'
      : this.renderStepChanges(stepChanges);

    const patchHtml = this.renderInlineDiffPatch(cmp);

    el.innerHTML = `
      <div class="diff-section">
        <div class="diff-title">Step changes</div>
        ${stepChangesHtml}
      </div>
      <div class="diff-section">
        <div class="diff-title">Ingredients (totals)</div>
        ${ingHtml}
      </div>
      <details class="diff-section">
        <summary class="diff-title" style="cursor:pointer">Raw text diff</summary>
        <div class="diff-patch">${patchHtml}</div>
      </details>`;
  },

  renderStepChanges(changes) {
    const renderInline = (tokens) => (tokens || []).map((token) => {
      if (token.op === 'context') return escHtml(token.text);
      if (token.op === 'replace') {
        // A coalesced change region. Render as old → new so the swap reads
        // unambiguously even when no internal separator would otherwise exist.
        const del = token.removed
          ? `<span class="diff-token-del">${escHtml(token.removed)}</span>`
          : '';
        const ins = token.added
          ? `<span class="diff-token-add">${escHtml(token.added)}</span>`
          : '';
        if (del && ins) return `${del}<span class="diff-arrow"> → </span>${ins}`;
        return del || ins;
      }
      // Back-compat: stand-alone removed/added (e.g. patch-line renderer reuse).
      const tcls = token.op === 'removed' ? 'diff-token-del' : 'diff-token-add';
      return `<span class="${tcls}">${escHtml(token.text)}</span>`;
    }).join('');

    // One line per change. The section + step number sits in a small left-side
    // label; the changed sentence reads inline with strike/highlight tokens.
    return `<ul class="step-diff-list">${changes.map((change) => {
      const sectionLabel = change.section_name ? `${change.section_name} · ` : '';
      const stepLabel = change.block_kind === 'note'
        ? 'Note'
        : (change.step_number ? `Step ${change.step_number}` : 'Step');
      const prefix = `<span class="step-diff-prefix">${escHtml(sectionLabel + stepLabel)}</span>`;
      let body;
      let cls;
      if (change.kind === 'modified') {
        cls = 'step-diff-modified';
        body = renderInline(change.inline_tokens);
      } else if (change.kind === 'removed') {
        cls = 'step-diff-removed';
        body = `<span class="diff-token-del">${escHtml(change.text)}</span>`;
      } else {
        cls = 'step-diff-added';
        body = `<span class="diff-token-add">${escHtml(change.text)}</span>`;
      }
      return `<li class="step-diff-row ${cls}">${prefix}<span class="step-diff-body">${body}</span></li>`;
    }).join('')}</ul>`;
  },

  renderInlineDiffPatch(cmp) {
    // Prefer the structured token-pair stream when the server provides it;
    // fall back to the old line-level coloring for back-compat.
    const lines = Array.isArray(cmp.text_diff_lines) ? cmp.text_diff_lines : null;
    if (!lines) {
      return (cmp.text_diff || '').split('\n').map((line) => {
        if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@')) return `<span class="diff-line-hdr">${escHtml(line)}</span>`;
        if (line.startsWith('+')) return `<span class="diff-line-add">${escHtml(line)}</span>`;
        if (line.startsWith('-')) return `<span class="diff-line-del">${escHtml(line)}</span>`;
        return `<span class="diff-line-ctx">${escHtml(line)}</span>`;
      }).join('\n');
    }
    return lines.map((entry) => {
      if (entry.kind === 'header' || entry.kind === 'hunk') {
        return `<span class="diff-line-hdr">${escHtml(entry.text)}</span>`;
      }
      if (entry.kind === 'context') {
        return `<span class="diff-line-ctx">${escHtml(entry.text)}</span>`;
      }
      const cls = entry.kind === 'removed' ? 'diff-line-del' : 'diff-line-add';
      const tokens = (entry.tokens || []).map((token) => {
        if (token.op === 'context') return escHtml(token.text);
        const tcls = token.op === 'removed' ? 'diff-token-del' : 'diff-token-add';
        return `<span class="${tcls}">${escHtml(token.text)}</span>`;
      }).join('');
      return `<span class="${cls}">${escHtml(entry.prefix || '')}${tokens}</span>`;
    }).join('\n');
  },

  renderEditorTab(body) {
    // If we entered via "Edit recipe" on a cook log, use that as the target;
    // otherwise fall back to the draft / active experiment.
    let cookLogTarget = null;
    if (this.cookLogEditingId) {
      const log = (this.cookLogs || []).find((entry) => entry.id === this.cookLogEditingId);
      if (log) cookLogTarget = this.cookLogToEditableTarget(log);
      else this.cookLogEditingId = null;
    }
    const experimentTarget = cookLogTarget
      || this.recipe.active_experiment
      || this.recipe.draft
      || null;
    if (experimentTarget && experimentTarget !== this.activeVersion) {
      this.activeVersion = experimentTarget;
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
    if (this.selectedDraftTokenId === tokenId) {
      this.clearDraftQuantitySelection();
      return;
    }
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
    const next = Number.isFinite(current)
      ? current * multiplier
      : fallbackPercent;
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
    const nextValue = this.getDraftQuantityPendingValue();
    preview.textContent = nextValue || token.quantityText;
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
      const timerResolver = makeDraftTokenResolver(
        this.draftQuantityTokens.filter((token) => token.kind === 'timer')
      );
      const inlineResolver = makeDraftTokenResolver(
        this.draftQuantityTokens.filter((token) => token.kind === 'inlineQuantity')
      );
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
        html += `<div class="section-head mt16">Steps</div>${CL.renderSteps(preview.steps, 1, false, preview.metadata, false, {
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
        // Mirror back into local state so the preview stays consistent.
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
      if (silent) {
        this.maybeShowUnresolvedWarning(response, true);
        return;
      }
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
    const message = `Unresolved references: ${names.join(', ')}`;
    if (silent) {
      // Surface even on autosave so the user notices typos right away
      showToast(message);
    } else {
      showToast(message);
    }
  },

  addTag() {
    const input = document.getElementById('tag-input');
    if (!input) return;
    const val = input.value.trim();
    if (!val) return;
    const existing = [...document.querySelectorAll('#tag-list .tag-chip')].map((el) => el.dataset.tag);
    if (existing.includes(val)) {
      input.value = '';
      return;
    }
    const list = document.getElementById('tag-list');
    const chip = document.createElement('div');
    chip.innerHTML = tagChip(val);
    list.appendChild(chip.firstElementChild);
    input.value = '';
  },

  removeTag(el) {
    el.closest('.tag-chip')?.remove();
  },

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

  openReleaseModal() {
    const versions = (this.recipe.versions || []).filter((entry) => !entry.is_draft);
    const lastVersion = versions[0]?.version_string;
    const sourceVersion = this.releaseSourceVersionKey();
    const sourceLabel = sourceVersion === 'draft' ? 'Draft' : sourceVersion;
    showModal(`
      <div class="modal-title">${sourceVersion === 'draft' ? 'Release version' : `Promote ${escHtml(sourceLabel)}`}</div>
      <div class="field-group mt8">
        <label class="field-label">Version number</label>
        <input id="rel-version" class="field-input" placeholder="e.g. v1.0, v1.1, v2.0-beta.1" value="${lastVersion ? suggestNextVersion(lastVersion) : 'v1.0'}" />
        ${lastVersion ? `<small style="color:var(--ink3);font-size:0.78rem;margin-top:4px">Previous: ${escHtml(lastVersion)}</small>` : ''}
      </div>
      <div class="field-group mt12">
        <label class="field-label">Status</label>
        <select id="rel-status" class="field-input">
          <option value="released">Released (stable)</option>
          <option value="beta">Beta</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      <div class="field-group mt12">
        <label class="field-label">Changelog</label>
        <textarea id="rel-changelog" class="field-input" placeholder="What changed in this version?"></textarea>
      </div>
      <div class="text-muted" style="font-size:0.82rem;margin-top:10px">Source: ${escHtml(sourceLabel)}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.release()">Release</button>
      </div>`);
    setTimeout(() => document.getElementById('rel-version')?.select(), 100);
  },

  async release() {
    const sourceVersion = this.releaseSourceVersionKey();
    if (sourceVersion === 'draft') {
      await this.saveDraft({ silent: true, advanceBeta: false });
    }
    const versionString = document.getElementById('rel-version')?.value.trim();
    const status = document.getElementById('rel-status')?.value;
    const changelog = document.getElementById('rel-changelog')?.value.trim();
    if (!versionString) {
      showToast('Version number required');
      return;
    }
    try {
      const response = await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/release`, { version_string: versionString, status, changelog, source_version: sourceVersion });
      closeModal();
      await this.refreshRecipe();
      await this.renderDetail(document.getElementById('view-container'), versionString, { syncUrl: true, replaceUrl: true });
      showToast(`Released ${versionString}`);
      this.maybeShowUnresolvedWarning(response, false);
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

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

  async renderOverviewTab(body) {
    const recipe = this.recipe;
    const expt = recipe.active_experiment;
    const best = recipe.current_best_release;
    if (!this.explicitVersionRequest) {
      const desired = this.defaultActiveVersion();
      if (desired && desired !== this.activeVersion) {
        this.activeVersion = desired;
        await this.loadParsed();
        await this.loadImages();
      }
    }
    const primary = this.activeVersion;
    const hasRealPrimary = !!(expt || best || (primary && primary.cooklang_text && primary.cooklang_text.trim()));
    if (!primary || !hasRealPrimary) {
      body.innerHTML = `
        <div class="tab-content">
          <div class="empty-state" style="padding:48px 0">
            <h2>No releases yet</h2>
            <p>Start a fresh draft and release v1.0 to begin the improvement loop.</p>
            <button class="btn btn-primary mt12" onclick="RecipeView.startFreshDraft()">Start a draft</button>
          </div>
        </div>`;
      return;
    }
    const isExperimentPrimary = !!(expt && primary === expt);
    const primaryLabel = isExperimentPrimary
      ? (primary.is_draft
          ? 'In progress · Draft'
          : `In progress · ${escHtml(primary.version_string || '')} (${escHtml(primary.status)})`)
      : (primary.version_string
          ? `Current best · ${escHtml(primary.version_string)} (${escHtml(primary.status)})`
          : 'Current best');
    const primaryBanner = this.overviewPrimaryBannerHtml(primary, primaryLabel, isExperimentPrimary, best);
    const sidebarHtml = this.overviewSidebarHtml();
    body.innerHTML = `
      <div class="tab-content overview-tab">
        <div class="overview-grid">
          <div class="overview-primary">
            ${primaryBanner}
            ${this.recipeBodyHtml()}
          </div>
          <aside class="overview-sidebar">
            ${sidebarHtml}
          </aside>
        </div>
      </div>`;
    this.renderImageManager();
  },

  overviewPrimaryBannerHtml(primary, primaryLabel, isExperimentPrimary, best) {
    const badgeClass = primary.is_draft ? 'draft' : primary.status;
    const actions = [];
    if (isExperimentPrimary) {
      const releaseLabel = primary.is_draft
        ? 'Release version…'
        : `Promote ${escHtml(primary.version_string || 'beta')}…`;
      actions.push(`<button class="btn btn-sm btn-primary" onclick="RecipeView.openReleaseModal()">${releaseLabel}</button>`);
      if (best) {
        actions.push(`<button class="btn btn-sm" onclick="RecipeView.setTab('editor')">Open Editor</button>`);
      }
    }
    return `<div class="overview-primary-banner">
      <span class="badge badge-${badgeClass}">${primaryLabel}</span>
      ${actions.length ? `<div class="overview-primary-banner-actions">${actions.join('')}</div>` : ''}
    </div>`;
  },

  overviewSidebarHtml() {
    const recipe = this.recipe;
    const bestEmpty = !recipe.current_best_release;
    const logEmpty = !recipe.latest_cook_log;
    const backlinksCard = this.overviewBacklinksCardHtml();
    if (bestEmpty && logEmpty) {
      const expt = recipe.active_experiment;
      const quiet = `<div class="overview-sidebar-card overview-sidebar-card-quiet">
        <div class="overview-sidebar-card-title">Set a baseline</div>
        <p class="text-muted" style="font-size:0.85rem;margin:0">Release this version to set a current best. Cook it to log feedback.</p>
        <div class="overview-sidebar-card-actions">
          ${expt ? `<button class="btn btn-sm" onclick="RecipeView.openReleaseModal()">Release…</button>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="RecipeView.setTab('cook-logs')">Cook Logs →</button>
        </div>
      </div>`;
      return `${quiet}${backlinksCard}`;
    }
    return `${bestEmpty ? '' : this.overviewBestCardHtml()}${logEmpty ? '' : this.overviewCookCardHtml()}${backlinksCard}`;
  },

  overviewBacklinksCardHtml() {
    const backlinks = Array.isArray(this.backlinks) ? this.backlinks : [];
    if (!backlinks.length) return '';
    const items = backlinks.map((entry) => {
      const url = `/recipe/${encodeURIComponent(entry.from_slug)}`;
      const jsUrl = String(url).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const pinSuffix = entry.pinned && entry.from_version
        ? ` <span class="ref-pin">@${escHtml(entry.from_version)}</span>`
        : '';
      return `<a href="${escHtml(url)}" onclick="event.preventDefault(); Router.go('${jsUrl}')">${escHtml(entry.from_title)}${pinSuffix}</a>`;
    }).join('');
    return `<div class="overview-sidebar-card">
      <div class="overview-sidebar-card-title">Used by</div>
      <div class="overview-backlinks-list">${items}</div>
    </div>`;
  },

  overviewBestCardHtml() {
    const recipe = this.recipe;
    const best = recipe.current_best_release;
    const expt = recipe.active_experiment;
    if (!best) {
      return `<div class="overview-sidebar-card">
        <div class="overview-sidebar-card-title">Current Best</div>
        <p class="text-muted" style="font-size:0.86rem">No releases yet. Open the Editor to start writing and release this recipe.</p>
        ${expt ? `<button class="btn btn-sm" onclick="RecipeView.setTab('editor')">Open Editor</button>` : ''}
      </div>`;
    }
    const changelogSnippet = (best.changelog || '').trim().slice(0, 140);
    const showOpen = expt; // only show "Open in History" when the primary isn't the current best
    return `<div class="overview-sidebar-card">
      <div class="overview-sidebar-card-title">Current Best</div>
      <div class="overview-best-line"><span class="badge badge-released">${escHtml(best.version_string || '')}</span><span class="text-muted" style="font-size:0.82rem">${fmtDate(best.created_at)}</span></div>
      ${changelogSnippet ? `<p class="overview-best-changelog">${escHtml(changelogSnippet)}${(best.changelog || '').length > 140 ? '…' : ''}</p>` : ''}
      <div class="overview-sidebar-card-actions">
        ${showOpen ? `<button class="btn btn-sm" onclick="RecipeView.focusVersionInHistory('${escJs(best.version_string)}')">Open in History →</button>` : ''}
        <button class="btn btn-sm" onclick="RecipeView.startNextBetaFrom('${escJs(best.version_string)}')">Start next beta</button>
      </div>
    </div>`;
  },

  overviewCookCardHtml() {
    const log = this.recipe.latest_cook_log;
    if (!log) {
      return `<div class="overview-sidebar-card">
        <div class="overview-sidebar-card-title">Latest Cook Log</div>
        <p class="text-muted" style="font-size:0.86rem">No cook logs yet.</p>
        <div class="overview-sidebar-card-actions">
          <button class="btn btn-sm" onclick="RecipeView.setTab('cook-logs')">Open Cook Logs →</button>
        </div>
      </div>`;
    }
    return `<div class="overview-sidebar-card">
      <div class="overview-sidebar-card-title">Latest Cook Log</div>
      <div class="overview-cook-outcome">${escHtml(log.outcome || '(no outcome)')}</div>
      <div class="text-muted" style="font-size:0.82rem">${fmtDate(log.cooked_at)} · <span class="badge badge-released">${escHtml(log.version_string)}</span></div>
      <div class="overview-sidebar-card-actions">
        <button class="btn btn-sm" onclick="RecipeView.setTab('cook-logs')">View all →</button>
      </div>
    </div>`;
  },

  focusVersionInHistory(versionString) {
    this.historyFocusVersion = versionString;
    this.setTab('history');
  },

  renderHistoryTab(body) {
    const variants = (this.recipe.branches || []).filter((branch) => branch.kind === 'variant');
    body.innerHTML = `
      <div class="tab-content history-tab">
        <div class="history-section">
          <div class="history-section-title">Releases &amp; betas</div>
          ${this.renderVersionsListHtml()}
        </div>
        ${variants.length ? `
        <div class="history-section">
          <div class="history-section-title">Variant branches</div>
          <div class="history-variant-list">
            ${variants.map((variant) => `
              <div class="history-variant-row">
                <div>
                  <div class="version-label">${escHtml(variant.name)}</div>
                  <div class="version-date">forked from ${escHtml(variant.forked_from_version_id || 'unknown')}</div>
                </div>
                <button class="btn btn-sm" onclick="RecipeView.switchBranch('${escJs(variant.slug)}')">Open</button>
              </div>`).join('')}
          </div>
        </div>` : ''}
        <details class="history-section history-compare-section" ${this.historyFocusVersion ? '' : ''}>
          <summary>Compare versions</summary>
          <div class="history-compare-body">${this.compareSectionHtml()}</div>
        </details>
      </div>`;
    if (this.compareSectionHtml().includes('cmp-from')) {
      // user must open <details> first; do not auto-run compare on load
    }
    if (this.historyFocusVersion) {
      const safeVersion = (window.CSS && CSS.escape) ? CSS.escape(this.historyFocusVersion) : this.historyFocusVersion.replace(/"/g, '\\"');
      const target = body.querySelector(`.version-item[data-version="${safeVersion}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('version-item-focus');
      }
    }
  },

  async renderCookLogsTab(body) {
    body.innerHTML = `<div class="tab-content"><div class="loading"><div class="spinner"></div></div></div>`;
    try {
      this.cookLogs = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs`);
    } catch (e) {
      body.innerHTML = `<div class="tab-content"><div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div></div>`;
      return;
    }
    await this.parseCookLogsAhead();
    this.paintCookLogs(body);
  },

  async parseCookLogsAhead() {
    const logs = Array.isArray(this.cookLogs) ? this.cookLogs : [];
    if (!this.cookLogParsed) this.cookLogParsed = {};
    const stale = Object.keys(this.cookLogParsed).filter((id) => !logs.some((log) => log.id === id));
    for (const id of stale) delete this.cookLogParsed[id];
    await Promise.all(logs.map(async (log) => {
      const cached = this.cookLogParsed[log.id];
      if (cached && cached.text === log.cooklang_text) return;
      if (!log.cooklang_text) {
        this.cookLogParsed[log.id] = { text: '', parsed: null };
        return;
      }
      try {
        const parsed = await API.post(`/recipes/${this.slug}/draft/parse`, { cooklang_text: log.cooklang_text });
        this.cookLogParsed[log.id] = { text: log.cooklang_text, parsed };
      } catch {
        this.cookLogParsed[log.id] = { text: log.cooklang_text, parsed: null };
      }
    }));
  },

  cookLogSourceLabel(log) {
    if (log.source_kind === 'draft') return 'from draft';
    return log.source_version_string ? `from ${log.source_version_string}` : 'from draft';
  },

  cookLogSourceKey(log) {
    return log.source_kind === 'draft' ? '__draft__' : (log.source_version_string || '__draft__');
  },

  paintCookLogs(body) {
    const logs = Array.isArray(this.cookLogs) ? this.cookLogs : [];
    const filter = this.cookLogsFilterVersion;
    const filtered = filter ? logs.filter((log) => this.cookLogSourceKey(log) === filter) : logs;
    const keysInUse = Array.from(new Set(logs.map((log) => this.cookLogSourceKey(log))));
    const chips = keysInUse.length > 1 ? `
      <div class="cook-log-version-chips">
        <button class="cook-log-chip${!filter ? ' active' : ''}" onclick="RecipeView.setCookLogFilter(null)">All</button>
        ${keysInUse.map((key) => {
          const label = key === '__draft__' ? 'Draft' : key;
          return `<button class="cook-log-chip${filter === key ? ' active' : ''}" onclick="RecipeView.setCookLogFilter('${escJs(key)}')">${escHtml(label)}</button>`;
        }).join('')}
      </div>` : '';
    const newButton = `<button class="btn btn-primary" onclick="RecipeView.openCookLogModal()">New cook log</button>`;
    const empty = filtered.length === 0
      ? `<div class="empty-state" style="padding:36px 0">
          <p>${logs.length === 0 ? 'No cook logs yet.' : 'No logs for this source.'}</p>
        </div>`
      : '';
    body.innerHTML = `
      <div class="tab-content cook-logs-tab">
        <div class="cook-logs-head">
          <div>
            <div class="section-head">Cook Logs</div>
            <div class="text-muted" style="font-size:0.85rem">${logs.length} log${logs.length === 1 ? '' : 's'} on this branch</div>
          </div>
          ${newButton}
        </div>
        ${chips}
        ${empty || `<div class="cook-log-feed">${filtered.map((log) => this.cookLogCardHtml(log)).join('')}</div>`}
      </div>`;
  },

  cookLogCardHtml(log) {
    const fields = [
      { key: 'what_worked', label: 'What worked' },
      { key: 'problems_found', label: 'Problems found' },
      { key: 'changes_to_try_next', label: 'Changes to try next' },
    ];
    const filledFields = fields.filter((f) => (log[f.key] || '').trim());
    const detailHtml = filledFields.length || (log.freeform_notes || '').trim()
      ? `<details class="cook-log-details">
          <summary>Details</summary>
          <dl class="cook-log-fields">
            ${filledFields.map((f) => `<dt>${escHtml(f.label)}</dt><dd>${formatMultilineText(log[f.key])}</dd>`).join('')}
            ${(log.freeform_notes || '').trim() ? `<dt>Notes</dt><dd>${formatMultilineText(log.freeform_notes)}</dd>` : ''}
          </dl>
        </details>`
      : '';
    const parsedEntry = this.cookLogParsed?.[log.id];
    const parsed = parsedEntry?.parsed;
    const recipeHtml = parsed
      ? `<details class="cook-log-recipe">
          <summary>Recipe as cooked</summary>
          <div class="cook-log-recipe-body">
            ${CL.renderMetrics(parsed.metrics)}
            ${parsed.ingredients?.length ? `<div class="section-head">Ingredients</div>${CL.renderIngredientSummary(parsed.ingredient_summary, 1, { mode: this.ingredientSummaryMode })}` : ''}
            ${parsed.steps?.length ? `<div class="section-head mt12">Steps</div>${CL.renderSteps(parsed.steps, 1, false, parsed.metadata, true, {})}` : ''}
          </div>
        </details>`
      : (log.cooklang_text ? '<div class="cook-log-recipe-loading text-muted">Parsing recipe…</div>' : '');
    return `<div class="cook-log-card" data-id="${escHtml(log.id)}">
      <div class="cook-log-head">
        <div class="cook-log-outcome">${escHtml(log.outcome || '(no outcome)')}</div>
        <div class="cook-log-meta">${fmtDate(log.cooked_at)} · <span class="badge badge-released">${escHtml(this.cookLogSourceLabel(log))}</span></div>
      </div>
      ${recipeHtml}
      ${detailHtml}
      <div class="cook-log-actions">
        <button class="btn btn-sm btn-primary" onclick="RecipeView.editCookLogRecipe('${escJs(log.id)}')">Edit recipe</button>
        <button class="btn btn-sm" onclick="RecipeView.iterateFromCookLog('${escJs(log.id)}')">Iterate as next draft</button>
        <button class="btn btn-sm" onclick="RecipeView.openCookLogModal('${escJs(log.id)}')">Edit notes</button>
        <button class="btn btn-sm" onclick="RecipeView.compareCookLogToSource('${escJs(log.id)}')">Compare to source</button>
        <button class="btn btn-sm" onclick="RecipeView.openPromoteLogModal('${escJs(log.id)}')">Promote to release</button>
        <button class="btn btn-sm btn-danger" onclick="RecipeView.deleteCookLogConfirm('${escJs(log.id)}')">Delete</button>
      </div>
    </div>`;
  },

  async iterateFromCookLog(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    // Warn before overwriting a draft that has unreleased changes — losing work
    // accidentally here would erase someone's planning iteration.
    const draftText = this.recipe?.draft?.cooklang_text || '';
    if (draftText.trim() && this.recipe?.has_unreleased_changes) {
      const sourceLabel = log.source_version_string || 'draft';
      if (!confirm(`The current draft has unreleased changes. Overwrite it with this cook log's recipe (forked from ${sourceLabel})?`)) {
        return;
      }
    }
    try {
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/fork-to-draft`, {});
      await this.refreshRecipe();
      // Clear any cook-log edit state so the experiment tab opens on the draft,
      // not back on the cook log we just forked.
      this.cookLogEditingId = null;
      this.activeVersion = this.recipe.draft || null;
      this.setTab('editor');
      showToast('Draft replaced with this cook log — Save advances the next beta');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async compareCookLogToSource(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    const fromLabel = log.source_kind === 'draft'
      ? 'Source snapshot (draft at log creation)'
      : `Source snapshot (${log.source_version_string})`;
    showModal(`
      <div class="modal-title">Compare cook log to source</div>
      <div class="text-muted" style="font-size:0.85rem;margin-bottom:10px">
        ${escHtml(fromLabel)} → recipe as cooked
      </div>
      <div id="cl-compare-result"><div class="loading"><div class="spinner"></div></div></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
      </div>`);
    const target = document.getElementById('cl-compare-result');
    if (!target) return;
    try {
      const fromKey = `cooklog-source:${logId}`;
      const toKey = `cooklog:${logId}`;
      const cmp = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/compare?from=${encodeURIComponent(fromKey)}&to=${encodeURIComponent(toKey)}`);
      this.renderCompareResult(target, cmp);
    } catch (e) {
      target.innerHTML = `<p class="text-muted">Error: ${escHtml(e.message)}</p>`;
    }
  },

  setCookLogFilter(versionString) {
    this.cookLogsFilterVersion = versionString;
    const body = document.getElementById('tab-body');
    if (body) this.paintCookLogs(body);
  },

  openCookLogModal(existingId) {
    const existing = existingId ? (this.cookLogs || []).find((log) => log.id === existingId) : null;
    const versions = (this.recipe.versions || []).filter((v) => !v.is_draft && v.version_string);
    const defaultSourceKey = existing
      ? (existing.source_kind === 'draft' ? '__draft__' : (existing.source_version_string || '__draft__'))
      : (this.recipe.current_best_release?.version_string
          || this.recipe.active_experiment?.version_string
          || versions[0]?.version_string
          || '__draft__');
    const sourceOptions = [`<option value="__draft__" ${defaultSourceKey === '__draft__' ? 'selected' : ''}>Current draft</option>`]
      .concat(versions.map((v) => `<option value="${escHtml(v.version_string)}" ${v.version_string === defaultSourceKey ? 'selected' : ''}>${escHtml(v.version_string)} (${escHtml(v.status)})</option>`))
      .join('');
    const cookedAtDefault = (existing?.cooked_at || new Date().toISOString()).slice(0, 16);
    showModal(`
      <div class="modal-title">${existing ? 'Edit cook log notes' : 'New cook log'}</div>
      <div class="cook-log-modal-row">
        <div class="field-group mt8" style="flex:1">
          <label class="field-label" for="cl-source">Source</label>
          <select id="cl-source" class="field-input" ${existing ? 'disabled' : ''}>${sourceOptions}</select>
          ${existing ? '' : '<small style="color:var(--ink3);font-size:0.78rem">The recipe is snapshotted from this source on create. Edit measurements in the full recipe editor afterwards.</small>'}
        </div>
        <div class="field-group mt8" style="flex:1">
          <label class="field-label" for="cl-cooked-at">Cooked at</label>
          <input id="cl-cooked-at" class="field-input" type="datetime-local" value="${escHtml(cookedAtDefault)}" />
        </div>
      </div>
      <div class="field-group mt12">
        <label class="field-label" for="cl-outcome">Outcome (one line)</label>
        <input id="cl-outcome" class="field-input" placeholder="e.g. crust burnt, crumb good" value="${escHtml(existing?.outcome || '')}" />
      </div>
      <div class="field-group mt12">
        <label class="field-label" for="cl-worked">What worked</label>
        <textarea id="cl-worked" class="field-input" rows="2">${escHtml(existing?.what_worked || '')}</textarea>
      </div>
      <div class="field-group mt12">
        <label class="field-label" for="cl-problems">Problems found</label>
        <textarea id="cl-problems" class="field-input" rows="2">${escHtml(existing?.problems_found || '')}</textarea>
      </div>
      <div class="field-group mt12">
        <label class="field-label" for="cl-changes">Changes to try next</label>
        <textarea id="cl-changes" class="field-input" rows="2">${escHtml(existing?.changes_to_try_next || '')}</textarea>
      </div>
      <div class="field-group mt12">
        <label class="field-label" for="cl-notes">Freeform notes (optional)</label>
        <textarea id="cl-notes" class="field-input" rows="2">${escHtml(existing?.freeform_notes || '')}</textarea>
      </div>
      ${existing ? '' : `
      <div class="text-muted" style="font-size:0.82rem;margin-top:10px;padding:10px;background:var(--bg2);border-radius:8px">
        After creating, hit <strong>Edit recipe</strong> on the new log card to adjust quantities in the full editor.
      </div>`}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.saveCookLog('${escJs(existingId || '')}')">${existing ? 'Save notes' : 'Create cook log'}</button>
      </div>`);
    setTimeout(() => document.getElementById('cl-outcome')?.focus(), 80);
  },

  async saveCookLog(existingId) {
    const sourceKey = document.getElementById('cl-source')?.value || '__draft__';
    const cookedAtLocal = document.getElementById('cl-cooked-at')?.value;
    const outcome = (document.getElementById('cl-outcome')?.value || '').trim();
    if (!outcome) {
      showToast('Outcome is required');
      return;
    }
    const body = {
      cooked_at: cookedAtLocal ? new Date(cookedAtLocal).toISOString() : undefined,
      outcome,
      what_worked: document.getElementById('cl-worked')?.value || '',
      problems_found: document.getElementById('cl-problems')?.value || '',
      changes_to_try_next: document.getElementById('cl-changes')?.value || '',
      freeform_notes: document.getElementById('cl-notes')?.value || '',
    };
    try {
      let created = null;
      if (existingId) {
        await API.put(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(existingId)}`, body);
      } else {
        const source = sourceKey === '__draft__'
          ? { kind: 'draft' }
          : { kind: 'version', version_string: sourceKey };
        created = await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs`, { ...body, source });
      }
      closeModal();
      await this.refreshRecipe();
      this.renderScaffold(document.getElementById('view-container'));
      this.renderHeaderThumbnail();
      if (created?.id) {
        // Send the user straight into the rich recipe editor for the new log.
        this.editCookLogRecipe(created.id);
      } else {
        await this.renderCookLogsTab(document.getElementById('tab-body'));
      }
      showToast(existingId ? 'Cook log saved' : 'Cook log added — edit measurements next');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  openPromoteLogModal(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    const versions = (this.recipe.versions || []).filter((v) => !v.is_draft && v.version_string);
    const lastVersion = versions[0]?.version_string;
    showModal(`
      <div class="modal-title">Promote cook log to release</div>
      <div class="field-group mt8">
        <label class="field-label">Version number</label>
        <input id="rel-version" class="field-input" placeholder="e.g. v1.0, v1.1" value="${lastVersion ? suggestNextVersion(lastVersion) : 'v1.0'}" />
        ${lastVersion ? `<small style="color:var(--ink3);font-size:0.78rem;margin-top:4px">Previous: ${escHtml(lastVersion)}</small>` : ''}
      </div>
      <div class="field-group mt12">
        <label class="field-label">Status</label>
        <select id="rel-status" class="field-input">
          <option value="released">Released (stable)</option>
          <option value="beta">Beta</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      <div class="field-group mt12">
        <label class="field-label">Changelog</label>
        <textarea id="rel-changelog" class="field-input" placeholder="What changed in this version?">${escHtml((log.outcome || ''))}</textarea>
      </div>
      <div class="text-muted" style="font-size:0.82rem;margin-top:10px">Source: cook log "${escHtml(log.outcome || log.id)}" (${escHtml(this.cookLogSourceLabel(log))})</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.promoteLog('${escJs(logId)}')">Promote</button>
      </div>`);
    setTimeout(() => document.getElementById('rel-version')?.select(), 100);
  },

  async promoteLog(logId) {
    const versionString = document.getElementById('rel-version')?.value.trim();
    const status = document.getElementById('rel-status')?.value;
    const changelog = document.getElementById('rel-changelog')?.value.trim();
    if (!versionString) {
      showToast('Version number required');
      return;
    }
    try {
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/promote`, { version_string: versionString, status, changelog });
      closeModal();
      await this.refreshRecipe();
      await this.renderDetail(document.getElementById('view-container'), versionString, { syncUrl: true, replaceUrl: true });
      showToast(`Released ${versionString}`);
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async deleteCookLogConfirm(id) {
    if (!confirm('Delete this cook log?')) return;
    try {
      await API.delete(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(id)}`);
      await this.refreshRecipe();
      this.renderScaffold(document.getElementById('view-container'));
      this.renderHeaderThumbnail();
      await this.renderCookLogsTab(document.getElementById('tab-body'));
      showToast('Cook log deleted');
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
};

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
        version = fallback ? await API.get(`/recipes/${slug}/branches/${encodeURIComponent(branch)}/versions/${fallback}`) : (recipe.draft || recipe.source_version);
      }
      const parsed = version?.cooklang_text
        ? await API.post(`/recipes/${slug}/draft/parse`, { cooklang_text: version.cooklang_text })
        : { ingredients: [], ingredient_summary: emptyIngredientSummary(), steps: [], cookwares: [], metadata: {} };
      const ingredientSummaryMode = resolveIngredientSummaryMode(parsed, RecipeView.ingredientSummaryMode);
      const images = await API.get(`/recipes/${slug}/branches/${encodeURIComponent(branch)}/images`);
      const notes = normalizeNotes(parsed?.metadata?.notes || parsed?.metadata?.Notes || version?.notes || '');
      const servings = parsed?.metadata?.servings || parsed?.metadata?.Servings || parsed?.metadata?.yield || '';
      container.innerHTML = `
        <div class="print-view">
          <div class="print-actions">
            <button class="btn btn-sm" onclick="Router.go('${escJs(recipePathForSelection(slug, version, branch))}', true)">Back</button>
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
          ${parsed.ingredients?.length ? `<div class="section-head">Ingredients</div>${CL.renderIngredientSummary(parsed.ingredient_summary, 1, { mode: ingredientSummaryMode })}` : ''}
          ${parsed.steps?.length ? `<div class="section-head mt16">Steps</div>${CL.renderSteps(parsed.steps, 1, false, parsed.metadata, true, {
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

// ── Helpers ───────────────────────────────────────────────────────────────────
function tagChip(tag) {
  return `<span class="tag-chip" data-tag="${escHtml(tag)}">${escHtml(tag)}<span class="rm" onclick="RecipeView.removeTag(this)">✕</span></span>`;
}

function recipePathForSelection(slug, version, branch = 'main') {
  const base = version && !version.is_draft && version.version_string
    ? `/recipe/${slug}/versions/${encodeURIComponent(version.version_string)}`
    : `/recipe/${slug}`;
  return branch && branch !== 'main'
    ? `${base}?branch=${encodeURIComponent(branch)}`
    : base;
}

function escJs(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeNotes(value) {
  return String(value || '').replace(/\\n/g, '\n');
}

function formatMultilineText(value) {
  return escHtml(value).replace(/\n/g, '<br>');
}

function renderDraftQuantityPanel(token) {
  if (!token) {
    return '';
  }
  const percentDisabled = token.numericValue === null ? 'disabled' : '';
  return `
    <div class="editor-sidecar-card editor-sidecar-card-simple">
      <div class="editor-sidecar-head">
        <div class="editor-sidecar-title-wrap">
          <div class="editor-sidecar-title">Adjust Quantity</div>
          <div class="editor-sidecar-name">${escHtml(token.label)}</div>
        </div>
        <button class="btn btn-sm btn-ghost editor-sidecar-close" onclick="RecipeView.clearDraftQuantitySelection()" aria-label="Close quantity editor">×</button>
      </div>
      <div class="editor-sidecar-current editor-sidecar-current-large">${escHtml(token.quantityText)}${token.units ? ` <span class="text-muted">${escHtml(token.units)}</span>` : ''}</div>
      <div class="editor-sidecar-presets">
        <button class="btn btn-sm editor-sidecar-preset" ${percentDisabled} onclick="RecipeView.setDraftQuantityPreset(5)">+5%</button>
        <button class="btn btn-sm editor-sidecar-preset" ${percentDisabled} onclick="RecipeView.setDraftQuantityPreset(10)">+10%</button>
        <button class="btn btn-sm editor-sidecar-preset" ${percentDisabled} onclick="RecipeView.scaleDraftQuantityPercent(2, 100)">2x</button>
        <button class="btn btn-sm editor-sidecar-preset" ${percentDisabled} onclick="RecipeView.scaleDraftQuantityPercent(0.5, -50)">0.5x</button>
      </div>
      <div class="editor-sidecar-stack">
        <label class="editor-sidecar-inline-label" for="draft-override-value">Set quantity</label>
        <div class="editor-sidecar-control">
          <input id="draft-override-value" class="field-input" type="text" value="${escHtml(token.quantityText)}" oninput="RecipeView.handleDraftQuantityAbsoluteInput()" />
          <span class="editor-sidecar-unit">${escHtml(token.units || '')}</span>
        </div>
      </div>
      <div class="editor-sidecar-divider"><span>or</span></div>
      <div class="editor-sidecar-stack">
        <label class="editor-sidecar-inline-label" for="draft-custom-percent">Change by %</label>
        <div class="editor-sidecar-control">
          <input id="draft-custom-percent" class="field-input" type="number" step="0.1" placeholder="5" ${percentDisabled} oninput="RecipeView.handleDraftQuantityPercentInput()" />
          <span class="editor-sidecar-unit">%</span>
        </div>
      </div>
      <div class="editor-sidecar-preview">
        <span class="editor-sidecar-preview-label">Final target quantity</span>
        <span class="editor-sidecar-preview-value" id="draft-pending-preview">${escHtml(token.quantityText)}</span>
      </div>
      <div class="editor-sidecar-actions">
        <button class="btn btn-sm btn-ghost" onclick="RecipeView.clearDraftQuantitySelection()">Cancel</button>
        <button class="btn btn-sm btn-primary" onclick="RecipeView.applyDraftQuantityPending()">Apply changes</button>
      </div>
      ${token.numericValue === null ? '<p class="text-muted editor-sidecar-note">Percent changes only work for numeric quantities.</p>' : ''}
    </div>`;
}

function formatPercentChange(value) {
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `(${sign}${formatEditableQuantity(rounded)}%)`;
}

function formatEditableQuantity(value) {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 100) / 100;
  if (rounded === Math.floor(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

function makeDraftTokenResolver(tokens) {
  const ordered = [...tokens];
  let index = 0;
  return () => ordered[index++] || null;
}

function buildDraftIngredientTokenOrder(preview, tokens, mode) {
  const summary = preview?.ingredient_summary;
  if (!summary || !tokens?.length) {
    return tokens || [];
  }

  const orderedIngredients = mode === 'sectioned' && summary.has_multiple_sections
    ? summary.sections.flatMap(section => section.ingredients || [])
    : (summary.flat || []);

  if (!orderedIngredients.length) {
    return tokens;
  }

  const pools = new Map();
  for (const token of tokens) {
    const key = draftIngredientTokenKey(token.label, token.units);
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(token);
  }

  const ordered = [];
  for (const ingredient of orderedIngredients) {
    const exactKey = draftIngredientTokenKey(ingredient.name, ingredient.units);
    const exactPool = pools.get(exactKey);
    if (exactPool?.length) {
      ordered.push(exactPool.shift());
      continue;
    }

    const fallbackKey = draftIngredientTokenKey(ingredient.name, '');
    const fallbackPool = pools.get(fallbackKey);
    if (fallbackPool?.length) {
      ordered.push(fallbackPool.shift());
    }
  }

  for (const remaining of pools.values()) {
    ordered.push(...remaining);
  }

  return ordered;
}

function draftIngredientTokenKey(name, units) {
  return `${String(name || '').trim().toLowerCase()}::${String(units || '').trim().toLowerCase()}`;
}

function emptyIngredientSummary() {
  return {
    mode_default: 'flat',
    flat: [],
    sections: [],
    has_multiple_sections: false,
  };
}

function resolveIngredientSummaryMode(parsed, currentMode) {
  const hasMultipleSections = !!parsed?.ingredient_summary?.has_multiple_sections;
  if (currentMode === 'sectioned' && hasMultipleSections) {
    return 'sectioned';
  }
  if (currentMode === 'flat') {
    return 'flat';
  }
  return hasMultipleSections ? 'sectioned' : 'flat';
}

function renderIngredientSummaryToggle(parsed, mode) {
  if (!parsed?.ingredient_summary?.has_multiple_sections) {
    return '';
  }
  return `<div class="ingredient-summary-toggle" role="tablist" aria-label="Ingredient summary mode">
    <button class="ingredient-summary-toggle-btn${mode === 'sectioned' ? ' active' : ''}" onclick="RecipeView.setIngredientSummaryMode('sectioned')">By section</button>
    <button class="ingredient-summary-toggle-btn${mode === 'flat' ? ' active' : ''}" onclick="RecipeView.setIngredientSummaryMode('flat')">All together</button>
  </div>`;
}

let printRequest;
async function triggerPrint(container = document.getElementById('view-container')) {
  if (printRequest) return printRequest;
  printRequest = (async () => {
    await waitForPrintReady(container);
    window.print();
  })();
  try {
    await printRequest;
  } finally {
    printRequest = null;
  }
}

async function waitForPrintReady(container) {
  if (!container) return;
  if (document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {}
  }
  await waitForNextPaint();
  const images = [...container.querySelectorAll('img')];
  await Promise.all(images.map(waitForImageReady));
  await waitForNextPaint();
}

function waitForImageReady(img) {
  if (img.complete) {
    return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
  }
  return new Promise(resolve => {
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}

function waitForNextPaint() {
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

function suggestNextVersion(last) {
  // Simple version bump: v1.0 → v1.1, v1.1 → v1.2, v2.0-beta.1 → v2.0
  const clean = last.replace(/^v/, '');
  if (clean.includes('-beta')) return 'v' + clean.replace(/-beta.*$/, '');
  const parts = clean.split('.');
  if (parts.length >= 2) {
    parts[parts.length - 1] = String(parseInt(parts[parts.length - 1] || 0) + 1);
    return 'v' + parts.join('.');
  }
  return last + '.1';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
