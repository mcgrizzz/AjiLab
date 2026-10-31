// ── Versions tab — version list, version editing/deleting, compare ───────────
Object.assign(RecipeView, {

  focusVersion(versionString) {
    this.focusedVersion = versionString;
    this.setTab('versions');
  },

  renderVersionsTab(body) {
    const variants = (this.recipe.branches || []).filter((branch) => branch.kind === 'variant');
    body.innerHTML = `
      <div class="tab-content versions-tab">
        <div class="versions-section">
          <div class="versions-section-title">Releases &amp; betas</div>
          ${this.renderVersionsListHtml()}
        </div>
        ${variants.length ? `
        <div class="versions-section">
          <div class="versions-section-title">Variant branches</div>
          <div class="versions-variant-list">
            ${variants.map((variant) => `
              <div class="versions-variant-row">
                <div>
                  <div class="version-label">${escHtml(variant.name)}</div>
                  <div class="version-date">forked from ${escHtml(variant.forked_from_version_id || 'unknown')}</div>
                </div>
                <button class="btn btn-sm" onclick="RecipeView.switchBranch('${escJs(variant.slug)}')">Open</button>
              </div>`).join('')}
          </div>
        </div>` : ''}
        <details class="versions-section versions-compare-section">
          <summary>Compare versions</summary>
          <div class="versions-compare-body">${this.compareSectionHtml()}</div>
        </details>
      </div>`;
    this.bindComparePanel(body);
    if (this.focusedVersion) {
      const safeVersion = (window.CSS && CSS.escape) ? CSS.escape(this.focusedVersion) : this.focusedVersion.replace(/"/g, '\\"');
      const target = body.querySelector(`.version-item[data-version="${safeVersion}"]`);
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        target.classList.add('version-item-focus');
      }
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
      <div class="version-item${this.focusedVersion === version.version_string ? ' version-item-focus' : ''}" data-version="${escHtml(version.version_string)}">
        <div class="version-dot ${version.status}"></div>
        <div style="flex:1">
          <div class="version-label">${escHtml(version.version_string)}</div>
          <div class="version-date">${fmtDate(version.created_at)} · <span class="badge badge-${version.status}">${version.status}</span></div>
          ${version.changelog ? `<div class="version-changelog">${escHtml(version.changelog)}</div>` : ''}
        </div>
        <div class="version-actions">
          <button class="btn btn-sm" onclick="RecipeView.viewVersion('${escJs(version.version_string)}')">View</button>
          <button class="btn btn-sm" onclick="RecipeView.startNextBetaFrom('${escJs(version.version_string)}')" title="Load ${escHtml(version.version_string)} into the draft to keep working on it">${this.draftAtRisk(version.cooklang_text) ? 'Replace draft…' : 'Start draft'}</button>
          <button class="btn btn-sm version-more-btn" data-version="${escHtml(version.version_string)}" onclick="RecipeView.openVersionMoreMenu(event, this)" aria-label="More actions for ${escHtml(version.version_string)}" title="More actions">⋯</button>
        </div>
      </div>`).join('')}</div>`;
  },

  // Overflow menu per version row; keeps the destructive Delete away from
  // everyday buttons.
  openVersionMoreMenu(event, btn) {
    event.stopPropagation();
    const versionString = btn.dataset.version;
    if (!versionString) return;
    closeStepActionMenu();
    const menu = document.createElement('div');
    menu.className = 'step-action-menu';
    menu.innerHTML = `<button class="step-action-item step-action-danger" data-act="delete">✕ Delete ${escHtml(versionString)}…</button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.max(8, r.right + window.scrollX - menu.offsetWidth)}px`;
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.step-action-item');
      if (!item) return;
      closeStepActionMenu();
      if (item.dataset.act === 'delete') this.openDeleteVersionModal(versionString);
    });
    setTimeout(() => document.addEventListener('click', closeStepActionMenu, { once: true }), 0);
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
        <button id="delete-version-btn" class="btn btn-danger-solid" onclick="RecipeView.confirmDeleteVersion('${escJs(versionString)}')" disabled>Delete version</button>
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

  // ── Compare ──────────────────────────────────────────────────────────────────

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
    const { from, to } = this.defaultComparePair(options.map((option) => option.val));
    return `
      <div class="compare-selectors">
        <select id="cmp-from" aria-label="Compare from" onchange="RecipeView.runCompare()">${opts(from)}</select>
        <span class="vs">→</span>
        <select id="cmp-to" aria-label="Compare to" onchange="RecipeView.runCompare()">${opts(to)}</select>
      </div>
      <div id="compare-result"></div>`;
  },

  // Default: what you'd cook today (the current best release) → the version
  // you're looking at. When those are the same, compare against the version
  // before it instead.
  defaultComparePair(keys) {
    const to = keys.includes(this.selectedVersionKey()) ? this.selectedVersionKey() : keys[0];
    const best = this.recipe.current_best_release?.version_string || this.recipe.latest_released || null;
    if (best && best !== to && keys.includes(best)) return { from: best, to };
    const idx = keys.indexOf(to);
    return { from: keys[idx + 1] || keys[idx - 1], to };
  },

  // The compare panel is a <details>; run as soon as it opens.
  bindComparePanel(root) {
    const panel = root.querySelector('.versions-compare-section');
    if (!panel) return;
    panel.addEventListener('toggle', () => {
      if (panel.open && !panel.dataset.loaded) {
        panel.dataset.loaded = '1';
        this.runCompare();
      }
    });
  },

  async runCompare() {
    const from = document.getElementById('cmp-from')?.value;
    const to = document.getElementById('cmp-to')?.value;
    const result = document.getElementById('compare-result');
    if (!from || !to || !result) return;
    if (from === to) {
      result.innerHTML = '<p class="text-muted compare-empty">Pick two different versions to compare.</p>';
      return;
    }
    const requestId = (this.compareRequestId = (this.compareRequestId || 0) + 1);
    result.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const cmp = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (requestId !== this.compareRequestId) return; // a newer pick won
      this.renderCompareResult(result, cmp);
    } catch (e) {
      if (requestId !== this.compareRequestId) return;
      result.innerHTML = `<div class="tab-content"><p class="text-muted">Couldn't compare these versions: ${escHtml(e.message)}</p></div>`;
    }
  },

  // Order follows what a cook reads first: metrics (hydration…), ingredient
  // totals, then the method. Metadata and the raw text diff stay collapsed.
  renderCompareResult(el, cmp) {
    const metricsHtml = this.renderMetricChanges(cmp.metric_changes || []);
    const ingHtml = this.renderIngredientChanges(cmp.ingredient_diff || {});
    const stepChanges = Array.isArray(cmp.step_changes) ? cmp.step_changes : [];
    const stepChangesHtml = stepChanges.length === 0
      ? '<p class="text-muted compare-empty">No method changes.</p>'
      : this.renderStepChanges(stepChanges);
    const metadata = cmp.metadata_changes || [];
    const patchHtml = this.renderInlineDiffPatch(cmp);
    el.innerHTML = `
      ${metricsHtml ? `
      <div class="diff-section">
        <div class="diff-title">Metrics</div>
        ${metricsHtml}
      </div>` : ''}
      <div class="diff-section">
        <div class="diff-title">Ingredients (totals)</div>
        ${ingHtml}
      </div>
      <div class="diff-section">
        <div class="diff-title">Method</div>
        ${stepChangesHtml}
      </div>
      ${metadata.length ? `
      <details class="diff-section">
        <summary class="diff-title diff-summary">Metadata (${metadata.length} change${metadata.length === 1 ? '' : 's'})</summary>
        ${this.renderMetadataChanges(metadata)}
      </details>` : ''}
      <details class="diff-section">
        <summary class="diff-title diff-summary">Raw text diff</summary>
        <div class="diff-patch">${patchHtml}</div>
      </details>`;
  },

  renderMetricChanges(metrics) {
    if (!metrics.length) return '';
    return `<div class="diff-metrics">${metrics.map((metric) => {
      const name = `<span class="diff-metric-name">${escHtml(metric.name)}</span>`;
      if (metric.kind === 'added') return `<div class="diff-metric diff-added">${name} <span class="diff-metric-value">${escHtml(metric.to_display || '—')}</span> <span class="diff-row-meta">new</span></div>`;
      if (metric.kind === 'removed') return `<div class="diff-metric diff-removed">${name} <span class="diff-metric-value">${escHtml(metric.from_display || '—')}</span> <span class="diff-row-meta">removed</span></div>`;
      if (metric.kind === 'same') return `<div class="diff-metric diff-same">${name} <span class="diff-metric-value">${escHtml(metric.to_display || '—')}</span> <span class="diff-row-meta">unchanged</span></div>`;
      return `<div class="diff-metric diff-changed">${name} <span class="diff-metric-value">${escHtml(metric.from_display || '—')} → ${escHtml(metric.to_display || '—')}</span>${metric.delta_display ? ` <span class="diff-row-meta">${escHtml(metric.delta_display)}</span>` : ''}</div>`;
    }).join('')}</div>`;
  },

  renderIngredientChanges(idiff) {
    const changed = idiff.changed || [];
    const renamed = idiff.renamed || [];
    const removed = idiff.removed || [];
    const added = idiff.added || [];
    const approx = idiff.approx || [];
    if (!changed.length && !renamed.length && !removed.length && !added.length && !approx.length) {
      return '<p class="text-muted compare-empty">No ingredient changes.</p>';
    }
    const pct = (row) => (row.percent_change === null || row.percent_change === undefined ? '' : ` <span class="diff-row-meta">${escHtml(formatPercentChange(row.percent_change))}</span>`);
    const rows = [
      ...changed.map((row) => `<div class="diff-changed">${escHtml(row.name)} ${escHtml(row.from_display)} → ${escHtml(row.to_display)}${pct(row)}</div>`),
      ...renamed.map((row) => `<div class="diff-changed"><span class="diff-tag">swap</span> ${escHtml(row.from_name)} ${escHtml(row.from_display)} → ${escHtml(row.name)} ${escHtml(row.to_display)}${pct(row)}</div>`),
      ...removed.map((row) => `<div class="diff-removed"><span class="diff-sign" aria-hidden="true">−</span> ${escHtml(row.name)} ${escHtml(row.from_display)} <span class="diff-row-meta">removed</span></div>`),
      ...added.map((row) => `<div class="diff-added"><span class="diff-sign" aria-hidden="true">+</span> ${escHtml(row.name)} ${escHtml(row.to_display)} <span class="diff-row-meta">added</span></div>`),
      ...approx.map((row) => `<div class="diff-same" title="Written in different units but within 2% of each other">≈ ${escHtml(row.name)} ${escHtml(row.from_display)} → ${escHtml(row.to_display)} <span class="diff-row-meta">same amount</span></div>`),
    ];
    return rows.join('');
  },

  renderMetadataChanges(changes) {
    const value = (text) => `<span class="diff-meta-value">${escHtml(text || '')}</span>`;
    return `<dl class="diff-meta">${changes.map((change) => {
      let body;
      if (change.kind === 'added') body = `<span class="diff-token-add">${value(change.to)}</span>`;
      else if (change.kind === 'removed') body = `<span class="diff-token-del">${value(change.from)}</span>`;
      else body = `<span class="diff-token-del">${value(change.from)}</span><span class="diff-arrow"> → </span><span class="diff-token-add">${value(change.to)}</span>`;
      return `<dt>${escHtml(change.key)}</dt><dd>${body}</dd>`;
    }).join('')}</dl>`;
  },

  renderStepChanges(changes) {
    const renderInline = (tokens) => (tokens || []).map((token) => {
      if (token.op === 'context') return escHtml(token.text);
      if (token.op === 'replace') {
        const del = token.removed ? `<span class="diff-token-del">${escHtml(token.removed)}</span>` : '';
        const ins = token.added ? `<span class="diff-token-add">${escHtml(token.added)}</span>` : '';
        if (del && ins) return `${del}<span class="diff-arrow"> → </span>${ins}`;
        return del || ins;
      }
      const tcls = token.op === 'removed' ? 'diff-token-del' : 'diff-token-add';
      return `<span class="${tcls}">${escHtml(token.text)}</span>`;
    }).join('');

    return `<ul class="step-diff-list">${changes.map((change) => {
      if (change.kind === 'section-renamed') {
        return `<li class="step-diff-row step-diff-section"><span class="step-diff-prefix">Section</span><span class="step-diff-body"><span class="diff-token-del">${escHtml(change.from_section_name || 'Untitled')}</span><span class="diff-arrow"> → </span><span class="diff-token-add">${escHtml(change.section_name || 'Untitled')}</span></span></li>`;
      }
      // Step numbers count across the recipe, as on the Overview.
      let stepLabel = 'Step';
      if (change.block_kind === 'note') stepLabel = 'Note';
      else if (change.step_number) {
        const was = change.kind === 'modified' && change.from_step_number && change.from_step_number !== change.step_number
          ? ` (was ${change.from_step_number})` : '';
        stepLabel = `${change.kind === 'removed' ? 'Old step' : 'Step'} ${change.step_number}${was}`;
      }
      const section = change.section_name ? `<span class="step-diff-section-name">${escHtml(change.section_name)}</span>` : '';
      const prefix = `<span class="step-diff-prefix">${escHtml(stepLabel)}${section}</span>`;
      let body, cls;
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
      if (entry.kind === 'header' || entry.kind === 'hunk') return `<span class="diff-line-hdr">${escHtml(entry.text)}</span>`;
      if (entry.kind === 'context') return `<span class="diff-line-ctx">${escHtml(entry.text)}</span>`;
      const cls = entry.kind === 'removed' ? 'diff-line-del' : 'diff-line-add';
      const tokens = (entry.tokens || []).map((token) => {
        if (token.op === 'context') return escHtml(token.text);
        const tcls = token.op === 'removed' ? 'diff-token-del' : 'diff-token-add';
        return `<span class="${tcls}">${escHtml(token.text)}</span>`;
      }).join('');
      return `<span class="${cls}">${escHtml(entry.prefix || '')}${tokens}</span>`;
    }).join('\n');
  },

});
