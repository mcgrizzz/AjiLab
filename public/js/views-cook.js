// ── View: Record a cook ───────────────────────────────────────────────────────
// /recipe/<slug>/cooks/new and /recipe/<slug>/cooks/<id>: one screen in the
// paper's order. The sheet comes first with every amount, time and
// temperature editable in place, then Outcome, Try next and Notes. Nothing is
// required: the cook is recorded at the first change (or "Cooked as
// written"), and every change saves in the background, in order, without
// repainting the page. Structural changes (a note or an added step) repaint
// the sheet once they're saved. Photos are optional; adding one records the
// cook too.
//
// Keyboard: Tab / Shift-Tab move between values (and steps that have none),
// Enter confirms and moves on, Esc puts a value back, Alt+S skips the step,
// Alt+N adds a note under it, Ctrl/Cmd-Z undoes the last change to the sheet,
// Ctrl/Cmd-Enter is Done.
const CookView = {
  active: false,

  base() {
    return `/recipes/${this.slug}/branches/${encodeURIComponent(this.branch)}`;
  },

  pathFor(id) {
    const params = new URLSearchParams();
    if (this.branch !== 'main') params.set('branch', this.branch);
    const qs = params.toString();
    return `/recipe/${this.slug}/cooks/${id}${qs ? `?${qs}` : ''}`;
  },

  reset() {
    this.recipe = null;
    this.log = null;
    this.start = null;
    this.sheetKey = null;
    this.scale = 1;
    this.text = '';
    this.sourceText = '';
    this.parsed = null;
    this.fields = [];
    this.sections = [];
    this.listed = new Set();
    this.day = CookSheet.localDay(new Date());
    this.time = '';
    this.intended = new Map();
    this.queue = Promise.resolve();
    this.pending = 0;
    this.failed = null;
    this.undoStack = [];
    this.reflectDirty = {};
    clearTimeout(this.reflectTimer);
    this.changingSheet = false;
    this.startShown = false;
    // How the paper showed the amounts ({ temp, units, round }); values show
    // the same, except one typed in another unit, which shows as typed
    // (showAs: field id → that unit).
    this.display = {};
    this.showAs = new Map();
    this.uploading = 0;
  },

  // opts: { id } for an existing cook; for a new one { sheet, scale, pick }
  // (pick: the sheet was chosen on purpose, so a pending print doesn't win).
  async render(container, slug, opts = {}) {
    this.reset();
    this.active = true;
    this.slug = slug;
    this.branch = opts.branch || 'main';
    container.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      this.recipe = await API.get(this.base());
      if (opts.id) {
        const log = await API.get(`${this.base()}/cook-logs/${encodeURIComponent(opts.id)}`);
        this.log = log;
        this.sheetKey = log.source_kind === 'draft' ? null : log.source_version_string;
        this.scale = Number(log.scale) || 1;
        this.text = log.cooklang_text || '';
        this.sourceText = log.source_cooklang_text || '';
        this.day = CookSheet.localDay(log.cooked_at);
        const time = CookSheet.localTime(log.cooked_at);
        this.time = time === '12:00' ? '' : time;
        for (const key of log.intended || []) this.intended.set(CookSheet.keyId(key), key);
        this.display = log.display || {};
      } else {
        const selected = opts.sheet ? { version_string: opts.sheet } : null;
        const scale = parseFloat(opts.scale) > 0 ? parseFloat(opts.scale) : 1;
        this.start = RecipeEditState.cookStart(this.recipe, selected, { explicit: !!opts.pick, scale });
        if (!this.start.version_string) {
          container.innerHTML = `<div class="empty-state"><p>Nothing to cook yet. Save the working copy as a test first.</p>
            <button class="btn mt12" onclick="Router.go('/recipe/${escJs(slug)}?tab=editor')">Open the editor</button></div>`;
          return;
        }
        this.sheetKey = this.start.version_string;
        this.scale = this.start.scale;
        // Cooked today unless you say otherwise: the print date is one of
        // the choices, not the default (people cook days after printing).
        this.display = this.printDisplay();
      }
      await this.loadSheet();
      this.paint(container);
      // A new cook: start typing the first value straight away (not on touch
      // screens, where that would open the keyboard over the sheet).
      if (!this.log && window.matchMedia?.('(pointer: fine)').matches) {
        container.querySelector('.cook-sheet .ck-input:not([tabindex="-1"])')?.focus();
      }
    } catch (e) {
      container.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
    }
  },

  // Leaving: send what's typed in the notes fields.
  leave() {
    if (!this.active) return;
    this.active = false;
    if (Object.keys(this.reflectDirty || {}).length) this.saveReflect();
  },

  // The display of the print this new cook starts from, if it's this sheet's.
  printDisplay() {
    const print = this.start?.print;
    return print && print.version_string === this.sheetKey ? (print.display || {}) : {};
  },

  // A value as the paper showed it, as text.
  shown(f, amount = f.current) {
    return CookSheet.formatAmount(CookSheet.shownAmount(f, amount, this.displayFor(f)), f.isTemp);
  },

  // How this value is shown: as on the paper, or in the unit it was typed in.
  displayFor(f) {
    const as = this.showAs.get(f.id);
    if (!as) return this.display;
    if (f.isTemp) return { ...this.display, temp: /^°?\s*c/i.test(as) ? 'C' : 'F' };
    const def = f.kind === 'ingredient' ? Units.lookup(as) : null;
    return def ? { ...this.display, units: { ...(this.display.units || {}), [Units.overrideKey(f.name)]: def.key } } : this.display;
  },

  // What the value is called: "flour", "time", "water temperature".
  valueName(f) {
    if (f.kind === 'ingredient') return f.name;
    if (f.kind === 'timer') return 'time';
    return `${f.kind === 'noteQuantity' ? `${f.name} ` : ''}${f.isTemp ? 'temperature' : 'amount'}`;
  },

  // A time in a unit the list knows: its box holds the number, the list
  // beside it the unit.
  hasUnitList(f) {
    return f.kind === 'timer' && !!CookSheet.timeUnit(f.original.units);
  },

  // What the box shows for a value.
  inputText(f, amount = f.current) {
    return this.hasUnitList(f) ? String(amount?.quantity ?? '') : this.shown(f, amount);
  },

  // The unit words to suit the number: "1 hour", "2 hours".
  unitWords(quantity) {
    const one = String(quantity ?? '').trim() === '1';
    return { sec: 'sec', min: 'min', hour: one ? 'hour' : 'hours', day: one ? 'day' : 'days' };
  },

  // A time's number box fits its number, so the unit follows it closely.
  boxSize(f, text) {
    return Math.max(1, String(text ?? '').length);
  },

  // The unit list as wide as the word it shows, plus the ▾.
  unitWidth(word) {
    return `calc(${String(word).length + 1}ch + 11px)`;
  },

  unitListHtml(f) {
    const unit = CookSheet.timeUnit(f.current.units) || CookSheet.timeUnit(f.original.units);
    const words = this.unitWords(f.current.quantity);
    return `<select class="ck-unit" data-f="${f.id}" tabindex="-1" aria-label="Unit" style="width:${this.unitWidth(words[unit] || 'min')}">${Object.entries(words)
      .map(([key, text]) => `<option value="${key}"${key === unit ? ' selected' : ''}>${text}</option>`).join('')}</select>`;
  },

  // What was typed, as the paper shows it, then in the recipe's own units.
  // A time's bare number takes the unit chosen beside it.
  readTyped(f, text) {
    const unit = this.hasUnitList(f) ? document.querySelector(`.ck-unit[data-f="${f.id}"]`)?.value : null;
    return CookSheet.readTyped(f, text, this.displayFor(f), unit);
  },

  // The unit typed with a value, when it's not the one shown ("200 g" where
  // the paper said 7 oz): the value then shows in it.
  typedUnit(f, text) {
    if (this.hasUnitList(f)) return null;
    const units = CookSheet.parseTyped(text, f, '')?.units;
    if (!units) return null;
    const shown = CookSheet.shownAmount(f, f.current, this.displayFor(f)).units;
    return CookSheet.formatAmount({ quantity: 1, units }, f.isTemp) === CookSheet.formatAmount({ quantity: 1, units: shown }, f.isTemp) ? null : units;
  },

  sheetEntry() {
    return this.sheetKey ? entryByKey(this.recipe, this.sheetKey) : null;
  },

  // The sheet as cooked: a new cook shows the sheet at its scale (exactly
  // the text the server will record); a recorded one, its own text, compared
  // with the sheet.
  async loadSheet() {
    if (this.log) {
      this.parsed = await API.post(`${this.base()}/draft/parse`, {
        cooklang_text: this.text, source_cooklang_text: this.sourceText, source_scale: this.scale,
      });
    } else {
      const entry = this.sheetEntry();
      this.parsed = await API.post(`${this.base()}/draft/parse`, { cooklang_text: entry?.cooklang_text || '', scale: this.scale });
      this.text = this.parsed.cooklang_text || '';
    }
    this.fields = CookSheet.buildFields(this.parsed.steps);
    this.sections = CookSheet.ingredientRows(this.parsed.ingredient_summary, this.fields);
    this.listed = CookSheet.listedFieldIds(this.sections);
    // An ingredient's note values go with it in the list.
    for (const row of this.sections.flatMap((section) => section.rows)) {
      if (row.field) for (const f of this.noteFieldsOf(row.field)) this.listed.add(f.id);
    }
  },

  // The values in the note of the ingredient a value belongs to.
  noteFieldsOf(f) {
    const own = this.componentOf(f);
    const count = (own?.token.note_values || []).length;
    return own ? this.fields.filter((x) => x.kind === 'noteQuantity' && x.sectionIndex === f.sectionIndex
      && x.stepNumber === f.stepNumber && x.index >= own.noteIndex && x.index < own.noteIndex + count) : [];
  },

  field(id) {
    return this.fields.find((f) => f.id === id) || null;
  },

  // ── Painting ────────────────────────────────────────────────────────────────

  paint(container) {
    const recipe = this.recipe;
    const log = this.log;
    container.innerHTML = `
      <div class="cook-view">
        <div class="cook-topbar">
          <button class="btn btn-sm" data-act="done">← ${escHtml(recipe.title)}</button>
          <span class="cook-status" id="cook-status" role="status" aria-live="polite"></span>
        </div>
        <header class="cook-header">
          <h1 class="cook-title" id="cook-title">${this.titleText()}</h1>
          <div class="cook-sheet-line" id="cook-sheet-line">${this.sheetLineHtml()}</div>
          <div class="cook-date" id="cook-date" role="group" aria-label="When you cooked">${this.dateHtml()}</div>
        </header>
        <div class="cook-start" id="cook-start">${this.startHtml()}</div>
        <section class="cook-sheet" id="cook-sheet" aria-label="The sheet as cooked">${this.sheetHtml()}</section>
        <section class="cook-reflect" aria-label="How it went">
          <div class="field-group">
            <label class="field-label" for="cook-outcome">Outcome</label>
            <input id="cook-outcome" class="field-input" data-reflect="outcome" maxlength="200" placeholder="One line, e.g. good, slightly sticky" value="${escHtml(log?.outcome || '')}" />
          </div>
          <div class="field-group">
            <label class="field-label" for="cook-next">Try next</label>
            <textarea id="cook-next" class="field-input" data-reflect="next" rows="2" placeholder="e.g. less water">${escHtml(log?.changes_to_try_next || '')}</textarea>
          </div>
          <div class="field-group">
            <label class="field-label" for="cook-notes">Notes</label>
            <textarea id="cook-notes" class="field-input" data-reflect="notes" rows="3" placeholder="What worked, what didn't">${escHtml(CookSheet.joinedNotes(log))}</textarea>
          </div>
          <div class="field-group">
            <span class="field-label" id="cook-photos-label">Photos</span>
            <div class="cook-photos" id="cook-photos" role="group" aria-labelledby="cook-photos-label">${this.photosHtml()}</div>
          </div>
        </section>
        <div class="cook-done-bar">
          <span class="cook-done-note">Saved as you go.</span>
          <button class="btn btn-primary" data-act="done" title="Done (Ctrl+Enter)">Done</button>
        </div>
      </div>`;
    const view = container.querySelector('.cook-view');
    view.addEventListener('input', (e) => this.onInput(e));
    view.addEventListener('change', (e) => this.onChange(e));
    view.addEventListener('keydown', (e) => this.onKeydown(e));
    view.addEventListener('click', (e) => this.onClick(e));
    // Focusing a value selects it, so typing replaces it. A click's mouseup
    // would collapse that selection to the click point (typing "225" into
    // "2|20 g" gives "222250 g"), so the mouseup after a focusing click is
    // swallowed.
    view.addEventListener('focusin', (e) => {
      if (!e.target.classList?.contains('ck-input')) return;
      e.target.select();
      e.target.dataset.justFocused = '1';
    });
    view.addEventListener('mouseup', (e) => {
      const input = e.target.closest?.('.ck-input');
      if (input?.dataset.justFocused) { e.preventDefault(); input.select(); }
      if (input) delete input.dataset.justFocused;
    });
    view.addEventListener('focusout', (e) => {
      if (e.target.dataset?.justFocused) delete e.target.dataset.justFocused;
      this.onFocusOut(e);
    });
    this.setStatus();
  },

  // One title before and after it's recorded: "Cook · Nov 10".
  titleText() {
    const date = new Date(`${this.day}T12:00`);
    const opts = { month: 'short', day: 'numeric' };
    if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return `Cook · ${escHtml(date.toLocaleDateString(undefined, opts))}`;
  },

  // "today", "yesterday", "on Nov 2".
  dayWords() {
    const words = shortDate(`${this.day}T12:00`);
    return words === 'today' || words === 'yesterday' ? words : `on ${words}`;
  },

  photosHtml() {
    const ids = this.log?.photos || [];
    const thumbs = ids.map((id) => `<div class="image-thumb cook-photo">
        <a href="/api/images/${escHtml(id)}" target="_blank" rel="noreferrer"><img src="/api/images/${escHtml(id)}" alt="Photo of this cook" loading="lazy" /></a>
        <button class="del-img" data-act="remove-photo" data-photo="${escHtml(id)}" aria-label="Delete this photo" title="Delete this photo">✕</button>
      </div>`).join('');
    const busy = Array.from({ length: this.uploading }, () => '<div class="image-thumb cook-photo cook-photo-busy" role="status">Adding…</div>').join('');
    return `${thumbs}${busy}
      <button class="btn btn-sm cook-photo-add" data-act="add-photo">${ids.length ? 'Add more' : 'Add photos'}</button>
      <input type="file" id="cook-photo-file" accept="image/*" multiple hidden />`;
  },

  paintPhotos() {
    const el = document.getElementById('cook-photos');
    if (el && this.active) el.innerHTML = this.photosHtml();
  },

  // Each photo goes up in turn, after whatever is already saving. A photo
  // that can't be added says so without stopping the rest of the cook.
  addPhotos(input) {
    const files = [...(input.files || [])].filter((f) => f.type.startsWith('image/'));
    input.value = '';
    if (!files.length) return;
    this.uploading += files.length;
    this.paintPhotos();
    for (const file of files) {
      this.enqueue(async () => {
        try {
          const fd = new FormData();
          fd.append('image', await shrinkImageFile(file));
          const log = await API.postForm(`${this.base()}/cook-logs/${encodeURIComponent(this.log.id)}/photos`, fd);
          this.log.photos = log.photos;
        } catch (e) {
          showToast(`Couldn't add ${file.name || 'the photo'}: ${e.message}`);
        } finally {
          this.uploading -= 1;
          this.paintPhotos();
        }
      });
    }
  },

  async removePhoto(id) {
    const ok = await confirmModal({ title: 'Delete this photo?', bodyHtml: '<p>It can’t be undone.</p>', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    this.enqueue(async () => {
      await API.delete(`/images/${encodeURIComponent(id)}`);
      this.log.photos = (this.log.photos || []).filter((p) => p !== id);
      this.paintPhotos();
      document.querySelector('#cook-photos .cook-photo-add')?.focus();
    });
  },

  sheetLabel() {
    const entry = this.sheetEntry();
    if (!entry) {
      if (this.log?.source_kind === 'draft') return `the working copy (${shortDate(this.log.created_at)})`;
      return this.log?.source_version_string || 'Unknown sheet';
    }
    return entry.kind === 'test' && entry.testing ? `${entry.label} — ${entry.testing}` : entry.label;
  },

  sheetLineHtml() {
    const scale = this.scale !== 1 ? ` · ${escHtml(formatEditableQuantity(this.scale))}×` : ' · 1×';
    const print = !this.log && this.start?.print && this.start.print.version_string === this.sheetKey
      ? ` · printed ${escHtml(shortDate(this.start.print.printed_at))}` : '';
    if (this.changingSheet) {
      return `<label class="cook-pick">Sheet <select id="cook-pick-sheet" class="field-input">${sheetOptionsHtml(sheetOptionGroups(this.recipe), this.sheetKey)}</select></label>
        <label class="cook-pick">Scale <input id="cook-pick-scale" class="field-input" type="number" min="0.05" max="100" step="any" value="${escHtml(formatEditableQuantity(this.scale))}" /></label>
        <button class="btn btn-sm" data-act="apply-sheet">Use this</button>
        <button class="btn btn-sm btn-ghost" data-act="cancel-sheet">Cancel</button>`;
    }
    const change = this.log
      ? '<span class="cook-fixed-note">Fixed once recorded</span>'
      : '<button class="link-btn" data-act="change-sheet">Change</button>';
    const asPrinted = CookSheet.displayNote(this.display);
    const shownAs = asPrinted ? ` · <span class="cook-shown-as" title="Values are shown as on the printout and saved in the recipe's own units">as printed: ${escHtml(asPrinted)}</span>` : '';
    return `<span class="cook-sheet-name">${escHtml(this.sheetLabel())}</span>${scale}${print}${shownAs} ${change}`;
  },

  dateHtml() {
    const print = this.start?.print;
    const printedAt = print && print.version_string === this.sheetKey ? print.printed_at : null;
    const choices = CookSheet.dateChoices(new Date(), printedAt);
    const chips = choices.map((c) => {
      const on = c.day === this.day;
      const label = c.id === 'print' ? `Print date · ${shortDate(c.day + 'T12:00')}` : c.label;
      return `<button class="cook-chip${on ? ' is-on' : ''}" data-act="day" data-day="${c.day}" aria-pressed="${on}">${escHtml(label)}</button>`;
    }).join('');
    return `<span class="cook-date-label">Cooked</span>${chips}
      <input type="date" class="field-input cook-day" id="cook-day" value="${escHtml(this.day)}" max="${escHtml(CookSheet.localDay(new Date()))}" aria-label="Day you cooked" />
      <input type="time" class="field-input cook-time" id="cook-time" value="${escHtml(this.time)}" aria-label="Time (optional)" title="Time (optional)" />`;
  },

  // The same shape before and after the cook is recorded, so nothing below
  // moves when it is.
  startHtml(recorded = !!this.log) {
    if (this.log && !this.startShown) return '';
    this.startShown = true;
    const lead = recorded
      ? '<span class="cook-start-done" role="status">✓ Recorded</span>'
      : '<button class="btn btn-primary" data-act="as-written">Cooked as written</button>';
    return `${lead}${this.startWhenHtml(recorded)}
      <span class="cook-start-note">${recorded ? 'Change' : 'Or change'} what you did differently below: Tab moves between values, Enter confirms, Esc puts one back.</span>`;
  },

  // Before anything is saved, say what the first change does, and as which day.
  startWhenHtml(recorded = !!this.log) {
    const when = recorded
      ? `Recorded as cooked ${escHtml(this.dayWords())}.`
      : `Nothing is saved yet. Your first change records this cook, as cooked <strong>${escHtml(this.dayWords())}</strong>.`;
    return `<span class="cook-start-when" id="cook-start-when">${when}</span>`;
  },

  sheetHtml() {
    const parsed = this.parsed;
    const multi = this.sections.length > 1;
    const ingredients = this.sections.some((s) => s.rows.length)
      ? `<div class="section-head">Ingredients</div>${this.sections.filter((section) => section.rows.length).map((section) => `
          ${multi && section.name ? `<div class="cook-ing-section">${escHtml(section.name)}</div>` : ''}
          <ul class="cook-ing-list">${section.rows.map((row) => this.rowHtml(row)).join('')}</ul>`).join('')}`
      : '';
    return `${CL.renderMetrics(parsed.metrics)}
      ${ingredients}
      ${parsed.steps?.length ? `<div class="section-head mt16">Steps</div><ol class="cook-steps">${this.stepsHtml()}</ol>` : ''}`;
  },

  // A row of the ingredient list: its amount, its note ("at 90-95°F", any
  // value in it editable here), and "was …" beside what changed.
  rowHtml(row) {
    if (row.field) {
      const own = this.componentOf(row.field);
      const notes = this.noteFieldsOf(row.field);
      const note = own ? this.componentNoteHtml(own.token, notes, own.noteIndex, () => true) : '';
      return `<li class="cook-ing-row">${this.fieldHtml(row.field, { tabbable: true, inList: true })}${note}
        <span class="ck-wases">${[row.field, ...notes].map((f) => this.wasHtml(f, f.kind !== 'ingredient')).join('')}</span></li>`;
    }
    const amount = CookSheet.formatAmount(row.amount);
    return `<li class="cook-ing-row cook-ing-row-fixed">
      <span class="cook-ing-amt">${escHtml(amount)}</span>
      <span class="cook-ing-name">${escHtml(row.name)}</span>
      ${row.note ? `<span class="cook-note">(${renderTextWithBreaks(row.note, this.display.temp || 'F')})</span>` : ''}
      ${row.uses > 1 ? '<span class="cook-ing-hint">change it in the steps</span>' : ''}
    </li>`;
  },

  // The step token a value belongs to, and the index (among the step's note
  // values) of its note's first value.
  componentOf(f) {
    for (const step of this.parsed.steps || []) {
      const info = CookSheet.stepInfo(step);
      if (info.sectionIndex !== f.sectionIndex || info.stepNumber !== f.stepNumber) continue;
      let n = 0;
      let noteIndex = 0;
      for (const token of step) {
        if (!token || typeof token !== 'object') continue;
        if (token.type === f.kind && n++ === f.index) return { token, noteIndex };
        noteIndex += (token.note_values || []).length;
      }
    }
    return null;
  },

  // An ingredient's or cookware's note, "(at 90-95°F)", with any value in it
  // editable like the rest. first: the index of its first value among the
  // step's note values. tabbable(f): whether its value is a Tab stop here.
  componentNoteHtml(token, fields, first, tabbable) {
    if (!token?.note || (token.type !== 'ingredient' && token.type !== 'cookware')) return '';
    let index = first;
    const inner = (token.note_parts || [token.note]).map((part) => {
      if (typeof part !== 'number') return renderTextWithBreaks(part, this.display.temp || 'F');
      const at = index++;
      const f = fields.find((x) => x.kind === 'noteQuantity' && x.index === at);
      return f ? this.fieldHtml(f, { tabbable: tabbable(f) }) : escHtml(token.note_values?.[part]?.value || '');
    }).join('');
    const endsWithValue = typeof (token.note_parts || []).at(-1) === 'number';
    return ` <span class="cook-note">(${inner}${endsWithValue ? '<span class="ck-punct">)</span>' : ')'}</span>`;
  },

  fieldHtml(f, { tabbable = true, inList = false } = {}) {
    const value = this.inputText(f);
    const size = this.hasUnitList(f) ? this.boxSize(f, value) : Math.max(3, value.length + 1, this.inputText(f, f.original).length + 1);
    const name = this.valueName(f);
    const label = f.kind === 'ingredient'
      ? `<span class="ck-name">${escHtml(f.name)}</span>`
      : (f.kind === 'timer' ? '<span class="ck-icon" aria-hidden="true">⏱</span>' : '');
    const input = `<input class="ck-input" data-f="${f.id}" value="${escHtml(value)}" size="${size}" spellcheck="false" autocomplete="off"${tabbable ? '' : ' tabindex="-1"'} aria-label="${escHtml(`${name}, the sheet said ${this.shown(f, f.original)}`)}" />`;
    const unitList = this.hasUnitList(f) ? `<span class="ck-unit-wrap">${this.unitListHtml(f)}</span>` : '';
    const chip = inList ? `${input}${unitList}${label}` : `${label}${input}${unitList}`;
    return `<span class="ck-field ck-${CookSheet.changeKind(f)}${inList ? ' ck-in-list' : ''}${unitList ? ' ck-has-unit' : ''}" data-f="${f.id}"><label class="ck-chip">${chip}</label></span>`;
  },

  // "was 232.2°C ↺ · I meant this" for a changed value: beside it in the
  // ingredient list, on a line under the step in the steps. labelled: says
  // which value ("time was 1-2 min").
  wasHtml(f, labelled) {
    return `<span class="ck-was" data-was="${f.id}"${labelled ? ' data-labelled="1"' : ''}>${this.wasInner(f, labelled)}</span>`;
  },

  wasInner(f, labelled = false) {
    const kind = CookSheet.changeKind(f);
    if (kind === 'unchanged') return '';
    const meant = f.key && this.intended.has(CookSheet.keyId(f.key));
    return (labelled ? `<span class="ck-was-what">${escHtml(this.valueName(f))}</span>` : '')
      + `<button class="ck-was-btn" data-act="revert" data-f="${f.id}" tabindex="-1" title="Put back what the sheet said">was <s>${escHtml(this.shown(f, f.original))}</s> <span class="ck-undo" aria-hidden="true">↺</span></button>`
      + (kind === 'changed' && f.key
        ? `<button class="ck-meant" data-act="meant" data-f="${f.id}" tabindex="-1" aria-pressed="${!!meant}" title="Mark this change as deliberate">${meant ? '✓ I meant this' : 'I meant this'}</button>`
        : '');
  },

  stepsHtml() {
    const out = [];
    let number = 0;
    const noteCounts = new Map();
    for (const step of this.parsed.steps || []) {
      const info = CookSheet.stepInfo(step);
      if (!Number.isFinite(info.stepNumber)) {
        const token = step.find((t) => t && typeof t === 'object');
        const value = String(token?.value || '');
        if (token?.type === 'text' && /^\s*=\s+/.test(value)) { out.push(`<li class="cook-section">${escHtml(value.replace(/^\s*=\s+/, ''))}</li>`); continue; }
        const note = value.replace(/^\s*(>\s*|--\s*)/, '');
        if (!note.trim()) continue;
        const occurrence = noteCounts.get(note.trim()) || 0;
        noteCounts.set(note.trim(), occurrence + 1);
        // A note added while recording can be fixed by clicking it.
        const added = this.log && token?.type === 'comment' && CookSheet.noteAdded(this.sourceText, note);
        out.push(added
          ? `<li class="cook-step-comment is-editable" tabindex="0" role="button" data-act="edit-note" data-note="${escHtml(note.trim())}" data-occurrence="${occurrence}" title="Fix this note (empty removes it)">${escHtml(note)}</li>`
          : `<li class="cook-step-comment">${escHtml(note)}</li>`);
        continue;
      }
      const added = info.deviation === 'added';
      const skipped = info.deviation === 'skipped';
      if (!added) number += 1;
      const here = this.fields.filter((f) => f.sectionIndex === info.sectionIndex && f.stepNumber === info.stepNumber);
      const counts = { ingredient: 0, timer: 0, inlineQuantity: 0, noteQuantity: 0 };
      const tokenHtml = (token) => {
        // Count every value of a kind, as buildFields does.
        if (token.type in counts) {
          const index = counts[token.type]++;
          const f = here.find((x) => x.kind === token.type && x.index === index);
          if (f) return this.fieldHtml(f, { tabbable: !this.listed.has(f.id) });
        }
        switch (token.type) {
          case 'ingredient': return `<span class="s-ingredient">${escHtml(token.name || token.value)}</span>`;
          case 'cookware': return `<span class="s-cookware">${escHtml(token.name || token.value)}</span>`;
          case 'text':
          case 'comment': return renderTextWithBreaks(token.value, this.display.temp || 'F');
          default: return escHtml(token.value || '');
        }
      };
      const noteHtml = (token) => {
        const first = counts.noteQuantity;
        counts.noteQuantity += (token.note_values || []).length;
        return this.componentNoteHtml(token, here, first, (f) => !this.listed.has(f.id));
      };
      // Punctuation straight after a value sits snug against its chip.
      let afterField = false;
      const body = step.map((token) => {
        if (typeof token === 'string') { afterField = false; return escHtml(token); }
        const punct = afterField && token.type === 'text' ? /^[,.;:!?)\]…]+/.exec(token.value || '') : null;
        const html = punct
          ? `<span class="ck-punct">${escHtml(punct[0])}</span>${tokenHtml({ ...token, value: token.value.slice(punct[0].length) })}`
          : tokenHtml(token);
        const note = noteHtml(token);
        afterField = !note && html.startsWith('<span class="ck-field');
        return html + note;
      }).join('');
      const valueless = !here.some((f) => !this.listed.has(f.id));
      // What changed in this step, on a line of its own under it (values
      // the ingredient list shows say so there).
      const changes = here.filter((f) => !this.listed.has(f.id)).map((f) => this.wasHtml(f, true)).join('');
      const tools = added
        ? `<span class="cook-badge-added">Added</span><button class="cook-tool" data-act="remove-step" tabindex="-1">Remove</button>`
        : `<button class="cook-tool cook-skip" data-act="skip" aria-pressed="${skipped}" tabindex="-1" title="${skipped ? 'Not skipped after all' : 'Skip this step'} (Alt+S)">${skipped ? 'Skipped' : 'Skip'}</button>`;
      out.push(`<li class="cook-step${skipped ? ' is-skipped' : ''}${added ? ' is-added' : ''}" data-section="${info.sectionIndex}" data-step="${info.stepNumber}"${valueless ? ` tabindex="0" aria-label="Step ${added ? '(added)' : number}"` : ''}>
        <span class="cook-step-num" aria-hidden="true">${added ? '+' : number}</span>
        <div class="cook-step-main">
          <div class="cook-step-text">${body}</div>
          <div class="cook-step-changes">${changes}</div>
          <div class="cook-step-tools" id="cook-tools-${info.sectionIndex}-${info.stepNumber}">${tools}
            <button class="cook-tool" data-act="note" tabindex="-1" title="Add a note under this step (Alt+N)">Note</button>
            <button class="cook-tool" data-act="add-step" tabindex="-1" title="Add a step you did after this one">Add a step after</button>
          </div>
          <div class="cook-step-editor"></div>
        </div>
        <button class="cook-tool cook-more" data-act="more" tabindex="-1" aria-expanded="false" aria-controls="cook-tools-${info.sectionIndex}-${info.stepNumber}" aria-label="Skip, note or add a step" title="Skip, note or add a step">⋯</button>
      </li>`);
    }
    return out.join('');
  },

  setStatus() {
    const el = document.getElementById('cook-status');
    if (!el) return;
    if (this.pending > 0) el.innerHTML = 'Saving…';
    else if (this.failed) el.innerHTML = `<span class="cook-status-error">Couldn't save: ${escHtml(this.failed)}</span> <button class="link-btn" data-act="reload">Reload</button>`;
    else el.textContent = this.log ? 'Saved' : 'Not recorded yet';
  },

  // ── Saving ──────────────────────────────────────────────────────────────────

  // Run changes one at a time, in order. The cook is recorded before the
  // first one. undo: remember the text before it for Ctrl-Z.
  enqueue(task, { undo = false } = {}) {
    this.pending += 1;
    this.setStatus();
    this.queue = this.queue.then(async () => {
      try {
        await this.ensureCreated();
        const before = this.text;
        await task();
        if (undo && before !== this.text) this.undoStack.push(before);
        this.failed = null;
      } catch (e) {
        this.failed = e.message || 'error';
      } finally {
        this.pending -= 1;
        this.setStatus();
      }
    });
    return this.queue;
  },

  async ensureCreated() {
    if (this.log) return;
    const outcome = document.getElementById('cook-outcome')?.value || '';
    const next = document.getElementById('cook-next')?.value || '';
    const notes = document.getElementById('cook-notes')?.value || '';
    this.log = await API.post(`${this.base()}/cook-logs`, {
      source: { kind: 'version', version_string: this.sheetKey },
      scale: this.scale,
      cooked_at: this.cookedAtIso(),
      outcome, changes_to_try_next: next, freeform_notes: notes,
      intended: [...this.intended.values()],
      display: this.display,
    });
    this.text = this.log.cooklang_text || '';
    this.sourceText = this.log.source_cooklang_text || '';
    if (this.active) {
      history.replaceState({}, '', this.pathFor(this.log.id));
      const start = document.getElementById('cook-start');
      if (start) start.innerHTML = this.startHtml(true);
      this.changingSheet = false;
      const line = document.getElementById('cook-sheet-line');
      if (line) line.innerHTML = this.sheetLineHtml();
    }
  },

  async stepAction(sectionIndex, stepNumber, body) {
    const log = await API.post(`${this.base()}/cook-logs/${encodeURIComponent(this.log.id)}/step-action`, {
      section_index: sectionIndex, step_number: stepNumber, ...body,
    });
    this.log = log;
    this.text = log.cooklang_text || '';
  },

  async putLog(patch) {
    this.log = await API.put(`${this.base()}/cook-logs/${encodeURIComponent(this.log.id)}`, patch);
    this.text = this.log.cooklang_text || '';
  },

  cookedAtIso() {
    return CookSheet.cookedAt(this.day, this.time);
  },

  // A note, an added step or an undo changes the sheet's shape: reparse and
  // repaint it, keeping focus where it was. A note or step being written
  // elsewhere meanwhile stays open, with what's typed in it.
  async repaintSheet(focus) {
    await this.loadSheet();
    const sheet = document.getElementById('cook-sheet');
    if (!sheet || !this.active) return;
    const open = [...sheet.querySelectorAll('.cook-editor-text')].filter((t) => !t.dataset.done).map((t) => {
      const step = this.stepOf(t);
      return step && { sectionIndex: step.sectionIndex, stepNumber: step.stepNumber, mode: t.dataset.mode, value: t.value, focused: t === document.activeElement };
    }).filter(Boolean);
    sheet.innerHTML = this.sheetHtml();
    for (const o of open) {
      const li = sheet.querySelector(`.cook-step[data-section="${o.sectionIndex}"][data-step="${o.stepNumber}"]`);
      const area = li && this.openEditor(this.stepOf(li), o.mode, { focus: o.focused });
      if (area) area.value = o.value;
    }
    if (focus && !open.some((o) => o.focused)) focus();
  },

  // ── Values ──────────────────────────────────────────────────────────────────

  inputsFor(f) {
    return [...document.querySelectorAll(`.ck-input[data-f="${f.id}"]`)];
  },

  paintField(f, preview) {
    const kind = preview?.kind || CookSheet.changeKind(f);
    for (const el of document.querySelectorAll(`.ck-field[data-f="${f.id}"]`)) {
      el.classList.remove('ck-unchanged', 'ck-same', 'ck-changed', 'ck-invalid');
      el.classList.add(`ck-${kind}`);
    }
    if (!preview) {
      for (const el of document.querySelectorAll(`.ck-was[data-was="${f.id}"]`)) el.innerHTML = this.wasInner(f, !!el.dataset.labelled);
    }
    if (!preview) {
      const value = this.inputText(f);
      for (const input of this.inputsFor(f)) {
        input.value = value;
        if (this.hasUnitList(f)) input.size = this.boxSize(f, value);
        else if (input.size < value.length + 1) input.size = value.length + 1;
      }
      const unit = this.hasUnitList(f) && CookSheet.timeUnit(f.current.units);
      if (unit) {
        const words = this.unitWords(f.current.quantity);
        document.querySelectorAll(`.ck-unit[data-f="${f.id}"]`).forEach((select) => {
          for (const option of select.options) option.textContent = words[option.value];
          select.value = unit;
          select.style.width = this.unitWidth(words[unit]);
        });
      }
    }
  },

  setValue(f, amount) {
    if (CookSheet.formatAmount(amount, f.isTemp) === CookSheet.formatAmount(f.current, f.isTemp)) {
      this.paintField(f);
      return;
    }
    f.current = { quantity: String(amount.quantity), units: String(amount.units || '') };
    const id = f.key ? CookSheet.keyId(f.key) : '';
    const unmeant = id && this.intended.has(id) && CookSheet.changeKind(f) !== 'changed';
    if (unmeant) this.intended.delete(id);
    this.paintField(f);
    const { sectionIndex, stepNumber, kind, index } = f;
    this.enqueue(async () => {
      await this.stepAction(sectionIndex, stepNumber, {
        action: 'update-quantity', token_kind: kind, token_index: index,
        new_quantity: f.current.quantity, new_units: f.current.units,
      });
      if (unmeant) await this.putLog({ intended: [...this.intended.values()] });
    }, { undo: true });
  },

  // Take what's typed in a value's box. Something that can't be read stays
  // there with a message when you press Enter (false: don't move on); when
  // you leave the box, the value is put back, saying so. An emptied box is
  // put back too.
  commitInput(input, { leaving = false } = {}) {
    const f = this.field(input.dataset.f);
    if (!f) return true;
    const text = input.value;
    const typed = this.readTyped(f, text);
    if (!typed) {
      if (text.trim() && !leaving) {
        input.setCustomValidity(this.unreadable(f, text));
        input.reportValidity();
        return false;
      }
      if (text.trim()) showToast(`${this.unreadable(f, text)} It's back to ${this.shown(f)}.`);
      input.setCustomValidity('');
      this.paintField(f);
      return true;
    }
    input.setCustomValidity('');
    const as = this.typedUnit(f, text);
    if (as) this.showAs.set(f.id, as);
    this.setValue(f, typed);
    return true;
  },

  unreadable(f, text) {
    const like = this.hasUnitList(f) ? '20, 1:30, 1h30 or 2 hours' : (f.isTemp ? '230, 230°C or 450°F' : '225, 225 g or 18-20');
    return `Couldn't read “${text.trim()}”. Try ${like}.`;
  },

  // The next (or previous) place to type: values, and steps with none.
  focusNext(from, direction = 1) {
    const stops = [...document.querySelectorAll('.cook-sheet .ck-input:not([tabindex="-1"]), .cook-sheet .cook-step[tabindex="0"]')];
    const at = stops.indexOf(from);
    const next = at < 0 ? null : stops[at + direction];
    if (next) next.focus();
    else if (direction > 0) document.getElementById('cook-outcome')?.focus();
  },

  toggleMeant(f) {
    if (!f?.key) return;
    const id = CookSheet.keyId(f.key);
    if (this.intended.has(id)) this.intended.delete(id);
    else this.intended.set(id, f.key);
    this.paintField(f);
    this.enqueue(() => this.putLog({ intended: [...this.intended.values()] }));
  },

  // ── Steps ───────────────────────────────────────────────────────────────────

  stepOf(el) {
    const li = el?.closest?.('.cook-step');
    if (!li) return null;
    return { li, sectionIndex: Number(li.dataset.section), stepNumber: Number(li.dataset.step) };
  },

  focusStep(sectionIndex, stepNumber, { after = false } = {}) {
    const li = document.querySelector(`.cook-step[data-section="${sectionIndex}"][data-step="${stepNumber}"]`);
    if (!li) return;
    const first = li.querySelector('.ck-input:not([tabindex="-1"])') || (li.getAttribute('tabindex') === '0' ? li : null);
    if (after) {
      const stops = [...li.querySelectorAll('.ck-input:not([tabindex="-1"])')];
      this.focusNext(stops.at(-1) || first || li, 1);
    } else (first || li).focus();
  },

  toggleSkip(step) {
    if (step.li.classList.contains('is-added')) return;
    const skipped = !step.li.classList.contains('is-skipped');
    step.li.classList.toggle('is-skipped', skipped);
    const button = step.li.querySelector('.cook-skip');
    if (button) {
      button.setAttribute('aria-pressed', String(skipped));
      button.textContent = skipped ? 'Skipped' : 'Skip';
      button.title = `${skipped ? 'Not skipped after all' : 'Skip this step'} (Alt+S)`;
    }
    this.enqueue(() => this.stepAction(step.sectionIndex, step.stepNumber, { action: 'set-deviation', deviation: skipped ? 'skipped' : null }), { undo: true });
  },

  // A note under the step, or a step you added after it: a text area in
  // place. Enter saves, Shift-Enter is a new line, Esc cancels.
  openEditor(step, mode, { focus = true } = {}) {
    const box = step.li.querySelector('.cook-step-editor');
    if (!box) return null;
    const id = `cook-ed-${step.sectionIndex}-${step.stepNumber}`;
    const isNote = mode === 'note';
    box.innerHTML = `<label class="cook-editor-label" for="${id}">${isNote ? 'Note under this step' : 'A step you added after this one'}</label>
      <textarea id="${id}" class="field-input cook-editor-text" rows="2" data-mode="${mode}" placeholder="${isNote ? 'e.g. dough sticky' : 'e.g. Fold 4 times. Amounts work as on the sheet: @water{20%g}'}"></textarea>
      <div class="cook-editor-hint">Enter (or leaving it) saves · Shift-Enter for a new line · Esc cancels</div>`;
    const area = box.querySelector('textarea');
    if (focus) area.focus();
    return area;
  },

  closeEditor(step, { refocus = true } = {}) {
    const box = step.li.querySelector('.cook-step-editor');
    if (box) box.innerHTML = '';
    if (refocus) this.focusStep(step.sectionIndex, step.stepNumber);
  },

  // leaving: focus went elsewhere (or Done), so it stays there.
  saveEditor(textarea, { leaving = false } = {}) {
    const step = this.stepOf(textarea);
    if (!step || textarea.dataset.done) return;
    textarea.dataset.done = '1';
    const content = textarea.value.trim();
    const mode = textarea.dataset.mode;
    if (!content) { this.closeEditor(step, { refocus: !leaving }); return; }
    this.closeEditor(step, { refocus: false });
    const { sectionIndex, stepNumber } = step;
    this.enqueue(async () => {
      await this.stepAction(sectionIndex, stepNumber, mode === 'note'
        ? { action: 'insert-note', note: content }
        : { action: 'insert-step-after', content: `!+ ${content.replace(/\s*\n\s*/g, ' ')}` });
      await this.repaintSheet(leaving ? null : () => this.focusStep(sectionIndex, stepNumber, { after: true }));
    }, { undo: true });
  },

  // Fixing a note added while recording: the note becomes a text area in
  // place. Enter saves, Esc cancels, empty removes it.
  editNote(li) {
    if (li.querySelector('textarea')) return;
    const note = li.dataset.note;
    li.innerHTML = `<textarea class="field-input cook-note-fix" rows="2" aria-label="Fix this note">${escHtml(note)}</textarea>
      <div class="cook-editor-hint">Enter saves · Esc cancels · empty removes the note</div>`;
    const area = li.querySelector('textarea');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  },

  saveNote(area, { leaving = false } = {}) {
    const li = area.closest('.cook-step-comment');
    if (!li || area.dataset.done) return;
    area.dataset.done = '1';
    const note = li.dataset.note;
    const occurrence = Number(li.dataset.occurrence) || 0;
    const next = area.value;
    if (next.replace(/\s+/g, ' ').trim() === note) { this.cancelNote(area, { refocus: !leaving }); return; }
    this.enqueue(async () => {
      const text = CookSheet.replaceNote(this.text, note, occurrence, next);
      if (text === this.text) return;
      await this.putLog({ cooklang_text: text });
      await this.repaintSheet();
    }, { undo: true });
  },

  cancelNote(area, { refocus = true } = {}) {
    const li = area.closest('.cook-step-comment');
    if (!li) return;
    area.dataset.done = '1';
    li.textContent = li.dataset.note;
    if (refocus) li.focus();
  },

  removeAddedStep(step) {
    const { sectionIndex, stepNumber } = step;
    this.enqueue(async () => {
      await this.stepAction(sectionIndex, stepNumber, { action: 'delete' });
      await this.repaintSheet();
    }, { undo: true });
  },

  undo() {
    const focusedField = document.activeElement?.dataset?.f || null;
    this.enqueue(async () => {
      const before = this.undoStack.pop();
      if (before === undefined) { showToast('Nothing to undo'); return; }
      await this.putLog({ cooklang_text: before });
      await this.repaintSheet(() => {
        const input = focusedField && document.querySelector(`.ck-input[data-f="${focusedField}"]`);
        input?.focus();
      });
    });
  },

  // ── Notes fields and the date ───────────────────────────────────────────────

  saveReflect() {
    clearTimeout(this.reflectTimer);
    const dirty = this.reflectDirty;
    this.reflectDirty = {};
    if (!Object.keys(dirty).length) return this.queue;
    const patch = {};
    if (dirty.outcome) patch.outcome = document.getElementById('cook-outcome')?.value ?? '';
    if (dirty.next) patch.changes_to_try_next = document.getElementById('cook-next')?.value ?? '';
    if (dirty.notes) {
      // The three old fields become the one Notes box.
      patch.freeform_notes = document.getElementById('cook-notes')?.value ?? '';
      patch.what_worked = '';
      patch.problems_found = '';
    }
    return this.enqueue(() => this.putLog(patch));
  },

  setDay(day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
    this.day = day;
    const box = document.getElementById('cook-date');
    const focusedTime = document.activeElement?.id === 'cook-time';
    if (box && !focusedTime) box.innerHTML = this.dateHtml();
    const title = document.getElementById('cook-title');
    if (title) title.innerHTML = this.titleText();
    const when = document.getElementById('cook-start-when');
    if (when) when.outerHTML = this.startWhenHtml();
    if (this.log) this.enqueue(() => this.putLog({ cooked_at: this.cookedAtIso() }));
  },

  // ── Events ──────────────────────────────────────────────────────────────────

  onInput(e) {
    const el = e.target;
    if (el.classList.contains('ck-input')) {
      const f = this.field(el.dataset.f);
      if (!f) return;
      el.setCustomValidity('');
      const typed = this.readTyped(f, el.value);
      this.paintField(f, { kind: typed ? CookSheet.changeKind(f, typed) : 'invalid' });
      if (this.hasUnitList(f)) el.size = this.boxSize(f, el.value);
      else if (el.size < el.value.length + 1) el.size = el.value.length + 1;
      return;
    }
    const reflect = el.dataset?.reflect;
    if (reflect) {
      this.reflectDirty[reflect] = true;
      clearTimeout(this.reflectTimer);
      this.reflectTimer = setTimeout(() => this.saveReflect(), 600);
    }
  },

  onChange(e) {
    const el = e.target;
    if (el.classList.contains('ck-unit')) {
      // The number stays; it's the unit that was wrong ("20" hours, not min).
      const f = this.field(el.dataset.f);
      const input = f && this.inputsFor(f)[0];
      if (input) this.commitInput(input);
    } else if (el.id === 'cook-day') this.setDay(el.value);
    else if (el.id === 'cook-photo-file') this.addPhotos(el);
    else if (el.id === 'cook-time') {
      this.time = el.value || '';
      if (this.log) this.enqueue(() => this.putLog({ cooked_at: this.cookedAtIso() }));
    } else if (el.dataset?.reflect) this.saveReflect();
  },

  // Leaving a value takes what's typed; leaving a note or step being
  // written saves it (Esc is the way to throw it away).
  onFocusOut(e) {
    const el = e.target;
    // A box taken away by a repaint isn't being left.
    if (!el.isConnected) return;
    if (el.classList?.contains('ck-input')) this.commitInput(el, { leaving: true });
    else if (el.classList?.contains('cook-editor-text')) this.saveEditor(el, { leaving: true });
    else if (el.classList?.contains('cook-note-fix')) this.saveNote(el, { leaving: true });
  },

  onKeydown(e) {
    const el = e.target;
    const mod = e.ctrlKey || e.metaKey;
    if (e.altKey && !mod && (e.code === 'KeyS' || e.code === 'KeyN')) {
      const step = this.stepOf(el);
      if (step && !el.classList.contains('cook-editor-text')) {
        e.preventDefault();
        if (e.code === 'KeyS') this.toggleSkip(step);
        else this.openEditor(step, 'note');
      }
      return;
    }
    if (el.classList.contains('ck-input')) {
      const f = this.field(el.dataset.f);
      if (e.key === 'Enter') {
        e.preventDefault();
        if (this.commitInput(el)) this.focusNext(el, e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'Escape' && f) {
        e.preventDefault();
        const committed = this.inputText(f);
        if (el.value !== committed) { el.value = committed; this.paintField(f); }
        else if (CookSheet.changeKind(f) !== 'unchanged') this.setValue(f, f.original);
        el.select();
        return;
      }
      if (mod && e.key.toLowerCase() === 'z' && f && el.value === this.inputText(f)) {
        e.preventDefault();
        this.undo();
      }
      return;
    }
    if (el.classList.contains('cook-note-fix')) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.saveNote(el); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelNote(el); }
      return;
    }
    if (el.classList.contains('cook-step-comment') && el.dataset.act === 'edit-note' && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.editNote(el);
      return;
    }
    if (el.classList.contains('cook-editor-text')) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.saveEditor(el); }
      else if (e.key === 'Escape') { e.preventDefault(); el.dataset.done = '1'; this.closeEditor(this.stepOf(el)); }
      return;
    }
    if (el.id === 'cook-outcome' && e.key === 'Enter') { e.preventDefault(); document.getElementById('cook-next')?.focus(); return; }
    if (el.classList.contains('cook-step')) {
      if (e.key === 'Enter') { e.preventDefault(); this.focusNext(el, 1); }
      else if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
    }
  },

  onClick(e) {
    const target = e.target.closest('[data-act]');
    if (!target) return;
    const act = target.dataset.act;
    const step = this.stepOf(target);
    const f = target.dataset.f ? this.field(target.dataset.f) : null;
    if (act === 'done') this.done();
    else if (act === 'reload') this.reload();
    else if (act === 'revert' && f) { this.setValue(f, f.original); this.inputsFor(f)[0]?.focus(); }
    else if (act === 'meant' && f) this.toggleMeant(f);
    else if (act === 'skip' && step) this.toggleSkip(step);
    else if (act === 'more' && step) {
      const open = step.li.classList.toggle('is-open');
      target.setAttribute('aria-expanded', String(open));
    }
    else if (act === 'note' && step) this.openEditor(step, 'note');
    else if (act === 'add-step' && step) this.openEditor(step, 'add');
    else if (act === 'remove-step' && step) this.removeAddedStep(step);
    else if (act === 'edit-note' && !e.target.closest('textarea')) this.editNote(target);
    else if (act === 'day') this.setDay(target.dataset.day);
    else if (act === 'as-written') this.cookedAsWritten();
    else if (act === 'add-photo') document.getElementById('cook-photo-file')?.click();
    else if (act === 'remove-photo') this.removePhoto(target.dataset.photo);
    else if (act === 'change-sheet') { this.changingSheet = true; document.getElementById('cook-sheet-line').innerHTML = this.sheetLineHtml(); document.getElementById('cook-pick-sheet')?.focus(); }
    else if (act === 'cancel-sheet') { this.changingSheet = false; document.getElementById('cook-sheet-line').innerHTML = this.sheetLineHtml(); }
    else if (act === 'apply-sheet') this.applySheet();
  },

  async applySheet() {
    if (this.log) return;
    const key = document.getElementById('cook-pick-sheet')?.value;
    const scale = Number(document.getElementById('cook-pick-scale')?.value);
    if (!key || !(scale > 0 && scale <= 100)) { showToast('Pick a sheet and a scale between 0 and 100'); return; }
    this.sheetKey = key;
    this.scale = scale;
    this.changingSheet = false;
    this.display = this.printDisplay();
    try {
      await this.loadSheet();
    } catch (e) {
      showToast('Error: ' + e.message);
      return;
    }
    this.paint(document.getElementById('view-container'));
  },

  // Nothing differed: record it as the sheet, and go on to the outcome.
  cookedAsWritten() {
    this.enqueue(async () => {});
    const start = document.getElementById('cook-start');
    if (start) start.innerHTML = this.startHtml(true);
    document.getElementById('cook-outcome')?.focus();
  },

  async reload() {
    if (!this.log) { Router.dispatch(location.pathname + location.search); return; }
    Router.go(this.pathFor(this.log.id), true);
  },

  async done() {
    // Ctrl+Enter leaves nothing behind: what's typed in a value, a note or a
    // step being written is taken first.
    const active = document.activeElement;
    if (active?.classList.contains('ck-input') && !this.commitInput(active, { leaving: true })) return;
    document.querySelectorAll('.cook-editor-text').forEach((t) => this.saveEditor(t, { leaving: true }));
    document.querySelectorAll('.cook-note-fix').forEach((t) => this.saveNote(t, { leaving: true }));
    this.saveReflect();
    await this.queue;
    if (this.failed) { showToast(`Couldn't save: ${this.failed}`); return; }
    const recorded = !!this.log;
    // Back to the test's page for a test (its cooks are there); otherwise
    // the recipe's Cooks.
    const sheet = this.sheetEntry();
    const branch = this.branch !== 'main' ? `branch=${encodeURIComponent(this.branch)}` : '';
    if (sheet?.kind === 'test' && sheet.test_key) {
      await Router.go(`/recipe/${this.slug}/tests/${encodeURIComponent(sheet.test_key)}${branch ? `?${branch}` : ''}`);
    } else {
      await Router.go(`/recipe/${this.slug}?tab=cook-logs${branch ? `&${branch}` : ''}`);
    }
    if (recorded) showToast('Cook saved');
  },
};

// Ctrl/Cmd-Enter is Done from anywhere on the screen.
document.addEventListener('keydown', (e) => {
  if (!CookView.active || !(e.ctrlKey || e.metaKey) || e.key !== 'Enter') return;
  if (!document.querySelector('.cook-view')) return;
  e.preventDefault();
  CookView.done();
});

window.addEventListener('beforeunload', (event) => {
  if (!CookView.active || (CookView.pending === 0 && !Object.keys(CookView.reflectDirty || {}).length)) return;
  event.preventDefault();
  event.returnValue = '';
});
