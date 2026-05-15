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
        ? 'In progress · Draft'
        : `In progress · ${escHtml(primary.version_string || '')} (${escHtml(primary.status)})`;
    } else if (isCurrentBest) {
      primaryLabel = `Current best · ${escHtml(primary.version_string)} (${escHtml(primary.status)})`;
    } else if (primary.version_string) {
      primaryLabel = `Viewing · ${escHtml(primary.version_string)} (${escHtml(primary.status)})`;
    } else {
      primaryLabel = 'Viewing';
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
    const showOpen = expt;
    return `<div class="overview-sidebar-card">
      <div class="overview-sidebar-card-title">Current Best</div>
      <div class="overview-best-line"><span class="badge badge-released">${escHtml(best.version_string || '')}</span><span class="text-muted" style="font-size:0.82rem">${fmtDate(best.created_at)}</span></div>
      ${changelogSnippet ? `<p class="overview-best-changelog">${escHtml(changelogSnippet)}${(best.changelog || '').length > 140 ? '…' : ''}</p>` : ''}
      <div class="overview-sidebar-card-actions">
        ${showOpen ? `<button class="btn btn-sm" onclick="RecipeView.focusVersion('${escJs(best.version_string)}')">Open in Versions →</button>` : ''}
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
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.release()">Release</button>
      </div>`);
    setTimeout(() => document.getElementById('rel-version')?.select(), 100);
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
