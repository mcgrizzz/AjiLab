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

  function cookLogSourceKey(recipe, selected) {
    if (selected?.is_draft && recipe.draft) return '__draft__';
    if (selected?.version_string && !selected._cookLogId
        && recipe.versions?.some(v => !v.is_draft && v.version_string === selected.version_string)) {
      return selected.version_string;
    }
    return recipe.current_best_release?.version_string
      || recipe.active_experiment?.version_string
      || recipe.versions?.find(v => !v.is_draft)?.version_string
      || '__draft__';
  }

  function cookLogTimestamp(local, existing) {
    // Preserve seconds and the exact instant during a repeated DST hour.
    if (existing && local === localDateTimeInput(existing)) return existing;
    return local ? new Date(local).toISOString() : undefined;
  }

  return { Session, open, localDateTimeInput, cookLogSourceKey, cookLogTimestamp,
    hasUnsaved: () => [...sessions.values()].some(session => session.dirty || session.pending) };
})();

window.addEventListener('beforeunload', event => {
  if (!RecipeEditState.hasUnsaved()) return;
  event.preventDefault();
  event.returnValue = '';
});
