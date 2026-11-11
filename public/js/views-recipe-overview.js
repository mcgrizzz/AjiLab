// ── Overview tab — the sheet on screen, open tests, adopt / new test ─────────
// The recipe opens on its current version. Above it, the open tests and how
// their cooks went. A test is adopted into the next version; a new test
// starts from the working copy (docs/VERSIONING-DESIGN.md).
Object.assign(RecipeView, {

  async renderOverviewTab(body) {
    const recipe = this.recipe;
    // The working copy is edited in the Editor, not cooked or printed, so the
    // Overview shows a version or test unless there's nothing else.
    const showingWorkingCopy = this.activeVersion?.is_draft;
    if (!this.explicitVersionRequest || (showingWorkingCopy && this.explicitVersionRequest === 'draft')) {
      const desired = (showingWorkingCopy && entryByKey(this.recipe, this.lastSheetKey)) || this.defaultActiveVersion();
      if (desired && desired !== this.activeVersion && !(desired.is_draft && showingWorkingCopy)) {
        this.activeVersion = desired;
        this.explicitVersionRequest = null;
        await this.loadParsed();
        await this.loadImages();
        this.refreshStatusRow();
        this.syncVersionUrl(true);
      }
    }
    const primary = this.activeVersion;
    if (!primary || !(primary.cooklang_text || '').trim()) {
      body.innerHTML = `
        <div class="tab-content">
          <div class="empty-state" style="padding:48px 0">
            <h2>No version yet</h2>
            <p>Write the recipe in the Editor, then save it as a test to cook from, or release it as v1.0.</p>
            <button class="btn btn-primary mt12" onclick="RecipeView.startFreshDraft()">Start writing</button>
          </div>
        </div>`;
      return;
    }
    if (primary.kind === 'test') { this.renderTestPage(body, primary); return; }
    body.innerHTML = `
      <div class="tab-content overview-tab">
        <div class="overview-grid">
          <div class="overview-primary">
            ${this.openTestsStripHtml(primary)}
            ${this.overviewPrimaryBannerHtml(primary)}
            ${this.recipeBodyHtml()}
          </div>
          <aside class="overview-sidebar">
            ${this.overviewSidebarHtml()}
          </aside>
        </div>
      </div>`;
    StickyFit.watch([body.querySelector('.recipe-sidebar'), body.querySelector('.overview-sidebar')]);
    this.renderImageManager();
  },

  // "Testing: Test 4 · more water · 2 cooks · latest Nov 5: Better flavor".
  openTestsStripHtml(primary) {
    const tests = this.recipe.open_tests || [];
    const current = this.recipe.current_version;
    const changes = this.recipe.draft_change_label;
    const workingCopyLine = changes && !primary.is_draft
      ? `<div class="tests-strip-note">${escHtml(changes)} · <button type="button" class="link-btn" onclick="RecipeView.setTab('editor')">Open editor</button></div>`
      : '';
    // On a test's own page, the strip is for getting to the others: with no
    // other open test, the banner below already says everything it would.
    const onlyThisOne = primary.kind === 'test' && tests.every((t) => t.version_string === primary.version_string);
    if (!tests.length || onlyThisOne) return workingCopyLine ? `<div class="tests-strip">${workingCopyLine}</div>` : '';
    const rows = tests.map((t) => {
      const evidence = t.cook_count
        ? `${t.cook_count} cook${t.cook_count === 1 ? '' : 's'} · latest ${shortDate(t.last_cooked_at)}${t.last_outcome ? `: ${t.last_outcome}` : ''}`
        : 'not cooked yet';
      const stale = current && t.base_version && t.base_version !== current.version_string
        ? ` · ${current.version_string} is newer` : '';
      const onScreen = primary.version_string === t.version_string;
      return `<li><button type="button" class="tests-strip-item${onScreen ? ' is-on-screen' : ''}" onclick="RecipeView.switchVersion('${escJs(t.version_string)}')"${onScreen ? ' aria-current="true"' : ''}>
        <span class="tests-strip-name">${escHtml(entryTitle(t))}</span><span class="tests-strip-evidence">${escHtml(`${stale} · ${evidence}`.replace(/^ · /, ''))}</span>
      </button></li>`;
    }).join('');
    return `<div class="tests-strip">
      <div class="tests-strip-head">Testing</div>
      <ul class="tests-strip-list">${rows}</ul>
      ${workingCopyLine}
    </div>`;
  },

  // "v1.1 · current version", "v1.0 · not current (current is v1.1)",
  // "v1.0 · Test 4 · more water · open" (its name says what it's made from).
  bannerLabel(entry) {
    const current = this.recipe.current_version;
    if (entry.is_draft) {
      return `Working copy${entry.base_version ? ` · based on ${entry.base_version}` : ''}`;
    }
    if (entry.kind === 'test') {
      const newer = current && entry.base_version && current.version_string !== entry.base_version
        ? ` · ${current.version_string} is newer` : '';
      return `${entryTitle(entry)} · ${testStateText(entry)}${newer}`;
    }
    if (entry.is_current) return `${entry.label} · current version`;
    return current ? `${entry.label} · not current (current is ${current.label})` : entry.label;
  },

  // Cooking comes first: "Record a cook" is the one filled button and records
  // the sheet (and scale) on screen; Print sits beside it.
  overviewPrimaryBannerHtml(primary) {
    const recipe = this.recipe;
    const badgeClass = primary.is_draft ? 'badge-draft' : (primary.kind === 'test' ? 'badge-beta' : 'badge-released');
    const scaleNote = this.scale && this.scale !== 1 ? ` at ${formatEditableQuantity(this.scale)}×` : '';
    const name = primary.is_draft ? 'the working copy' : primary.label;
    const key = primary.version_string;
    const actions = [];
    let note = '';
    if (primary.is_draft) {
      actions.push(`<button class="btn btn-sm btn-primary" onclick="RecipeView.setTab('editor')">Open editor</button>`);
      actions.push(`<button class="btn btn-sm btn-outline" onclick="RecipeView.openSaveTestModal()">Save as ${escHtml(recipe.next_test_label)}…</button>`);
      note = 'The working copy is where the next test is set up. Save it as a test to print and cook it.';
    } else {
      // Named, since it isn't always the sheet on screen: a sheet printed
      // and not yet recorded comes first (it's the paper in your hand).
      const start = RecipeEditState.cookStart(recipe, primary, { explicit: !!this.explicitVersionRequest, scale: this.scale });
      const cookOf = start.version_string ? entryLabelFor(recipe, start.version_string) : name;
      const printedNote = start.print && start.version_string !== key ? `, printed ${shortDate(start.print.printed_at)} and not recorded yet` : scaleNote;
      actions.push(`<button class="btn btn-sm btn-primary" onclick="RecipeView.logThisCook()" title="Record a cook of ${escHtml(cookOf)}${escHtml(printedNote)}">Record a cook of ${escHtml(cookOf)}</button>`);
      actions.push(`<button class="btn btn-sm" onclick="RecipeView.openPrintView()" title="Print ${escHtml(name)}${escHtml(scaleNote)} (Ctrl+P)">Print</button>`);
      if (primary.kind === 'test' && !primary.locked) {
        actions.push(`<button class="btn btn-sm" onclick="RecipeView.fixTypo('${escJs(key)}')" title="You can edit ${escHtml(primary.label)} until it’s cooked">Edit</button>`);
      }
      if (primary.kind === 'test') {
        if (primary.open) {
          actions.push(`<button class="btn btn-sm btn-outline" onclick="RecipeView.openReleaseModal()" title="Make ${escHtml(recipe.next_version_string)} from ${escHtml(primary.label)}">Adopt as ${escHtml(recipe.next_version_string)}…</button>`);
          actions.push(`<button class="btn btn-sm btn-ghost" onclick="RecipeView.setTestOpen('${escJs(key)}', false)" title="It stays with its cooks, out of the Testing list">Stop testing</button>`);
        }
        // What to do next with it.
        if (primary.open && primary.followed_by) {
          note = `${primary.followed_by} carries on from this test. Stop testing it, unless you’re cooking both side by side.`;
        } else if (primary.open && !primary.cook_count) {
          note = 'Next: print it, cook from the paper, then record how it went. Until it’s cooked you can still edit it.';
        } else if (primary.open) {
          note = `Its cooks are below. When it’s right, adopt it as ${recipe.next_version_string}; or start a new test from a cook.`;
        }
        if (primary.closed_as === 'superseded') note = `${recipe.current_version?.label || 'A newer version'} came after this test. Reopen it to keep testing it.`;
        if (primary.closed_as === 'followed') note = `${primary.followed_by || 'A later test'} carries on from this test. Reopen it (⋯) to test both side by side.`;
      } else {
        actions.push(`<button class="btn btn-sm btn-outline" onclick="RecipeView.openNewTestModal('${escJs(key)}')">${primary.is_current ? 'New test…' : `New test from ${escHtml(primary.label)}…`}</button>`);
      }
      actions.push(`<button class="btn btn-sm btn-ghost overview-more-btn" onclick="RecipeView.openSheetMenu(event, this, '${escJs(key)}')" aria-label="More actions for ${escHtml(primary.label)}" title="More actions">⋯</button>`);
    }
    const from = !primary.is_draft && primary.kind === 'version' && primary.from_label ? ` · from ${primary.from_label}` : '';
    return `<div class="overview-primary-banner">
      <span class="badge ${badgeClass}">${escHtml(this.bannerLabel(primary) + from)}</span>
      <div class="overview-primary-banner-actions">${actions.join('')}</div>
      ${note ? `<p class="overview-banner-note">${escHtml(note)}</p>` : ''}
    </div>`;
  },

  openSheetMenu(event, btn, versionString) {
    const entry = entryByKey(this.recipe, versionString);
    if (!entry) return;
    const items = [];
    if (entry.kind === 'test') {
      items.push({ label: entry.testing ? 'Change what it’s testing…' : 'Say what it’s testing…', onClick: () => this.openTestingModal(versionString) });
      items.push({ label: `New test from ${entry.label}…`, onClick: () => this.openNewTestModal(versionString) });
      // Stop testing sits beside Adopt on the page.
      if (!entry.open && testReopenable(entry)) {
        items.push({ label: 'Reopen', onClick: () => this.setTestOpen(versionString, true) });
      }
    } else {
      items.push({
        label: `Fix a typo in ${entry.label}…`,
        title: `Edit ${entry.label} in place. For a real change, start a new test.`,
        onClick: () => this.fixTypo(versionString),
      });
    }
    openActionMenu(event, btn, items);
  },

  // A cook of the sheet on screen, at the scale on screen.
  // An unrecorded print wins unless this sheet was opened on purpose.
  logThisCook() {
    this.recordCook({ scale: this.scale, explicit: !!this.explicitVersionRequest });
  },

  overviewSidebarHtml() {
    return `${this.overviewCookCardHtml()}${this.overviewBacklinksCardHtml()}`;
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

  overviewCookCardHtml() {
    const log = this.recipe.latest_cook_log;
    if (!log) {
      return `<div class="overview-sidebar-card overview-sidebar-card-quiet">
        <div class="overview-sidebar-card-title">Latest cook</div>
        <p class="text-muted" style="font-size:0.86rem;margin:0">Not cooked yet. Print it, cook from the sheet, then record how it went.</p>
      </div>`;
    }
    const sheet = log.source_kind === 'draft' ? 'working copy' : entryLabelFor(this.recipe, log.version_string);
    return `<div class="overview-sidebar-card">
      <div class="overview-sidebar-card-title">Latest cook</div>
      <div class="overview-cook-outcome">${escHtml(log.outcome || '(no outcome)')}</div>
      <div class="text-muted" style="font-size:0.82rem">${fmtDate(log.cooked_at)} · <span class="badge ${versionBadgeClass(this.recipe, log.version_string)}">${escHtml(sheet)}</span>${cookLogScaleBadge(log)}</div>
      ${(log.changes_to_try_next || '').trim() ? `<div class="overview-cook-next"><span class="overview-cook-next-label">Try next:</span> ${escHtml(log.changes_to_try_next.trim())}</div>` : ''}
      <div class="overview-sidebar-card-actions">
        <button class="btn btn-sm" onclick="RecipeView.setTab('cook-logs')">All cooks →</button>
      </div>
    </div>`;
  },

  // ── New test / Testing line / stop & reopen / fix a typo ────────────────────

  // "New test…": ask what's being tested, reset the working copy to the sheet
  // it starts from, and open the Editor.
  openNewTestModal(fromKey = this.recipe.current_version?.version_string) {
    const from = entryByKey(this.recipe, fromKey);
    if (!from) { showToast('Nothing to start a test from yet'); return; }
    showModal(`
      <div class="modal-title">New test${from.is_current ? '' : ` from ${escHtml(from.label)}`}</div>
      <div class="field-group mt8">
        <label class="field-label" for="new-test-testing">What are you testing?</label>
        <input id="new-test-testing" class="field-input" placeholder="e.g. more water" maxlength="120" />
        <small style="color:var(--ink2);font-size:0.78rem">One short phrase. It goes on the printout.</small>
      </div>
      <p class="text-muted" style="font-size:0.85rem;margin-top:10px">The working copy resets to ${escHtml(from.label)} and the Editor opens. Make the change, then save it as ${escHtml(this.nextTestLabelFrom(from))}.${from.kind === 'test' && from.open ? ` Saving it closes ${escHtml(from.label)}, as the new test carries on from it; you can keep both open instead.` : ''}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="new-test-go">Start test</button>
      </div>`);
    const input = document.getElementById('new-test-testing');
    const go = () => this.startNewTest(fromKey, input?.value.trim() || '');
    document.getElementById('new-test-go')?.addEventListener('click', go);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    setTimeout(() => input?.focus(), 60);
  },

  async startNewTest(fromKey, testing) {
    // It takes a moment (the working copy is reset on the server): say so
    // in place until the Editor opens.
    const button = document.getElementById('new-test-go');
    if (button?.disabled) return;
    if (button) { button.disabled = true; button.textContent = 'Starting…'; }
    const from = entryByKey(this.recipe, fromKey);
    const ok = await this.replaceDraft({
      sourceLabel: from?.label || fromKey,
      targetText: from?.cooklang_text ?? null,
      request: () => API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(fromKey)}/fork`, { testing }),
      message: `Working copy reset to ${from?.label || fromKey}. Make your change, then save it as a test.`,
    });
    if (document.getElementById('new-test-go') !== button) return;
    if (ok) closeModal();
    else { button.disabled = false; button.textContent = 'Start test'; }
  },

  // What a new test started from this sheet will be called: "v1.1 · Test 3"
  // (a test made from a test is made from its version).
  nextTestLabelFrom(from) {
    const version = from.kind === 'test' ? from.base_version : from.version_string;
    const seq = (this.recipe.versions || [])
      .filter((v) => v.kind === 'test' && v.test_seq && (v.test_base || null) === (version || null))
      .reduce((max, v) => Math.max(max, v.test_seq), 0) + 1;
    return version ? `${version} · Test ${seq}` : `Test ${seq}`;
  },

  openTestingModal(versionString) {
    const test = entryByKey(this.recipe, versionString);
    if (!test) return;
    showModal(`
      <div class="modal-title">What is ${escHtml(test.label)} testing?</div>
      <div class="field-group mt8">
        <label class="field-label" for="testing-line">Testing</label>
        <input id="testing-line" class="field-input" placeholder="e.g. more water" maxlength="120" value="${escHtml(test.testing || '')}" />
        <small style="color:var(--ink2);font-size:0.78rem">A label only; the sheet itself doesn't change.</small>
      </div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="testing-save">Save</button>
      </div>`);
    const input = document.getElementById('testing-line');
    const save = async () => {
      try {
        await API.put(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(versionString)}/testing`, { testing: input?.value || '' });
        closeModal();
        await this.refreshRecipe();
        await this.renderDetail(document.getElementById('view-container'), versionString, { syncUrl: true, replaceUrl: true });
      } catch (e) {
        showToast('Error: ' + e.message);
      }
    };
    document.getElementById('testing-save')?.addEventListener('click', save);
    input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    setTimeout(() => input?.select(), 60);
  },

  async setTestOpen(versionString, open) {
    const test = entryByKey(this.recipe, versionString);
    try {
      await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(versionString)}/open`, { open });
      await this.refreshRecipe();
      await this.renderDetail(document.getElementById('view-container'), versionString, { syncUrl: true, replaceUrl: true });
      if (open) showToast(`${test?.label || 'Test'} reopened`);
      else showToast(test?.followed_by ? `Closed ${test.label}: ${test.followed_by} carries on from it` : `Stopped testing ${test?.label || ''}`.trim(), { action: { label: 'Undo', onClick: () => this.setTestOpen(versionString, true) } });
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  // In-place edit of a version (with the warning), or of a test that hasn't
  // been cooked. A test with a print record asks first: the print dialog
  // records one even when it's cancelled. The Editor goes back to the
  // working copy when you leave it.
  async fixTypo(versionString) {
    const entry = entryByKey(this.recipe, versionString);
    if (!entry || entry.locked) return false;
    if (entry.kind === 'test' && entry.last_printed_at) {
      const ok = await confirmModal({
        title: `Edit ${entry.label}?`,
        bodyHtml: `<p>${escHtml(entry.label)} went to the printer ${escHtml(shortDate(entry.last_printed_at))}. If it’s on paper, print it again after editing so the paper matches.</p>`,
        confirmLabel: 'Edit',
      });
      if (!ok) return false;
    }
    this.fixingVersion = versionString;
    this.activeVersion = entry;
    this.explicitVersionRequest = versionString;
    this.setTab('editor');
    this.refreshStatusRow();
    return true;
  },

  // ── Adopt / Release without testing ─────────────────────────────────────────
  // From a test on screen: "Adopt Test 4 as v1.2". From the working copy:
  // "Release without testing". Either way the next version; a test made from
  // an older version is merged into the current one.

  openReleaseModal() {
    const recipe = this.recipe;
    const sourceKey = this.releaseSourceVersionKey();
    const source = entryByKey(recipe, sourceKey);
    const current = recipe.current_version;
    const fromTest = sourceKey !== 'draft';
    const title = fromTest ? `Adopt ${source?.label || 'this test'} as ${recipe.next_version_string}` : 'Release without testing';
    const base = source?.base_version;
    const mergeNote = current && base && base !== current.version_string
      ? `${fromTest ? source.label : 'The working copy'} is based on ${base}. Its changes will be merged into ${current.label}, so nothing adopted since is lost.`
      : '';
    const intro = fromTest
      ? `Makes the next version from ${source?.label}${source?.testing ? ` (${source.testing})` : ''}, as written.`
      : `Makes the next version straight from the working copy, without cooking it as a test first. For an obvious fix.`;
    showModal(`
      <div class="modal-title">${escHtml(title)}</div>
      <p class="text-muted" style="font-size:0.85rem;margin:4px 0 0">${escHtml(intro)}</p>
      <div class="field-group mt12">
        <label class="field-label" for="rel-version">Version number</label>
        <input id="rel-version" class="field-input" placeholder="e.g. v1.1" value="${escHtml(recipe.next_version_string || 'v1.0')}" />
        ${current ? `<small style="color:var(--ink3);font-size:0.78rem;margin-top:4px">Current: ${escHtml(current.label)}</small>` : ''}
      </div>
      <div class="field-group mt12">
        <label class="field-label" for="rel-changelog">What changed</label>
        <textarea id="rel-changelog" class="field-input" placeholder="e.g. water 350 → 380 g">${escHtml(fromTest ? (source?.testing || '') : (recipe.draft?.testing || ''))}</textarea>
      </div>
      <div id="rel-merge" class="release-evidence" aria-live="polite"${mergeNote ? '' : ' hidden'}>${escHtml(mergeNote)}</div>
      ${fromTest ? `<div id="rel-evidence" class="release-evidence" aria-live="polite"></div><div id="rel-source"></div>` : ''}
      <div id="rel-conflict" class="release-evidence release-evidence-warn" hidden></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="rel-go" onclick="RecipeView.release()">${fromTest ? 'Adopt' : 'Release'}</button>
      </div>`);
    setTimeout(() => document.getElementById('rel-version')?.select(), 100);
    const notes = document.getElementById('rel-changelog');
    notes?.addEventListener('input', () => { notes.dataset.edited = '1'; });
    if (fromTest) this.loadReleaseEvidence(sourceKey);
    this.loadAdoptPreview(sourceKey, fromTest ? source : recipe.draft);
  },

  // Before Adopt is clicked: whether it merges into the current version or
  // conflicts with it, and "What changed" in words from the real changes.
  async loadAdoptPreview(sourceKey, source) {
    const base = source?.base_version ? entryByKey(this.recipe, source.base_version) : null;
    const branch = `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}`;
    try {
      const [preview, baseParsed, sourceParsed] = await Promise.all([
        API.get(`${branch}/versions/${encodeURIComponent(sourceKey)}/adopt-preview`),
        base ? API.post(`${branch}/draft/parse`, { cooklang_text: base.cooklang_text }) : null,
        base ? API.post(`${branch}/draft/parse`, { cooklang_text: source.cooklang_text }) : null,
      ]);
      if (!document.getElementById('rel-go')) return; // closed
      const merge = document.getElementById('rel-merge');
      if (preview.mode === 'conflict') {
        this.showAdoptConflict(entryLabelFor(this.recipe, sourceKey));
        document.getElementById('rel-go').disabled = true;
      } else if (merge && preview.mode === 'merged') {
        merge.hidden = false;
        merge.textContent = `Merges cleanly into ${preview.current}: its changes are added to ${preview.current}, and nothing adopted since is lost.`;
      }
      const notes = document.getElementById('rel-changelog');
      if (base && notes && !notes.dataset.edited) {
        const asSheet = (parsed, text) => ({ fields: CookSheet.buildFields(parsed.steps), steps: parsed.steps, text });
        const summary = CookSheet.changeSummary(asSheet(baseParsed, base.cooklang_text), asSheet(sourceParsed, source.cooklang_text));
        if (summary) notes.value = summary;
      }
    } catch {
      // The preview is a help; Adopt still checks on the server.
    }
  },

  // How much cooking backs this test: adopting something nobody has cooked
  // should be a conscious choice.
  async loadReleaseEvidence(versionString) {
    const el = document.getElementById('rel-evidence');
    if (!el) return;
    const label = entryLabelFor(this.recipe, versionString);
    el.textContent = 'Checking cooks…';
    let logs;
    try {
      logs = await API.get(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/versions/${encodeURIComponent(versionString)}/cook-logs`);
    } catch {
      if (document.getElementById('rel-evidence') === el) el.textContent = '';
      return;
    }
    if (document.getElementById('rel-evidence') !== el) return; // modal changed
    const list = Array.isArray(logs) ? logs : [];
    // What the test changes: against its own base, not the current version
    // (which may have moved on).
    const test = entryByKey(this.recipe, versionString);
    const from = test?.base_version || this.recipe.current_version?.version_string;
    const compareLink = from && from !== versionString
      ? ` <button type="button" class="link-btn" onclick="RecipeView.showCompare('${escJs(from)}', '${escJs(versionString)}')">See what it changes from ${escHtml(from)}</button>`
      : '';
    if (!list.length) {
      el.className = 'release-evidence release-evidence-warn';
      el.innerHTML = `<strong>${escHtml(label)} hasn't been cooked yet.</strong> Consider cooking it before adopting it.${compareLink}`;
      return;
    }
    const ordered = [...list].sort(CookSheet.cookOrder);
    const latest = ordered[ordered.length - 1];
    // "1 at 2×": cooks at another scale back the test too, but say so.
    const byScale = new Map();
    for (const log of list) {
      const scale = Number(log.scale) || 1;
      if (scale !== 1) byScale.set(scale, (byScale.get(scale) || 0) + 1);
    }
    const scaleNote = Array.from(byScale, ([scale, n]) => `${n} at ${formatEditableQuantity(scale)}×`).join(', ');
    el.className = 'release-evidence';
    el.innerHTML = `${list.length} cook${list.length === 1 ? '' : 's'}${scaleNote ? ` (${escHtml(scaleNote)})` : ''} · latest ${escHtml(fmtDate(latest.cooked_at))}${latest.outcome ? `: “${escHtml(latest.outcome)}”` : ''}.${compareLink}`;
    // As written, or what one of the cooks did (the per-change checklist).
    const choice = document.getElementById('rel-source');
    if (!choice) return;
    this.cookLogs = list;
    const cooks = ordered;
    choice.innerHTML = `<fieldset class="rel-source">
      <legend class="field-label">Adopt</legend>
      <label class="rel-source-option"><input type="radio" name="rel-source" value="" checked /> ${escHtml(label)} as written</label>
      ${cooks.map((log, i) => `<label class="rel-source-option"><input type="radio" name="rel-source" value="${escHtml(log.id)}" /> What Cook ${i + 1} did (${escHtml(shortDate(log.cooked_at))}${(Number(log.scale) || 1) !== 1 ? `, ${escHtml(formatEditableQuantity(Number(log.scale)))}×` : ''}${log.outcome ? `: ${escHtml(log.outcome)}` : ''})…</label>`).join('')}
    </fieldset>`;
    choice.addEventListener('change', (e) => {
      if (e.target.name === 'rel-source' && e.target.value) this.openPromoteLogModal(e.target.value);
    });
  },

  // Open the Versions tab's compare on a given pair.
  showCompare(from, to) {
    closeModal();
    this.pendingCompare = { from, to };
    this.setTab('versions');
  },

  // A refused merge: say where, and offer the way through (a new test from
  // the current version).
  showAdoptConflict(sourceLabel) {
    const el = document.getElementById('rel-conflict');
    const current = this.recipe.current_version;
    if (!el) { showToast(`${sourceLabel} and ${current?.label || 'the current version'} change the same line`); return; }
    el.hidden = false;
    const mergeNote = document.getElementById('rel-merge');
    if (mergeNote) mergeNote.hidden = true;
    el.innerHTML = `<strong>${escHtml(sourceLabel)} and ${escHtml(current?.label || 'the current version')} change the same line</strong>, so they can't be combined automatically.
      ${current ? `Start a new test from ${escHtml(current.label)} and make the change there. <button type="button" class="link-btn" onclick="closeModal(); RecipeView.openNewTestModal('${escJs(current.version_string)}')">New test from ${escHtml(current.label)}…</button>` : ''}`;
  },

  async release() {
    const sourceVersion = this.releaseSourceVersionKey();
    if (sourceVersion === 'draft') await this.saveDraft({ silent: true, advanceBeta: false });
    const versionString = document.getElementById('rel-version')?.value.trim();
    const changelog = document.getElementById('rel-changelog')?.value.trim();
    if (!versionString) { showToast('Version number required'); return; }
    const sourceLabel = entryLabelFor(this.recipe, sourceVersion);
    try {
      const response = await API.post(`/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}/release`, { version_string: versionString, changelog, source_version: sourceVersion });
      closeModal();
      this.fixingVersion = null;
      this.activeTab = 'overview';
      await this.refreshRecipe();
      await this.renderDetail(document.getElementById('view-container'), versionString, { syncUrl: true, replaceUrl: true });
      showToast(`${versionString} is now the current version${response?.merged ? ` (merged with the previous one)` : ''}`);
      this.maybeShowUnresolvedWarning(response, false);
    } catch (e) {
      if (e.message === 'conflict') { this.showAdoptConflict(sourceLabel); return; }
      showToast('Error: ' + e.message);
    }
  },

});
