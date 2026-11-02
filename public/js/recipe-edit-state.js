// Browser-local recovery and target-bound saves. No recipe data leaves this origin.
const RecipeEditState = (() => {
  const sessions = new Map();
  const same = (a, b) => a.text === b.text && JSON.stringify(a.tags) === JSON.stringify(b.tags);

  class Session {
    constructor({ key, initial, storage, write, autosave }) {
      this.key = `ajilab:unsaved:${key}`;
      this.storage = storage;
      this.write = write;
      this.autosave = autosave;
      this.value = { text: initial.text, tags: [...initial.tags] };
      this.saved = this.value;
      this.revision = 0;
      this.dirty = false;
      this.status = 'Saved';
      this.timer = null;
      this.pending = null;
      this.recovered = false;
      this.storageFailed = false;
      try {
        const stored = JSON.parse(storage?.getItem(this.key) || 'null');
        if (stored && typeof stored.text === 'string' && Array.isArray(stored.tags)
            && stored.tags.every(tag => typeof tag === 'string') && !same(stored, initial)) {
          this.value = { text: stored.text, tags: stored.tags };
          this.dirty = true;
          this.recovered = true;
          this.status = 'Recovered unsaved changes — review and save';
        } else if (stored) {
          storage?.removeItem(this.key);
        }
      } catch { this.storageFailed = true; }
    }

    notify() { this.onChange?.(this); }

    persist() {
      try {
        if (!this.storage) throw new Error('Storage unavailable');
        if (this.dirty) this.storage.setItem(this.key, JSON.stringify(this.value));
        else this.storage.removeItem(this.key);
        this.storageFailed = false;
      } catch { this.storageFailed = true; }
    }

    update(text, tags) {
      const next = { text, tags: [...tags] };
      if (same(this.value, next)) return;
      this.value = next;
      this.revision += 1;
      // An in-flight request may still change the server even after a local undo.
      this.dirty = !!this.pending || !same(this.saved, next);
      this.status = this.dirty ? 'Unsaved changes' : 'Saved';
      this.persist();
      clearTimeout(this.timer);
      if (this.dirty && this.autosave && !this.recovered) {
        this.timer = setTimeout(() => this.requestSave?.(), 1500);
      }
      this.notify();
    }

    detach() {
      clearTimeout(this.timer);
      this.timer = null;
      this.onChange = null;
    }

    async save(options = {}) {
      clearTimeout(this.timer);
      if (this.pending) {
        const previous = await this.pending;
        if (!previous.ok) return previous;
        return this.dirty || options.advanceBeta ? this.save(options) : previous;
      }
      if (!this.dirty && !options.advanceBeta) return { ok: true, value: this.value };
      const value = { text: this.value.text, tags: [...this.value.tags] };
      const revision = this.revision;
      this.status = 'Saving…';
      this.notify();
      const task = Promise.resolve().then(async () => {
        try {
          const response = await this.write(value, options);
          this.saved = value;
          this.dirty = revision !== this.revision;
          this.recovered = false;
          this.status = this.dirty ? 'Unsaved changes' : 'Saved';
          this.persist();
          return { ok: true, response, value };
        } catch (error) {
          this.dirty = true;
          this.status = 'Could not save — retry';
          this.persist();
          return { ok: false, error };
        } finally {
          this.pending = null;
          this.notify();
        }
      });
      this.pending = task;
      return task;
    }
  }

  function open(options) {
    const previous = sessions.get(options.key);
    if (previous?.dirty || previous?.pending) return previous;
    const session = new Session(options);
    sessions.set(options.key, session);
    return session;
  }

  function localDateTimeInput(value = new Date()) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  // The sheet a new cook defaults to: the version or test on screen. The
  // working copy is never cooked, so it falls back to the current version
  // (or, with no version yet, the newest open test).
  function cookLogSourceKey(recipe, selected) {
    if (selected?.version_string && !selected._cookLogId
        && recipe.versions?.some(v => !v.is_draft && v.version_string === selected.version_string)) {
      return selected.version_string;
    }
    return recipe.current_version?.version_string
      || recipe.open_tests?.[0]?.version_string
      || recipe.versions?.find(v => !v.is_draft)?.version_string
      || null;
  }

  // Where a new cook starts: { version_string, scale, print }. Unless a
  // sheet was picked on purpose (explicit), the newest print from the last
  // two weeks that has no cook recorded since: that's the paper in your hand.
  // Otherwise the sheet on screen, at the scale on screen or, at 1×, at the
  // scale it was last printed.
  const PRINT_FRESH_MS = 14 * 24 * 60 * 60 * 1000;
  function localDay(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function cookStart(recipe, selected, { explicit = false, scale = 1, now = Date.now() } = {}) {
    const prints = (recipe.recent_prints || []).filter(p => now - Date.parse(p.printed_at) < PRINT_FRESH_MS);
    const sheetOf = (key) => recipe.versions?.find(v => v.version_string === key);
    const recorded = (p) => {
      const cooked = sheetOf(p.version_string)?.last_cooked_at;
      return !!cooked && localDay(cooked) >= localDay(p.printed_at);
    };
    if (!explicit) {
      const pending = prints.find(p => sheetOf(p.version_string) && !recorded(p));
      if (pending) return { version_string: pending.version_string, scale: pending.scale, print: pending };
    }
    const key = cookLogSourceKey(recipe, selected);
    const print = prints.find(p => p.version_string === key) || null;
    return { version_string: key, scale: scale !== 1 ? scale : (print?.scale || 1), print };
  }

  function cookLogTimestamp(local, existing) {
    // Preserve seconds and the exact instant during a repeated DST hour.
    if (existing && local === localDateTimeInput(existing)) return existing;
    return local ? new Date(local).toISOString() : undefined;
  }

  // ── Replacing a draft on purpose (fork / undo) ──
  // Must match the key views-recipe-editor uses for the draft buffer.
  function draftKey(slug, branch) {
    return JSON.stringify([slug, branch, 'draft', 'draft']);
  }

  // Wait for an in-flight save so it can't land after a replacement.
  async function settle(key) {
    const session = sessions.get(key);
    if (session?.pending) await session.pending;
  }

  // Local edits not on the server yet (in memory or recovered from storage).
  function unsavedValue(key, storage) {
    const session = sessions.get(key);
    if (session) return session.dirty ? session.value : null;
    try {
      const stored = JSON.parse(storage?.getItem(`ajilab:unsaved:${key}`) || 'null');
      if (stored && typeof stored.text === 'string' && Array.isArray(stored.tags)) return stored;
    } catch {}
    return null;
  }

  // Forget a buffer whose server copy was deliberately replaced, so the editor
  // doesn't resurrect (or autosave) the old text.
  function discard(key, storage) {
    const session = sessions.get(key);
    if (session) {
      session.detach();
      session.requestSave = null;
      session.dirty = false;
      sessions.delete(key);
    }
    try { storage?.removeItem(`ajilab:unsaved:${key}`); } catch {}
  }

  // Rough size of a replacement: lines only in `from` / only in `to`.
  function lineChangeSummary(from, to) {
    const count = (text) => {
      const counts = new Map();
      for (const line of String(text || '').split(/\r?\n/)) {
        if (line.trim()) counts.set(line, (counts.get(line) || 0) + 1);
      }
      return counts;
    };
    const a = count(from);
    const b = count(to);
    let removed = 0;
    let added = 0;
    for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) || 0));
    for (const [line, n] of b) added += Math.max(0, n - (a.get(line) || 0));
    return { removed, added };
  }

  // Unsent new-cook-log form fields, kept per tab until the log is created.
  const UNSENT_LOG_PREFIX = 'ajilab:unsent-cook-log:';
  function loadUnsentCookLog(storage, slug, branch) {
    try {
      const value = JSON.parse(storage?.getItem(UNSENT_LOG_PREFIX + JSON.stringify([slug, branch])) || 'null');
      return value && typeof value === 'object' ? value : null;
    } catch { return null; }
  }
  function saveUnsentCookLog(storage, slug, branch, fields) {
    try {
      const key = UNSENT_LOG_PREFIX + JSON.stringify([slug, branch]);
      const hasText = Object.entries(fields).some(([name, value]) => name !== 'source' && name !== 'cooked_at' && name !== 'scale' && String(value || '').trim());
      if (hasText) storage?.setItem(key, JSON.stringify(fields));
      else storage?.removeItem(key);
    } catch {}
  }
  function clearUnsentCookLog(storage, slug, branch) {
    try { storage?.removeItem(UNSENT_LOG_PREFIX + JSON.stringify([slug, branch])); } catch {}
  }

  return { Session, open, localDateTimeInput, cookLogSourceKey, cookStart, localDay, cookLogTimestamp,
    draftKey, settle, unsavedValue, discard, lineChangeSummary,
    loadUnsentCookLog, saveUnsentCookLog, clearUnsentCookLog,
    hasUnsaved: () => [...sessions.values()].some(session => session.dirty || session.pending) };
})();

window.addEventListener('beforeunload', event => {
  if (!RecipeEditState.hasUnsaved()) return;
  event.preventDefault();
  event.returnValue = '';
});
