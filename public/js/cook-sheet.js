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

  const hasQuantity = (token) => token.quantity !== '' && token.quantity != null;
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
      const counts = { ingredient: 0, timer: 0, inlineQuantity: 0 };
      for (const token of step) {
        if (!token || typeof token !== 'object' || !KINDS.includes(token.type) || !hasQuantity(token)) continue;
        const index = counts[token.type]++;
        const name = token.type === 'inlineQuantity' ? '' : lower(token.name);
        let key = null;
        if (!added) {
          const id = `${token.type}|${name}`;
          const n = ordinals.get(id) || 0;
          ordinals.set(id, n + 1);
          key = { kind: token.type, name, n };
        }
        const current = { quantity: String(token.quantity), units: String(token.units || '') };
        const annotated = token.source_quantity !== undefined && token.source_quantity !== null;
        const original = annotated
          ? { quantity: String(token.source_quantity), units: String(token.source_units ?? current.units) }
          : { ...current };
        fields.push({
          id: `f${fields.length}`,
          sectionIndex: info.sectionIndex,
          stepNumber: info.stepNumber,
          kind: token.type,
          index,
          name: String(token.name || ''),
          isTemp: token.type === 'inlineQuantity' && TEMP_UNIT.test(String(token.units || '')),
          key,
          added,
          original,
          current,
        });
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
  // "230 c". A bare number keeps the unit. Null when it isn't an amount.
  function parseTyped(text, field) {
    const typed = String(text ?? '').trim();
    if (!typed) return null;
    // Mixed numbers and fractions first, so "1/2" isn't read as "1".
    const number = '(?:\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d*\\s*[⅛¼⅓⅜½⅝⅔¾⅞]|\\d+(?:[.,]\\d+)?)';
    const match = typed.match(new RegExp(`^(${number}(?:\\s*[-–]\\s*${number})?)\\s*(.*)$`));
    if (!match) return null;
    const quantity = match[1].replace(/\s*[-–]\s*/, '-').replace(/(\d),(\d)/g, '$1.$2').trim();
    let units = match[2].trim();
    if (field.isTemp) {
      const temp = units.replace(/^°\s*/, '');
      if (temp && !TEMP_UNIT.test(temp)) return null;
      units = /^c/i.test(temp) ? 'C' : (/^f/i.test(temp) ? 'F' : '');
    }
    return { quantity, units: units || field.current.units };
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

  return { buildFields, ingredientRows, listedFieldIds, formatAmount, parseTyped, changeKind, keyId,
    joinedNotes, localDay, localTime, dateChoices, cookedAt, stepInfo };
})();
