// ── Units: volume/mass conversion for the recipe viewer ─────────────────────
// Display-only: recipes keep the units they were written in. The reader can
// pick, per ingredient, another unit to show it in (1 L → 33.8 fl oz). The
// viewer asks `present()` how to show an amount given the scale and those
// per-ingredient choices, and gets back null when the amount should render
// exactly as before. Conversions go through a base unit per category.
const Units = (() => {
  // factor = size in base units (ml for volume, g for mass).
  const UNITS = {
    ml:      { category: 'volume', factor: 1, label: 'ml' },
    cl:      { category: 'volume', factor: 10, label: 'cl' },
    dl:      { category: 'volume', factor: 100, label: 'dl' },
    l:       { category: 'volume', factor: 1000, label: 'L' },
    tsp:     { category: 'volume', factor: 4.92892,   label: 'tsp' },
    tbsp:    { category: 'volume', factor: 14.7868,   label: 'tbsp' },
    'fl oz': { category: 'volume', factor: 29.5735,     label: 'fl oz' },
    cup:     { category: 'volume', factor: 236.588,     label: 'cup',    plural: 'cups' },
    pint:    { category: 'volume', factor: 473.176,     label: 'pint',   plural: 'pints' },
    quart:   { category: 'volume', factor: 946.353,     label: 'quart',  plural: 'quarts' },
    gallon:  { category: 'volume', factor: 3785.41,     label: 'gallon', plural: 'gallons' },
    mg:      { category: 'mass',   factor: 0.001, label: 'mg' },
    g:       { category: 'mass',   factor: 1, label: 'g' },
    kg:      { category: 'mass',   factor: 1000, label: 'kg' },
    oz:      { category: 'mass',   factor: 28.3495,     label: 'oz' },
    lb:      { category: 'mass',   factor: 453.592,     label: 'lb' },
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
  };
  const ALIAS_TO_KEY = {};
  for (const [key, names] of Object.entries(ALIASES)) {
    for (const name of names) ALIAS_TO_KEY[name] = key;
  }

  const FRACTION_UNITS = new Set(['tsp', 'tbsp', 'cup', 'pint', 'quart', 'gallon']);
  const FRACTIONS = [[0, ''], [1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'], [1 / 2, '½'],
    [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'], [1, '']];
  const VULGAR = { '⅛': 1 / 8, '¼': 1 / 4, '⅓': 1 / 3, '⅜': 3 / 8, '½': 1 / 2, '⅝': 5 / 8, '⅔': 2 / 3, '¾': 3 / 4, '⅞': 7 / 8 };
  // Units offered in the per-ingredient picker, in display order.
  const PICKER_UNITS = {
    volume: ['ml', 'l', 'tsp', 'tbsp', 'fl oz', 'cup', 'pint', 'quart'],
    mass: ['g', 'kg', 'oz', 'lb'],
  };
  // Nobody measures a litre in teaspoons: cap spoons at a cup's worth.
  const PICKER_MAX = { tsp: 12, tbsp: 16 };

  // Canonical key for a unit string, or null when it isn't a volume/mass unit
  // we know (cloves, pinch, cans…). Case only matters for the T/t spoon
  // shorthands.
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

  function formatNumber(value, unitKey) {
    if (FRACTION_UNITS.has(unitKey) && value >= 1 / 16) {
      let whole = Math.floor(value);
      const frac = value - whole;
      let best = FRACTIONS[0];
      for (const candidate of FRACTIONS) {
        if (Math.abs(frac - candidate[0]) < Math.abs(frac - best[0])) best = candidate;
      }
      if (best[0] === 1) { whole += 1; best = FRACTIONS[0]; }
      if (!best[1]) return String(whole);
      return whole ? `${whole}${best[1]}` : best[1];
    }
    if (unitKey === 'ml' || unitKey === 'g' || unitKey === 'mg') {
      return value >= 10 ? String(Math.round(value)) : trimZeros(value.toFixed(1));
    }
    if (unitKey === 'l' || unitKey === 'kg' || unitKey === 'lb') return trimZeros(value.toFixed(2));
    if (value >= 100) return String(Math.round(value));
    return trimZeros(value.toFixed(value < 1 ? 2 : 1));
  }

  function overrideKey(name) {
    return String(name ?? '').trim().toLowerCase();
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

  // The author's unit, with case-only variants shown canonically ("l" → "L";
  // a lowercase l reads like a 1 next to a number).
  function displayWritten(writtenUnit, def) {
    const written = String(writtenUnit).trim();
    return written.toLowerCase() === def.label.toLowerCase() ? def.label : written;
  }

  // The unit the reader picked for this ingredient, if it fits its category.
  function chosenUnit(def, view, name) {
    const choice = view?.overrides?.[overrideKey(name)];
    return choice && UNITS[choice]?.category === def.category ? choice : def.key;
  }

  // How to show `quantity unit` at `scale` given `view` ({ overrides:
  // { ingredientName: unitKey } }). Returns null when the original rendering
  // should be used unchanged.
  function present(quantity, unit, scale = 1, view = null, name = '') {
    const def = lookup(unit);
    if (!def) return null;
    const nums = parseQuantity(quantity);
    if (!nums) return null;
    const target = chosenUnit(def, view, name);
    if (target === def.key && scale === 1 && displayWritten(unit, def) === String(unit).trim()) return null;
    return formatIn(nums, def, unit, scale, target);
  }

  // Unit choices for the picker: same-category units whose value reads
  // sensibly (⅛ to 1000), plus the recipe's own unit and the current choice.
  function alternatives(quantity, unit, scale = 1, view = null, name = '') {
    const def = lookup(unit);
    if (!def) return [];
    const nums = parseQuantity(quantity);
    if (!nums) return [];
    const current = chosenUnit(def, view, name);
    const keys = [...PICKER_UNITS[def.category]];
    if (!keys.includes(def.key)) keys.unshift(def.key);
    const base = Math.max(...nums) * scale * def.factor;
    return keys
      .filter((k) => {
        if (k === def.key || k === current) return true;
        const v = base / UNITS[k].factor;
        return v >= 0.125 && v <= (PICKER_MAX[k] ?? 1000);
      })
      .map((k) => ({ ...formatIn(nums, def, unit, scale, k), active: k === current, written: k === def.key }));
  }

  // Click-to-scale: the reader typed `typed` (from parseAmount) on an amount
  // written as `origQty writtenUnit` and currently shown in `shownUnit`.
  // Returns { scale, unitKey } (unitKey set when they typed an explicit unit)
  // or { error }.
  function scaleForTarget(origQty, writtenUnit, shownUnit, typed) {
    if (!typed || !(typed.value > 0) || !(origQty > 0)) return { error: 'Enter an amount greater than zero' };
    const written = lookup(writtenUnit);
    if (!written) {
      const same = !typed.unit || typed.unit.trim().toLowerCase() === String(writtenUnit || '').trim().toLowerCase();
      if (!same) return { error: `Can't convert ${typed.unit} to ${writtenUnit || 'this amount'}` };
      return { scale: typed.value / origQty, unitKey: null };
    }
    let target = lookup(typed.unit || shownUnit || writtenUnit);
    if (!target) return { error: `Unknown unit "${typed.unit}"` };
    // "16 oz" of a liquid means fluid ounces.
    if (target.key === 'oz' && written.category === 'volume') target = lookup('fl oz');
    if (target.category !== written.category) {
      return { error: `Can't convert ${target.label} (${target.category}) to ${written.label} (${written.category})` };
    }
    const inWritten = typed.value * target.factor / written.factor;
    return { scale: inWritten / origQty, unitKey: typed.unit ? target.key : null };
  }

  return { UNITS, key, lookup, unitLabel, parseAmount, parseQuantity, formatNumber,
    overrideKey, present, alternatives, scaleForTarget };
})();
