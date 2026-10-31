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
  assert.equal(Units.present(1, 'L', 1, view, 'Heavy Cream').text, '33.8 fl oz');
  assert.equal(Units.present(1, 'L', 0.473176, view, 'heavy cream').text, '16 fl oz');
  assert.equal(Units.present(1, 'L', 1, view, 'milk'), null, 'other ingredients are untouched');
  assert.equal(Units.present(2, 'cups', 1, pick('milk', 'ml'), 'milk').text, '473 ml');
  assert.equal(Units.present(1, 'L', 1, pick('cream', 'cup'), 'cream').text, '4¼ cups');
  assert.equal(Units.present(500, 'g', 1, pick('flour', 'fl oz'), 'flour'), null, 'volume choice ignored for a mass ingredient');
  assert.equal(Units.present(500, 'g', 1, pick('flour', 'lb'), 'flour').text, '1.1 lb');
  assert.equal(Units.present('200-300', 'ml', 1, pick('stock', 'cup'), 'stock').text, '⅞-1¼ cups');
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
  assert.equal(byKey['fl oz'].text, '33.8 fl oz');
  assert.equal(byKey.ml.text, '1000 ml');

  const chosen = Units.alternatives(1, 'L', 1, pick('cream', 'fl oz'), 'cream');
  assert.equal(chosen.find(a => a.active).unitKey, 'fl oz');

  const small = Array.from(Units.alternatives(1, 'tsp', 1, none, 'vanilla'), a => a.unitKey);
  assert.ok(small.includes('ml') && small.includes('tsp'));
  assert.ok(!small.includes('l') && !small.includes('cup'), 'units that would read < ⅛ are hidden');

  assert.equal(Units.alternatives(2, 'cloves', 1, none, 'garlic').length, 0, 'no picker for unknown units');
  assert.deepEqual(Array.from(Units.alternatives(250, 'g', 1, none, 'flour'), a => a.unitKey), ['g', 'kg', 'oz', 'lb']);
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
  assert.match(Units.scaleForTarget(500, 'g', 'g', Units.parseAmount('2 cups')).error, /Can't convert/);
  assert.match(Units.scaleForTarget(500, 'g', 'g', Units.parseAmount('2 handfuls')).error, /Unknown unit/);
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
  assert.match(CL.renderSteps(steps, 1, {}, true, { units: pick('heavy cream', 'cup') }), /\(4¼ cups\)/);
  assert.match(CL.renderSteps(steps, 1, {}, true, { units: none }), /\(1 L\)/);
});
