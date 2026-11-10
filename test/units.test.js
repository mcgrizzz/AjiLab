import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

function setup() {
  const context = vm.createContext({});
  vm.runInContext(read('../public/js/units.js'), context);
  vm.runInContext(read('../public/js/cooklang-render.js'), context);
  return { Units: vm.runInContext('Units', context), CL: vm.runInContext('CL', context) };
}

const none = { overrides: {} };
const pick = (name, unitKey) => ({ overrides: { [name]: unitKey } });

test('unit aliases resolve, including spoon shorthands and dotted forms', () => {
  const { Units } = setup();
  assert.equal(Units.key('L'), 'l');
  assert.equal(Units.key('Litres'), 'l');
  assert.equal(Units.key('fl. oz.'), 'fl oz');
  assert.equal(Units.key('floz'), 'fl oz');
  assert.equal(Units.key('cups'), 'cup');
  assert.equal(Units.key('T'), 'tbsp');
  assert.equal(Units.key('t'), 'tsp');
  assert.equal(Units.key('lbs'), 'lb');
  assert.equal(Units.key('cloves'), null);
  assert.equal(Units.key(''), null);
});

test('typed amounts parse whole numbers, decimals, fractions and units', () => {
  const { Units } = setup();
  const p = (s) => { const r = Units.parseAmount(s); return r && [Math.round(r.value * 1000) / 1000, r.unit]; };
  assert.deepEqual(p('16 fl oz'), [16, 'fl oz']);
  assert.deepEqual(p('16oz'), [16, 'oz']);
  assert.deepEqual(p('1.5'), [1.5, '']);
  assert.deepEqual(p('1/2 cup'), [0.5, 'cup']);
  assert.deepEqual(p('1 1/2 cups'), [1.5, 'cups']);
  assert.deepEqual(p('1½ cups'), [1.5, 'cups']);
  assert.deepEqual(p('¾'), [0.75, '']);
  assert.equal(Units.parseAmount('cups'), null);
  assert.equal(Units.parseAmount(''), null);
});

test('without a choice, amounts render as written at 1x and reformat sensibly when scaled', () => {
  const { Units } = setup();
  assert.equal(Units.present(1, 'L', 1, none, 'cream'), null);
  assert.equal(Units.present(1, 'l', 1, none, 'cream').text, '1 L', 'lowercase l is shown as L');
  assert.equal(Units.present(250, 'g', 0.5, none).text, '125 g');
  assert.equal(Units.present(2, 'cups', 0.5, none).text, '1 cup');
  assert.equal(Units.present(1, 'cup', 1 / 3, none).text, '⅓ cup');
  assert.equal(Units.present(3, 'cloves', 2, none), null, 'unknown units fall back to the old renderer');
});

test('a per-ingredient unit choice converts only that ingredient, within its category', () => {
  const { Units } = setup();
  const view = pick('heavy cream', 'fl oz');
  assert.equal(Units.present(1, 'L', 1, view, 'Heavy Cream').text, '34 fl oz');
  assert.equal(Units.present(1, 'L', 0.473176, view, 'heavy cream').text, '16 fl oz');
  assert.equal(Units.present(1, 'L', 1, view, 'milk'), null, 'other ingredients are untouched');
  assert.equal(Units.present(2, 'cups', 1, pick('milk', 'ml'), 'milk').text, '473 ml');
  assert.equal(Units.present(1, 'L', 1, pick('cream', 'cup'), 'cream').text, '4¼ cups');
  assert.equal(Units.present(500, 'g', 1, pick('flour', 'fl oz'), 'flour'), null, 'volume choice ignored for a mass ingredient');
  assert.equal(Units.present(500, 'g', 1, pick('flour', 'lb'), 'flour').text, '1⅛ lb');
  assert.equal(Units.present('200-300', 'ml', 1, pick('stock', 'cup'), 'stock').text, '¾-1¼ cups');
});

test('picker alternatives show sensible units with converted values and mark the current one', () => {
  const { Units } = setup();
  const alts = Units.alternatives(1, 'L', 1, none, 'cream');
  assert.deepEqual(Array.from(alts, a => a.unitKey), ['ml', 'l', 'fl oz', 'cup', 'pint', 'quart'], 'spoons are capped at a cup');
  assert.equal(alts.find(a => a.unitKey === 'quart').text, '1 quart', 'plural follows the displayed number');
  const byKey = Object.fromEntries(alts.map(a => [a.unitKey, a]));
  assert.equal(byKey.l.text, '1 L');
  assert.equal(byKey.l.written, true);
  assert.equal(byKey.l.active, true);
  assert.equal(byKey['fl oz'].text, '34 fl oz');
  assert.equal(byKey.ml.text, '1000 ml');

  const chosen = Units.alternatives(1, 'L', 1, pick('cream', 'fl oz'), 'cream');
  assert.equal(chosen.find(a => a.active).unitKey, 'fl oz');

  const small = Array.from(Units.alternatives(1, 'tsp', 1, none, 'vanilla'), a => a.unitKey);
  assert.ok(small.includes('ml') && small.includes('tsp'));
  assert.ok(!small.includes('l') && !small.includes('cup'), 'units that would read < ⅛ are hidden');

  assert.equal(Units.alternatives(2, 'cloves', 1, none, 'garlic').length, 0, 'no picker for unknown units');
  assert.deepEqual(Array.from(Units.alternatives(250, 'g', 1, none, 'flour'), a => a.unitKey), ['g', 'oz', 'lb'], 'kg would step down to g');
});

test('scale-to-amount converts the typed unit into a recipe scale', () => {
  const { Units } = setup();
  const cream = Units.scaleForTarget(1, 'L', 'L', Units.parseAmount('16 fl oz'));
  assert.ok(Math.abs(cream.scale - 0.473176) < 1e-6);
  assert.equal(cream.unitKey, 'fl oz');

  const ozLiquid = Units.scaleForTarget(1, 'L', 'L', Units.parseAmount('16 oz'));
  assert.equal(ozLiquid.unitKey, 'fl oz', '"oz" on a liquid means fluid ounces');

  const bare = Units.scaleForTarget(1, 'L', 'cups', Units.parseAmount('2'));
  assert.ok(Math.abs(bare.scale - 0.473176) < 1e-6, 'a bare number uses the unit currently shown');
  assert.equal(bare.unitKey, null);

  assert.equal(Units.scaleForTarget(2, 'cloves', 'cloves', Units.parseAmount('3')).scale, 1.5);
  assert.equal(Units.scaleForTarget(500, 'g', 'g', Units.parseAmount('2 cups'), 'spaghetti').error, 'Spaghetti is measured by weight. Try g, oz or lb.');
  assert.equal(Units.scaleForTarget(500, 'g', 'g', Units.parseAmount('2 handfuls'), 'flour').error, '"handfuls" isn\'t a unit AjiLab knows. Try g, oz or lb.');
  assert.equal(Units.scaleForTarget(2, 'cloves', 'cloves', Units.parseAmount('1 cup'), 'garlic').error, 'Garlic is counted in cloves, so enter a number of cloves.');
  assert.ok(Units.scaleForTarget(500, 'g', 'g', Units.parseAmount('0')).error);
});

test('renderer applies unit choices to the ingredient list and step amounts', () => {
  const { CL } = setup();
  const ings = [
    { name: 'heavy cream', quantity: 1, units: 'L' },
    { name: 'garlic', quantity: 2, units: 'cloves' },
  ];
  const view = pick('heavy cream', 'fl oz');
  const html = CL.renderIngredients(ings, 0.473176, { units: view });
  assert.match(html, /<button type="button" class="ing-qty ing-qty-editable"[^>]*>16 fl oz<\/button>/);
  assert.match(html, /data-unit="L"/);
  assert.match(html, /data-shown-unit="fl oz"/);
  assert.match(html, /0\.47 L as written/);
  assert.match(html, />0\.95 cloves</);

  const plain = CL.renderIngredients(ings, 1, {});
  assert.match(plain, />1 L</, 'no unit options → unchanged output');

  const steps = [[{ type: 'text', value: 'Whisk ' }, { type: 'ingredient', name: 'heavy cream', quantity: 1, units: 'L' }]];
  const text = (html) => html.replace(/<[^>]+>/g, '');
  assert.match(text(CL.renderSteps(steps, 1, {}, true, { units: pick('heavy cream', 'cup') })), /\(4¼ cups\)/);
  assert.match(CL.renderSteps(steps, 1, {}, true, { units: pick('heavy cream', 'cup') }), /<span class="qty-frac">¼<\/span>/, 'fractions are wrapped for styling');
  assert.match(CL.renderSteps(steps, 1, {}, true, { units: none }), /\(1 L\)/);
});

test('punctuation after a chip wraps with it', () => {
  const { CL } = setup();
  const steps = [[
    { type: 'text', value: 'Season with ' },
    { type: 'ingredient', name: 'salt' },
    { type: 'text', value: ', ' },
    { type: 'ingredient', name: 'pepper' },
    { type: 'text', value: ' and rest ' },
    { type: 'timer', value: '48 hours', quantity: 48, units: 'hours' },
    { type: 'text', value: '.' },
  ]];
  const html = CL.renderSteps(steps, 1, {}, false, { units: none });
  assert.match(html, /<span class="s-glue"><span class="s-ingredient">salt<\/span>,<\/span> <span class="s-ingredient">pepper<\/span> and rest/);
  assert.match(html, /<span class="s-glue"><span class="s-timer">⏱ 48 hours<\/span>\.<\/span><\/span><\/li>/);
});

test('US amounts use fractions within 3%, metric uses decimals', () => {
  const { Units } = setup();
  assert.equal(Units.present(450, 'g', 1, pick('pasta', 'lb'), 'pasta').text, '1 lb', 'no false precision (0.99 lb)');
  assert.equal(Units.present(450, 'g', 1, pick('pasta', 'oz'), 'pasta').text, '16 oz');
  assert.equal(Units.present(100, 'g', 1, pick('butter', 'oz'), 'butter').text, '3½ oz');
  assert.equal(Units.present(120, 'ml', 1, pick('oil', 'fl oz'), 'oil').text, '4 fl oz');
  assert.equal(Units.present(120, 'ml', 1, pick('oil', 'tbsp'), 'oil').text, '8 tbsp');
  assert.equal(Units.present(120, 'ml', 1, pick('oil', 'cup'), 'oil').text, '½ cup');
  assert.equal(Units.present(1, 'kg', 0.333, none, 'flour').text, '0.33 kg');
});

test('a chosen unit steps down for small rows of the same ingredient', () => {
  const { Units } = setup();
  const cups = pick('olive oil', 'cup');
  assert.equal(Units.present(120, 'ml', 1, cups, 'olive oil').text, '½ cup');
  assert.equal(Units.present(30, 'ml', 1, cups, 'olive oil').text, '2 tbsp');
  assert.equal(Units.present(5, 'ml', 1, cups, 'olive oil').text, '1 tsp');
  assert.equal(Units.present(300, 'g', 1, pick('flour', 'kg'), 'flour'), null, '300 g steps back down to the recipe unit (rendered as written)');
  assert.equal(Units.present(200, 'g', 1, pick('flour', 'lb'), 'flour').text, '7 oz');
  const alts = Units.alternatives(30, 'ml', 1, cups, 'olive oil');
  assert.equal(alts.find(a => a.active).unitKey, 'tbsp', 'the picker marks what is actually shown');
  assert.ok(!alts.some(a => a.unitKey === 'cup'), 'cups are not offered for 2 tbsp');
  assert.equal(Units.present(30, 'ml', 1, none, 'olive oil'), null, "the author's own unit never steps down");
});

test('sameAmount treats formatting-only differences as equal', () => {
  const { Units } = setup();
  // Bare F/C come from ^{…} tokens, which carry kind 'temperature'.
  const same = (a, b) => Units.sameAmount(a, b);
  assert.ok(same({ quantity: 450, units: '°F' }, { quantity: 450, units: 'F', kind: 'temperature' }));
  assert.ok(same({ quantity: 450, units: '°F' }, { quantity: 232, units: 'C', kind: 'temperature' }), '450 °F ≈ 232 °C');
  assert.ok(!same({ quantity: 450, units: 'F', kind: 'temperature' }, { quantity: 475, units: 'F', kind: 'temperature' }));
  assert.ok(!same({ quantity: 450, units: 'F', kind: 'temperature' }, { quantity: 230, units: 'C', kind: 'temperature' }), 'beyond 1 °C is a change');
  assert.ok(!same({ quantity: 26.5, units: 'C', kind: 'temperature' }, { quantity: 27, units: '°C' }), 'same unit: any numeric change counts');
  assert.ok(!same({ quantity: 500, units: 'g' }, { quantity: 501, units: 'g' }));
  assert.ok(same({ quantity: 1, units: 'L' }, { quantity: 1000, units: 'ml' }));
  assert.ok(same({ quantity: 25, units: 'min' }, { quantity: 25, units: 'minutes' }));
  assert.ok(same({ quantity: 1.5, units: 'hours' }, { quantity: 90, units: 'min' }));
  assert.ok(!same({ quantity: 1, units: 'cup' }, { quantity: 236, units: 'g' }), 'volume vs mass never matches');
  assert.ok(same({ quantity: 2, units: 'cloves' }, { quantity: '2', units: 'Cloves' }));
  assert.ok(!same({ quantity: 2, units: 'cloves' }, { quantity: 2, units: 'heads' }));
  assert.ok(same({ quantity: '23-25', units: 'C', kind: 'temperature', range: { min: 23, max: 25 } }, { quantity: '23-25', units: '°C' }));
  assert.ok(same({ quantity: '', units: '' }, { quantity: null, units: undefined }));
  assert.ok(!same({ quantity: 1, units: '' }, { quantity: '', units: '' }));
});

test('compareAmounts: near-equal across units is "near", not "same"', () => {
  const { Units } = setup();
  const cmp = (a, b) => Units.compareAmounts(a, b);
  assert.equal(cmp({ quantity: 1, units: 'cup' }, { quantity: 240, units: 'ml' }), 'near');
  assert.equal(cmp({ quantity: 1, units: 'L' }, { quantity: 1000, units: 'ml' }), 'same');
  assert.equal(cmp({ quantity: 1, units: 'cup' }, { quantity: 250, units: 'ml' }), 'different');
  // Same unit stays exact: no "near" for 100 g vs 101 g.
  assert.equal(cmp({ quantity: 100, units: 'g' }, { quantity: 101, units: 'g' }), 'different');
  assert.equal(Units.sameAmount({ quantity: 1, units: 'cup' }, { quantity: 240, units: 'ml' }), false);
});

test('percentChange converts units and skips temperatures', () => {
  const { Units } = setup();
  assert.equal(Math.round(Units.percentChange({ quantity: 265, units: 'g' }, { quantity: 380, units: 'g' }) * 10) / 10, 43.4);
  assert.equal(Math.round(Units.percentChange({ quantity: 1, units: 'kg' }, { quantity: 1500, units: 'g' })), 50);
  assert.equal(Units.percentChange({ quantity: 1, units: 'cup' }, { quantity: 100, units: 'g' }), null);
  assert.equal(Units.percentChange({ quantity: 450, units: 'F', kind: 'temperature' }, { quantity: 500, units: 'F', kind: 'temperature' }), null);
  assert.equal(Units.percentChange({ quantity: 2, units: 'cloves' }, { quantity: 3, units: 'cloves' }), 50);
});

test('a bare C is a cup in ingredient amounts and Celsius inside ^{…} / %{…}', () => {
  const { Units } = setup();
  // Ingredient amounts (no token context): C and c are cups.
  assert.equal(Units.temperatureKey('C', false), null);
  assert.equal(Units.temperatureKey('c', false), null);
  assert.equal(Units.temperatureKey('°C', false), 'C');
  assert.equal(Units.temperatureKey('celsius', false), 'C');
  assert.equal(Units.compareAmounts({ quantity: 1, units: 'C' }, { quantity: 240, units: 'ml' }), 'near');
  assert.equal(Units.sameAmount({ quantity: 1, units: 'c' }, { quantity: 1, units: 'cup' }), true);
  assert.equal(Units.comparableUnits('C', 'ml'), true);
  // ^{…} and %{…} tokens: bare C/F are temperatures.
  const temp = (q, u) => ({ quantity: q, units: u, kind: 'temperature', type: 'inlineQuantity' });
  assert.equal(Units.sameAmount(temp(232, 'C'), temp(450, 'F')), true);
  assert.equal(Units.sameAmount(temp(23, 'c'), temp(23, 'C')), true);
  assert.equal(Units.sameAmount({ quantity: 450, units: 'F', type: 'inlineQuantity' }, { quantity: '450 °F', units: '°F', type: 'inlineQuantity' }), true);
  assert.equal(Units.percentChange(temp(450, 'F'), temp(500, 'F')), null);
});

test('a list with no amounts has no amount column; a mixed one keeps it', () => {
  const { CL } = setup();
  const seasonings = [{ name: 'salt', quantity: '' }, { name: 'pepper', quantity: null }];
  const bare = CL.renderIngredients(seasonings, 1, {});
  assert.match(bare, /^<ul class="ingredient-list ingredient-list-unmeasured">/);
  assert.doesNotMatch(bare, /ing-qty/);
  assert.match(bare, /salt/);

  const mixed = CL.renderIngredients([{ name: 'flour', quantity: 500, units: 'g' }, ...seasonings], 1, {});
  assert.match(mixed, /^<ul class="ingredient-list">/);
  assert.equal(mixed.match(/class="ing-qty/g).length, 3, 'empty cells keep the names lined up');

  // A unit alone (`@salt{%pinch}`) is an amount.
  assert.match(CL.renderIngredients([{ name: 'salt', quantity: '', units: 'pinch' }], 1, {}), /^<ul class="ingredient-list">/);
});
