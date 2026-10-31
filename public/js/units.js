// ── Units: conversion, display and comparison of recipe amounts ─────────────
// Shared by the browser (classic script → global `Units`) and the server
// (imported for its side effect, which sets `globalThis.Units`).
//
// Display: recipes keep the units they were written in. The reader can pick,
// per ingredient, another unit to show it in (1 L → 34 fl oz). `present()`
// says how to show an amount given the scale and those choices, and returns
// null when the amount should render exactly as before.
//
// Comparison: `sameAmount()` decides whether two written amounts are the same
// after unit conversion (450 °F = ^{450%F} = 232 °C, 1 L = 1000 ml), so diffs
// don't flag pure formatting changes.
//
// Conversions go through a base unit per category (ml, g, seconds).
const Units = (() => {
  // factor = size in base units (ml for volume, g for mass, s for time).
  const UNITS = {
    ml:      { category: 'volume', factor: 1, label: 'ml' },
    cl:      { category: 'volume', factor: 10, label: 'cl' },
    dl:      { category: 'volume', factor: 100, label: 'dl' },
    l:       { category: 'volume', factor: 1000, label: 'L' },
    tsp:     { category: 'volume', factor: 4.92892, label: 'tsp' },
    tbsp:    { category: 'volume', factor: 14.7868, label: 'tbsp' },
    'fl oz': { category: 'volume', factor: 29.5735, label: 'fl oz' },
    cup:     { category: 'volume', factor: 236.588, label: 'cup', plural: 'cups' },
    pint:    { category: 'volume', factor: 473.176, label: 'pint', plural: 'pints' },
    quart:   { category: 'volume', factor: 946.353, label: 'quart', plural: 'quarts' },
    gallon:  { category: 'volume', factor: 3785.41, label: 'gallon', plural: 'gallons' },
    mg:      { category: 'mass', factor: 0.001, label: 'mg' },
    g:       { category: 'mass', factor: 1, label: 'g' },
    kg:      { category: 'mass', factor: 1000, label: 'kg' },
    oz:      { category: 'mass', factor: 28.3495, label: 'oz' },
    lb:      { category: 'mass', factor: 453.592, label: 'lb' },
    sec:     { category: 'time', factor: 1, label: 'sec' },
    min:     { category: 'time', factor: 60, label: 'min' },
    hour:    { category: 'time', factor: 3600, label: 'hour', plural: 'hours' },
    day:     { category: 'time', factor: 86400, label: 'day', plural: 'days' },
  };

  const ALIASES = {
    ml: ['ml', 'milliliter', 'milliliters', 'millilitre', 'millilitres'],
    cl: ['cl', 'centiliter', 'centiliters', 'centilitre', 'centilitres'],
    dl: ['dl', 'deciliter', 'deciliters', 'decilitre', 'decilitres'],
    l: ['l', 'lt', 'liter', 'liters', 'litre', 'litres'],
    tsp: ['tsp', 'tsps', 'teaspoon', 'teaspoons'],
    tbsp: ['tbsp', 'tbsps', 'tbs', 'tbl', 'tablespoon', 'tablespoons'],
    'fl oz': ['fl oz', 'floz', 'fl ounce', 'fl ounces', 'fluid ounce', 'fluid ounces'],
    cup: ['cup', 'cups', 'c'],
    pint: ['pint', 'pints', 'pt', 'pts'],
    quart: ['quart', 'quarts', 'qt', 'qts'],
    gallon: ['gallon', 'gallons', 'gal', 'gals'],
    mg: ['mg', 'milligram', 'milligrams'],
    g: ['g', 'gram', 'grams'],
    kg: ['kg', 'kilogram', 'kilograms', 'kilo', 'kilos'],
    oz: ['oz', 'ounce', 'ounces'],
    lb: ['lb', 'lbs', 'pound', 'pounds'],
    sec: ['s', 'sec', 'secs', 'second', 'seconds'],
    min: ['min', 'mins', 'minute', 'minutes'],
    hour: ['h', 'hr', 'hrs', 'hour', 'hours'],
    day: ['day', 'days'],
  };
  const ALIAS_TO_KEY = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    for (const name of names) ALIAS_TO_KEY[name] = key;
  }

  const VULGAR = { '⅛': 1 / 8, '¼': 1 / 4, '⅓': 1 / 3, '⅜': 3 / 8, '½': 1 / 2, '⅝': 5 / 8, '⅔': 2 / 3, '¾': 3 / 4, '⅞': 7 / 8 };
  const GLYPH = { 0.125: '⅛', 0.25: '¼', 0.375: '⅜', 0.5: '½', 0.625: '⅝', 0.75: '¾', 0.875: '⅞' };
  const THIRD = { 1: '⅓', 2: '⅔' };

  // US measures are shown as fractions, metric as decimals. Each US unit lists
  // fraction sets from coarsest to finest; the first that lands within 3% of
  // the true amount wins (450 g → "1 lb", 500 g → "1⅛ lb", 8.1 tbsp → "8 tbsp").
  const WHOLE = [0];
  const HALVES = [0, 1 / 2];
  const QUARTERS = [0, 1 / 4, 1 / 2, 3 / 4];
  const CUP_MARKS = [0, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4];
  const EIGHTHS = [0, 1 / 8, 1 / 4, 3 / 8, 1 / 2, 5 / 8, 3 / 4, 7 / 8];
  const FRACTION_SETS = {
    tsp: [WHOLE, QUARTERS, EIGHTHS],
    tbsp: [WHOLE, HALVES],
    cup: [WHOLE, CUP_MARKS],
    pint: [WHOLE, QUARTERS],
    quart: [WHOLE, QUARTERS],
    gallon: [WHOLE, QUARTERS],
    'fl oz': [WHOLE, HALVES, QUARTERS],
    oz: [WHOLE, HALVES, QUARTERS],
    lb: [WHOLE, QUARTERS, EIGHTHS],
  };

  // Units offered in the per-ingredient picker, in display order.
  const PICKER_UNITS = {
    volume: ['ml', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'quart'],
    mass: ['g', 'kg', 'oz', 'lb'],
  };
  // Nobody measures a litre in teaspoons: cap spoons at a cup's worth.
  const PICKER_MAX = { tsp: 12, tbsp: 16 };
  // A chosen unit steps down for small amounts, the way a cook would measure:
  // cups below ¼ cup become tablespoons, kg below 1 kg become grams, …
  const STEP_DOWN = {
    gallon: ['quart', 1], quart: ['pint', 1], pint: ['cup', 1], cup: ['tbsp', 0.25],
    'fl oz': ['tbsp', 1], tbsp: ['tsp', 1], l: ['ml', 1], kg: ['g', 1], lb: ['oz', 0.5],
  };
  const CATEGORY_WORD = { mass: 'weight', volume: 'volume', time: 'time' };
  const CATEGORY_HINT = { mass: 'g, oz or lb', volume: 'ml, cups or fl oz', time: 'min or hours' };

  // Canonical key for a unit string, or null when it isn't a unit we know
  // (cloves, pinch, cans…). Case only matters for the T/t spoon shorthands.
  function key(unit) {
    const raw = String(unit ?? '').trim();
    if (!raw) return null;
    if (raw === 'T') return 'tbsp';
    if (raw === 't') return 'tsp';
    const norm = raw.toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
    return ALIAS_TO_KEY[norm] || null;
  }

  function lookup(unit) {
    const k = key(unit);
    return k ? { key: k, ...UNITS[k] } : null;
  }

  // Plural follows the number as displayed: 1.06 quarts shows as "1 quart".
  function unitLabel(unitKey, value, shown = null) {
    const def = UNITS[unitKey];
    const one = shown !== null ? shown === '1' || /^[⅛¼⅓⅜½⅝⅔¾⅞]$/.test(shown) || parseFloat(shown) < 1 : value <= 1 + 1e-9;
    return def.plural && !one ? def.plural : def.label;
  }

  // "16", "1.5", "1/2", "1 1/2", "1½", "½", "16 fl oz", "16oz" → { value, unit }.
  function parseAmount(text) {
    const m = String(text ?? '').match(/^\s*(\d+(?:\.\d+)?|\.\d+)?(?:\s+(\d+)\/(\d+)|\/(\d+))?\s*([⅛¼⅓⅜½⅝⅔¾⅞])?\s*(.*?)\s*$/);
    if (!m || (m[1] === undefined && !m[5])) return null;
    let value;
    if (m[4] !== undefined) {
      value = parseFloat(m[1]) / parseFloat(m[4]);
    } else {
      value = m[1] !== undefined ? parseFloat(m[1]) : 0;
      if (m[2] !== undefined) value += parseFloat(m[2]) / parseFloat(m[3]);
    }
    if (m[5]) value += VULGAR[m[5]];
    if (!Number.isFinite(value)) return null;
    return { value, unit: m[6] || '' };
  }

  // Quantity as stored on an ingredient (number, "1/2", "1-2") → [n] or [min, max].
  function parseQuantity(quantity) {
    if (typeof quantity === 'number') return Number.isFinite(quantity) ? [quantity] : null;
    const str = String(quantity ?? '').trim();
    const range = str.match(/^(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)$/);
    if (range) return [parseFloat(range[1]), parseFloat(range[2])];
    const parsed = parseAmount(str);
    return parsed && !parsed.unit ? [parsed.value] : null;
  }

  function trimZeros(text) {
    return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
  }

  function roundToSet(value, set) {
    const whole = Math.floor(value);
    const frac = value - whole;
    let best = 0;
    for (const f of [...set, 1]) {
      if (Math.abs(frac - f) < Math.abs(frac - best)) best = f;
    }
    return whole + best;
  }

  function fractionText(value) {
    let whole = Math.floor(value + 1e-9);
    const frac = value - whole;
    if (frac < 1e-6) return String(whole);
    const thirds = Math.round(frac * 3);
    const glyph = Math.abs(frac - thirds / 3) < 1e-6 ? THIRD[thirds] : GLYPH[Math.round(frac * 8) / 8];
    if (!glyph) return trimZeros(value.toFixed(2));
    return whole ? `${whole}${glyph}` : glyph;
  }

  function formatNumber(value, unitKey) {
    const sets = FRACTION_SETS[unitKey];
    if (sets && value > 0) {
      let chosen = null;
      for (const set of sets) {
        const rounded = roundToSet(value, set);
        if (rounded > 0 && Math.abs(rounded - value) / value <= 0.03) { chosen = rounded; break; }
      }
      if (chosen === null) chosen = roundToSet(value, sets[sets.length - 1]);
      if (chosen > 0) return fractionText(chosen);
      return trimZeros(value.toFixed(2));
    }
    if (unitKey === 'ml' || unitKey === 'g' || unitKey === 'mg') {
      return value >= 10 ? String(Math.round(value)) : trimZeros(value.toFixed(1));
    }
    if (unitKey === 'l' || unitKey === 'kg') return trimZeros(value.toFixed(2));
    if (value >= 100) return String(Math.round(value));
    return trimZeros(value.toFixed(value < 1 ? 2 : 1));
  }

  function overrideKey(name) {
    return String(name ?? '').trim().toLowerCase();
  }

  // The author's unit, with case-only variants shown canonically ("l" → "L";
  // a lowercase l reads like a 1 next to a number).
  function displayWritten(writtenUnit, def) {
    const written = String(writtenUnit).trim();
    return written.toLowerCase() === def.label.toLowerCase() ? def.label : written;
  }

  // Format parsed quantity values (at scale) from `def` into unit `target`.
  function formatIn(nums, def, writtenUnit, scale, target) {
    const values = nums.map(n => (n * scale * def.factor) / UNITS[target].factor);
    const qty = values.map(v => formatNumber(v, target)).join('-');
    const converted = target !== def.key;
    // Keep the author's spelling unless we converted, except that "cup"/"cups"
    // style units follow the scaled amount ("2 cups" at ½× → "1 cup").
    const written = displayWritten(writtenUnit, def);
    const followsPlural = def.plural && [def.label, def.plural].includes(written.toLowerCase());
    const lastShown = qty.split('-').pop();
    const label = converted || followsPlural ? unitLabel(target, values[values.length - 1], lastShown) : written;
    return { qty, unit: label, text: `${qty} ${label}`, unitKey: target, converted };
  }

  function stepsDown(unitKey, base) {
    const step = STEP_DOWN[unitKey];
    return !!step && base / UNITS[unitKey].factor < step[1];
  }

  // The unit to show this row in: the reader's choice for the ingredient (if
  // it fits the category), stepped down for small amounts. The author's own
  // unit is never stepped down.
  function displayUnit(def, view, name, base) {
    const choice = view?.overrides?.[overrideKey(name)];
    let target = choice && UNITS[choice]?.category === def.category ? choice : def.key;
    while (target !== def.key && stepsDown(target, base)) target = STEP_DOWN[target][0];
    return target;
  }

  // How to show `quantity unit` at `scale` given `view` ({ overrides:
  // { ingredientName: unitKey } }). Returns null when the original rendering
  // should be used unchanged.
  function present(quantity, unit, scale = 1, view = null, name = '') {
    const def = lookup(unit);
    if (!def) return null;
    const nums = parseQuantity(quantity);
    if (!nums) return null;
    const target = displayUnit(def, view, name, Math.max(...nums) * scale * def.factor);
    if (target === def.key && scale === 1 && displayWritten(unit, def) === String(unit).trim()) return null;
    return formatIn(nums, def, unit, scale, target);
  }

  // Unit choices for the picker: same-category units whose value reads
  // sensibly (⅛ up to a cap, and not small enough to step down), plus the
  // recipe's own unit and the one currently shown.
  function alternatives(quantity, unit, scale = 1, view = null, name = '') {
    const def = lookup(unit);
    if (!def || !PICKER_UNITS[def.category]) return [];
    const nums = parseQuantity(quantity);
    if (!nums) return [];
    const base = Math.max(...nums) * scale * def.factor;
    const current = displayUnit(def, view, name, base);
    const keys = [...PICKER_UNITS[def.category]];
    if (!keys.includes(def.key)) keys.unshift(def.key);
    return keys
      .filter((k) => {
        if (k === def.key || k === current) return true;
        const v = base / UNITS[k].factor;
        return v >= 0.125 && v <= (PICKER_MAX[k] ?? 1000) && !stepsDown(k, base);
      })
      .map((k) => ({ ...formatIn(nums, def, unit, scale, k), active: k === current, written: k === def.key }));
  }

  function capitalize(text) {
    const s = String(text || '').trim();
    return s ? s[0].toUpperCase() + s.slice(1) : s;
  }

  // Scale-to-amount: the reader typed `typed` (from parseAmount) for an
  // ingredient written as `origQty writtenUnit` and currently shown in
  // `shownUnit`. Returns { scale, unitKey } (unitKey set when they typed an
  // explicit unit) or { error } phrased for the cook.
  function scaleForTarget(origQty, writtenUnit, shownUnit, typed, name = '') {
    const noun = capitalize(name) || 'This ingredient';
    if (!typed || !(typed.value > 0) || !(origQty > 0)) return { error: 'Enter an amount greater than zero, e.g. 16 fl oz.' };
    const written = lookup(writtenUnit);
    if (!written) {
      const unitText = String(writtenUnit || '').trim();
      const same = !typed.unit || typed.unit.trim().toLowerCase() === unitText.toLowerCase();
      if (!same) {
        return { error: unitText
          ? `${noun} is counted in ${unitText}, so enter a number of ${unitText}.`
          : `${noun} has no unit, so enter just a number.` };
      }
      return { scale: typed.value / origQty, unitKey: null };
    }
    let target = lookup(typed.unit || shownUnit || writtenUnit);
    if (!target) return { error: `"${typed.unit}" isn't a unit AjiLab knows. Try ${CATEGORY_HINT[written.category]}.` };
    // "16 oz" of a liquid means fluid ounces.
    if (target.key === 'oz' && written.category === 'volume') target = lookup('fl oz');
    if (target.category !== written.category) {
      return { error: `${noun} is measured by ${CATEGORY_WORD[written.category]}. Try ${CATEGORY_HINT[written.category]}.` };
    }
    const inWritten = typed.value * target.factor / written.factor;
    return { scale: inWritten / origQty, unitKey: typed.unit ? target.key : null };
  }

  // ── Comparison ──
  function temperatureKey(unit) {
    const raw = String(unit ?? '').trim().toLowerCase().replace(/\s+/g, '').replace(/^degrees?/, '').replace(/^°/, '');
    if (raw === 'f' || raw === 'fahrenheit') return 'F';
    if (raw === 'c' || raw === 'celsius') return 'C';
    return null;
  }

  function toCelsius(value, unitKey) {
    return unitKey === 'F' ? (value - 32) * 5 / 9 : value;
  }

  // [min, max] numbers for an amount, from its range or quantity.
  function amountValues(amount) {
    const range = amount?.range;
    if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) return [range.min, range.max];
    // Plain-text amounts can carry their unit in the quantity ("450 °F").
    let quantity = amount?.quantity;
    const units = String(amount?.units ?? '').trim();
    if (typeof quantity === 'string' && units && quantity.trim().endsWith(units)) {
      quantity = quantity.trim().slice(0, -units.length).trim();
    }
    const nums = parseQuantity(quantity);
    if (!nums) return null;
    return nums.length === 1 ? [nums[0], nums[0]] : nums;
  }

  function close(a, b) {
    return Math.abs(a - b) <= 1e-9 + 0.005 * Math.max(Math.abs(a), Math.abs(b));
  }

  function looseText(amount) {
    return `${amount?.quantity ?? ''}${amount?.units ?? ''}`.toLowerCase().replace(/[°\s]/g, '');
  }

  function exact(a, b) {
    return Math.abs(a - b) <= 1e-9;
  }

  // Are two amounts ({ quantity, units, range? }) the same once units are
  // converted? In the same unit the numbers must match exactly (26.5 → 27 °C
  // is an edit). Across units, allow for the rounding conversions involve:
  // temperatures within 1 °C (450 °F ≈ 232 °C), everything else within 0.5%.
  // Unknown units must match by name; non-numeric amounts compare as text.
  function sameAmount(a, b) {
    const av = amountValues(a);
    const bv = amountValues(b);
    if (!av || !bv) return looseText(a) === looseText(b);
    const at = temperatureKey(a?.units);
    const bt = temperatureKey(b?.units);
    if (at || bt) {
      if (!at || !bt) return false;
      if (at === bt) return av.every((v, i) => exact(v, bv[i]));
      return av.every((v, i) => Math.abs(toCelsius(v, at) - toCelsius(bv[i], bt)) < 1);
    }
    const ad = lookup(a?.units);
    const bd = lookup(b?.units);
    if (ad || bd) {
      if (!ad || !bd || ad.category !== bd.category) return false;
      if (ad.key === bd.key) return av.every((v, i) => exact(v, bv[i]));
      return av.every((v, i) => close(v * ad.factor, bv[i] * bd.factor));
    }
    const au = String(a?.units ?? '').trim().toLowerCase();
    const bu = String(b?.units ?? '').trim().toLowerCase();
    return au === bu && av.every((v, i) => exact(v, bv[i]));
  }

  return { UNITS, key, lookup, unitLabel, parseAmount, parseQuantity, formatNumber,
    overrideKey, present, alternatives, scaleForTarget, temperatureKey, sameAmount };
})();

if (typeof globalThis !== 'undefined') globalThis.Units = Units;
