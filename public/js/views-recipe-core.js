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
  showAmounts: true,
  temperatureUnit: 'F',
  unitOverrides: null,
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
  // "Fix a typo in v1.1…": the version the Editor edits in place. Otherwise
  // the Editor always edits the working copy.
  fixingVersion: null,
  backlinks: [],

  async render(container, slug, opts = {}) {
    this.destroyDraftEditor();
    this.slug = slug;
    this.branchSlug = opts.branch || 'main';
    // Backward compat: old bookmarks used ?tab=history before the rename.
    this.activeTab = opts.tab === 'history' ? 'versions' : (opts.tab || 'overview');
    // Arriving with ?tab=editor counts as switching to the editor.
    this.lastRenderedTab = null;
    this.scale = parseFloat(opts.scale) > 0 ? parseFloat(opts.scale) : 1;
    this.showAmounts = true;
    this.temperatureUnit = 'F';
    this.closeQtyPopover?.();
    // Per-ingredient display units last until a different recipe is opened.
    if (this.unitOverrides?.slug !== slug) this.unitOverrides = null;
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
    this.fixingVersion = null;
    this.backlinks = [];
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      await this.refreshRecipe();
    } catch {
      container.innerHTML = `<div class="empty-state"><p>Recipe not found.</p></div>`;
      return;
    }
    // /tests/v1.1-2 → the test's internal name. Older links (/tests/4) used
    // the recipe-wide number and still work.
    let versionKey = opts.version || null;
    if (opts.testKey) {
      const key = opts.testKey;
      const test = (this.recipe.versions || []).find((v) => v.kind === 'test'
        && (v.test_key === key || (/^\d+$/.test(key) && v.test_number === Number(key))));
      if (!test) {
        container.innerHTML = `<div class="empty-state"><p>Test ${escHtml(key)} not found.</p></div>`;
        return;
      }
      versionKey = test.version_string;
      this.explicitVersionRequest = versionKey;
    }
    await this.renderDetail(container, versionKey);
    // An old beta link (/versions/v1.1-beta.1) becomes /tests/4.
    if (versionKey) {
      const path = new URL(this.recipePathFor(versionKey), location.origin).pathname;
      if (path !== location.pathname) history.replaceState({}, '', path + location.search);
    }
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
    if (!this.activeVersion) {
      return this.recipe?.current_version?.version_string || this.recipe?.open_tests?.[0]?.version_string || 'draft';
    }
    return this.activeVersion.is_draft ? 'draft' : this.activeVersion.version_string;
  },

  // /recipe/x (current version), /recipe/x/versions/v1.0, /recipe/x/tests/4
  recipePathFor(versionKey = this.selectedVersionKey()) {
    const entry = entryByKey(this.recipe, versionKey);
    let base = `/recipe/${this.slug}`;
    if (entry?.kind === 'test' && entry.test_key) base = `/recipe/${this.slug}/tests/${encodeURIComponent(entry.test_key)}`;
    else if (versionKey && versionKey !== 'draft' && !entry?.is_current) base = `/recipe/${this.slug}/versions/${encodeURIComponent(versionKey)}`;
    const params = new URLSearchParams();
    if (this.branchSlug && this.branchSlug !== 'main') params.set('branch', this.branchSlug);
    if (this.scale && this.scale !== 1) params.set('scale', String(this.scale));
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  },

  printPathFor(versionKey = this.selectedVersionKey()) {
    const params = new URLSearchParams({ version: versionKey || 'draft' });
    if (this.branchSlug && this.branchSlug !== 'main') params.set('branch', this.branchSlug);
    if (this.scale && this.scale !== 1) params.set('scale', String(this.scale));
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

  // The recipe opens on its current version, always. With no version yet:
  // the newest open test, then any test, then the working copy.
  defaultActiveVersion() {
    const recipe = this.recipe;
    const inherited = recipe.source_version ? { ...recipe.source_version, is_inherited_source: true } : null;
    if (this.activeTab === 'editor') return recipe.draft || recipe.current_version || inherited;
    return recipe.current_version
      || recipe.open_tests?.[0]
      || (recipe.versions || []).find((v) => v.kind === 'test')
      || recipe.draft
      || inherited;
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
    this.destroyDraftEditor();
    // A concrete versionStr (release, beta, draft, …) is an explicit pick: pin
    // it so the version selector switches to it and tab renderers don't override
    // it back to their default. Callers that want the default pass null.
    if (versionStr) this.explicitVersionRequest = versionStr;
    this.activeVersion = await this.fetchVersion(versionStr);
    await this.loadParsed();
    await this.loadImages();
    if (opts.syncUrl) this.syncVersionUrl(!!opts.replaceUrl);
    this.renderScaffold(container);
    this.renderHeaderThumbnail();
    this.renderTab();
  },

  // The picker and badges under the title; re-rendered on its own when the
  // sheet on screen changes without a full re-render (Editor ↔ Overview).
  statusRowHtml() {
    const recipe = this.recipe;
    const branches = recipe.branches || [];
    const branchOptions = branches.map((entry) => `
      <option value="${escHtml(entry.slug)}" ${entry.slug === this.branchSlug ? 'selected' : ''}>
        ${escHtml(entry.name)}${entry.kind === 'main' ? ' (main)' : ''}
      </option>`).join('');
    const branchSelect = branches.length > 1
      ? `<select class="version-select" onchange="RecipeView.switchBranch(this.value)">${branchOptions}</select>`
      : '';
    // Picker: Versions ("v1.1 · current") and Tests ("Test 4 · more water ·
    // open"). The working copy isn't a sheet; it shows only while it's on
    // screen. Changing it calls switchVersion, which keeps activeVersion + URL
    // + explicitVersionRequest in sync.
    const selectedKey = this.selectedVersionKey();
    const groups = sheetOptionGroups(recipe);
    // When editing a cook log, the version selector is misleading — show a
    // non-interactive label that names the log's source instead.
    let versionSelect;
    if (this.cookLogEditingId) {
      const log = (this.cookLogs || []).find((l) => l.id === this.cookLogEditingId);
      const sourceLabel = log
        ? (log.source_kind === 'draft' ? 'Cook · from the working copy' : `Cook · from ${entryLabelFor(recipe, log.source_version_string)}`)
        : 'Cook';
      versionSelect = `<span class="badge" style="font-weight:500;cursor:default">${escHtml(sourceLabel)}</span>`;
    } else {
      // In the Editor the working copy is always a choice, to go back to it.
      const workingCopyOption = selectedKey === 'draft'
        ? '<option value="draft" selected>Working copy</option>'
        : (this.activeTab === 'editor' && recipe.draft ? '<option value="draft">Working copy</option>' : '');
      versionSelect = groups.length > 0
        ? `<select class="version-select" onchange="RecipeView.switchVersion(this.value)" aria-label="Version or test">
            ${workingCopyOption}${sheetOptionsHtml(groups, selectedKey)}
          </select>`
        : '';
    }

    return `${this.headerStatusBits()}${versionSelect}${branchSelect}`;
  },

  refreshStatusRow() {
    const row = document.querySelector('.recipe-status-row');
    if (row) row.innerHTML = this.statusRowHtml();
  },

  renderScaffold(container) {
    this.destroyDraftEditor();
    const recipe = this.recipe;
    const tabCount = (n) => n > 0 ? `<span class="tab-count">· ${n}</span>` : '';
    const versionsCount = recipe.counts ? (recipe.counts.releases_count + recipe.counts.betas_count) : 0;
    const cookLogsCount = recipe.counts?.cook_logs_count || 0;
    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'editor', label: 'Editor' },
      { id: 'versions', label: `Versions${tabCount(versionsCount)}` },
      { id: 'cook-logs', label: `Cooks${tabCount(cookLogsCount)}` },
    ];

    container.innerHTML = `
      <div class="recipe-header">
        <div class="recipe-header-main">
          <div id="header-thumb-slot" class="header-thumb-slot"></div>
          <div class="recipe-header-copy">
            <h1 class="recipe-title-lg">${escHtml(recipe.title)}</h1>
            <div class="recipe-status-row">${this.statusRowHtml()}</div>
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

  // The picker already says "v1.1 · current"; only the absence needs saying.
  headerStatusBits() {
    return this.recipe.current_version ? '' : '<span class="badge badge-draft">No version yet</span>';
  },

  setTab(tab) {
    if (tab !== 'editor' && this.cookLogEditingId) {
      this.cookLogEditingId = null;
      this.activeVersion = null;
    }
    if (tab !== 'editor') this.fixingVersion = null;
    // A real switch to the editor lands exactly on the panes, from any scroll.
    this.editorScrollForce = tab === 'editor' && this.activeTab !== 'editor';
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
    // Switching to the editor (not re-rendering it) opens it scrolled to the panes.
    this.editorScrollPending = this.activeTab === 'editor' && this.lastRenderedTab !== 'editor';
    this.lastRenderedTab = this.activeTab;
    switch (this.activeTab) {
      case 'overview': this.renderOverviewTab(body); break;
      case 'editor': this.renderEditorTab(body); break;
      case 'versions': this.renderVersionsTab(body); break;
      case 'cook-logs': this.renderCookLogsTab(body); break;
      default: this.renderOverviewTab(body);
    }
  },

  destroyDraftEditor() {
    this.editorSaveSession?.detach();
    this.editorSaveSession = null;
    if (this.draftEditor?.destroy) this.draftEditor.destroy();
    this.draftEditor = null;
  },

  // ── Editor / cook-log bridge methods ────────────────────────────────────────

  // What the Editor edits: a cook's recipe (Mark differences), a version
  // being fixed in place ("Fix a typo in v1.1…"), a test not cooked yet
  // ("Edit"), or else the working copy. A cooked or closed test is locked.
  getEditableVersion() {
    if (this.activeVersion?._cookLogId) return this.activeVersion;
    if (this.fixingVersion) {
      const version = (this.recipe?.versions || []).find((v) => v.version_string === this.fixingVersion && !v.locked);
      if (version) return version;
    }
    return this.recipe?.draft || null;
  },

  editTargetLabel() {
    const editable = this.getEditableVersion();
    if (!editable) return 'No editable version';
    if (editable._cookLogId) {
      const log = editable._cookLog;
      const sourceLabel = log?.source_kind === 'draft'
        ? 'the working copy'
        : entryLabelFor(this.recipe, log?.source_version_string);
      return `Editing a cook${log?.outcome ? ` — ${log.outcome}` : ''} (from ${sourceLabel})`;
    }
    if (editable.is_draft) {
      const base = editable.base_version ? ` · based on ${editable.base_version}` : '';
      const from = editable.from_label ? ` · from ${editable.from_label}` : '';
      return `Working copy${base}${from}`;
    }
    if (editable.kind === 'test') return `Editing ${editable.label}${editable.testing ? ` — ${editable.testing}` : ''}`;
    return `Fixing ${editable.label || editable.version_string} in place`;
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
    this.destroyDraftEditor();
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

  // What "Adopt…" / "Release without testing…" makes the next version from.
  releaseSourceVersionKey() {
    if (this.activeVersion?.kind === 'test' && this.activeVersion?.version_string) {
      return this.activeVersion.version_string;
    }
    return 'draft';
  },

  imageTargetLabel() {
    const target = this.activeVersion;
    if (!target) return 'this version';
    if (target.is_draft) return 'Working copy';
    return entryTitle(target);
  },
};
