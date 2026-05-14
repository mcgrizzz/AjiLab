// ── Cook logs tab — list, cards, log CRUD, promote, compare ──────────────────
Object.assign(RecipeView, {

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
      if (!log.cooklang_text) { this.cookLogParsed[log.id] = { text: '', parsed: null }; return; }
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

  setCookLogFilter(versionString) {
    this.cookLogsFilterVersion = versionString;
    const body = document.getElementById('tab-body');
    if (body) this.paintCookLogs(body);
  },

  async iterateFromCookLog(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    const draftText = this.recipe?.draft?.cooklang_text || '';
    if (draftText.trim() && this.recipe?.has_unreleased_changes) {
      const sourceLabel = log.source_version_string || 'draft';
      if (!confirm(`The current draft has unreleased changes. Overwrite it with this cook log's recipe (forked from ${sourceLabel})?`)) return;
    }
    try {
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/fork-to-draft`, {});
      await this.refreshRecipe();
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
    if (!outcome) { showToast('Outcome is required'); return; }
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
        const source = sourceKey === '__draft__' ? { kind: 'draft' } : { kind: 'version', version_string: sourceKey };
        created = await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs`, { ...body, source });
      }
      closeModal();
      await this.refreshRecipe();
      this.renderScaffold(document.getElementById('view-container'));
      this.renderHeaderThumbnail();
      if (created?.id) {
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
    if (!versionString) { showToast('Version number required'); return; }
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

});
