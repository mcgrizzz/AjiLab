// ── Folders ───────────────────────────────────────────────────────────────────
// Folders group recipes on the home page (Thanksgiving, Baking). A recipe can
// be in several, or none; deleting a folder keeps its recipes. They belong to
// the recipe, not its text, so nothing here makes a version.
const Folders = {
  cache: null,

  // The folder glyph for a folder with no icon of its own.
  GLYPH: '<svg class="ri-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/></svg>',

  async list(force = false) {
    if (!this.cache || force) this.cache = await API.get('/folders');
    return this.cache;
  },

  invalidate() { this.cache = null; },

  iconHtml(folder) {
    return RecipeIcons.html(folder?.icon, this.GLYPH);
  },

  href(folder) {
    return `/?folder=${encodeURIComponent(folder.id)}`;
  },

  // New folder (no `folder`) or edit one: name, icon, delete. `onDone(saved)`
  // gets the saved folder, or null when it was deleted; `onBack` returns to
  // the dialog this was opened from.
  edit({ folder = null, onDone = () => closeModal(), onBack = null } = {}) {
    const state = { name: folder?.name || '', icon: folder?.icon || '' };
    const render = () => {
      showModal(`
        <div class="modal-title">${folder ? 'Edit folder' : 'New folder'}</div>
        <div class="folder-edit-row">
          <button type="button" class="folder-icon-btn" id="folder-icon" title="Choose an icon" aria-label="Choose an icon">${RecipeIcons.html(state.icon, this.GLYPH)}</button>
          <div class="field-group folder-edit-name">
            <label class="field-label" for="folder-name">Name</label>
            <input id="folder-name" class="field-input" placeholder="e.g. Thanksgiving" maxlength="60" autocomplete="off" value="${escHtml(state.name)}" />
          </div>
        </div>
        <p id="folder-error" class="folder-error" aria-live="polite"></p>
        ${folder ? `<button type="button" class="link-btn folder-delete" id="folder-delete">Delete this folder…</button>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" id="folder-cancel">${onBack ? 'Back' : 'Cancel'}</button>
          <button type="button" class="btn btn-primary" id="folder-save">${folder ? 'Save' : 'Create'}</button>
        </div>`);
      const name = document.getElementById('folder-name');
      name.addEventListener('input', () => { state.name = name.value; });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
      setTimeout(() => name.focus(), 60);
      document.getElementById('folder-icon').addEventListener('click', () => RecipeIcons.pick({
        title: `Icon for ${state.name.trim() || 'the folder'}`,
        current: state.icon,
        onPick: (icon) => { state.icon = icon; render(); },
        onBack: render,
      }));
      document.getElementById('folder-cancel').addEventListener('click', () => (onBack ? onBack() : closeModal()));
      document.getElementById('folder-save').addEventListener('click', save);
      document.getElementById('folder-delete')?.addEventListener('click', remove);
    };
    const save = async () => {
      const error = document.getElementById('folder-error');
      if (!state.name.trim()) { error.textContent = 'Give it a name.'; return; }
      try {
        const body = { name: state.name, icon: state.icon };
        const saved = folder ? await API.put(`/folders/${folder.id}`, body) : await API.post('/folders', body);
        this.invalidate();
        onDone(saved);
      } catch (e) {
        if (document.getElementById('folder-error')) document.getElementById('folder-error').textContent = e.message;
      }
    };
    const remove = async () => {
      const n = folder.recipe_count || 0;
      const ok = await confirmModal({
        title: `Delete “${folder.name}”?`,
        bodyHtml: `<p>${n ? `Its ${n} recipe${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''}, in All and any other folders.` : 'It has no recipes.'}</p>`,
        confirmLabel: 'Delete folder',
        danger: true,
      });
      if (!ok) { render(); return; }
      try {
        await API.delete(`/folders/${folder.id}`);
        this.invalidate();
        onDone(null);
      } catch (e) {
        showToast('Error: ' + e.message);
      }
    };
    render();
  },

  // Which recipes are in the folder: a checklist of every recipe.
  async chooseRecipes(folder, onDone = () => closeModal()) {
    const recipes = (await API.get('/recipes')).slice().sort((a, b) => a.title.localeCompare(b.title));
    const chosen = new Set(recipes.filter((r) => (r.folder_ids || []).includes(folder.id)).map((r) => r.slug));
    showModal(`
      <div class="modal-title">Recipes in ${escHtml(folder.name)}</div>
      ${recipes.length > 8 ? '<input id="folder-filter" class="field-input folder-filter" type="search" placeholder="Filter…" autocomplete="off" />' : ''}
      <ul class="folder-pick-list">
        ${recipes.map((r) => `<li data-title="${escHtml(r.title.toLowerCase())}">
          <label class="folder-pick">
            <input type="checkbox" value="${escHtml(r.slug)}" ${chosen.has(r.slug) ? 'checked' : ''} />
            <span class="folder-pick-icon">${r.thumbnail_image_id ? `<img src="/api/images/${r.thumbnail_image_id}" alt="" loading="lazy" />` : RecipeIcons.html(RecipeIcons.of(r), '🍽')}</span>
            <span class="folder-pick-title">${escHtml(r.title)}</span>
          </label>
        </li>`).join('')}
      </ul>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancel</button>
        <button type="button" class="btn btn-primary" id="folder-pick-save">Save</button>
      </div>`);
    document.getElementById('folder-filter')?.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      document.querySelectorAll('.folder-pick-list li').forEach((li) => { li.hidden = !!q && !li.dataset.title.includes(q); });
    });
    document.getElementById('folder-pick-save').addEventListener('click', async () => {
      const slugs = [...document.querySelectorAll('.folder-pick-list input:checked')].map((input) => input.value);
      try {
        const saved = await API.put(`/folders/${folder.id}/recipes`, { slugs });
        this.invalidate();
        onDone(saved);
      } catch (e) {
        showToast('Error: ' + e.message);
      }
    });
  },
};
