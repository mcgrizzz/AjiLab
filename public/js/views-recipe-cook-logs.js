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
      // Scale is fixed per log, so the text pair is a complete cache key.
      if (cached && cached.text === log.cooklang_text && cached.sourceText === sourceText) return;
      if (!log.cooklang_text) { this.cookLogParsed[log.id] = { text: '', sourceText, parsed: null }; return; }
      try {
        const parsed = await API.post(`/recipes/${this.slug}/draft/parse`, {
          cooklang_text: log.cooklang_text,
          source_cooklang_text: sourceText,
          // A 2× log is compared with the source × 2.
          source_scale: Number(log.scale) || 1,
        });
        this.cookLogParsed[log.id] = { text: log.cooklang_text, sourceText, parsed };
      } catch {
        this.cookLogParsed[log.id] = { text: log.cooklang_text, sourceText, parsed: null };
      }
    }));
  },

  // "from Test 4", "from v1.1"; old cooks of the working copy say so.
  cookLogSourceLabel(log) {
    if (log.source_kind === 'draft' || !log.source_version_string) return `from the working copy (${shortDate(log.created_at || log.cooked_at)})`;
    return `from ${entryLabelFor(this.recipe, log.source_version_string)}`;
  },

  // Which decisions sit on the card itself (the rest are in ⋯): while the
  // cook's test is open and nothing was adopted from it, Adopt and New test;
  // for a cook of the current version, New test.
  cookDecisions(log) {
    const sheet = log.source_kind === 'version' ? entryByKey(this.recipe, log.source_version_string) : null;
    if (this.cookAdoptedAs(log)) return { adopt: false, newTest: false };
    if (sheet?.kind === 'test' && sheet.open) return { adopt: true, newTest: true };
    return { adopt: false, newTest: !!sheet?.is_current };
  },

  // The version adopted from this cook, if any.
  cookAdoptedAs(log) {
    return (this.recipe.versions || []).find((v) => v.kind === 'version' && v.from_cook_log_id === log.id)?.label || null;
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
          const label = key === '__draft__' ? 'Working copy' : entryLabelFor(this.recipe, key);
          return `<button class="cook-log-chip${filter === key ? ' active' : ''}" onclick="RecipeView.setCookLogFilter('${escJs(key)}')">${escHtml(label)}</button>`;
        }).join('')}
      </div>` : '';
    const newButton = `<button class="btn btn-primary" onclick="RecipeView.openCookLogModal()">Record a cook</button>`;
    const empty = filtered.length === 0
      ? `<div class="empty-state" style="padding:36px 0">
          <p>${logs.length === 0 ? 'No cooks recorded yet.' : 'No cooks from this sheet.'}</p>
        </div>`
      : '';
    body.innerHTML = `
      <div class="tab-content cook-logs-tab">
        <div class="cook-logs-head">
          <div>
            <div class="section-head">Cooks</div>
            <div class="text-muted" style="font-size:0.85rem">${logs.length} cook${logs.length === 1 ? '' : 's'}</div>
          </div>
          ${newButton}
        </div>
        ${chips}
        ${empty || `<div class="cook-log-feed">${filtered.map((log) => this.cookLogCardHtml(log)).join('')}</div>`}
      </div>`;
  },

  cookLogCardHtml(log) {
    // "Changes to try next" is the input for the next cook, so it's shown on
    // the card; the rest sits under Details.
    const fields = [
      { key: 'what_worked', label: 'What worked' },
      { key: 'problems_found', label: 'Problems found' },
    ];
    const nextChanges = (log.changes_to_try_next || '').trim();
    const nextHtml = nextChanges
      ? `<div class="cook-log-next"><div class="cook-log-next-label">Changes to try next</div><div class="cook-log-next-text">${formatMultilineText(nextChanges)}</div></div>`
      : '';
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
            <div class="cook-log-recipe-grid">
              ${parsed.ingredients?.length ? `<div class="cook-log-recipe-ingredients"><div class="section-head">Ingredients</div>${CL.renderIngredientSummary(parsed.ingredient_summary, 1, { mode: this.ingredientSummaryMode, disableScale: true })}</div>` : ''}
              ${parsed.steps?.length ? `<div class="cook-log-recipe-steps"><div class="section-head">Steps</div>${CL.renderSteps(parsed.steps, 1, parsed.metadata, true, { cookLogId: log.id })}</div>` : ''}
            </div>
            <div class="cook-log-recipe-extras">
              <button class="btn btn-sm" onclick="RecipeView.addRecipeNoteToLog('${escJs(log.id)}')">＋ Add recipe note</button>
              <button class="btn btn-sm btn-ghost" onclick="RecipeView.editCookLogRecipe('${escJs(log.id)}')">Open full editor →</button>
            </div>
          </div>
        </details>`
      : (log.cooklang_text ? '<div class="cook-log-recipe-loading text-muted">Parsing recipe…</div>' : '');
    const adoptedAs = this.cookAdoptedAs(log);
    const decide = this.cookDecisions(log);
    return `<div class="cook-log-card" data-id="${escHtml(log.id)}">
      <div class="cook-log-head">
        <div class="cook-log-outcome">${escHtml(log.outcome || '(no outcome)')}</div>
        <div class="cook-log-meta">${fmtDate(log.cooked_at)} · <span class="badge ${versionBadgeClass(this.recipe, log.source_kind === 'draft' ? null : log.source_version_string)}">${escHtml(this.cookLogSourceLabel(log))}</span>${cookLogScaleBadge(log)}${adoptedAs ? ` <span class="badge badge-released">Adopted as ${escHtml(adoptedAs)}</span>` : ''}</div>
      </div>
      ${nextHtml}
      ${recipeHtml}
      ${detailHtml}
      <div class="cook-log-actions">
        <button class="btn btn-sm" onclick="RecipeView.markDifferences('${escJs(log.id)}')">Mark differences</button>
        ${decide.adopt ? `<button class="btn btn-sm" onclick="RecipeView.openPromoteLogModal('${escJs(log.id)}')">Adopt from this cook…</button>` : ''}
        ${decide.newTest ? `<button class="btn btn-sm" onclick="RecipeView.iterateFromCookLog('${escJs(log.id)}')">New test from this cook…</button>` : ''}
        <button class="btn btn-sm cook-log-more-btn" data-log-id="${escJs(log.id)}" onclick="RecipeView.openCookLogMoreMenu(event, this)" aria-label="More actions" title="More actions">⋯</button>
      </div>
    </div>`;
  },

  setCookLogFilter(versionString) {
    this.cookLogsFilterVersion = versionString;
    const body = document.getElementById('tab-body');
    if (body) this.paintCookLogs(body);
  },

  // "New test from this cook": what happened becomes the next test. Asks
  // what's being tested, then opens the working copy in the Editor.
  iterateFromCookLog(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    showModal(`
      <div class="modal-title">New test from the ${escHtml(fmtDate(log.cooked_at))} cook</div>
      <div class="field-group mt8">
        <label class="field-label" for="cook-test-testing">What are you testing?</label>
        <input id="cook-test-testing" class="field-input" placeholder="e.g. longer rest, as in this cook" maxlength="120" value="${escHtml((log.changes_to_try_next || '').trim().split('\n')[0].slice(0, 120))}" />
        <small style="color:var(--ink2);font-size:0.78rem">One short phrase. It goes on the printout.</small>
      </div>
      <p class="text-muted" style="font-size:0.85rem;margin-top:10px">The working copy becomes this cook as cooked${(Number(log.scale) || 1) !== 1 ? ', back at 1×' : ''}. Adjust it in the Editor, then save it as Test ${this.recipe.next_test_number}.</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="cook-test-go">Start test</button>
      </div>`);
    const input = document.getElementById('cook-test-testing');
    const go = () => this.startTestFromCook(logId, input?.value.trim() || '');
    document.getElementById('cook-test-go')?.addEventListener('click', go);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => input?.select(), 60);
  },

  async startTestFromCook(logId, testing) {
    closeModal();
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    try {
      await this.replaceDraft({
        sourceLabel: `the ${fmtDate(log.cooked_at)} cook`,
        // At another scale the working copy gets the cook brought back to 1×,
        // which only the server computes; skip the "already matches" shortcut.
        targetText: (Number(log.scale) || 1) === 1 ? (log.cooklang_text || null) : null,
        request: async () => {
          await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/fork-to-draft`, { testing });
          this.cookLogEditingId = null;
        },
        message: `Working copy is now this cook. Make any changes, then save it as Test ${this.recipe.next_test_number}.`,
      });
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async compareCookLogToSource(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    const scale = Number(log.scale) || 1;
    const atScale = scale === 1 ? '' : ` at ${formatEditableQuantity(scale)}×`;
    const fromLabel = log.source_kind === 'draft'
      ? `The working copy as it was then${atScale}`
      : `${entryLabelFor(this.recipe, log.source_version_string)}${atScale}`;
    showModal(`
      <div class="modal-title">Compare this cook with its sheet</div>
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
      const cmp = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/compare?from=${encodeURIComponent(fromKey)}&to=${encodeURIComponent(toKey)}&temp=${encodeURIComponent(this.temperatureUnit || 'F')}`);
      this.renderCompareResult(target, cmp);
    } catch (e) {
      target.innerHTML = `<p class="text-muted">Error: ${escHtml(e.message)}</p>`;
    }
  },

  // options.scale: the scale the cook used (from Overview's "Log this cook").
  // A new log's amounts start at the source × scale; the scale can't change
  // afterwards, since that would silently reinterpret every amount.
  openCookLogModal(existingId, options = {}) {
    const existing = existingId ? (this.cookLogs || []).find((log) => log.id === existingId) : null;
    // "Which sheet?": versions and tests. The working copy is never cooked;
    // an old cook of it shows as such.
    const defaultSourceKey = existing
      ? (existing.source_kind === 'draft' ? '__draft__' : (existing.source_version_string || '__draft__'))
      : RecipeEditState.cookLogSourceKey(this.recipe, this.activeVersion);
    const sourceOptions = (defaultSourceKey === '__draft__' ? `<option value="__draft__" selected>Working copy</option>` : '')
      + sheetOptionsHtml(sheetOptionGroups(this.recipe), defaultSourceKey);
    const cookedAtDefault = RecipeEditState.localDateTimeInput(existing?.cooked_at || new Date());
    const startScale = Number(options.scale) > 0 ? Number(options.scale) : 1;
    const existingScale = Number(existing?.scale) || 1;
    const scaleField = existing
      ? `<div class="field-group mt8 cl-scale-field">
          <span class="field-label">Scale</span>
          <div class="cl-scale-fixed">${formatEditableQuantity(existingScale)}×</div>
          <small style="color:var(--ink2);font-size:0.78rem">Fixed. To change it, delete this cook and record it again.</small>
        </div>`
      : `<div class="field-group mt8 cl-scale-field">
          <label class="field-label" for="cl-scale">Scale</label>
          <div class="cl-scale-input"><input id="cl-scale" class="field-input" type="number" min="0.05" max="100" step="any" inputmode="decimal" value="${escHtml(formatEditableQuantity(startScale))}" /><span aria-hidden="true">×</span></div>
          <small style="color:var(--ink2);font-size:0.78rem">Amounts are recorded as cooked. Can't be changed later.</small>
        </div>`;
    showModal(`
      <div class="modal-title">${existing ? 'Edit cook notes' : 'Record a cook'}</div>
      <div class="cook-log-modal-row">
        <div class="field-group mt8" style="flex:1">
          <label class="field-label" for="cl-source">Which sheet?</label>
          <select id="cl-source" class="field-input" ${existing ? 'disabled' : ''}>${sourceOptions}</select>
          ${existing ? '' : '<small style="color:var(--ink2);font-size:0.78rem">The version or test you cooked from. A copy is kept with the cook.</small>'}
        </div>
        <div class="field-group mt8" style="flex:1">
          <label class="field-label" for="cl-cooked-at">Cooked at</label>
          <input id="cl-cooked-at" class="field-input" type="datetime-local" value="${escHtml(cookedAtDefault)}" />
          <small style="color:var(--ink2);font-size:0.78rem">Local time (${escHtml(Intl.DateTimeFormat().resolvedOptions().timeZone)})</small>
        </div>
        ${scaleField}
      </div>
      <div class="field-group mt12">
        <label class="field-label" for="cl-outcome">Outcome (one line)</label>
        <input id="cl-outcome" class="field-input" placeholder="e.g. crust burnt, crumb good" value="${escHtml(existing?.outcome || '')}" />
      </div>
      <!-- Right after the outcome: it's what the card and the next cook use. -->
      <div class="field-group mt12">
        <label class="field-label" for="cl-changes">Changes to try next</label>
        <textarea id="cl-changes" class="field-input" rows="2" placeholder="e.g. bake 5 min longer uncovered">${escHtml(existing?.changes_to_try_next || '')}</textarea>
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
        <label class="field-label" for="cl-notes">Freeform notes (optional)</label>
        <textarea id="cl-notes" class="field-input" rows="2">${escHtml(existing?.freeform_notes || '')}</textarea>
      </div>
      ${existing ? '' : `
      <div class="text-muted" style="font-size:0.82rem;margin-top:10px;padding:10px;background:var(--bg2);border-radius:8px">
        After creating, use <strong>Mark differences</strong> to record actual quantities and changes to the method.
      </div>`}
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.saveCookLog('${escJs(existingId || '')}')">${existing ? 'Save notes' : 'Save cook'}</button>
      </div>`);
    if (!existing) this.trackUnsentCookLog({ keepScale: options.scale != null });
    setTimeout(() => document.getElementById('cl-outcome')?.focus(), 80);
  },

  // New-log form fields survive an accidental close or reload (per tab) until
  // the log is created.
  unsentCookLogStorage() {
    try { return window.sessionStorage; } catch { return null; }
  },

  // keepScale: the scale came from the Overview; a restored draft keeps it.
  trackUnsentCookLog({ keepScale = false } = {}) {
    const storage = this.unsentCookLogStorage();
    const fields = { source: 'cl-source', cooked_at: 'cl-cooked-at', scale: 'cl-scale', outcome: 'cl-outcome', what_worked: 'cl-worked',
      problems_found: 'cl-problems', changes_to_try_next: 'cl-changes', freeform_notes: 'cl-notes' };
    const saved = RecipeEditState.loadUnsentCookLog(storage, this.slug, this.branchSlug);
    if (saved) {
      for (const [name, id] of Object.entries(fields)) {
        if (name === 'scale' && keepScale) continue;
        const el = document.getElementById(id);
        if (el && typeof saved[name] === 'string' && saved[name] !== '') el.value = saved[name];
      }
      document.querySelector('#modal-content .modal-title')?.insertAdjacentHTML('afterend',
        `<div class="unsent-log-note">Restored notes you hadn't submitted. <button class="link-btn" onclick="RecipeView.discardUnsentCookLog()">Start over</button></div>`);
    }
    const save = () => {
      const values = {};
      for (const [name, id] of Object.entries(fields)) values[name] = document.getElementById(id)?.value || '';
      RecipeEditState.saveUnsentCookLog(storage, this.slug, this.branchSlug, values);
    };
    // Listen on the fields themselves: #modal-content outlives this modal.
    for (const id of Object.values(fields)) {
      const el = document.getElementById(id);
      el?.addEventListener('input', save);
      el?.addEventListener('change', save);
    }
  },

  discardUnsentCookLog() {
    RecipeEditState.clearUnsentCookLog(this.unsentCookLogStorage(), this.slug, this.branchSlug);
    closeModal();
    this.openCookLogModal();
  },

  async saveCookLog(existingId) {
    const sourceKey = document.getElementById('cl-source')?.value || '';
    if (!existingId && (!sourceKey || sourceKey === '__draft__')) { showToast('Pick the version or test you cooked from'); return; }
    const cookedAtLocal = document.getElementById('cl-cooked-at')?.value;
    const existing = existingId ? (this.cookLogs || []).find(log => log.id === existingId) : null;
    // Preserve the exact instant (including seconds and a DST fold) when only notes change.
    const cookedAt = RecipeEditState.cookLogTimestamp(cookedAtLocal, existing?.cooked_at);
    const outcome = (document.getElementById('cl-outcome')?.value || '').trim();
    if (!outcome) { showToast('Outcome is required'); return; }
    const scaleInput = document.getElementById('cl-scale');
    const scale = scaleInput ? Number(scaleInput.value) : 1;
    if (!existingId && !(scale > 0 && scale <= 100)) { showToast('Scale must be between 0 and 100'); return; }
    const body = {
      cooked_at: cookedAt,
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
        created = await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs`, { ...body, source, scale });
        RecipeEditState.clearUnsentCookLog(this.unsentCookLogStorage(), this.slug, this.branchSlug);
      }
      closeModal();
      await this.refreshRecipe();
      // Logged from Overview: land on the new log in Cook Logs.
      if (created && this.activeTab !== 'cook-logs') {
        this.activeTab = 'cook-logs';
        this.syncTabUrl();
      }
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
      showToast(existingId ? 'Cook saved' : 'Cook recorded. Mark what you did differently next');
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  // Adopt from a cook: the sheet it was cooked from plus the ticked changes
  // become the next version (merged into the current one if the sheet was
  // based on an older version).
  async openPromoteLogModal(logId) {
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    if (!log) return;
    const recipe = this.recipe;
    const sheetLabel = log.source_kind === 'draft' ? 'the working copy' : entryLabelFor(recipe, log.source_version_string);
    const already = this.cookAdoptedAs(log);
    const scale = Number(log.scale) || 1;
    showModal(`
      <div class="modal-title">Adopt changes from this cook</div>
      ${already ? `<div class="release-evidence release-evidence-warn">This cook was already adopted as ${escHtml(already)}.</div>` : ''}
      <div class="field-group mt8">
        <label class="field-label" for="rel-version">Version number</label>
        <input id="rel-version" class="field-input" placeholder="e.g. v1.1" value="${escHtml(recipe.next_version_string || 'v1.0')}" />
        ${recipe.current_version ? `<small style="color:var(--ink3);font-size:0.78rem;margin-top:4px">Current: ${escHtml(recipe.current_version.label)}</small>` : ''}
      </div>
      <div class="field-group mt12">
        <label class="field-label" for="rel-changelog">What changed</label>
        <textarea id="rel-changelog" class="field-input" placeholder="e.g. rest 30 → 40 min"></textarea>
      </div>
      <div id="cherry-pick-panel" class="mt12"><div class="loading"><div class="spinner"></div></div></div>
      <div id="rel-conflict" class="release-evidence release-evidence-warn" hidden></div>
      <div class="text-muted" style="font-size:0.82rem;margin-top:10px">Cook of ${escHtml(fmtDate(log.cooked_at))} (“${escHtml(log.outcome || '')}”) from ${escHtml(sheetLabel)}${scale !== 1 ? `, at ${formatEditableQuantity(scale)}×.<br>Changes are shown as cooked; the version is saved at 1×, with amounts divided by ${formatEditableQuantity(scale)}` : ''}.</div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="RecipeView.promoteLog('${escJs(logId)}')">Adopt</button>
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
      return `<p class="text-muted" style="font-size:0.85rem">Cooked as written. The new version will match the sheet.</p>`;
    }
    const withinSpecBlock = withinSpecItems.length
      ? `<details class="cp-within-spec">
          <summary>Within source range (${withinSpecItems.length} step${withinSpecItems.length === 1 ? '' : 's'})</summary>
          <ul class="cp-list cp-list-nested">${withinSpecItems.join('')}</ul>
        </details>`
      : '';
    return `
      <div class="cp-header">
        <div class="cp-title">Changes to adopt</div>
        <div class="cp-legend text-muted">${totalChanges} change${totalChanges === 1 ? '' : 's'}. Unticked ones keep the sheet's value.</div>
      </div>
      ${primaryItems.length ? `<ul class="cp-list">${primaryItems.join('')}</ul>` : ''}
      ${withinSpecBlock}
    `;
  },

  async promoteLog(logId) {
    const versionString = document.getElementById('rel-version')?.value.trim();
    const changelog = document.getElementById('rel-changelog')?.value.trim();
    if (!versionString) { showToast('Version number required'); return; }
    const selections = Array.from(document.querySelectorAll('.cp-checkbox:checked')).map((el) => el.value);
    const useCherryPick = !!this.cherryPickClassified;
    try {
      const endpoint = useCherryPick
        ? `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/promote-cherry-pick`
        : `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(logId)}/promote`;
      const body = useCherryPick
        ? { version_string: versionString, changelog, selections }
        : { version_string: versionString, changelog };
      const response = await API.post(endpoint, body);
      this.cherryPickClassified = null;
      closeModal();
      this.cookLogEditingId = null;
      this.activeTab = 'overview';
      await this.refreshRecipe();
      await this.renderDetail(document.getElementById('view-container'), versionString, { syncUrl: true, replaceUrl: true });
      showToast(`${versionString} is now the current version${response?.merged ? ' (merged with the previous one)' : ''}`);
    } catch (e) {
      if (e.message === 'conflict') { this.showAdoptConflict('This cook'); return; }
      showToast('Error: ' + e.message);
    }
  },

  async deleteCookLogConfirm(id) {
    if (!confirm('Delete this cook?')) return;
    try {
      await API.delete(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/cook-logs/${encodeURIComponent(id)}`);
      await this.refreshRecipe();
      this.renderScaffold(document.getElementById('view-container'));
      this.renderHeaderThumbnail();
      await this.renderCookLogsTab(document.getElementById('tab-body'));
      showToast('Cook deleted');
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
    const isTemp = el.dataset.clEditTemp === '1';
    if (!logId || !kind || !Number.isFinite(sectionIndex) || !Number.isFinite(stepNumber) || !Number.isFinite(tokenIndex)) return;
    // Seed the input with the digits-and-range chunk of the current display.
    // Falls back to the full text for non-trivial values (e.g. fractions).
    const currentDisplay = el.textContent.trim();
    const numericMatch = currentDisplay.match(/-?\d+(?:[\.\/\-]\d+)?/);
    const seed = numericMatch ? numericMatch[0] : currentDisplay;
    const originalHtml = el.innerHTML;

    // Temperatures get a C/F selector so the cook can record the unit they
    // actually used. Default it to the unit currently shown — which the °F/°C
    // view toggle may have converted — so the seeded number stays valid.
    let seedUnit = '';
    if (isTemp) {
      const dispUnitMatch = currentDisplay.match(/([CF])\b/i);
      seedUnit = dispUnitMatch ? dispUnitMatch[1].toUpperCase() : 'F';
      el.innerHTML = `<input class="cl-edit-input" type="text" value="${escHtml(seed)}" />`
        + `<select class="cl-edit-unit-select" aria-label="Temperature unit">`
        + `<option value="C"${seedUnit === 'C' ? ' selected' : ''}>°C</option>`
        + `<option value="F"${seedUnit === 'F' ? ' selected' : ''}>°F</option>`
        + `</select>`;
    } else {
      const unitsLabel = units ? ` ${units}` : '';
      el.innerHTML = `<input class="cl-edit-input" type="text" value="${escHtml(seed)}" />${unitsLabel ? `<span class="cl-edit-units">${escHtml(unitsLabel)}</span>` : ''}`;
    }
    const input = el.querySelector('input');
    const unitSelect = el.querySelector('select');
    input.focus();
    input.select();

    let settled = false;
    const restore = () => {
      if (settled) return;
      settled = true;
      el.innerHTML = originalHtml;
    };
    const isChanged = () => {
      const v = input.value.trim();
      if (v === '') return false;
      if (v !== seed) return true;
      return isTemp && unitSelect && unitSelect.value !== seedUnit;
    };
    const commit = async () => {
      if (settled) return;
      if (!isChanged()) { restore(); return; }
      const newValue = input.value.trim();
      const newUnits = isTemp ? (unitSelect ? unitSelect.value : seedUnit) : units;
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
          new_units: newUnits,
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
    // Settle only when focus leaves the whole widget, so moving between the
    // number input and the unit <select> doesn't commit/cancel prematurely.
    el.addEventListener('focusout', () => {
      setTimeout(() => {
        if (settled || el.contains(document.activeElement)) return;
        if (isChanged()) commit();
        else restore();
      }, 0);
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
    const log = (this.cookLogs || []).find((entry) => entry.id === logId);
    const decide = log ? this.cookDecisions(log) : { adopt: true, newTest: true };
    const menu = document.createElement('div');
    menu.className = 'step-action-menu';
    menu.innerHTML = `
      ${decide.adopt ? '' : `<button class="step-action-item" data-act="adopt">Adopt changes from this cook…</button>`}
      ${decide.newTest ? '' : `<button class="step-action-item" data-act="new-test">New test from this cook…</button>`}
      <button class="step-action-item" data-act="notes">✎ Edit notes</button>
      <button class="step-action-item" data-act="compare">≡ Compare with its sheet</button>
      <div class="step-action-sep"></div>
      <button class="step-action-item step-action-danger" data-act="delete">✕ Delete cook</button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.max(8, r.right + window.scrollX - menu.offsetWidth)}px`;
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.step-action-item');
      if (!item) return;
      closeStepActionMenu();
      const act = item.dataset.act;
      if (act === 'adopt') this.openPromoteLogModal(logId);
      else if (act === 'new-test') this.iterateFromCookLog(logId);
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
