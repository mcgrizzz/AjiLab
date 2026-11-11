// ── Recording a cook: the sheet's values (pure) ──────────────────────────────
// The cook screen (views-cook.js) edits a cook's text one value at a time
// through the server's step actions, which address a value by section,
// step, kind and its index among that kind in the step. buildFields finds
// those values in the parsed sheet, in sheet order, with what the paper said
// and what was cooked. The rest are the small decisions the screen makes:
// which ingredient-list rows can be edited, how a typed value is read,
// whether a change is real, the "I meant this" keys, and the cooked-at date.
const CookSheet = (() => {
  const KINDS = ['ingredient', 'timer', 'inlineQuantity'];
  const TEMP_UNIT = /^°?\s*([FCfc]|fahrenheit|celsius)$/i;
  // A typed number: mixed numbers and fractions first, so "1/2" isn't read as "1".
  const NUMBER = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\s*[⅛¼⅓⅜½⅝⅔¾⅞]|\\d+(?:[.,]\\d+)?)';

  const hasQuantity = (token) => token.quantity !== '' && token.quantity != null;

  // A timer range comes from the parser with its unit inside the quantity
  // ("1-2 min" with units "min"); keep the number part only.
  function bareQuantity(quantity, units) {
    const text = String(quantity ?? '').trim();
    const unit = String(units ?? '').trim();
    if (unit && text.endsWith(unit) && text.length > unit.length) return text.slice(0, -unit.length).trim();
    return text;
  }
  const lower = (text) => String(text ?? '').trim().toLowerCase();

  function stepInfo(step) {
    const first = step.find((token) => token && typeof token === 'object');
    return {
      sectionIndex: first?.section_index,
      stepNumber: first?.step_number,
      deviation: first?.deviation || null,
    };
  }

  // Every value in the sheet that can change, in sheet order. original is
  // what the paper said (the source at the cook's scale): the server's diff
  // annotation (source_*) when the cook already differs, else the value
  // itself. key is the "I meant this" key: the nth value of this kind and
  // name, not counting added steps, so it survives later edits. (The parser
  // keeps no timer names, so timers count by position.)
  function buildFields(steps) {
    const fields = [];
    const ordinals = new Map();
    for (const step of steps || []) {
      const info = stepInfo(step);
      if (!Number.isFinite(info.stepNumber)) continue;
      const added = info.deviation === 'added';
      const counts = { ingredient: 0, timer: 0, inlineQuantity: 0, noteQuantity: 0 };
      const push = (token, kind, index, name) => {
        let key = null;
        if (!added) {
          const id = `${kind}|${lower(name)}`;
          const n = ordinals.get(id) || 0;
          ordinals.set(id, n + 1);
          key = { kind, name: lower(name), n };
        }
        const current = { quantity: bareQuantity(token.quantity, token.units), units: String(token.units || '') };
        const annotated = token.source_quantity !== undefined && token.source_quantity !== null;
        const original = annotated
          ? { quantity: bareQuantity(token.source_quantity, token.source_units ?? token.units), units: String(token.source_units ?? current.units) }
          : { ...current };
        fields.push({
          id: `f${fields.length}`,
          sectionIndex: info.sectionIndex,
          stepNumber: info.stepNumber,
          kind,
          index,
          name,
          isTemp: (kind === 'inlineQuantity' || kind === 'noteQuantity') && TEMP_UNIT.test(String(token.units || '')),
          // Scaling changes only ingredients that aren't fixed (@salt{=2%g}).
          scales: kind === 'ingredient' && !token.fixed,
          key,
          added,
          original,
          current,
        });
      };
      for (const token of step) {
        if (!token || typeof token !== 'object') continue;
        if (KINDS.includes(token.type)) {
          // Every value of a kind counts, with an amount or not ("@pepper{}",
          // "@oil"), as the server's step actions count them.
          const index = counts[token.type]++;
          if (hasQuantity(token)) push(token, token.type, index, token.type === 'inlineQuantity' ? '' : String(token.name || ''));
        }
        // The values in an ingredient's or cookware's note ("water, at
        // 90-95°F") follow it, numbered on their own as the server numbers them.
        for (const value of token.note_values || []) {
          const index = counts.noteQuantity++;
          if (hasQuantity(value)) push(value, 'noteQuantity', index, String(token.name || ''));
        }
      }
    }
    return fields;
  }

  // The ingredient list, by section as on the paper. A row can be edited
  // when it is the only use of that ingredient in its section; otherwise
  // it's edited in the steps, where each use is.
  function ingredientRows(summary, fields) {
    const sections = summary?.sections?.length ? summary.sections : [{ name: null, ingredients: summary?.flat || [] }];
    return sections.map((section, sectionIndex) => {
      const inSection = fields.filter((f) => f.kind === 'ingredient' && f.sectionIndex === sectionIndex && !f.added);
      const rows = (section.ingredients || []).map((ingredient) => {
        const uses = inSection.filter((f) => lower(f.name) === lower(ingredient.name));
        return {
          name: String(ingredient.name || ''),
          note: String(ingredient.note || ''),
          amount: { quantity: ingredient.quantity ?? '', units: ingredient.units || '' },
          field: uses.length === 1 ? uses[0] : null,
          uses: uses.length,
        };
      });
      return { name: section.name || null, rows };
    });
  }

  // Fields the ingredient list covers: in the steps they're still editable
  // but out of the Tab order, so each value is one stop.
  function listedFieldIds(sections) {
    return new Set(sections.flatMap((section) => section.rows.filter((row) => row.field).map((row) => row.field.id)));
  }

  function formatAmount(amount, isTemp = false) {
    const quantity = String(amount?.quantity ?? '').trim();
    const units = String(amount?.units ?? '').trim();
    if (!units) return quantity;
    if (isTemp) return `${quantity}°${units.replace(/^°\s*/, '').toUpperCase()}`;
    return `${quantity} ${units}`;
  }

  // What was typed: "225", "225 g", "1 cup", "18-20", "1/2 tsp", "230°C",
  // "230 c". A bare number takes the unit shown (by default the value's own).
  // Null when it isn't an amount.
  function parseTyped(text, field, shownUnits = field.current.units) {
    const typed = String(text ?? '').trim();
    if (!typed) return null;
    if (field.kind === 'timer' && timeUnit(field.original.units)) {
      return parseDuration(typed, timeUnit(shownUnits) || timeUnit(field.original.units), field.original.units);
    }
    const match = typed.match(new RegExp(`^(${NUMBER}(?:\\s*[-–]\\s*${NUMBER})?)\\s*(.*)$`));
    if (!match) return null;
    const quantity = match[1].replace(/\s*[-–]\s*/, '-').replace(/(\d),(\d)/g, '$1.$2').trim();
    let units = match[2].trim();
    if (field.isTemp) {
      const temp = units.replace(/^°\s*/, '');
      if (temp && !TEMP_UNIT.test(temp)) return null;
      units = /^c/i.test(temp) ? 'C' : (/^f/i.test(temp) ? 'F' : '');
    }
    return { quantity, units: units || shownUnits };
  }

  // ── Times ────────────────────────────────────────────────────────────────
  // A time's unit is one of four, picked from a list on the cook screen.
  // What's typed may carry its own: "90 min", "2 hours", "1h30", "1:30"
  // (h:mm in hours, m:ss in minutes or seconds).

  const TIME_UNITS = {
    sec: /^(s|sec|secs|second|seconds)$/i,
    min: /^(m|min|mins|minute|minutes)$/i,
    hour: /^(h|hr|hrs|hour|hours)$/i,
    day: /^(d|day|days)$/i,
  };
  const MINUTES = { sec: 1 / 60, min: 1, hour: 60, day: 1440 };
  const TIME_WORDS = { second: 'seconds', minute: 'minutes', hour: 'hours', day: 'days', hr: 'hrs' };

  // 'sec' | 'min' | 'hour' | 'day', or null for anything else.
  function timeUnit(units) {
    const u = String(units ?? '').trim().replace(/\.$/, '');
    return Object.keys(TIME_UNITS).find((key) => TIME_UNITS[key].test(u)) || null;
  }

  // The unit as the sheet writes it: its own spelling when it's the same
  // unit (singular or plural to suit the number), else min, sec, hours, days.
  function timeUnitText(unit, quantity, own = '') {
    const base = timeUnit(own) === unit ? String(own).trim() : { sec: 'sec', min: 'min', hour: 'hours', day: 'days' }[unit];
    const one = String(quantity).trim() === '1';
    for (const [single, plural] of Object.entries(TIME_WORDS)) {
      const word = base.toLowerCase();
      if (word === single || word === plural) return one ? single : plural;
    }
    return base;
  }

  // A typed time in `unit` unless it names its own; null when it isn't one.
  function parseDuration(text, unit, own = '') {
    const typed = String(text ?? '').trim().toLowerCase();
    if (!typed || !MINUTES[unit]) return null;
    const result = (quantity, key) => ({ quantity, units: timeUnitText(key, quantity, own) });
    const inUnit = (minutes, key) => result(String(Number((minutes / MINUTES[key]).toFixed(2))), key);
    const clock = /^(\d+):([0-5]\d)$/.exec(typed);
    if (clock) {
      const [hi, lo] = [Number(clock[1]), Number(clock[2])];
      return unit === 'hour' || unit === 'day' ? inUnit(hi * 60 + lo, unit) : inUnit(hi + lo / 60, unit === 'sec' ? 'min' : unit);
    }
    const both = /^(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?)\s*(\d+)\s*(?:m|min|mins|minutes?)?$/.exec(typed);
    if (both) return inUnit(Number(both[1]) * 60 + Number(both[2]), unit === 'hour' ? 'hour' : 'min');
    const match = typed.match(new RegExp(`^(${NUMBER}(?:\\s*[-–]\\s*${NUMBER})?)\\s*([a-z]*)\\.?$`));
    if (!match) return null;
    const key = match[2] ? timeUnit(match[2]) : unit;
    if (!key) return null;
    return result(match[1].replace(/\s*[-–]\s*/, '-').replace(/(\d),(\d)/g, '$1.$2').trim(), key);
  }

  // ── As on the paper ──────────────────────────────────────────────────────
  // A print can show temperatures in the other scale and ingredients in
  // other units ({ temp: 'C', units: { flour: 'cup' } }). The cook screen
  // shows values the same way, and saves what's typed back in the recipe's
  // own unit, so the text keeps one set of units.

  const tempKey = (unit) => {
    const t = String(unit ?? '').trim().replace(/^°\s*/, '').toLowerCase();
    return t === 'c' || t === 'celsius' ? 'C' : (t === 'f' || t === 'fahrenheit' ? 'F' : null);
  };
  const convertTemp = (v, from, to) => (from === to ? v : (to === 'C' ? (v - 32) * 5 / 9 : v * 9 / 5 + 32));
  // Saved back in the recipe's unit: to a tenth, whole when close.
  const tempText = (v, unit) => Units.roundTemperature(v, unit, 'tenth');
  // A converted amount Cooklang can hold: no fraction glyphs, sensible digits.
  const plainNumber = (v) => String(v >= 100 ? Math.round(v) : Number(v.toFixed(v < 10 ? 2 : 1)));

  function shownAmount(field, amount, display) {
    if (!display || !amount) return amount;
    if (field.isTemp && display.temp) {
      const from = tempKey(amount.units);
      const nums = Units.parseQuantity(String(amount.quantity));
      if (!from || from === display.temp || !nums) return amount;
      // Rounded as the paper rounded it (display.round, the reader's choice).
      return { quantity: nums.map((n) => Units.roundTemperature(convertTemp(n, from, display.temp), display.temp, display.round || 'tenth')).join('-'), units: display.temp };
    }
    if (field.kind === 'ingredient' && display.units && Object.keys(display.units).length) {
      const shown = Units.present(amount.quantity, amount.units, 1, { overrides: display.units }, field.name);
      if (shown?.converted) return { quantity: shown.qty, units: shown.unit };
    }
    return amount;
  }

  // A typed amount in the recipe's own unit for this value, when it converts.
  function savedAmount(field, typed) {
    const own = field.original.units;
    const nums = Units.parseQuantity(String(typed.quantity));
    if (!nums) return typed;
    if (field.isTemp) {
      const from = tempKey(typed.units);
      const to = tempKey(own);
      if (!from || !to || from === to) return typed;
      return { quantity: nums.map((n) => tempText(convertTemp(n, from, to), to)).join('-'), units: own };
    }
    if (field.kind === 'ingredient') {
      const a = Units.lookup(typed.units);
      const b = Units.lookup(own);
      if (a && b && a.key !== b.key && a.category === b.category) {
        return { quantity: nums.map((n) => plainNumber((n * a.factor) / b.factor)).join('-'), units: own };
      }
    }
    return typed;
  }

  // What a typed value means. When it reads the same as the paper showed the
  // value now (or the sheet's own value), it's that value: typing back the
  // 232 the paper showed for 450°F isn't a change to 449.6°F. Otherwise it's
  // what was typed, in the recipe's own unit. unit: a time's chosen unit.
  // Null when it isn't an amount.
  function readTyped(field, text, display, unit = null) {
    const shownUnits = unit || shownAmount(field, field.current, display).units;
    const typed = parseTyped(text, field, shownUnits);
    if (!typed) return null;
    const as = formatAmount(typed, field.isTemp);
    for (const amount of [field.current, field.original]) {
      if (formatAmount(shownAmount(field, amount, display), field.isTemp) === as) return amount;
    }
    return savedAmount(field, typed);
  }

  // "°C, flour in cups": what the screen converts, for its header.
  function displayNote(display) {
    const parts = [];
    if (display?.temp) parts.push(`°${display.temp}`);
    for (const [name, unit] of Object.entries(display?.units || {})) parts.push(`${name} in ${Units.UNITS[unit] ? Units.unitLabel(unit, 2) : unit}`);
    return parts.join(', ');
  }

  // Cooks oldest first: by the day cooked, then by when each was saved (two
  // cooks of the same day without a time are both at noon).
  function cookOrder(a, b) {
    return String(a.cooked_at).localeCompare(String(b.cooked_at)) || String(a.created_at).localeCompare(String(b.created_at));
  }

  // 'unchanged' (as printed), 'same' (written differently but the same
  // amount, like 1000 ml for 1 L: shown grey) or 'changed'.
  function changeKind(field, amount = field.current) {
    const a = { ...field.original, type: field.kind };
    const b = { ...amount, type: field.kind };
    if (formatAmount(a, field.isTemp) === formatAmount(b, field.isTemp)) return 'unchanged';
    return Units.sameAmount(a, b) ? 'same' : 'changed';
  }

  const keyId = (key) => (key ? `${key.kind}|${key.name}|${key.n}` : '');

  // Old cooks had three note fields; the screen has one.
  function joinedNotes(log) {
    const parts = [];
    if (String(log?.what_worked || '').trim()) parts.push(`What worked: ${log.what_worked.trim()}`);
    if (String(log?.problems_found || '').trim()) parts.push(`Problems: ${log.problems_found.trim()}`);
    if (String(log?.freeform_notes || '').trim()) parts.push(log.freeform_notes.trim());
    return parts.join('\n\n');
  }

  function localDay(value) {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function localTime(value) {
    const d = new Date(value);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  // The quick date choices: the print date (when there is one), today,
  // yesterday. Days are local 'YYYY-MM-DD'.
  function dateChoices(now, printedAt) {
    const today = localDay(now);
    const yesterday = localDay(new Date(new Date(now).getTime() - 864e5));
    const choices = [];
    if (printedAt) {
      const printDay = localDay(printedAt);
      if (printDay !== today && printDay !== yesterday) choices.push({ id: 'print', label: 'Print date', day: printDay });
    }
    choices.push({ id: 'today', label: 'Today', day: today });
    choices.push({ id: 'yesterday', label: 'Yesterday', day: yesterday });
    return choices;
  }

  // A day and an optional time ('HH:MM'); no time means midday, so the day
  // reads the same in nearby time zones.
  function cookedAt(day, time) {
    const [y, m, d] = String(day).split('-').map(Number);
    const [hh, mm] = /^\d{1,2}:\d{2}$/.test(String(time || '')) ? time.split(':').map(Number) : [12, 0];
    return new Date(y, m - 1, d, hh, mm).toISOString();
  }

  // Notes are "> text" lines. A note you added can be fixed (or removed,
  // with empty text): the nth line with that text is replaced.
  const noteLine = (line) => line.match(/^\s*>\s?(.*)$/);
  function noteAdded(sourceText, note) {
    return !String(sourceText || '').split('\n').some((line) => noteLine(line)?.[1].trim() === note.trim());
  }
  function replaceNote(text, note, occurrence, next) {
    const lines = String(text).split('\n');
    let seen = -1;
    const at = lines.findIndex((line) => noteLine(line)?.[1].trim() === note.trim() && ++seen === occurrence);
    if (at < 0) return text;
    const value = String(next || '').replace(/\s*\n\s*/g, ' ').trim();
    if (value) {
      lines[at] = `> ${value}`;
    } else {
      // Remove the note and one of the blank lines around it.
      const blankAfter = lines[at + 1] !== undefined && !lines[at + 1].trim();
      const blankBefore = at > 0 && !lines[at - 1].trim();
      lines.splice(blankAfter ? at : (blankBefore ? at - 1 : at), blankAfter || blankBefore ? 2 : 1);
    }
    return lines.join('\n');
  }

  // ── Comparing the cooks of a sheet ─────────────────────────────────────────

  const plainStepText = (step) => step
    .map((t) => (typeof t === 'string' ? t : (t.type === 'ingredient' || t.type === 'cookware' ? (t.name || t.value) : t.value)) || '')
    .join('').replace(/\s+/g, ' ').trim();

  // The sheet's steps as printed: numbered in order, added steps not
  // counted (they have no number on the paper).
  function stepList(steps) {
    const out = [];
    let number = 0;
    for (const step of steps || []) {
      const info = stepInfo(step);
      if (!Number.isFinite(info.stepNumber)) continue;
      const added = info.deviation === 'added';
      if (!added) number += 1;
      out.push({ sectionIndex: info.sectionIndex, stepNumber: info.stepNumber, number: added ? null : number, after: number, deviation: info.deviation, text: plainStepText(step) });
    }
    return out;
  }

  const trimNumber = (n) => String(Number(n.toFixed(2)));

  // An amount as at the sheet's 1×: a 2× cook's scaled ingredients divided
  // back. Times, temperatures and fixed amounts don't scale.
  function atSheetScale(field, amount, scale) {
    if (!scale || scale === 1 || !field.scales) return amount;
    const values = Units.parseQuantity(String(amount.quantity));
    if (!values) return amount;
    return { quantity: values.map((v) => trimNumber(v / scale)).join('-'), units: amount.units };
  }

  function valueLabel(field, numbers, repeated) {
    const step = numbers.get(`${field.sectionIndex}:${field.stepNumber}`);
    const where = step ? `, step ${step}` : '';
    if (field.kind === 'ingredient') return repeated.has(lower(field.name)) ? `${field.name}${where}` : field.name;
    if (field.kind === 'timer') return `time${where}`;
    // A value in an ingredient's note: "water temperature".
    if (field.kind === 'noteQuantity') return `${field.name} ${field.isTemp ? 'temperature' : 'amount'}${repeated.has(lower(field.name)) ? where : ''}`;
    return `${field.isTemp ? 'temperature' : 'amount'}${where}`;
  }

  // The cooks of a sheet side by side, at the sheet's 1×. Rows: the values
  // the sheet changes from its base ("tested"), and any value a cook did
  // differently; then skipped and added steps.
  //   base, sheet: { fields, steps } (base may be null)
  //   cooks: [{ id, scale, fields, steps, intended: [keys] }] (fields parsed
  //          against the sheet at the cook's scale)
  function comparison({ base, sheet, cooks }) {
    const keyed = (fields) => new Map(fields.filter((f) => f.key).map((f) => [keyId(f.key), f]));
    const sheetByKey = keyed(sheet.fields);
    const baseByKey = base ? keyed(base.fields) : null;
    const steps = stepList(sheet.steps);
    const numbers = new Map(steps.filter((s) => s.number).map((s) => [`${s.sectionIndex}:${s.stepNumber}`, s.number]));
    const counts = new Map();
    for (const f of sheet.fields) if (f.kind === 'ingredient' && f.key) counts.set(lower(f.name), (counts.get(lower(f.name)) || 0) + 1);
    const repeated = new Set([...counts].filter(([, n]) => n > 1).map(([name]) => name));
    const cookKeyed = cooks.map((cook) => ({ cook, byKey: keyed(cook.fields), intended: new Set((cook.intended || []).map(keyId)) }));

    const rows = [];
    const ids = [...sheetByKey.keys()];
    if (baseByKey) for (const id of baseByKey.keys()) if (!sheetByKey.has(id)) ids.push(id);
    for (const id of ids) {
      const f = sheetByKey.get(id) || null;
      const b = baseByKey?.get(id) || null;
      const ref = f || b;
      const tested = !!baseByKey && (!f || !b || formatAmount(b.current, ref.isTemp) !== formatAmount(f.current, ref.isTemp));
      const cells = cookKeyed.map(({ cook, byKey, intended }) => {
        const cf = byKey.get(id);
        if (!f) return { kind: 'none' };
        if (!cf) return { kind: 'left-out', intended: intended.has(id) };
        return {
          kind: changeKind(cf),
          amount: atSheetScale(cf, cf.current, cook.scale),
          cooked: cf.current,
          scaled: (cook.scale || 1) !== 1 && cf.scales,
          intended: intended.has(id),
        };
      });
      if (!tested && cells.every((c) => c.kind === 'unchanged' || c.kind === 'none')) continue;
      rows.push({ id, label: valueLabel(ref, numbers, repeated), isTemp: ref.isTemp, base: b ? b.current : null, sheet: f ? f.current : null, tested, cells });
    }

    // Steps a cook skipped, by their number on the paper.
    const stepRows = [];
    for (const step of steps.filter((s) => s.number)) {
      const cells = cooks.map((cook) => stepList(cook.steps).some((s) => s.number === step.number && s.deviation === 'skipped'));
      if (cells.some(Boolean)) stepRows.push({ label: `Skipped step ${step.number}`, text: step.text, cells });
    }
    cooks.forEach((cook, i) => {
      for (const s of stepList(cook.steps).filter((x) => x.deviation === 'added')) {
        stepRows.push({ label: `Added after step ${s.after}`, text: s.text, cells: cooks.map((_, j) => j === i) });
      }
    });
    return { rows, stepRows };
  }

  // The recipe's figures (hydration, salt %) for each cook, as rows for the
  // cooks table. Every shown figure gets a row, changed or not: they're what
  // cooks are compared by. A cook's figure counts as changed when it differs
  // from the sheet's and isn't inside the sheet's range (74.4% of 73-76% is
  // a choice the sheet allowed, not a change).
  //   base, sheet, cooks[]: { metrics } (parsed, cooks at the sheet's 1×)
  function metricRows({ base, sheet, cooks }) {
    const shown = (metrics) => new Map((metrics || []).filter((m) => !m.hidden).map((m) => [m.name, m]));
    const sheetBy = shown(sheet?.metrics);
    const baseBy = base ? shown(base.metrics) : new Map();
    const cookBy = cooks.map((cook) => shown(cook.metrics));
    const names = [...new Set([...sheetBy.keys(), ...baseBy.keys(), ...cookBy.flatMap((m) => [...m.keys()])])];
    const text = (m) => (m && !m.error ? m.display : null);
    const ends = (m) => (m.range ? [m.range.min, m.range.max] : [m.value, m.value]);
    const allowed = (m, ref) => {
      if (!m || !ref || m.error || ref.error || !ref.range) return false;
      const [lo, hi] = ends(m);
      const eps = 1e-9;
      return lo >= ref.range.min - eps && hi <= ref.range.max + eps;
    };
    return names.map((name) => {
      const ref = sheetBy.get(name);
      return {
        name,
        base: text(baseBy.get(name)),
        sheet: text(ref),
        cells: cookBy.map((by) => {
          const m = by.get(name);
          if (!m) return { kind: 'none', display: null };
          if (m.error) return { kind: 'error', display: null, error: m.error };
          const same = text(m) === text(ref) || allowed(m, ref);
          return { kind: same ? 'same' : 'changed', display: m.display };
        }),
      };
    });
  }

  // "water: 140 → 150 g" for the version notes.
  function changeText(label, from, to, isTemp) {
    if (!from) return `added ${label}: ${formatAmount(to, isTemp)}`;
    if (!to) return `no ${label}`;
    const sameUnit = String(from.units) === String(to.units);
    return sameUnit && from.units && !isTemp
      ? `${label}: ${from.quantity} → ${to.quantity} ${to.units}`
      : `${label}: ${formatAmount(from, isTemp)} → ${formatAmount(to, isTemp)}`;
  }

  // What a sheet changes from its base, in words: its value changes, and
  // whether anything else in the steps changed.
  function changeList(base, sheet) {
    if (!base) return [];
    const { rows } = comparison({ base, sheet, cooks: [] });
    const parts = rows.filter((r) => r.tested).map((r) => changeText(r.label, r.base, r.sheet, r.isTemp));
    const shape = (text) => String(text || '').replace(/\{[^}]*\}/g, '{}').replace(/\s+/g, ' ').trim();
    if (base.text !== undefined && sheet.text !== undefined && shape(base.text) !== shape(sheet.text)) parts.push('changes to the steps');
    return parts;
  }

  function changeSummary(base, sheet) {
    return changeList(base, sheet).join('; ');
  }

  // A cook's ticked changes in words, at the sheet's 1×.
  function cookChangeList(cookFields, scale, keyIds, stepNotes = []) {
    const wanted = new Set(keyIds);
    const parts = cookFields
      .filter((f) => f.key && wanted.has(keyId(f.key)) && changeKind(f) !== 'unchanged')
      .map((f) => changeText(valueLabel(f, new Map(), new Set()), atSheetScale(f, f.original, scale), atSheetScale(f, f.current, scale), f.isTemp));
    return [...parts, ...stepNotes];
  }

  function cookChangeSummary(cookFields, scale, keyIds, stepNotes = []) {
    return cookChangeList(cookFields, scale, keyIds, stepNotes).join('; ');
  }

  // A version adopted from a cook of a test: what the test changed, then what
  // the cook did. "salt: 2 → 1 g (tested); water: 75 → 85 g (Cook 1)".
  function adoptFromCookNotes(tested, cookParts, cookName) {
    return [...tested.map((t) => `${t} (tested)`), ...cookParts.map((c) => `${c} (${cookName})`)].join('; ');
  }

  // A checklist change id ("step-token:0:2:ingredient:1", in the sheet's
  // coordinates) as an "I meant this" key, through the sheet's fields.
  function keyForChange(sheetFields, changeId) {
    const m = String(changeId).match(/^step-token:(-?\d+):(\d+):(\w+):(\d+)$/);
    if (!m) return null;
    const f = sheetFields.find((x) => x.sectionIndex === Number(m[1]) && x.stepNumber === Number(m[2]) && x.kind === m[3] && x.index === Number(m[4]));
    return f?.key ? keyId(f.key) : null;
  }

  return { shownAmount, savedAmount, readTyped, displayNote, cookOrder, changeList, cookChangeList, adoptFromCookNotes,
    stepList, atSheetScale, comparison, metricRows, changeSummary, cookChangeSummary, keyForChange,
    noteAdded, replaceNote, buildFields, ingredientRows, listedFieldIds, formatAmount, parseTyped, changeKind, keyId,
    timeUnit, timeUnitText, parseDuration,
    joinedNotes, localDay, localTime, dateChoices, cookedAt, stepInfo };
})();
