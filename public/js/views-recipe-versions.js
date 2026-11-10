// ── Versions tab — version list, version editing/deleting, compare ───────────
Object.assign(RecipeView, {

  focusVersion(versionString) {
    this.focusedVersion = versionString;
    this.setTab('versions');
  },

  renderVersionsTab(body) {
    const variants = (this.recipe.branches || []).filter((branch) => branch.kind === 'variant');
    const all = (this.recipe.versions || []).filter((entry) => !entry.is_draft);
    const versions = all.filter((v) => v.kind === 'version');
    const tests = all.filter((v) => v.kind === 'test')
      .sort((a, b) => (b.open - a.open) || ((b.test_number || 0) - (a.test_number || 0)));
    body.innerHTML = `
      <div class="tab-content versions-tab">
        <div class="versions-section">
          <div class="versions-section-title">Versions</div>
          ${versions.length ? `<div class="versions-list">${versions.map((v) => this.versionRowHtml(v)).join('')}</div>`
            : `<p class="text-muted versions-empty">No version yet. Adopt a test, or release the working copy, to make v1.0.</p>`}
        </div>
        <div class="versions-section">
          <div class="versions-section-title">Tests</div>
          ${tests.length ? `<div class="versions-list">${tests.map((v) => this.versionRowHtml(v)).join('')}</div>`
            : `<p class="text-muted versions-empty">No tests yet. Use “New test…” on the Overview to try a change.</p>`}
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
          <summary>Compare</summary>
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

  // A version: "v1.1 · current", date, "from Test 4", what changed.
  // A test: "v1.0 · Test 4 · more water", "2 cooks · adopted as v1.1".
  versionRowHtml(v) {
    const isTest = v.kind === 'test';
    const facts = [fmtDate(v.created_at)];
    if (isTest) {
      facts.push(v.cook_count ? `${v.cook_count} cook${v.cook_count === 1 ? '' : 's'}` : 'not cooked');
    } else if (v.from_label) {
      facts.push(`from ${v.from_label}`);
    }
    const state = isTest
      ? `<span class="badge ${v.open ? 'badge-beta' : 'badge-draft'}">${escHtml(testStateText(v))}</span>`
      : (v.is_current ? '<span class="badge badge-released">current</span>' : '');
    const note = isTest ? (v.last_outcome ? `Latest cook: ${v.last_outcome}` : '') : v.changelog;
    const key = v.version_string;
    return `
      <div class="version-item${this.focusedVersion === key ? ' version-item-focus' : ''}" data-version="${escHtml(key)}">
        <div class="version-dot ${isTest ? (v.open ? 'beta' : 'archived') : 'released'}"></div>
        <div style="flex:1">
          <div class="version-label">${escHtml(entryTitle(v))} ${state}</div>
          <div class="version-date">${escHtml(facts.join(' · '))}</div>
          ${note ? `<div class="version-changelog">${escHtml(note)}</div>` : ''}
        </div>
        <div class="version-actions">
          <button class="btn btn-sm" onclick="RecipeView.viewVersion('${escJs(key)}')">View</button>
          <button class="btn btn-sm version-more-btn" data-version="${escHtml(key)}" onclick="RecipeView.openVersionMoreMenu(event, this)" aria-label="More actions for ${escHtml(v.label)}" title="More actions">⋯</button>
        </div>
      </div>`;
  },

  // Overflow menu per row; keeps the destructive Delete away from everyday
  // buttons.
  openVersionMoreMenu(event, btn) {
    const versionString = btn.dataset.version;
    const entry = entryByKey(this.recipe, versionString);
    if (!entry) return;
    const isTest = entry.kind === 'test';
    openActionMenu(event, btn, [
      isTest && !entry.locked ? { label: `Edit ${entry.label}`, title: 'You can edit a test until it’s cooked', onClick: () => this.fixTypo(versionString) } : null,
      { label: `New test from ${entry.label}…`, onClick: () => this.openNewTestModal(versionString) },
      isTest
        ? (entry.open
          ? { label: 'Stop testing', onClick: () => this.setTestOpen(versionString, false) }
          : (testReopenable(entry) ? { label: 'Reopen', onClick: () => this.setTestOpen(versionString, true) } : null))
        : { label: `Fix a typo in ${entry.label}…`, onClick: () => this.fixTypo(versionString) },
      'sep',
      { label: `Delete ${entry.label}…`, danger: true, onClick: () => this.openDeleteVersionModal(versionString) },
    ]);
  },

  openDeleteVersionModal(versionString) {
    const label = entryLabelFor(this.recipe, versionString);
    showModal(`
      <div class="modal-title">Delete ${escHtml(label)}</div>
      <p class="text-muted" style="font-size:0.85rem">
        This removes ${escHtml(label)} for good. Cooks recorded from it keep their own copy of the sheet. Type <strong>${escHtml(label)}</strong> to enable deletion.
      </p>
      <div class="field-group mt12">
        <label class="field-label" for="delete-version-confirm">Confirm</label>
        <input id="delete-version-confirm" class="field-input" placeholder="${escHtml(label)}" autocomplete="off" oninput="RecipeView.toggleDeleteVersionConfirm('${escJs(label)}')" />
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button id="delete-version-btn" class="btn btn-danger-solid" onclick="RecipeView.confirmDeleteVersion('${escJs(versionString)}')" disabled>Delete ${escHtml(label)}</button>
      </div>`);
  },

  toggleDeleteVersionConfirm(label) {
    const input = document.getElementById('delete-version-confirm');
    const button = document.getElementById('delete-version-btn');
    if (!input || !button) return;
    button.disabled = input.value.trim() !== label;
  },

  async confirmDeleteVersion(versionString) {
    const wasSelected = this.selectedVersionKey() === versionString;
    const label = entryLabelFor(this.recipe, versionString);
    try {
      await API.delete(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(versionString)}`);
      closeModal();
      await this.refreshRecipe();
      await this.renderDetail(document.getElementById('view-container'), wasSelected ? null : this.selectedVersionKey(), { syncUrl: true, replaceUrl: true });
      showToast(`${label} deleted`);
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  // ── Compare ──────────────────────────────────────────────────────────────────

  compareSectionHtml() {
    // Versions, tests, and the working copy (it can be compared, just not
    // cooked or printed).
    const groups = sheetOptionGroups(this.recipe);
    if (this.recipe.draft?.cooklang_text?.trim()) {
      groups.push({ label: 'Working copy', options: [{ val: 'draft', label: 'Working copy' }] });
    }
    const keys = groups.flatMap((group) => group.options.map((option) => option.val));
    if (keys.length < 2) {
      return `<div class="text-muted" style="padding:12px 0;font-size:0.88rem">Need at least two versions or tests to compare.</div>`;
    }
    const opts = (selected) => sheetOptionsHtml(groups, selected);
    const pending = this.pendingCompare;
    const { from, to } = pending && keys.includes(pending.from) && keys.includes(pending.to)
      ? pending
      : this.defaultComparePair(keys);
    return `
      <div class="compare-selectors">
        <select id="cmp-from" aria-label="Compare from" onchange="RecipeView.runCompare()">${opts(from)}</select>
        <span class="vs">→</span>
        <select id="cmp-to" aria-label="Compare to" onchange="RecipeView.runCompare()">${opts(to)}</select>
      </div>
      <div id="compare-result"></div>`;
  },

  // Default: the current version → what you're looking at. A test compares
  // with what it's based on. When those are the same, compare against the one
  // before it instead.
  defaultComparePair(keys) {
    const to = keys.includes(this.selectedVersionKey()) ? this.selectedVersionKey() : keys[0];
    const toEntry = entryByKey(this.recipe, to);
    const base = toEntry?.kind === 'test' && toEntry.base_version ? toEntry.base_version : null;
    const current = base || this.recipe.current_version?.version_string || null;
    if (current && current !== to && keys.includes(current)) return { from: current, to };
    const idx = keys.indexOf(to);
    return { from: keys[idx + 1] || keys[idx - 1], to };
  },

  // The compare panel is a <details>; run as soon as it opens.
  bindComparePanel(root) {
    const panel = root.querySelector('.versions-compare-section');
    if (!panel) return;
    if (this.pendingCompare) {
      // Opened via "See changes from …": show it right away.
      this.pendingCompare = null;
      panel.open = true;
      panel.dataset.loaded = '1';
      this.runCompare();
      panel.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
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
      result.innerHTML = '<p class="text-muted compare-empty">Pick two different ones to compare.</p>';
      return;
    }
    const requestId = (this.compareRequestId = (this.compareRequestId || 0) + 1);
    result.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const cmp = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&temp=${encodeURIComponent(this.temperatureUnit || 'F')}`);
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
    const from = (text) => `<span class="diff-from">${escHtml(text || '—')}</span>`;
    const to = (text) => `<span class="diff-to">${escHtml(text || '—')}</span>`;
    const meta = (text) => (text ? `<span class="diff-row-meta">${escHtml(text)}</span>` : '');
    return `<div class="diff-metrics">${metrics.map((metric) => {
      const name = `<span class="diff-metric-name">${escHtml(metric.name)}</span>`;
      if (metric.kind === 'added') return `<div class="diff-metric diff-added">${name} ${to(metric.to_display)}${meta('new')}</div>`;
      if (metric.kind === 'removed') return `<div class="diff-metric diff-removed">${name} ${from(metric.from_display)}${meta('removed')}</div>`;
      if (metric.kind === 'same') return `<div class="diff-metric diff-same">${name} <span class="diff-to">${escHtml(metric.to_display || '—')}</span>${meta('unchanged')}</div>`;
      return `<div class="diff-metric diff-changed">${name} ${from(metric.from_display)} → ${to(metric.to_display)}${meta(metric.delta_display)}</div>`;
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
    const name = (text, cls = 'diff-name') => `<span class="${cls}">${escHtml(text)}</span>`;
    const from = (text) => `<span class="diff-from">${escHtml(text)}</span>`;
    const to = (text) => `<span class="diff-to">${escHtml(text)}</span>`;
    const meta = (text) => (text ? `<span class="diff-row-meta">${escHtml(text)}</span>` : '');
    const pct = (row) => (row.percent_change === null || row.percent_change === undefined ? '' : meta(formatPercentChange(row.percent_change)));
    const rows = [
      ...changed.map((row) => `<div class="diff-changed">${name(row.name)} ${from(row.from_display)} → ${to(row.to_display)}${pct(row)}</div>`),
      ...renamed.map((row) => `<div class="diff-swap"><span class="diff-tag">swap</span> ${name(row.from_name, 'diff-name diff-name-from')} ${from(row.from_display)} → ${name(row.name)} ${to(row.to_display)}${pct(row)}</div>`),
      ...removed.map((row) => `<div class="diff-removed">${name(row.name)} ${from(row.from_display)}${meta('removed')}</div>`),
      ...added.map((row) => `<div class="diff-added">${name(row.name)} ${to(row.to_display)}${meta('added')}</div>`),
      ...approx.map((row) => `<div class="diff-same" title="Written in different units but within 2% of each other">≈ ${name(row.name)} ${escHtml(row.from_display)} → ${escHtml(row.to_display)}${meta('same amount')}</div>`),
    ];
    return rows.join('');
  },

  renderMetadataChanges(changes) {
    const value = (text) => `<span class="diff-meta-value">${escHtml(text || '')}</span>`;
    return `<dl class="diff-meta">${changes.map((change) => {
      let body;
      if (change.kind === 'added') body = `<span class="diff-token-add">${value(change.to)}</span>`;
      else if (change.kind === 'removed') body = `<span class="diff-token-del">${value(change.from)}</span>`;
      else if (change.inline_tokens) body = `<span class="diff-meta-value">${this.renderInlineTokens(change.inline_tokens)}</span>`;
      else body = `<span class="diff-token-del">${value(change.from)}</span><span class="diff-arrow"> → </span><span class="diff-token-add">${value(change.to)}</span>`;
      return `<dt>${escHtml(change.key)}</dt><dd>${body}</dd>`;
    }).join('')}</dl>`;
  },

  // Word-level diff: unchanged text plain, removed struck through, added
  // highlighted, swaps as "old → new".
  renderInlineTokens(tokens) {
    return (tokens || []).map((token) => {
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
  },

  renderStepChanges(changes) {
    const renderInline = (tokens) => this.renderInlineTokens(tokens);

    return `<ul class="step-diff-list">${changes.map((change) => {
      if (change.kind === 'section-renamed') {
        return `<li class="step-diff-row step-diff-section"><span class="step-diff-prefix">Section</span><span class="step-diff-body"><span class="diff-token-del">${escHtml(change.from_section_name || 'Untitled')}</span><span class="diff-arrow"> → </span><span class="diff-token-add">${escHtml(change.section_name || 'Untitled')}</span></span></li>`;
      }
      // Step numbers count across the recipe, as on the Overview.
      // "New"/"Old" say added/removed in words, not just by colour.
      const age = change.kind === 'added' ? 'New ' : change.kind === 'removed' ? 'Old ' : '';
      let stepLabel = `${age}step`;
      if (change.block_kind === 'note') stepLabel = `${age}note`;
      else if (change.step_number) {
        const was = change.kind === 'modified' && change.from_step_number && change.from_step_number !== change.step_number
          ? ` (was ${change.from_step_number})` : '';
        stepLabel = `${age}step ${change.step_number}${was}`;
      }
      stepLabel = stepLabel.charAt(0).toUpperCase() + stepLabel.slice(1);
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
