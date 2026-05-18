// ── Cook logs tab — list, cards, log CRUD, promote, compare ──────────────────

// Cherry-pick promote helpers (module-private). cherryRow renders one row of
// the change-selection checkbox list; composeAmountLabel formats `from`/`to`
// strings the same way the renderer does, including ranges. tokenLabel maps
// a TokenDiff to a kind-appropriate human label (temperature vs ingredient
// name vs timer). cherryStepGroup wraps a modified step's snippet header
// around its token-diff children so the snippet appears once per step.
function cherryRow(id, classification, label, sub, defaultChecked) {
  const checked = defaultChecked ? ' checked' : '';
  return `<li class="cp-row cp-row-${escHtml(classification)}">
    <label class="cp-label">
      <input type="checkbox" class="cp-checkbox" value="${escHtml(id)}"${checked} />
      <span class="cp-tag cp-tag-${escHtml(classification)}">${escHtml(classification)}</span>
      <span class="cp-text">
        <span class="cp-label-line">${escHtml(label)}</span>
        ${sub ? `<span class="cp-sub">${sub}</span>` : ''}
      </span>
    </label>
  </li>`;
}

function cherryStepGroup(snippet, innerHtml) {
  return `<li class="cp-step-group">
    <div class="cp-step-header">${escHtml(snippet)}</div>
    <ul class="cp-step-children">${innerHtml}</ul>
  </li>`;
}

function composeAmountLabel(quantity, units, range) {
  if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
    const q = range.min === range.max ? String(range.min) : `${range.min}-${range.max}`;
    return units ? `${q} ${units}` : q;
  }
  if (quantity == null || quantity === '') return units || '';
  return units ? `${quantity} ${units}` : String(quantity);
}

function tokenLabel(d) {
  if (d.kind === 'ingredient') return d.name || 'ingredient';
  if (d.kind === 'timer') return d.name || 'timer';
  if (d.kind === 'inlineQuantity') {
    const units = String(d.to_units || d.from_units || '').trim();
    if (/^°?[FCfc]$|fahrenheit|celsius/i.test(units)) return 'temperature';
    return 'value';
  }
  return 'value';
}

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
      // Cache key includes source text so a source change invalidates the diff.
      const sourceText = log.source_cooklang_text || '';
      if (cached && cached.text === log.cooklang_text && cached.sourceText === sourceText) return;
      if (!log.cooklang_text) { this.cookLogParsed[log.id] = { text: '', sourceText, parsed: null }; return; }
      try {
        const parsed = await API.post(`/recipes/${this.slug}/draft/parse`, {
          cooklang_text: log.cooklang_text,
          source_cooklang_text: sourceText,
        });
        this.cookLogParsed[log.id] = { text: log.cooklang_text, sourceText, parsed };
      } catch {
        this.cookLogParsed[log.id] = { text: log.cooklang_text, sourceText, parsed: null };
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
    if (!this.expandedCookLogs) this.expandedCookLogs = new Set();
    const isOpen = this.expandedCookLogs.has(log.id);
    const recipeHtml = parsed
      ? `<details class="cook-log-recipe" id="cook-log-recipe-${escHtml(log.id)}"${isOpen ? ' open' : ''} ontoggle="RecipeView.onCookLogRecipeToggle('${escJs(log.id)}', this)">
          <summary>Recipe as cooked</summary>
          <div class="cook-log-recipe-body">
            ${CL.renderMetrics(parsed.metrics)}
            ${parsed.ingredients?.length ? `<div class="section-head">Ingredients</div>${CL.renderIngredientSummary(parsed.ingredient_summary, 1, { mode: this.ingredientSummaryMode, disableScale: true })}` : ''}
            ${parsed.steps?.length ? `<div class="section-head mt12">Steps</div>${CL.renderSteps(parsed.steps, 1, parsed.metadata, true, { cookLogId: log.id })}` : ''}
            <div class="cook-log-recipe-extras">
              <button class="btn btn-sm" onclick="RecipeView.addRecipeNoteToLog('${escJs(log.id)}')">＋ Add recipe note</button>
              <button class="btn btn-sm btn-ghost" onclick="RecipeView.editCookLogRecipe('${escJs(log.id)}')">Open full editor →</button>
            </div>
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
        <button class="btn btn-sm btn-primary" onclick="RecipeView.markDifferences('${escJs(log.id)}')">Mark differences</button>
        <button class="btn btn-sm" onclick="RecipeView.openPromoteLogModal('${escJs(log.id)}')">Promote to release</button>
        <button class="btn btn-sm cook-log-more-btn" data-log-id="${escJs(log.id)}" onclick="RecipeView.openCookLogMoreMenu(event, this)" aria-label="More actions" title="More actions">⋯</button>
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
      // Always repaint the cook logs tab so the feed isn't blank behind any
      // panel that opens next.
      await this.renderCookLogsTab(document.getElementById('tab-body'));
      if (created?.id) {
        // Open the inline diff panel ("Recipe as cooked") instead of the
        // heavyweight full editor — the user typically wants to tweak
        // measurements against the source recipe, not edit the whole text.
        this.markDifferences(created.id);
      }
      showToast(existingId ? 'Cook log saved' : 'Cook log added — mark differences next');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async openPromoteLogModal(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    const versions = (this.recipe.versions || []).filter((v) => !v.is_draft && v.version_string);
    const lastVersion = versions[0]?.version_string;
    // Show shell + spinner while we fetch the classification.
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
      <div id="cherry-pick-panel" class="mt12"><div class="loading"><div class="spinner"></div></div></div>
      <div class="text-muted" style="font-size:0.82rem;margin-top:10px">Source: cook log "${escHtml(log.outcome || log.id)}" (${escHtml(this.cookLogSourceLabel(log))})</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.promoteLog('${escJs(logId)}')">Promote</button>
      </div>`);
    setTimeout(() => document.getElementById('rel-version')?.select(), 100);
    try {
      const classified = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/classify`);
      this.cherryPickClassified = classified;
      const target = document.getElementById('cherry-pick-panel');
      if (target) target.innerHTML = this.renderCherryPickPanel(classified);
    } catch (e) {
      const target = document.getElementById('cherry-pick-panel');
      if (target) target.innerHTML = `<p class="text-muted">Could not load changes: ${escHtml(e.message)}</p>`;

    }
  },

  // Render the cherry-pick checkbox panel from the classifier output. Each
  // change has a stable change_id used by the server to apply only the
  // selected ones. Defaults: within-spec unchecked, deviation/addition/removal
  // checked, notes-only unchecked. Modified steps render as a snippet header
  // with token-diff rows nested under it so the snippet doesn't repeat. Pure
  // within-spec steps collapse into a disclosure so deviations dominate.
  renderCherryPickPanel(classified) {
    const primaryItems = []; // step-groups (modified w/ deviations) + addition/removal rows
    const withinSpecItems = []; // step-groups whose token diffs are all within-spec
    let totalChanges = 0;
    for (const step of (classified.steps || [])) {
      const snippet = step.text_snippet || `Section ${step.section_index + 1}, Step ${step.step_number}`;
      if (step.kind === 'added') {
        const id = `step-add:${step.section_index}:${step.step_number}`;
        primaryItems.push(cherryRow(id, 'addition', `Added: ${snippet}`, '', true));
        totalChanges += 1;
        continue;
      }
      if (step.kind === 'removed') {
        const id = `step-remove:${step.section_index}:${step.step_number}`;
        primaryItems.push(cherryRow(id, 'removal', `Removed: ${snippet}`, '', true));
        totalChanges += 1;
        continue;
      }
      // modified — one row per token diff, grouped under a step header.
      const tokenRows = (step.token_diffs || []).map((d) => {
        const id = `step-token:${step.section_index}:${step.step_number}:${d.kind}:${d.source_token_index}`;
        const fromLabel = composeAmountLabel(d.from_quantity, d.from_units, d.from_range);
        const toLabel = composeAmountLabel(d.to_quantity, d.to_units, null);
        const sub = `<span class="cp-from">${escHtml(fromLabel || '—')}</span> <span class="cp-arrow">→</span> <span class="cp-to">${escHtml(toLabel || '—')}</span>`;
        return cherryRow(id, d.classification, tokenLabel(d), sub, d.classification === 'deviation');
      });
      if (tokenRows.length === 0) continue;
      totalChanges += tokenRows.length;
      const allWithinSpec = (step.token_diffs || []).every((d) => d.classification === 'within-spec');
      const group = cherryStepGroup(snippet, tokenRows.join(''));
      (allWithinSpec ? withinSpecItems : primaryItems).push(group);
    }
    if (totalChanges === 0) {
      return `<p class="text-muted" style="font-size:0.85rem">No changes vs source. The promoted version will match the source recipe.</p>`;
    }
    const withinSpecBlock = withinSpecItems.length
      ? `<details class="cp-within-spec">
          <summary>Within source range (${withinSpecItems.length} step${withinSpecItems.length === 1 ? '' : 's'})</summary>
          <ul class="cp-list cp-list-nested">${withinSpecItems.join('')}</ul>
        </details>`
      : '';
    return `
      <div class="cp-header">
        <div class="cp-title">Changes to promote</div>
        <div class="cp-legend text-muted">${totalChanges} change${totalChanges === 1 ? '' : 's'}. Unchecked = source value preserved.</div>
      </div>
      ${primaryItems.length ? `<ul class="cp-list">${primaryItems.join('')}</ul>` : ''}
      ${withinSpecBlock}
    `;
  },

  async promoteLog(logId) {
    const versionString = document.getElementById('rel-version')?.value.trim();
    const status = document.getElementById('rel-status')?.value;
    const changelog = document.getElementById('rel-changelog')?.value.trim();
    if (!versionString) { showToast('Version number required'); return; }
    const selections = Array.from(document.querySelectorAll('.cp-checkbox:checked')).map((el) => el.value);
    const useCherryPick = !!this.cherryPickClassified;
    try {
      const endpoint = useCherryPick
        ? `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/promote-cherry-pick`
        : `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/promote`;
      const body = useCherryPick
        ? { version_string: versionString, status, changelog, selections }
        : { version_string: versionString, status, changelog };
      await API.post(endpoint, body);
      this.cherryPickClassified = null;
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

  // ── Step action menu (cook log view) ────────────────────────────────────────

  openStepActionMenu(event, btn) {
    event.stopPropagation();
    const li = btn.closest('.step-item');
    if (!li) return;
    const logId = li.dataset.cookLogId;
    const sectionIndex = parseInt(li.dataset.sectionIndex, 10);
    const stepNumber = parseInt(li.dataset.stepNumber, 10);
    if (!logId || !Number.isFinite(sectionIndex) || !Number.isFinite(stepNumber)) return;
    const isSkipped = li.classList.contains('step-deviation-skipped');
    closeStepActionMenu();
    const menu = document.createElement('div');
    menu.className = 'step-action-menu';
    menu.dataset.menuFor = li.dataset.stepId || '';
    menu.innerHTML = `
      <button class="step-action-item${isSkipped ? ' active' : ''}" data-act="skipped">– ${isSkipped ? 'Unmark skipped' : 'Mark as skipped'}</button>
      <div class="step-action-sep"></div>
      <button class="step-action-item" data-act="note">＋ Add note below</button>
      <button class="step-action-item" data-act="add-step-after">＋ Add step after</button>
      <button class="step-action-item step-action-danger" data-act="delete">✕ Delete step</button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.max(8, r.right + window.scrollX - menu.offsetWidth)}px`;
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.step-action-item');
      if (!item) return;
      const act = item.dataset.act;
      closeStepActionMenu();
      this.handleStepAction(logId, sectionIndex, stepNumber, act, isSkipped);
    });
    setTimeout(() => {
      document.addEventListener('click', closeStepActionMenu, { once: true });
    }, 0);
  },

  async handleStepAction(logId, sectionIndex, stepNumber, act, isSkipped) {
    const endpoint = `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/step-action`;
    try {
      if (act === 'skipped') {
        // Toggle: clicking when already skipped clears the marker.
        const deviation = isSkipped ? null : 'skipped';
        await API.post(endpoint, { section_index: sectionIndex, step_number: stepNumber, action: 'set-deviation', deviation });
      } else if (act === 'note') {
        const note = prompt('Note to add below this step:');
        if (!note || !note.trim()) return;
        await API.post(endpoint, { section_index: sectionIndex, step_number: stepNumber, action: 'insert-note', note: note.trim() });
      } else if (act === 'add-step-after') {
        const content = prompt('New step content (will be marked as an addition):');
        if (!content || !content.trim()) return;
        await API.post(endpoint, { section_index: sectionIndex, step_number: stepNumber, action: 'insert-step-after', content: `!+ ${content.trim()}` });
      } else if (act === 'delete') {
        if (!confirm('Delete this step from the cook log?')) return;
        await API.post(endpoint, { section_index: sectionIndex, step_number: stepNumber, action: 'delete' });
      } else {
        return;
      }
      await this.refreshCookLogsAfterMutation();
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  // Inline click-to-edit for a quantity inside the cook-log "Recipe as cooked"
  // panel. Replaces the clicked text node with an <input>, commits on Enter
  // or blur-with-change, cancels on Esc.
  editCookLogQuantity(event, el) {
    if (!el || el.querySelector('input')) return;
    event.stopPropagation();
    const li = el.closest('.step-item');
    if (!li) return;
    const logId = li.dataset.cookLogId;
    const sectionIndex = parseInt(li.dataset.sectionIndex, 10);
    const stepNumber = parseInt(li.dataset.stepNumber, 10);
    const kind = el.dataset.clEditKind;
    const tokenIndex = parseInt(el.dataset.clEditIndex, 10);
    const units = el.dataset.clEditUnits || '';
    if (!logId || !kind || !Number.isFinite(sectionIndex) || !Number.isFinite(stepNumber) || !Number.isFinite(tokenIndex)) return;
    // Seed the input with the digits-and-range chunk of the current display.
    // Falls back to the full text for non-trivial values (e.g. fractions).
    const currentDisplay = el.textContent.trim();
    const numericMatch = currentDisplay.match(/-?\d+(?:[\.\/\-]\d+)?/);
    const seed = numericMatch ? numericMatch[0] : currentDisplay;
    const originalHtml = el.innerHTML;
    const unitsLabel = units ? ` ${units}` : '';
    el.innerHTML = `<input class="cl-edit-input" type="text" value="${escHtml(seed)}" />${unitsLabel ? `<span class="cl-edit-units">${escHtml(unitsLabel)}</span>` : ''}`;
    const input = el.querySelector('input');
    input.focus();
    input.select();

    let settled = false;
    const restore = () => {
      if (settled) return;
      settled = true;
      el.innerHTML = originalHtml;
    };
    const commit = async () => {
      if (settled) return;
      const newValue = input.value.trim();
      if (newValue === '' || newValue === seed) { restore(); return; }
      settled = true;
      el.innerHTML = `<span class="cl-edit-saving">…</span>`;
      try {
        const endpoint = `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/step-action`;
        await API.post(endpoint, {
          section_index: sectionIndex,
          step_number: stepNumber,
          action: 'update-quantity',
          token_kind: kind,
          token_index: tokenIndex,
          new_quantity: newValue,
          new_units: units,
        });
        await this.refreshCookLogsAfterMutation();
      } catch (e) {
        showToast('Error: ' + e.message);
        // Repaint to recover from the partial DOM swap.
        await this.refreshCookLogsAfterMutation();
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); restore(); }
    });
    input.addEventListener('blur', () => {
      // Treat blur-with-change as a commit; blur-with-no-change as cancel.
      if (input.value.trim() === seed || input.value.trim() === '') restore();
      else commit();
    });
  },

  // ── Section action menu ─────────────────────────────────────────────────────

  openSectionActionMenu(event, btn) {
    event.stopPropagation();
    const li = btn.closest('.step-section');
    if (!li) return;
    const logId = li.dataset.cookLogId;
    const sectionIndex = parseInt(li.dataset.sectionIndex, 10);
    if (!logId || !Number.isFinite(sectionIndex)) return;
    closeStepActionMenu();
    const menu = document.createElement('div');
    menu.className = 'step-action-menu';
    menu.innerHTML = `
      <button class="step-action-item" data-act="add-step">＋ Add step at section end</button>
      <button class="step-action-item" data-act="add-note">＋ Add section note</button>
      <button class="step-action-item" data-act="rename">✎ Rename section</button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.max(8, r.right + window.scrollX - menu.offsetWidth)}px`;
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.step-action-item');
      if (!item) return;
      closeStepActionMenu();
      this.handleSectionAction(logId, sectionIndex, item.dataset.act, li);
    });
    setTimeout(() => {
      document.addEventListener('click', closeStepActionMenu, { once: true });
    }, 0);
  },

  async handleSectionAction(logId, sectionIndex, act, sectionEl) {
    const endpoint = `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/section-action`;
    try {
      if (act === 'add-step') {
        const content = prompt('New step content (will be marked as an addition):');
        if (!content || !content.trim()) return;
        await API.post(endpoint, { section_index: sectionIndex, action: 'add-step', content: `!+ ${content.trim()}` });
      } else if (act === 'add-note') {
        const note = prompt('Section note:');
        if (!note || !note.trim()) return;
        await API.post(endpoint, { section_index: sectionIndex, action: 'add-note', note: note.trim() });
      } else if (act === 'rename') {
        const currentName = sectionEl?.querySelector('.step-section-name')?.textContent?.trim() || '';
        const name = prompt('Section name:', currentName);
        if (!name || !name.trim() || name.trim() === currentName) return;
        await API.post(endpoint, { section_index: sectionIndex, action: 'rename', name: name.trim() });
      } else {
        return;
      }
      await this.refreshCookLogsAfterMutation();
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async addRecipeNoteToLog(logId) {
    const note = prompt('Recipe-level note:');
    if (!note || !note.trim()) return;
    const endpoint = `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/recipe-action`;
    try {
      await API.post(endpoint, { action: 'add-note', note: note.trim() });
      await this.refreshCookLogsAfterMutation();
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  markDifferences(logId) {
    const details = document.getElementById(`cook-log-recipe-${logId}`);
    if (!details) return;
    details.open = true;
    if (!this.expandedCookLogs) this.expandedCookLogs = new Set();
    this.expandedCookLogs.add(logId);
    details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  // Keeps the expanded-state Set in sync with manual <details> toggles so a
  // step-action repaint via paintCookLogs can restore the open panel.
  onCookLogRecipeToggle(logId, el) {
    if (!this.expandedCookLogs) this.expandedCookLogs = new Set();
    if (el?.open) this.expandedCookLogs.add(logId);
    else this.expandedCookLogs.delete(logId);
  },

  openCookLogMoreMenu(event, btn) {
    event.stopPropagation();
    const logId = btn.dataset.logId;
    if (!logId) return;
    closeStepActionMenu();
    const menu = document.createElement('div');
    menu.className = 'step-action-menu';
    menu.innerHTML = `
      <button class="step-action-item" data-act="iterate">↗ Iterate as next draft</button>
      <button class="step-action-item" data-act="notes">✎ Edit notes</button>
      <button class="step-action-item" data-act="compare">≡ Compare to source</button>
      <div class="step-action-sep"></div>
      <button class="step-action-item step-action-danger" data-act="delete">✕ Delete cook log</button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.max(8, r.right + window.scrollX - menu.offsetWidth)}px`;
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.step-action-item');
      if (!item) return;
      closeStepActionMenu();
      const act = item.dataset.act;
      if (act === 'iterate') this.iterateFromCookLog(logId);
      else if (act === 'notes') this.openCookLogModal(logId);
      else if (act === 'compare') this.compareCookLogToSource(logId);
      else if (act === 'delete') this.deleteCookLogConfirm(logId);
    });
    setTimeout(() => {
      document.addEventListener('click', closeStepActionMenu, { once: true });
    }, 0);
  },

  async refreshCookLogsAfterMutation() {
    this.cookLogs = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs`);
    await this.parseCookLogsAhead();
    const body = document.getElementById('tab-body');
    if (body) this.paintCookLogs(body);
  },

});

function closeStepActionMenu() {
  document.querySelectorAll('.step-action-menu').forEach((m) => m.remove());
}
