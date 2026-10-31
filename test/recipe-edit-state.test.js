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

test('cook logs follow selected beta, release, and draft; inherited selections fall back', () => {
  const { state } = setup();
  const recipe = { draft: {}, versions: [{ version_string: 'v1.0' }, { version_string: 'v1.1-beta.1' }],
    current_best_release: { version_string: 'v1.0' } };
  assert.equal(state.cookLogSourceKey(recipe, { version_string: 'v1.1-beta.1' }), 'v1.1-beta.1');
  assert.equal(state.cookLogSourceKey(recipe, { version_string: 'v1.0' }), 'v1.0');
  assert.equal(state.cookLogSourceKey(recipe, { is_draft: true }), '__draft__');
  assert.equal(state.cookLogSourceKey(recipe, { version_string: 'missing' }), 'v1.0');
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

test('datetime input uses local wall-clock time across zones and DST seasons', () => {
  const previous = process.env.TZ;
  try {
    for (const [zone, iso, expected] of [
      ['America/New_York', '2026-09-08T20:46:00Z', '2026-09-08T16:46'],
      ['America/New_York', '2026-01-08T20:46:00Z', '2026-01-08T15:46'],
      ['America/New_York', '2026-03-08T07:30:00Z', '2026-03-08T03:30'],
      ['Asia/Kolkata', '2026-09-08T20:46:00Z', '2026-09-09T02:16'],
      ['UTC', '2026-09-08T20:46:00Z', '2026-09-08T20:46'],
    ]) {
      process.env.TZ = zone;
      const result = setup().state.localDateTimeInput(iso);
      assert.equal(result, expected);
      assert.equal(new Date(result).toISOString(), new Date(iso).toISOString());
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('editing log notes preserves seconds and the later occurrence of a repeated DST time', () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    const { state } = setup();
    const existing = '2026-11-01T06:30:42.000Z';
    const local = state.localDateTimeInput(existing);
    assert.equal(local, '2026-11-01T01:30');
    assert.equal(state.cookLogTimestamp(local, existing), existing);
    assert.equal(state.cookLogTimestamp('2026-11-01T03:15', existing), '2026-11-01T08:15:00.000Z');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('draft replacement: unsaved buffers are visible, settled and discarded', async () => {
  const { state } = setup();
  const store = storage();
  const key = state.draftKey('bread', 'main');
  assert.equal(key, JSON.stringify(['bread', 'main', 'draft', 'draft']), 'must match the editor draft buffer key');
  assert.equal(state.unsavedValue(key, store), null);

  // Recovered from storage with no live session (e.g. after a reload).
  store.setItem(`ajilab:unsaved:${key}`, JSON.stringify({ text: 'local only', tags: [] }));
  assert.equal(state.unsavedValue(key, store).text, 'local only');

  let release;
  const session = state.open({ key, initial, storage: store, autosave: true,
    write: () => new Promise(resolve => { release = resolve; }) });
  session.update('typed', ['bread']);
  assert.equal(state.unsavedValue(key, store).text, 'typed');
  const saving = session.save();
  let settled = false;
  const waiting = state.settle(key).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'settle waits for the in-flight save');
  release({ ok: true });
  await saving;
  await waiting;
  assert.equal(settled, true);

  session.update('more typing', ['bread']);
  state.discard(key, store);
  assert.equal(state.unsavedValue(key, store), null);
  assert.equal(store.getItem(`ajilab:unsaved:${key}`), null);
  assert.equal(state.hasUnsaved(), false);
  const fresh = state.open({ key, initial, storage: store, autosave: true, write: async () => ({}) });
  assert.notEqual(fresh, session, 'a discarded buffer is not reused by the editor');
  assert.equal(fresh.value.text, initial.text);
});

test('line change summary counts lines unique to each side', () => {
  const { state } = setup();
  assert.deepEqual({ ...state.lineChangeSummary('a\nb\nc', 'a\nb\nd\ne') }, { removed: 1, added: 2 });
  assert.deepEqual({ ...state.lineChangeSummary('same\n\nsame', 'same\nsame') }, { removed: 0, added: 0 });
});

test('unsent cook log fields persist until cleared, and blank forms are not kept', () => {
  const { state } = setup();
  const store = storage();
  state.saveUnsentCookLog(store, 'bread', 'main', { source: 'v1.0', cooked_at: '2026-10-31T10:00', outcome: '' });
  assert.equal(state.loadUnsentCookLog(store, 'bread', 'main'), null, 'source/time alone are not worth restoring');
  state.saveUnsentCookLog(store, 'bread', 'main', { source: 'v1.0', outcome: 'Great crumb' });
  assert.equal(state.loadUnsentCookLog(store, 'bread', 'main').outcome, 'Great crumb');
  assert.equal(state.loadUnsentCookLog(store, 'bread', 'rye'), null, 'scoped per branch');
  state.clearUnsentCookLog(store, 'bread', 'main');
  assert.equal(state.loadUnsentCookLog(store, 'bread', 'main'), null);
});
