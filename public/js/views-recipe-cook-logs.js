// ── Cook logs tab — list, cards, log CRUD, promote, compare ──────────────────

// A cook's photos as a row of thumbnails, each opening the full photo.
function cookPhotosHtml(log) {
  const ids = log?.photos || [];
  if (!ids.length) return '';
  return `<div class="cook-log-photos">${ids.map((id) => `
    <a class="image-thumb image-thumb-link image-thumb-compact" href="/api/images/${escHtml(id)}" target="_blank" rel="noreferrer">
      <img src="/api/images/${escHtml(id)}" alt="Photo of this cook" loading="lazy" />
    </a>`).join('')}</div>`;
}

// Cherry-pick promote helpers (module-private). cherryRow renders one row of
// the change-selection checkbox list; composeAmountLabel formats `from`/`to`
// strings the same way the renderer does, including ranges. tokenLabel maps
// a TokenDiff to a kind-appropriate human label (temperature vs ingredient
// name vs timer). cherryStepGroup wraps a modified step's snippet header
// around its token-diff children so the snippet appears once per step.
// The checklist's words for each kind of change.
const CHANGE_WORDS = { deviation: 'changed', 'within-spec': "within the sheet's range", addition: 'added', removal: 'skipped' };

function cherryRow(id, classification, label, sub, defaultChecked) {
  const checked = defaultChecked ? ' checked' : '';
  return `<li class="cp-row cp-row-${escHtml(classification)}">
    <label class="cp-label">
      <input type="checkbox" class="cp-checkbox" value="${escHtml(id)}"${checked} />
      <span class="cp-tag cp-tag-${escHtml(classification)}">${escHtml(CHANGE_WORDS[classification] || classification)}</span>
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
    const newButton = `<button class="btn btn-primary" onclick="RecipeView.recordCook()">Record a cook</button>`;
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
    // The changes marked "I meant this", at the cook's own scale.
    const meant = parsed && log.intended?.length
      ? CookSheet.cookChangeList(CookSheet.buildFields(parsed.steps), 1, log.intended.map(CookSheet.keyId))
      : [];
    const meantHtml = meant.length
      ? `<div class="cook-log-meant"><span class="cook-log-next-label">Meant</span> ${meant.map((m) => escHtml(m)).join('; ')}</div>`
      : '';
    // Temperatures as the cook was recorded (°C if the paper was).
    const temperatureUnit = log.display?.temp || 'F';
    if (!this.expandedCookLogs) this.expandedCookLogs = new Set();
    const isOpen = this.expandedCookLogs.has(log.id);
    const recipeHtml = parsed
      ? `<details class="cook-log-recipe" id="cook-log-recipe-${escHtml(log.id)}"${isOpen ? ' open' : ''} ontoggle="RecipeView.onCookLogRecipeToggle('${escJs(log.id)}', this)">
          <summary>Recipe as cooked</summary>
          <div class="cook-log-recipe-body">
            ${CL.renderMetrics(parsed.metrics)}
            <div class="cook-log-recipe-grid">
              ${parsed.ingredients?.length ? `<div class="cook-log-recipe-ingredients"><div class="section-head">Ingredients</div>${CL.renderIngredientSummary(parsed.ingredient_summary, 1, { mode: this.ingredientSummaryMode, disableScale: true, temperatureUnit })}</div>` : ''}
              ${parsed.steps?.length ? `<div class="cook-log-recipe-steps"><div class="section-head">Steps</div>${CL.renderSteps(parsed.steps, 1, parsed.metadata, true, { temperatureUnit })}</div>` : ''}
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
      ${cookPhotosHtml(log)}
      ${nextHtml}
      ${meantHtml}
      ${recipeHtml}
      ${detailHtml}
      <div class="cook-log-actions">
        <button class="btn btn-sm" onclick="RecipeView.openCook('${escJs(log.id)}')">Edit cook</button>
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
    const sheet = log.source_kind === 'version' ? entryByKey(this.recipe, log.version_string) : null;
    const carriesOn = sheet?.kind === 'test' && sheet.open
      ? ` Saving it closes ${escHtml(sheet.label)}, as the new test carries on from it; you can keep both open instead.` : '';
    showModal(`
      <div class="modal-title">New test from the ${escHtml(fmtDate(log.cooked_at))} cook</div>
      <div class="field-group mt8">
        <label class="field-label" for="cook-test-testing">What are you testing?</label>
        <input id="cook-test-testing" class="field-input" placeholder="e.g. longer rest, as in this cook" maxlength="120" value="${escHtml((log.changes_to_try_next || '').trim().split('\n')[0].slice(0, 120))}" />
        <small style="color:var(--ink2);font-size:0.78rem">One short phrase. It goes on the printout.</small>
      </div>
      <p class="text-muted" style="font-size:0.85rem;margin-top:10px">The working copy becomes this cook as cooked${(Number(log.scale) || 1) !== 1 ? ', back at 1×' : ''}. Adjust it in the Editor, then save it as a test.${carriesOn}</p>
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
        message: 'Working copy is now this cook. Make any changes, then save it as a test.',
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
      const cmp = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/compare?from=${encodeURIComponent(fromKey)}&to=${encodeURIComponent(toKey)}&temp=${encodeURIComponent(this.temperatureUnit || 'F')}&round=${Units.temperatureRounding()}`);
      this.renderCompareResult(target, cmp);
    } catch (e) {
      target.innerHTML = `<p class="text-muted">Error: ${escHtml(e.message)}</p>`;
    }
  },

  // Recording a cook, or changing one, happens on its own screen
  // (views-cook.js). A new cook starts from the newest unrecorded print,
  // unless the sheet on screen was picked on purpose (options.explicit).
  recordCook(options = {}) {
    const params = new URLSearchParams();
    const sheet = this.activeVersion && !this.activeVersion.is_draft && !this.activeVersion._cookLogId
      ? this.activeVersion.version_string : null;
    if (sheet) params.set('sheet', sheet);
    if (options.explicit && sheet) params.set('pick', '1');
    if (Number(options.scale) > 0 && Number(options.scale) !== 1) params.set('scale', String(options.scale));
    if (this.branchSlug && this.branchSlug !== 'main') params.set('branch', this.branchSlug);
    const qs = params.toString();
    Router.go(`/recipe/${this.slug}/cooks/new${qs ? `?${qs}` : ''}`);
  },

  openCook(logId) {
    const qs = this.branchSlug && this.branchSlug !== 'main' ? `?branch=${encodeURIComponent(this.branchSlug)}` : '';
    Router.go(`/recipe/${this.slug}/cooks/${encodeURIComponent(logId)}${qs}`);
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
    const notes = document.getElementById('rel-changelog');
    notes?.addEventListener('input', () => { notes.dataset.edited = '1'; });
    try {
      const branch = `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}`;
      // A cook of a test: the test's own changes go into the version too.
      const sheet = log.source_kind === 'version' ? entryByKey(recipe, log.source_version_string) : null;
      const base = sheet?.kind === 'test' && sheet.base_version ? entryByKey(recipe, sheet.base_version) : null;
      const [classified, sheetParsed, cookParsed, baseAt1, sheetAt1] = await Promise.all([
        API.get(`${branch}/cook-logs/${encodeURIComponent(logId)}/classify`),
        // The sheet at the cook's scale (the checklist's coordinates), and the
        // cook against it.
        API.post(`${branch}/draft/parse`, { cooklang_text: log.source_cooklang_text || '', scale }),
        API.post(`${branch}/draft/parse`, { cooklang_text: log.cooklang_text || '', source_cooklang_text: log.source_cooklang_text || '', source_scale: scale }),
        base ? API.post(`${branch}/draft/parse`, { cooklang_text: base.cooklang_text }) : null,
        base ? API.post(`${branch}/draft/parse`, { cooklang_text: log.source_cooklang_text || '' }) : null,
      ]);
      const asSheet = (parsed, text) => ({ fields: CookSheet.buildFields(parsed.steps), steps: parsed.steps, text });
      const tested = base ? CookSheet.changeList(asSheet(baseAt1, base.cooklang_text), asSheet(sheetAt1, log.source_cooklang_text || '')) : [];
      // "Cook 2": its place among the cooks of that sheet, oldest first.
      const sameSheet = (this.cookLogs || []).filter((l) => l.source_kind === log.source_kind && l.source_version_string === log.source_version_string).sort(CookSheet.cookOrder);
      const cookName = sameSheet.length > 1 ? `Cook ${sameSheet.findIndex((l) => l.id === log.id) + 1}` : 'the cook';
      this.cherryPickClassified = classified;
      const target = document.getElementById('cherry-pick-panel');
      if (!target) return;
      target.innerHTML = (tested.length ? `<div class="cp-tested">
          <div class="cp-title">What ${escHtml(sheet.label)} tests, always included</div>
          <ul class="cp-list">${tested.map((t) => `<li class="cp-row cp-row-tested"><label class="cp-label">
            <input type="checkbox" checked disabled /><span class="cp-tag cp-tag-tested">tested</span><span class="cp-text"><span class="cp-label-line">${escHtml(t)}</span></span>
          </label></li>`).join('')}</ul>
        </div>` : '') + this.renderCherryPickPanel(classified);
      const sheetFields = CookSheet.buildFields(sheetParsed.steps);
      const cookFields = CookSheet.buildFields(cookParsed.steps);
      // Changes marked "I meant this" come ticked, and only those.
      const intended = new Set((log.intended || []).map(CookSheet.keyId));
      if (intended.size) {
        for (const box of target.querySelectorAll('.cp-checkbox:not(:disabled)')) {
          const key = CookSheet.keyForChange(sheetFields, box.value);
          if (key) box.checked = intended.has(key);
        }
      }
      // "What changed" follows the ticks, until it's edited by hand.
      const fill = () => {
        if (!notes || notes.dataset.edited) return;
        const ticked = [...target.querySelectorAll('.cp-checkbox:checked')].map((box) => box.value);
        const keys = ticked.map((id) => CookSheet.keyForChange(sheetFields, id)).filter(Boolean);
        const steps = ticked.filter((id) => !id.startsWith('step-token:')).map((id) => (id.startsWith('step-add:') ? 'added a step' : `dropped step ${id.split(':')[2]}`));
        notes.value = CookSheet.adoptFromCookNotes(tested, CookSheet.cookChangeList(cookFields, scale, keys, steps), cookName);
      };
      fill();
      target.addEventListener('change', fill);
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
    const photos = ((this.cookLogs || []).find((l) => l.id === id)?.photos || []).length;
    if (!confirm(`Delete this cook${photos ? ` and its ${photos === 1 ? 'photo' : `${photos} photos`}` : ''}?`)) return;
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
      <button class="step-action-item" data-act="text">Edit the text…</button>
      <button class="step-action-item" data-act="compare">≡ Compare with its sheet</button>
      <div class="step-action-sep"></div>
      <button class="step-action-item step-action-danger" data-act="delete">✕ Delete cook</button>`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.top = `${r.bottom + window.scrollY + 4}px`;
    menu.style.left = `${Math.max(8, r.right + window.scrollX - menu.offsetWidth)}px`;
    actionMenuOpener = btn;
    menu.querySelector('.step-action-item')?.focus();
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.step-action-item');
      if (!item) return;
      closeStepActionMenu();
      const act = item.dataset.act;
      if (act === 'adopt') this.openPromoteLogModal(logId);
      else if (act === 'new-test') this.iterateFromCookLog(logId);
      else if (act === 'text') this.editCookLogRecipe(logId);
      else if (act === 'compare') this.compareCookLogToSource(logId);
      else if (act === 'delete') this.deleteCookLogConfirm(logId);
    });
    setTimeout(() => {
      document.addEventListener('click', closeStepActionMenu, { once: true });
    }, 0);
  },


});

function closeStepActionMenu() {
  document.querySelectorAll('.step-action-menu').forEach((m) => m.remove());
}
