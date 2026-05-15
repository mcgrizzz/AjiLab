// ── View: Recipe Detail — core state, lifecycle, tab routing ─────────────────
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
  focusedVersion: null,
  explicitVersionRequest: null,
  backlinks: [],

  async render(container, slug, opts = {}) {
    this.slug = slug;
    this.branchSlug = opts.branch || 'main';
    // Backward compat: old bookmarks used ?tab=history before the rename.
    this.activeTab = opts.tab === 'history' ? 'versions' : (opts.tab || 'overview');
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
    this.focusedVersion = null;
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

    // Version selector: shows the currently selected version, with all versions
    // (and the draft when present) as options. Changing it calls switchVersion,
    // which keeps activeVersion + URL + explicitVersionRequest in sync.
    const versionList = [
      ...(recipe.draft ? [{ val: 'draft', label: 'Draft' }] : []),
      ...(recipe.versions || []).filter((v) => !v.is_draft).map((v) => ({
        val: v.version_string,
        label: `${v.version_string} (${v.status})`,
      })),
    ];
    const selectedKey = this.selectedVersionKey();
    // When editing a cook log, the version selector is misleading — show a
    // non-interactive label that names the log's source instead.
    let versionSelect;
    if (this.cookLogEditingId) {
      const log = (this.cookLogs || []).find((l) => l.id === this.cookLogEditingId);
      const sourceLabel = log
        ? (log.source_kind === 'draft' ? 'Cook log · from draft' : `Cook log · from ${log.source_version_string || 'unknown'}`)
        : 'Cook log';
      versionSelect = `<span class="badge" style="font-weight:500;cursor:default">${escHtml(sourceLabel)}</span>`;
    } else {
      versionSelect = versionList.length > 0
        ? `<select class="version-select" onchange="RecipeView.switchVersion(this.value)" aria-label="Select version">
            ${versionList.map((opt) => `<option value="${escHtml(opt.val)}" ${opt.val === selectedKey ? 'selected' : ''}>${escHtml(opt.label)}</option>`).join('')}
          </select>`
        : '';
    }

    const statusBits = this.headerStatusBits();
    const tabCount = (n) => n > 0 ? `<span class="tab-count">· ${n}</span>` : '';
    const versionsCount = recipe.counts ? (recipe.counts.releases_count + recipe.counts.betas_count) : 0;
    const cookLogsCount = recipe.counts?.cook_logs_count || 0;
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'editor', label: 'Editor' },
      { id: 'versions', label: `Versions${tabCount(versionsCount)}` },
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
              ${versionSelect}
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
    if (tab !== 'editor' && this.cookLogEditingId) {
      this.cookLogEditingId = null;
      this.activeVersion = null;
    }
    this.activeTab = tab;
    if (tab !== 'versions') this.focusedVersion = null;
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
      case 'versions': this.renderVersionsTab(body); break;
      case 'cook-logs': this.renderCookLogsTab(body); break;
      default: this.renderOverviewTab(body);
    }
  },

  destroyDraftEditor() {
    if (this.draftEditor?.destroy) this.draftEditor.destroy();
    this.draftEditor = null;
  },

  // ── Editor / cook-log bridge methods ────────────────────────────────────────

  getEditableVersion() {
    if (this.activeVersion?._cookLogId) return this.activeVersion;
    if (this.activeVersion?.is_draft || this.activeVersion?.status === 'beta') return this.activeVersion;
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
    if (!log) { showToast('Cook log not found'); return; }
    this.cookLogEditingId = logId;
    this.activeVersion = this.cookLogToEditableTarget(log);
    this.renderScaffold(document.getElementById('view-container'));
    this.renderHeaderThumbnail();
    this.setTab('editor');
  },

  exitCookLogEdit() {
    this.cookLogEditingId = null;
    this.activeVersion = null;
    this.renderScaffold(document.getElementById('view-container'));
    this.renderHeaderThumbnail();
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
};
