import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/js/recipe-edit-state.js', import.meta.url), 'utf8');
function setup() {
  const listeners = {};
  const context = vm.createContext({ setTimeout, clearTimeout, window: {
    addEventListener: (name, fn) => { listeners[name] = fn; },
  } });
  vm.runInContext(source, context);
  return { state: vm.runInContext('RecipeEditState', context), listeners };
}
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
const initial = { text: '@water{100%g}', tags: ['bread'] };

test('a cook follows the selected test or version; the working copy falls back to the current version', () => {
  const { state } = setup();
  const recipe = { draft: {}, versions: [{ version_string: 'v1.0' }, { version_string: 'test-1' }],
    current_version: { version_string: 'v1.0' }, open_tests: [{ version_string: 'test-1' }] };
  assert.equal(state.cookLogSourceKey(recipe, { version_string: 'test-1' }), 'test-1');
  assert.equal(state.cookLogSourceKey(recipe, { version_string: 'v1.0' }), 'v1.0');
  assert.equal(state.cookLogSourceKey(recipe, { is_draft: true }), 'v1.0');
  assert.equal(state.cookLogSourceKey(recipe, { version_string: 'missing' }), 'v1.0');
  // No version yet: the newest open test.
  const testsOnly = { draft: {}, versions: [{ version_string: 'test-1' }], current_version: null, open_tests: [{ version_string: 'test-1' }] };
  assert.equal(state.cookLogSourceKey(testsOnly, { is_draft: true }), 'test-1');
  assert.equal(state.cookLogSourceKey({ draft: {}, versions: [], open_tests: [] }, { is_draft: true }), null);
});

test('a new cook starts from the paper in hand: the newest print with no cook saved since', () => {
  const { state } = setup();
  const now = Date.parse('2026-11-10T12:00:00Z');
  const at = (hoursAgo) => new Date(now - hoursAgo * 36e5).toISOString();
  const recipe = {
    draft: {},
    current_version: { version_string: 'v1.0' },
    open_tests: [{ version_string: 'test-4' }],
    versions: [
      { version_string: 'v1.0', last_recorded_at: at(1) },   // cooked after its print
      { version_string: 'v1.1', last_recorded_at: at(6) },   // cooked today, printed again since
      { version_string: 'test-4', last_recorded_at: at(200) },
      { version_string: 'test-3', last_recorded_at: null },
    ],
    recent_prints: [
      { version_string: 'v1.0', scale: 1, printed_at: at(2) },
      { version_string: 'v1.1', scale: 2, printed_at: at(3) },
      { version_string: 'test-4', scale: 2, printed_at: at(30) },
      { version_string: 'test-3', scale: 1, printed_at: at(24 * 20) }, // too old
    ],
  };
  const current = { version_string: 'v1.0' };
  // The helper runs in its own context: compare plain values.
  const start = (...args) => JSON.parse(JSON.stringify(state.cookStart(...args)));
  assert.deepEqual(start(recipe, current, { now }), { version_string: 'v1.1', scale: 2, print: recipe.recent_prints[1] });
  // Picked on purpose: that sheet, at its last print's scale or the screen's.
  assert.deepEqual(start(recipe, current, { now, explicit: true }), { version_string: 'v1.0', scale: 1, print: recipe.recent_prints[0] });
  assert.equal(state.cookStart(recipe, { version_string: 'test-4' }, { now, explicit: true }).scale, 2);
  assert.equal(state.cookStart(recipe, { version_string: 'test-4' }, { now, explicit: true, scale: 3 }).scale, 3);
  // v1.1 recorded too: the next unrecorded print is Test 4's.
  recipe.versions[1].last_recorded_at = at(0);
  assert.equal(state.cookStart(recipe, current, { now }).version_string, 'test-4');
  // Everything recorded (or too old): the sheet on screen.
  recipe.versions[2].last_recorded_at = at(0);
  assert.deepEqual(start(recipe, current, { now }), { version_string: 'v1.0', scale: 1, print: recipe.recent_prints[0] });
  assert.deepEqual(start({ ...recipe, recent_prints: undefined }, { is_draft: true }, { now }), { version_string: 'v1.0', scale: 1, print: null });
});

test('failed saves survive navigation and a new page session, then retry clears recovery', async () => {
  const { state, listeners } = setup();
  const local = storage();
  const session = state.open({ key: 'bagels/main/beta', initial, storage: local,
    write: async () => { throw new Error('offline'); } });
  session.update('@water{120%g}', ['bread', 'test']);
  assert.equal((await session.save()).ok, false);
  assert.match(session.status, /Could not save/);
  session.detach();
  assert.equal(state.open({ key: 'bagels/main/beta', initial, storage: local }), session);
  const event = { preventDefault() { this.prevented = true; } };
  listeners.beforeunload(event);
  assert.equal(event.prevented, true);

  const reloaded = setup().state.open({ key: 'bagels/main/beta', initial, storage: local,
    write: async () => ({ ok: true }) });
  assert.equal(reloaded.recovered, true);
  assert.equal(reloaded.value.text, '@water{120%g}');
  assert.equal(reloaded.value.tags.join(','), 'bread,test');
  assert.equal((await reloaded.save()).ok, true);
  assert.equal(local.getItem(reloaded.key), null);
  assert.equal(reloaded.dirty, false);
});

test('in-flight saves serialize and do not erase newer text or recovery data', async () => {
  const { state } = setup();
  const local = storage();
  const sent = [];
  let finish;
  const session = state.open({ key: 'A', initial, storage: local, write: value => {
    sent.push(value.text);
    return new Promise(resolve => { finish = resolve; });
  } });
  session.update('first edit', []);
  const first = session.save();
  await Promise.resolve();
  session.update('second edit', []);
  const second = session.save();
  assert.equal(sent.length, 1);
  finish({});
  await first;
  assert.equal(session.dirty, true);
  assert.equal(JSON.parse(local.getItem(session.key)).text, 'second edit');
  await Promise.resolve();
  assert.deepEqual(sent, ['first edit', 'second edit']);
  finish({});
  await second;
  assert.equal(session.dirty, false);
  assert.equal(session.value.text, 'second edit');
});

test('detaching cancels pending autosave and saves remain bound to their original targets', async () => {
  const { state } = setup();
  const writes = [];
  const a = state.open({ key: 'recipe-A/main/draft', initial, storage: storage(), autosave: true,
    write: async value => { writes.push(['A', value.text]); } });
  const b = state.open({ key: 'recipe-B/test/draft', initial, storage: storage(),
    write: async value => { writes.push(['B', value.text]); } });
  a.update('A edit', []);
  assert.ok(a.timer);
  a.detach();
  assert.equal(a.timer, null);
  b.update('B edit', []);
  await a.save();
  assert.deepEqual(writes, [['A', 'A edit']]);
  assert.equal(b.dirty, true);
});

test('release edits remain recoverable without autosave; storage failures are visible', async () => {
  const { state } = setup();
  let writes = 0;
  const session = state.open({ key: 'release', initial, storage: {
    getItem() { return null; }, setItem() { throw Error('quota'); }, removeItem() {},
  }, autosave: false, write: async () => { writes++; } });
  session.update('typo fix', []);
  assert.equal(session.timer, null);
  assert.equal(session.storageFailed, true);
  assert.equal(writes, 0);
  await session.save();
  assert.equal(writes, 1);
  assert.equal(session.dirty, false);
});

test('synchronous write failures can be retried', async () => {
  const { state } = setup();
  let fail = true;
  const session = state.open({ key: 'sync', initial, storage: storage(), write: () => {
    if (fail) throw Error('failed');
    return {};
  } });
  session.update('edit', []);
  assert.equal((await session.save()).ok, false);
  assert.equal(session.pending, null);
  fail = false;
  assert.equal((await session.save()).ok, true);
});

test('line change summary counts removed and added lines', () => {
  const { state } = setup();
  assert.deepEqual({ ...state.lineChangeSummary('a\nb\nc', 'a\nb\nd\ne') }, { removed: 1, added: 2 });
  assert.deepEqual({ ...state.lineChangeSummary('same\n\nsame', 'same\nsame') }, { removed: 0, added: 0 });
});
