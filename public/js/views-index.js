// ── View: Recipe Index ────────────────────────────────────────────────────────
const IndexView = {
  // The folder being shown ('' is All), from `/?folder=<id>`.
  folderId: '',
  folders: [],
  listToken: 0,

  // Plain clicks navigate in-app; modified/middle clicks fall through to the
  // browser so Cmd/Ctrl-click opens a new tab.
  openRecipe(event, link) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return true;
    event.preventDefault();
    Router.go(link.getAttribute('href'));
    return false;
  },

  // "Edited today · last cooked May 24 · 4 cooks"
  activityLine(r) {
    const parts = [];
    const kind = r.last_activity_kind;
    if (kind === 'cooked') parts.push(`Last cooked ${shortDate(r.last_cooked_at)}`);
    else if (kind === 'version') parts.push(`${r.last_version} saved ${shortDate(r.last_version_at)}`);
    else if (kind === 'edited') parts.push(`Edited ${shortDate(r.last_edited_at)}`);
    else parts.push(`Created ${shortDate(r.created_at)}`);
    if (kind !== 'cooked') parts.push(r.last_cooked_at ? `last cooked ${shortDate(r.last_cooked_at)}` : 'not cooked yet');
    const logs = r.cook_logs_total || 0;
    if (logs) parts.push(`${logs} cook${logs === 1 ? '' : 's'}`);
    return parts.join(' · ');
  },

  // No match: start a recipe with the search text as its name.
  createFromSearch() {
    const q = document.getElementById('search-input')?.value.trim() || '';
    document.getElementById('nav-add')?.click();
    setTimeout(() => {
      const input = document.getElementById('new-recipe-title');
      if (input && q) { input.value = q; input.select(); }
    }, 20);
  },

  async render(container) {
    this.folderId = new URL(location.href).searchParams.get('folder') || '';
    container.innerHTML = `
      <div class="search-bar">
        <div class="search-wrap">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.3"/>
            <path d="M10 10L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          <input type="search" id="search-input" placeholder="Search recipes…" autocomplete="off" />
        </div>
        <nav id="folder-bar" class="folder-bar" aria-label="Folders"></nav>
      </div>
      <div id="folder-head" class="folder-head" hidden></div>
      <div id="recipe-list" class="recipe-list"></div>`;

    let debounce;
    document.getElementById('search-input').addEventListener('input', e => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.loadList(e.target.value.trim()), 280);
    });

    await this.renderFolders();
    await this.loadList('');
  },

  query() {
    return document.getElementById('search-input')?.value.trim() || '';
  },

  currentFolder() {
    return this.folders.find((f) => f.id === this.folderId) || null;
  },

  // The chips (All, each folder, New folder) and the open folder's header.
  async renderFolders() {
    try {
      this.folders = await Folders.list(true);
    } catch {
      this.folders = [];
    }
    if (this.folderId && !this.currentFolder()) {
      // A folder that's gone (deleted elsewhere, an old link): show All.
      this.folderId = '';
      history.replaceState({}, '', '/');
    }
    const bar = document.getElementById('folder-bar');
    if (bar) {
      const chip = (id, inner, label) => `<button type="button" class="folder-chip" aria-pressed="${this.folderId === id}" onclick="IndexView.openFolder('${escHtml(id)}')" aria-label="${escHtml(label)}">${inner}</button>`;
      bar.innerHTML = [
        chip('', '<span class="folder-chip-name">All</span>', 'All recipes'),
        ...this.folders.map((f) => chip(f.id,
          `<span class="folder-chip-icon">${Folders.iconHtml(f)}</span><span class="folder-chip-name">${escHtml(f.name)}</span><span class="folder-chip-count">${f.recipe_count}</span>`,
          `${f.name}, ${f.recipe_count} recipe${f.recipe_count === 1 ? '' : 's'}`)),
        '<button type="button" class="folder-chip folder-chip-new" onclick="IndexView.newFolder()">+ New folder</button>',
      ].join('');
    }
    const head = document.getElementById('folder-head');
    const folder = this.currentFolder();
    if (head) {
      head.hidden = !folder;
      head.innerHTML = folder ? `
        <span class="folder-head-icon">${Folders.iconHtml(folder)}</span>
        <h2 class="folder-head-name">${escHtml(folder.name)}</h2>
        <div class="folder-head-actions">
          <button type="button" class="btn btn-sm" onclick="IndexView.chooseRecipes()">Choose recipes</button>
          <button type="button" class="btn btn-sm btn-ghost" onclick="IndexView.editFolder()">Edit folder</button>
        </div>` : '';
    }
  },

  async openFolder(id) {
    this.folderId = id || '';
    history.replaceState({}, '', this.folderId ? `/?folder=${encodeURIComponent(this.folderId)}` : '/');
    await this.renderFolders();
    await this.loadList(this.query());
  },

  newFolder() {
    Folders.edit({
      onDone: async (folder) => {
        closeModal();
        await this.openFolder(folder.id);
      },
    });
  },

  editFolder() {
    const folder = this.currentFolder();
    if (!folder) return;
    Folders.edit({
      folder,
      onDone: async (saved) => {
        closeModal();
        if (!saved) showToast(`Deleted “${folder.name}”. Its recipes are still in All.`);
        await this.openFolder(saved ? saved.id : '');
      },
    });
  },

  async chooseRecipes() {
    const folder = this.currentFolder();
    if (!folder) return;
    try {
      await Folders.chooseRecipes(folder, async () => {
        closeModal();
        await this.openFolder(folder.id);
      });
    } catch (e) {
      showToast('Error: ' + e.message);
    }
  },

  async handleBackupFile(input) {
    const file = input.files?.[0];
    console.log('[import] file:', file?.name, file?.size);
    if (!file) return;

    const setStatus = (msg, isError = false) => {
      const el = document.getElementById('backup-status');
      console.log('[import]', isError ? 'error:' : 'status:', msg, '| el found:', !!el);
      if (el) { el.style.color = isError ? 'var(--red,#c0392b)' : ''; el.textContent = msg; }
      else if (isError) alert('Import error: ' + msg);
    };

    setStatus('Importing… this may take a moment.');

    try {
      console.log('[import] building FormData');
      const form = new FormData();
      form.append('backup', file);

      console.log('[import] sending to /api/system/restore');
      const res = await fetch('/api/system/restore', { method: 'POST', body: form });
      console.log('[import] response:', res.status);

      const json = await res.json();
      console.log('[import] body:', json);

      if (!res.ok) throw new Error(json.error || `Server returned ${res.status}`);

      setStatus('Import complete — loading your recipes…');
      await this.loadList('');
    } catch (e) {
      console.error('[import] failed:', e);
      setStatus(e.message, true);
    }
  },

  async loadList(q) {
    const list = document.getElementById('recipe-list');
    if (!list) return;
    // Only the newest request paints: typing and switching folders overlap.
    const token = ++this.listToken;
    list.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (this.folderId) params.set('folder', this.folderId);
      const recipes = await API.get(`/recipes${params.size ? `?${params}` : ''}`);
      if (token !== this.listToken) return;
      const folder = this.currentFolder();
      if (recipes.length === 0 && folder) {
        list.innerHTML = q
          ? `<div class="empty-state"><h2>Nothing in ${escHtml(folder.name)} matches “${escHtml(q)}”</h2>
              <button class="btn mt12" onclick="IndexView.openFolder('')">Search all recipes</button></div>`
          : `<div class="empty-state"><h2>Nothing in ${escHtml(folder.name)} yet</h2>
              <p>Choose recipes to put in it. A recipe's menu (⚙) has its folders too.</p>
              <button class="btn btn-primary mt12" onclick="IndexView.chooseRecipes()">Choose recipes</button></div>`;
        return;
      }
      if (recipes.length === 0) {
        list.innerHTML = q
          ? `<div class="empty-state"><h2>No recipes match “${escHtml(q)}”</h2><p>Try a different search, or start it as a new recipe.</p>
              <button class="btn btn-primary mt12" onclick="IndexView.createFromSearch()">Create “${escHtml(q)}”</button></div>`
          : `<div class="empty-state">
              <h2>No recipes yet</h2>
              <p>Use “New recipe” to add your first one, or import from a backup.</p>
              <label for="backup-file-input" class="btn btn-sm mt12" style="cursor:pointer;display:inline-block">
                Import from backup
              </label>
              <input type="file" id="backup-file-input" accept=".dump"
                style="opacity:0;position:absolute;width:1px;height:1px;overflow:hidden"
                onchange="IndexView.handleBackupFile(this)" />
              <p id="backup-status" style="margin-top:12px;font-size:0.85rem;color:var(--ink3)"></p>
            </div>`;
        return;
      }
      list.innerHTML = recipes.map(r => {
        // "v1.1" + "Testing: more water" (or "2 open tests"); no version yet
        // says so.
        const badges = [];
        const current = r.current_version?.label || r.latest_released;
        badges.push(current
          ? `<span class="badge badge-released">${escHtml(current)}</span>`
          : '<span class="badge badge-draft">No version yet</span>');
        const tests = r.open_tests || [];
        if (tests.length === 1) {
          const t = tests[0];
          badges.push(`<span class="badge badge-beta">${escHtml(t.testing ? `Testing: ${t.testing}` : `${t.label} open`)}</span>`);
        } else if (tests.length > 1) {
          badges.push(`<span class="badge badge-beta">${tests.length} open tests</span>`);
        }
        if (r.draft_change_label) badges.push(`<span class="badge badge-in-progress">${escHtml(r.draft_change_label)}</span>`);
        const thumb = r.thumbnail_image_id
          ? `<img src="/api/images/${r.thumbnail_image_id}" alt="${escHtml(r.title)}" loading="lazy" />`
          : RecipeIcons.html(r.icon, '🍽');
        const href = `/recipe/${encodeURIComponent(r.slug)}`;
        return `<a class="recipe-card" href="${escHtml(href)}" onclick="return IndexView.openRecipe(event, this)">
          <div class="recipe-thumb">${thumb}</div>
          <div class="recipe-info">
            <div class="recipe-title">${escHtml(r.title)}</div>
            <div class="recipe-meta">${badges.join('')}</div>
            <div class="recipe-activity">${escHtml(IndexView.activityLine(r))}</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="color:var(--ink3);flex-shrink:0">
            <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
        </a>`;
      }).join('');
    } catch (e) {
      if (token !== this.listToken) return;
      list.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
    }
  },
};
