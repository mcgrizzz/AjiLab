// ── The test page — what a test changes, and how its cooks went ─────────────
// /recipe/<slug>/tests/N. From the top: the test and its actions, what it
// changes from its base (the compare view), its cooks side by side (only the
// values that differ, at the sheet's 1×), then the sheet itself, collapsed.
// The decisions sit with the evidence: adopt as written or from a cook, a new
// test from a cook, stop testing. See docs/VERSIONING-DESIGN.md §3.6, §7.
Object.assign(RecipeView, {

  renderTestPage(body, test) {
    const label = test.label;
    body.innerHTML = `
      <div class="tab-content overview-tab test-page">
        ${this.openTestsStripHtml(test)}
        ${this.overviewPrimaryBannerHtml(test)}
        <section class="test-section" aria-labelledby="test-changes-title">
          <h2 class="test-section-title" id="test-changes-title">What it changes${test.base_version ? ` from ${escHtml(test.base_version)}` : ''}</h2>
          <div id="test-changes"><div class="loading"><div class="spinner"></div></div></div>
        </section>
        <section class="test-section" aria-labelledby="test-cooks-title">
          <h2 class="test-section-title" id="test-cooks-title">Cooks</h2>
          <div id="test-cooks"><div class="loading"><div class="spinner"></div></div></div>
        </section>
        <details class="test-sheet">
          <summary>The sheet: ${escHtml(label)}${test.testing ? ` — ${escHtml(test.testing)}` : ''}</summary>
          ${this.recipeBodyHtml()}
        </details>
      </div>`;
    StickyFit.watch([body.querySelector('.recipe-sidebar')]);
    this.renderImageManager();
    this.loadTestChanges(test);
    this.loadTestCooks(test);
  },

  apiBase() {
    return `/recipes/${this.slug}/branches/${encodeURIComponent(this.branchSlug)}`;
  },

  async parseText(text, options = {}) {
    return API.post(`${this.apiBase()}/draft/parse`, { cooklang_text: text || '', ...options });
  },

  async loadTestChanges(test) {
    const el = document.getElementById('test-changes');
    if (!el) return;
    if (!test.base_version) {
      el.innerHTML = `<p class="text-muted test-empty">${escHtml(test.label)} came before any version, so there's nothing to compare it with.</p>`;
      return;
    }
    try {
      const cmp = await API.get(`${this.apiBase()}/compare?from=${encodeURIComponent(test.base_version)}&to=${encodeURIComponent(test.version_string)}&temp=${encodeURIComponent(this.temperatureUnit || 'F')}`);
      if (document.getElementById('test-changes') !== el) return;
      this.renderCompareResult(el, cmp);
    } catch (e) {
      el.innerHTML = `<p class="text-muted">Couldn't compare: ${escHtml(e.message)}</p>`;
    }
  },

  // ── The cooks, side by side ─────────────────────────────────────────────────

  async loadTestCooks(test) {
    const el = document.getElementById('test-cooks');
    if (!el) return;
    try {
      const logs = (await API.get(`${this.apiBase()}/versions/${encodeURIComponent(test.version_string)}/cook-logs`))
        .filter((log) => log.source_kind === 'version')
        .sort((a, b) => a.cooked_at.localeCompare(b.cooked_at));
      // The cook decisions (adopt from a cook, new test from a cook) look
      // cooks up here.
      this.cookLogs = logs;
      if (!logs.length) {
        el.innerHTML = `<div class="test-empty">
          <p class="text-muted">Not cooked yet. Print it, cook from the sheet, then record how it went.</p>
          <button class="btn btn-sm btn-primary" onclick="RecipeView.logThisCook()">Record a cook</button>
        </div>`;
        return;
      }
      const baseEntry = test.base_version ? entryByKey(this.recipe, test.base_version) : null;
      const [sheetParsed, baseParsed, ...cookParsed] = await Promise.all([
        this.parseText(test.cooklang_text),
        baseEntry ? this.parseText(baseEntry.cooklang_text) : null,
        ...logs.map((log) => this.parseText(log.cooklang_text, {
          source_cooklang_text: log.source_cooklang_text, source_scale: Number(log.scale) || 1,
        })),
      ]);
      const asSheet = (parsed, text) => ({ fields: CookSheet.buildFields(parsed.steps), steps: parsed.steps, text });
      const table = CookSheet.comparison({
        base: baseParsed ? asSheet(baseParsed, baseEntry.cooklang_text) : null,
        sheet: asSheet(sheetParsed, test.cooklang_text),
        cooks: logs.map((log, i) => ({
          scale: Number(log.scale) || 1,
          fields: CookSheet.buildFields(cookParsed[i].steps),
          steps: cookParsed[i].steps,
          intended: log.intended || [],
        })),
      });
      if (document.getElementById('test-cooks') !== el) return;
      el.innerHTML = this.cookTableHtml(test, baseEntry, logs, table);
    } catch (e) {
      el.innerHTML = `<p class="text-muted">Couldn't load the cooks: ${escHtml(e.message)}</p>`;
    }
  },

  cookTableHtml(test, baseEntry, logs, table) {
    const amount = (a, isTemp) => (a ? escHtml(CookSheet.formatAmount(a, isTemp)) : '—');
    const cols = logs.length + (baseEntry ? 2 : 1);
    const head = `<tr>
      <th scope="col" class="ct-label-col"><span class="visually-hidden">Value</span></th>
      ${baseEntry ? `<th scope="col" class="ct-sheet-col">${escHtml(baseEntry.label)}</th>` : ''}
      <th scope="col" class="ct-sheet-col">${escHtml(test.label)}</th>
      ${logs.map((log, i) => `<th scope="col" class="ct-cook-col">
        <button type="button" class="link-btn" onclick="RecipeView.openCook('${escJs(log.id)}')" title="Open this cook">Cook ${i + 1}</button>
        <span class="ct-cook-meta">${escHtml(shortDate(log.cooked_at))}${(Number(log.scale) || 1) !== 1 ? ` · ${escHtml(formatEditableQuantity(Number(log.scale)))}×` : ''}</span>
      </th>`).join('')}
    </tr>`;
    const cellHtml = (cell, row) => {
      if (cell.kind === 'none') return '<td class="ct-cell ct-none">—</td>';
      if (cell.kind === 'left-out') return `<td class="ct-cell ct-changed${cell.intended ? ' ct-intended' : ''}">left out${cell.intended ? ' <span class="ct-meant" title="I meant this">✓</span>' : ''}</td>`;
      const title = cell.scaled ? ` title="Cooked: ${escHtml(CookSheet.formatAmount(cell.cooked, row.isTemp))} (shown at 1×)"` : '';
      const kindLabel = cell.kind === 'same' ? '<span class="visually-hidden"> (same amount)</span>' : (cell.kind === 'changed' ? '<span class="visually-hidden"> (changed)</span>' : '');
      return `<td class="ct-cell ct-${cell.kind}${cell.intended ? ' ct-intended' : ''}"${title}>${amount(cell.amount, row.isTemp)}${kindLabel}${cell.intended ? ' <span class="ct-meant" title="I meant this">✓</span>' : ''}</td>`;
    };
    const valueRows = table.rows.length
      ? table.rows.map((row) => `<tr class="${row.tested ? 'ct-tested' : ''}">
          <th scope="row" class="ct-label">${escHtml(row.label)}${row.tested ? ' <span class="ct-tested-tag">tested</span>' : ''}</th>
          ${baseEntry ? `<td class="ct-cell ct-sheet">${amount(row.base, row.isTemp)}</td>` : ''}
          <td class="ct-cell ct-sheet">${amount(row.sheet, row.isTemp)}</td>
          ${row.cells.map((cell) => cellHtml(cell, row)).join('')}
        </tr>`).join('')
      : `<tr><th scope="row" class="ct-label">Amounts</th><td class="ct-cell ct-unchanged" colspan="${cols}">Every cook used the amounts on the sheet.</td></tr>`;
    const stepRows = table.stepRows.map((row) => `<tr>
        <th scope="row" class="ct-label">${escHtml(row.label)}</th>
        <td class="ct-cell ct-step-text" colspan="${baseEntry ? 2 : 1}">${escHtml(row.text)}</td>
        ${row.cells.map((on) => `<td class="ct-cell${on ? ' ct-changed' : ' ct-none'}">${on ? '✓' : ''}</td>`).join('')}
      </tr>`).join('');
    const textRow = (label, pick) => `<tr class="ct-words">
        <th scope="row" class="ct-label">${label}</th>
        <td class="ct-cell" colspan="${baseEntry ? 2 : 1}"></td>
        ${logs.map((log) => `<td class="ct-cell ct-text">${pick(log) ? formatMultilineText(pick(log)) : '<span class="text-muted">—</span>'}</td>`).join('')}
      </tr>`;
    const decisions = `<tr class="ct-actions">
        <th scope="row" class="ct-label"><span class="visually-hidden">Decide</span></th>
        <td class="ct-cell" colspan="${baseEntry ? 2 : 1}"></td>
        ${logs.map((log) => {
          const adopted = this.cookAdoptedAs(log);
          const decide = this.cookDecisions(log);
          return `<td class="ct-cell">
            ${adopted ? `<span class="badge badge-released">Adopted as ${escHtml(adopted)}</span>` : ''}
            ${decide.adopt ? `<button class="btn btn-sm" onclick="RecipeView.openPromoteLogModal('${escJs(log.id)}')">Adopt from this cook…</button>` : ''}
            ${decide.newTest ? `<button class="btn btn-sm btn-ghost" onclick="RecipeView.iterateFromCookLog('${escJs(log.id)}')">New test from it…</button>` : ''}
          </td>`;
        }).join('')}
      </tr>`;
    const legend = '<p class="ct-legend">Amounts at the sheet’s 1×; a cook at another scale shows what it used on hover. <span class="ct-key ct-changed">changed</span> <span class="ct-key ct-same">same amount, written differently</span> <span class="ct-key">✓ I meant this</span></p>';
    return `<div class="cook-table-wrap"><table class="cook-table">
        <thead>${head}</thead>
        <tbody>
          ${valueRows}
          ${stepRows}
          ${textRow('Outcome', (log) => log.outcome)}
          ${textRow('Try next', (log) => log.changes_to_try_next)}
          ${textRow('Notes', (log) => CookSheet.joinedNotes(log))}
          ${decisions}
        </tbody>
      </table></div>${legend}`;
  },
});
