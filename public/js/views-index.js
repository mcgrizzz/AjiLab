// ── View: Recipe Index ────────────────────────────────────────────────────────
const IndexView = {
  async render(container) {
    container.innerHTML = `
      <div class="search-bar">
        <div class="search-wrap">
          <svg class="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="6.5" cy="6.5" r="4.5" stroke="currentColor" stroke-width="1.3"/>
            <path d="M10 10L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          <input type="search" id="search-input" placeholder="Search recipes…" autocomplete="off" />
        </div>
      </div>
      <div id="recipe-list" class="recipe-list"></div>`;

    let debounce;
    document.getElementById('search-input').addEventListener('input', e => {
      clearTimeout(debounce);
      debounce = setTimeout(() => this.loadList(e.target.value.trim()), 280);
    });

    await this.loadList('');
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
    list.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const recipes = await API.get(`/recipes${q ? '?q=' + encodeURIComponent(q) : ''}`);
      if (recipes.length === 0) {
        list.innerHTML = q
          ? `<div class="empty-state"><h2>No results</h2><p>Try a different search.</p></div>`
          : `<div class="empty-state">
              <h2>No recipes yet</h2>
              <p>Tap + to add your first recipe, or import from a backup.</p>
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
        const badges = [];
        if (r.latest_released) badges.push(`<span class="badge badge-released">${escHtml(r.latest_released)}</span>`);
        if (r.latest_beta) badges.push(`<span class="badge badge-beta">${escHtml(r.latest_beta)} beta</span>`);
        if (!r.latest_released && !r.latest_beta) badges.push(`<span class="badge badge-draft">Draft</span>`);
        if (r.draft_change_label) badges.push(`<span class="badge badge-unsaved">${escHtml(r.draft_change_label)}</span>`);
        const thumb = r.thumbnail_image_id
          ? `<img src="/api/images/${r.thumbnail_image_id}" alt="${escHtml(r.title)}" loading="lazy" />`
          : '🍽';
        return `<div class="recipe-card" onclick="Router.go('/recipe/${escHtml(r.slug)}')">
          <div class="recipe-thumb">${thumb}</div>
          <div class="recipe-info">
            <div class="recipe-title">${escHtml(r.title)}</div>
            <div class="recipe-meta">${badges.join('')}</div>
          </div>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style="color:var(--ink3);flex-shrink:0">
            <path d="M6 4L10 8L6 12" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
        </div>`;
      }).join('');
    } catch (e) {
      list.innerHTML = `<div class="empty-state"><p>Error: ${escHtml(e.message)}</p></div>`;
    }
  },
};
