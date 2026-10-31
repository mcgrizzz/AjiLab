// ── Units: volume/mass conversion for the recipe viewer ─────────────────────
// Display-only: recipes keep the units they were written in. The viewer asks
// `present()` how to show an amount given the current scale, the reader's
// unit preferences (volume/mass system + per-ingredient overrides), and gets
// back null when the amount should render exactly as before.
const Units = (() => {
  // factor = size in base units (ml for volume, g for mass).
  // system: which preference converts *away* from this unit. Spoons are used
  // in both systems, so neither preference rewrites them.
  const UNITS = {
    ml:      { category: 'volume', factor: 1,         system: 'metric', label: 'ml' },
    cl:      { category: 'volume', factor: 10,        system: 'metric', label: 'cl' },
    dl:      { category: 'volume', factor: 100,       system: 'metric', label: 'dl' },
    l:       { category: 'volume', factor: 1000,      system: 'metric', label: 'L' },
    tsp:     { category: 'volume', factor: 4.92892,   system: 'both',   label: 'tsp' },
    tbsp:    { category: 'volume', factor: 14.7868,   system: 'both',   label: 'tbsp' },
    'fl oz': { category: 'volume', factor: 29.5735,   system: 'us',     label: 'fl oz' },
    cup:     { category: 'volume', factor: 236.588,   system: 'us',     label: 'cup',    plural: 'cups' },
    pint:    { category: 'volume', factor: 473.176,   system: 'us',     label: 'pint',   plural: 'pints' },
    quart:   { category: 'volume', factor: 946.353,   system: 'us',     label: 'quart',  plural: 'quarts' },
    gallon:  { category: 'volume', factor: 3785.41,   system: 'us',     label: 'gallon', plural: 'gallons' },
    mg:      { category: 'mass',   factor: 0.001,     system: 'metric', label: 'mg' },
    g:       { category: 'mass',   factor: 1,         system: 'metric', label: 'g' },
    kg:      { category: 'mass',   factor: 1000,      system: 'metric', label: 'kg' },
    oz:      { category: 'mass',   factor: 28.3495,   system: 'us',     label: 'oz' },
    lb:      { category: 'mass',   factor: 453.592,   system: 'us',     label: 'lb' },
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
  const SYSTEMS = ['asis', 'metric', 'us'];
  const PREFS_KEY = 'ajilab.unitPrefs';

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

  function unitLabel(unitKey, value) {
    const def = UNITS[unitKey];
    return def.plural && value > 1 + 1e-9 ? def.plural : def.label;
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

  // Auto-pick a readable unit in the target system for an amount (base units).
  function pickUnit(system, category, base) {
    if (category === 'volume') {
      if (system === 'metric') return base >= 1000 ? 'l' : 'ml';
      if (base < 14.5) return 'tsp';
      if (base < 59) return 'tbsp';
      return 'cup';
    }
    if (system === 'metric') return base >= 1000 ? 'kg' : 'g';
    return base >= 453.592 ? 'lb' : 'oz';
  }

  function overrideKey(name) {
    return String(name ?? '').trim().toLowerCase();
  }

  // How to show `quantity unit` at `scale` under `view`
  // ({ volume, mass: 'asis'|'metric'|'us', overrides: { ingredientName: unitKey } }).
  // Returns null when the original rendering should be used unchanged.
  function present(quantity, unit, scale = 1, view = null, name = '') {
    const def = lookup(unit);
    if (!def) return null;
    const nums = parseQuantity(quantity);
    if (!nums) return null;
    const base = nums.map(n => n * scale * def.factor);

    let target = def.key;
    const override = view?.overrides?.[overrideKey(name)];
    if (override && UNITS[override]?.category === def.category) {
      target = override;
    } else {
      const system = view?.[def.category];
      if ((system === 'metric' || system === 'us') && def.system !== system && def.system !== 'both') {
        target = pickUnit(system, def.category, Math.max(...base));
      }
    }
    if (target === def.key && scale === 1) return null;

    const values = base.map(b => b / UNITS[target].factor);
    const qty = values.map(v => formatNumber(v, target)).join('-');
    const converted = target !== def.key;
    // Keep the author's spelling unless we converted, except that "cup"/"cups"
    // style units follow the scaled amount ("2 cups" at ½× → "1 cup").
    const written = String(unit).trim();
    const followsPlural = def.plural && [def.label, def.plural].includes(written.toLowerCase());
    const label = converted || followsPlural ? unitLabel(target, values[values.length - 1]) : written;
    return { qty, unit: label, text: `${qty} ${label}`, unitKey: target, converted };
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

  // Which convertible categories appear in a list of ingredients.
  function categoriesIn(ingredients) {
    const found = new Set();
    for (const ing of ingredients || []) {
      const def = lookup(ing?.units);
      if (def) found.add(def.category);
    }
    return found;
  }

  function loadPrefs() {
    const prefs = { volume: 'asis', mass: 'asis' };
    try {
      const saved = JSON.parse(window.localStorage.getItem(PREFS_KEY) || '{}');
      if (SYSTEMS.includes(saved.volume)) prefs.volume = saved.volume;
      if (SYSTEMS.includes(saved.mass)) prefs.mass = saved.mass;
    } catch {}
    return prefs;
  }

  function savePrefs(prefs) {
    try { window.localStorage.setItem(PREFS_KEY, JSON.stringify({ volume: prefs.volume, mass: prefs.mass })); } catch {}
  }

  return { UNITS, key, lookup, unitLabel, parseAmount, parseQuantity, formatNumber, pickUnit,
    overrideKey, present, scaleForTarget, categoriesIn, loadPrefs, savePrefs };
})();
