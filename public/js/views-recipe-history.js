// ── History tab — version list, version editing/deleting, compare ─────────────
Object.assign(RecipeView, {

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
        <details class="history-section history-compare-section">
          <summary>Compare versions</summary>
          <div class="history-compare-body">${this.compareSectionHtml()}</div>
        </details>
      </div>`;
    if (this.historyFocusVersion) {
      const safeVersion = (window.CSS && CSS.escape) ? CSS.escape(this.historyFocusVersion) : this.historyFocusVersion.replace(/"/g, '\\"');
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
        renderGroup('Removals', idiff.removed || [], (row) => `<div class="diff-removed">- ${escHtml(row.from_display)} ${escHtml(row.name)}</div>`),
        renderGroup('Additions', idiff.added || [], (row) => `<div class="diff-added">+ ${escHtml(row.to_display)} ${escHtml(row.name)}</div>`),
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
        const del = token.removed ? `<span class="diff-token-del">${escHtml(token.removed)}</span>` : '';
        const ins = token.added ? `<span class="diff-token-add">${escHtml(token.added)}</span>` : '';
        if (del && ins) return `${del}<span class="diff-arrow"> → </span>${ins}`;
        return del || ins;
      }
      const tcls = token.op === 'removed' ? 'diff-token-del' : 'diff-token-add';
      return `<span class="${tcls}">${escHtml(token.text)}</span>`;
    }).join('');

    return `<ul class="step-diff-list">${changes.map((change) => {
      const sectionLabel = change.section_name ? `${change.section_name} · ` : '';
      const stepLabel = change.block_kind === 'note' ? 'Note' : (change.step_number ? `Step ${change.step_number}` : 'Step');
      const prefix = `<span class="step-diff-prefix">${escHtml(sectionLabel + stepLabel)}</span>`;
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
