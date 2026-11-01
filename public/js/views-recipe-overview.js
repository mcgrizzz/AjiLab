// ── Overview tab — primary banner, sidebar cards, release modal ───────────────
Object.assign(RecipeView, {

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
    // Compare by version_string / draft flag, not object identity. switchVersion
    // re-fetches the version which produces a new object even when it represents
    // the same release.
    const sameVersion = (a, b) => {
      if (!a || !b) return false;
      if (a === b) return true;
      if (a.is_draft && b.is_draft) return true;
      return !!a.version_string && a.version_string === b.version_string;
    };
    const isExperimentPrimary = sameVersion(expt, primary);
    const isCurrentBest = sameVersion(best, primary);
    let primaryLabel;
    if (isExperimentPrimary) {
      primaryLabel = primary.is_draft
        ? 'Latest · Draft'
        : `Latest · ${escHtml(primary.version_string || '')} (${escHtml(primary.status)})`;
    } else if (isCurrentBest) {
      primaryLabel = `Current best · ${escHtml(primary.version_string)} (${escHtml(primary.status)})`;
    } else if (primary.version_string) {
      primaryLabel = `Viewing · ${escHtml(primary.version_string)} (${escHtml(primary.status)})`;
    } else {
      primaryLabel = primary.is_draft ? 'Viewing · Draft (unreleased)' : 'Viewing';
    }
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

  // Cooking comes first: "Log this cook" is the one filled button and logs the
  // version (and scale) on screen; Print sits beside it. Releasing is a
  // deliberate step, so Promote/Release is outlined.
  overviewPrimaryBannerHtml(primary, primaryLabel, isExperimentPrimary, best) {
    const badgeClass = primary.is_draft ? 'draft' : primary.status;
    const versionName = primary.is_draft ? 'the draft' : (primary.version_string || 'this version');
    const scaleNote = this.scale && this.scale !== 1 ? ` at ${formatEditableQuantity(this.scale)}×` : '';
    const actions = [
      `<button class="btn btn-sm btn-primary" onclick="RecipeView.logThisCook()" title="Log a cook of ${escHtml(versionName)}${escHtml(scaleNote)}">Log this cook</button>`,
      `<button class="btn btn-sm" onclick="RecipeView.openPrintView()" title="Print ${escHtml(versionName)}${escHtml(scaleNote)} (Ctrl+P)">Print</button>`,
    ];
    if (isExperimentPrimary) {
      const releaseLabel = primary.is_draft ? 'Release…' : 'Promote…';
      const releaseTitle = primary.is_draft
        ? 'Release the draft as a new version'
        : `Promote ${primary.version_string || 'this beta'} to a release`;
      actions.push(`<button class="btn btn-sm btn-outline" onclick="RecipeView.openReleaseModal()" title="${escHtml(releaseTitle)}">${releaseLabel}</button>`);
      if (best) {
        actions.push(`<button class="btn btn-sm btn-ghost" onclick="RecipeView.setTab('editor')">Open Editor</button>`);
      }
    } else if (primary.is_draft) {
      actions.push(`<button class="btn btn-sm btn-ghost" onclick="RecipeView.setTab('editor')">Open Editor</button>`);
    }
    return `<div class="overview-primary-banner">
      <span class="badge badge-${badgeClass}">${primaryLabel}</span>
      <div class="overview-primary-banner-actions">${actions.join('')}</div>
    </div>`;
  },

  // New cook log for the version on screen, at the scale on screen.
  logThisCook() {
    this.openCookLogModal(undefined, { scale: this.scale });
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
    const showOpen = expt;
    return `<div class="overview-sidebar-card">
      <div class="overview-sidebar-card-title">Current Best</div>
      <div class="overview-best-line"><span class="badge badge-released">${escHtml(best.version_string || '')}</span><span class="text-muted" style="font-size:0.82rem">${fmtDate(best.created_at)}</span></div>
      ${changelogSnippet ? `<p class="overview-best-changelog">${escHtml(changelogSnippet)}${(best.changelog || '').length > 140 ? '…' : ''}</p>` : ''}
      <div class="overview-sidebar-card-actions">
        ${showOpen ? `<button class="btn btn-sm" onclick="RecipeView.focusVersion('${escJs(best.version_string)}')">Open in Versions →</button>` : ''}
        <button class="btn btn-sm" onclick="RecipeView.startNextBetaFrom('${escJs(best.version_string)}')" title="Load ${escHtml(best.version_string)} into the draft to keep working on it">${escHtml(this.draftFromVersionLabel(best.version_string))}</button>
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
      <div class="text-muted" style="font-size:0.82rem">${fmtDate(log.cooked_at)} · <span class="badge badge-released">${escHtml(log.version_string || 'draft')}</span>${cookLogScaleBadge(log)}</div>
      <div class="overview-sidebar-card-actions">
        <button class="btn btn-sm" onclick="RecipeView.setTab('cook-logs')">View all →</button>
      </div>
    </div>`;
  },

  // ── Release modal ────────────────────────────────────────────────────────────

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
      ${sourceVersion === 'draft' ? '' : `<div id="rel-evidence" class="release-evidence" aria-live="polite"></div>`}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.release()">Release</button>
      </div>`);
    setTimeout(() => document.getElementById('rel-version')?.select(), 100);
    if (sourceVersion !== 'draft') this.loadReleaseEvidence(sourceVersion);
  },

  // How much cooking backs this version: promoting something nobody has
  // cooked should be a conscious choice.
  async loadReleaseEvidence(versionString) {
    const el = document.getElementById('rel-evidence');
    if (!el) return;
    el.textContent = 'Checking cook logs…';
    let logs;
    try {
      logs = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(versionString)}/cook-logs`);
    } catch {
      if (document.getElementById('rel-evidence') === el) el.textContent = '';
      return;
    }
    if (document.getElementById('rel-evidence') !== el) return; // modal changed
    const list = Array.isArray(logs) ? logs : [];
    const best = this.recipe.current_best_release?.version_string;
    const compareLink = best && best !== versionString
      ? ` <button type="button" class="link-btn" onclick="RecipeView.showCompare('${escJs(best)}', '${escJs(versionString)}')">See changes from ${escHtml(best)}</button>`
      : '';
    if (!list.length) {
      el.className = 'release-evidence release-evidence-warn';
      el.innerHTML = `<strong>No cooks logged on ${escHtml(versionString)} yet.</strong> Consider cooking it before promoting.${compareLink}`;
      return;
    }
    const latest = list.reduce((a, b) => (new Date(a.cooked_at) > new Date(b.cooked_at) ? a : b));
    // "1 cooked at 2×": cooks at another scale back the version too, but say so.
    const byScale = new Map();
    for (const log of list) {
      const scale = Number(log.scale) || 1;
      if (scale !== 1) byScale.set(scale, (byScale.get(scale) || 0) + 1);
    }
    const scaleNote = Array.from(byScale, ([scale, n]) => `${n} cooked at ${formatEditableQuantity(scale)}×`).join(', ');
    el.className = 'release-evidence';
    el.innerHTML = `${list.length} cook${list.length === 1 ? '' : 's'} logged on ${escHtml(versionString)}${scaleNote ? ` (${escHtml(scaleNote)})` : ''} · latest ${escHtml(fmtDate(latest.cooked_at))}${latest.outcome ? `: “${escHtml(latest.outcome)}”` : ''}.${compareLink}`;
  },

  // Open the Versions tab's compare on a given pair.
  showCompare(from, to) {
    closeModal();
    this.pendingCompare = { from, to };
    this.setTab('versions');
  },

  async release() {
    const sourceVersion = this.releaseSourceVersionKey();
    if (sourceVersion === 'draft') await this.saveDraft({ silent: true, advanceBeta: false });
    const versionString = document.getElementById('rel-version')?.value.trim();
    const status = document.getElementById('rel-status')?.value;
    const changelog = document.getElementById('rel-changelog')?.value.trim();
    if (!versionString) { showToast('Version number required'); return; }
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

});
