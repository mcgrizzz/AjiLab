import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');

function setup() {
  const store = new Map();
  const context = vm.createContext({
    window: { localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } },
  });
  vm.runInContext(read('../public/js/units.js'), context);
  vm.runInContext(read('../public/js/cooklang-render.js'), context);
  return { Units: vm.runInContext('Units', context), CL: vm.runInContext('CL', context), store };
}

const asIs = { volume: 'asis', mass: 'asis', overrides: {} };
const us = { volume: 'us', mass: 'us', overrides: {} };
const metric = { volume: 'metric', mass: 'metric', overrides: {} };

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

test('as written leaves amounts alone at 1x and reformats sensibly when scaled', () => {
  const { Units } = setup();
  assert.equal(Units.present(1, 'L', 1, asIs, 'cream'), null);
  assert.equal(Units.present(250, 'g', 0.5, asIs).text, '125 g');
  assert.equal(Units.present(2, 'cups', 0.5, asIs).text, '1 cup');
  assert.equal(Units.present(1, 'cup', 1 / 3, asIs).text, '⅓ cup');
  assert.equal(Units.present(3, 'cloves', 2, asIs), null, 'unknown units fall back to the old renderer');
});

test('US and metric systems convert only units from the other system', () => {
  const { Units } = setup();
  assert.equal(Units.present(1, 'L', 1, us).text, '4¼ cups');
  assert.equal(Units.present(10, 'ml', 1, us).text, '2 tsp');
  assert.equal(Units.present(45, 'ml', 1, us).text, '3 tbsp');
  assert.equal(Units.present(2, 'cups', 1, metric).text, '473 ml');
  assert.equal(Units.present(6, 'cups', 1, metric).text, '1.42 L');
  assert.equal(Units.present(500, 'g', 1, us).text, '1.1 lb');
  assert.equal(Units.present(100, 'g', 1, us).text, '3.5 oz');
  assert.equal(Units.present(8, 'oz', 1, metric).text, '227 g');
  assert.equal(Units.present(2, 'tbsp', 1, metric), null, 'spoons are left alone in both systems');
  assert.equal(Units.present(2, 'cups', 1, us), null, 'already US');
  assert.equal(Units.present('200-300', 'ml', 1, us).text, '⅞-1¼ cups');
});

test('per-ingredient overrides beat the system choice for matching categories', () => {
  const { Units } = setup();
  const view = { volume: 'metric', mass: 'asis', overrides: { 'heavy cream': 'fl oz', flour: 'fl oz' } };
  assert.equal(Units.present(1, 'L', 0.473176, view, 'Heavy Cream').text, '16 fl oz');
  assert.equal(Units.present(500, 'g', 1, view, 'flour'), null, 'volume override ignored for a mass ingredient');
});

test('click-to-scale converts the typed unit into a recipe scale', () => {
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

test('preferences persist through localStorage and ignore junk', () => {
  const { Units, store } = setup();
  assert.deepEqual({ ...Units.loadPrefs() }, { volume: 'asis', mass: 'asis' });
  Units.savePrefs({ volume: 'us', mass: 'metric' });
  assert.deepEqual({ ...Units.loadPrefs() }, { volume: 'us', mass: 'metric' });
  store.set('ajilab.unitPrefs', '{"volume":"imperial"}');
  assert.equal(Units.loadPrefs().volume, 'asis');
});

test('renderer applies unit preferences to the ingredient list and step amounts', () => {
  const { CL } = setup();
  const ings = [
    { name: 'heavy cream', quantity: 1, units: 'L' },
    { name: 'garlic', quantity: 2, units: 'cloves' },
  ];
  const view = { volume: 'asis', mass: 'asis', overrides: { 'heavy cream': 'fl oz' } };
  const html = CL.renderIngredients(ings, 0.473176, { units: view });
  assert.match(html, />16 fl oz</);
  assert.match(html, /data-unit="L"/);
  assert.match(html, /data-shown-unit="fl oz"/);
  assert.match(html, /0\.47 L as written/);
  assert.match(html, />0\.95 cloves</);

  const plain = CL.renderIngredients(ings, 1, {});
  assert.match(plain, />1 L</, 'no unit options → unchanged output');

  const steps = [[{ type: 'text', value: 'Whisk ' }, { type: 'ingredient', name: 'heavy cream', quantity: 1, units: 'L' }]];
  assert.match(CL.renderSteps(steps, 1, {}, true, { units: us }), /\(4¼ cups\)/);
});
