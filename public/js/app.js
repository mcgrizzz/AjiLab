// ── Router ────────────────────────────────────────────────────────────────────
const Router = {
  routes: [
    { pattern: /^\/$/, view: 'index' },
    { pattern: /^\/recipe\/([^/]+)\/versions\/([^/]+)$/, view: 'recipe-version' },
    { pattern: /^\/recipe\/([^/]+)\/print$/, view: 'recipe-print' },
    { pattern: /^\/recipe\/([^/]+)$/, view: 'recipe' },
  ],

  async go(path, replace = false) {
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    await this.dispatch(path);
  },

  async dispatch(path) {
    const url = new URL(path, location.origin);
    const pathname = url.pathname;
    const container = document.getElementById('view-container');
    const backBtn = document.getElementById('nav-back');
    const addBtn = document.getElementById('nav-add');
    document.body.classList.remove('print-route');

    for (const route of this.routes) {
      const m = pathname.match(route.pattern);
      if (m) {
        if (route.view === 'index') {
          backBtn.classList.add('hidden');
          addBtn.classList.remove('hidden');
          await IndexView.render(container);
          return;
        }
        if (route.view === 'recipe') {
          backBtn.classList.remove('hidden');
          addBtn.classList.remove('hidden');
          await RecipeView.render(container, m[1], {
            branch: url.searchParams.get('branch') || 'main',
            tab: url.searchParams.get('tab') || 'overview',
          });
          return;
        }
        if (route.view === 'recipe-version') {
          backBtn.classList.remove('hidden');
          addBtn.classList.remove('hidden');
          await RecipeView.render(container, m[1], {
            version: m[2],
            branch: url.searchParams.get('branch') || 'main',
            tab: url.searchParams.get('tab') || 'overview',
          });
          return;
        }
        if (route.view === 'recipe-print') {
          backBtn.classList.remove('hidden');
          addBtn.classList.add('hidden');
          document.body.classList.add('print-route');
          await PrintView.render(container, m[1], {
            version: url.searchParams.get('version') || 'draft',
            branch: url.searchParams.get('branch') || 'main',
          });
          return;
        }
      }
    }
    // 404
    container.innerHTML = `<div class="empty-state"><h2>Not found</h2><button class="btn mt12" onclick="Router.go('/')">Go home</button></div>`;
  },

  init() {
    window.addEventListener('popstate', () => this.dispatch(location.pathname + location.search));
    this.dispatch(location.pathname + location.search);
  },
};

// ── Modal ─────────────────────────────────────────────────────────────────────
function showModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) closeModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

document.addEventListener('keydown', e => {
  if (e.key !== 'p' && e.key !== 'P') return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.shiftKey || e.altKey) return;
  const onRecipePage = /^\/recipe\/[^/]+(?:\/versions\/[^/]+)?\/?$/.test(location.pathname);
  if (!onRecipePage) return;
  if (typeof RecipeView === 'undefined' || typeof RecipeView.openPrintView !== 'function') return;
  e.preventDefault();
  RecipeView.openPrintView();
});

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

// ── New Recipe ────────────────────────────────────────────────────────────────
document.getElementById('nav-add').addEventListener('click', () => {
  showModal(`
    <div class="modal-title">New recipe</div>
    <div class="field-group mt8">
      <label class="field-label">Recipe name</label>
      <input id="new-recipe-title" class="field-input" placeholder="e.g. Sourdough Bagels" autofocus />
    </div>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="createRecipe()">Create</button>
    </div>`);
  setTimeout(() => {
    const input = document.getElementById('new-recipe-title');
    if (input) {
      input.focus();
      input.addEventListener('keydown', e => { if (e.key === 'Enter') createRecipe(); });
    }
  }, 80);
});

async function createRecipe() {
  const title = document.getElementById('new-recipe-title')?.value.trim();
  if (!title) return;
  try {
    const r = await API.post('/recipes', { title });
    closeModal();
    await Router.go(`/recipe/${r.slug}?tab=experiment`);
  } catch (e) {
    showToast('Error: ' + e.message);
  }
}

// ── Back button ───────────────────────────────────────────────────────────────
document.getElementById('nav-back').addEventListener('click', () => {
  if (location.pathname === '/') return;
  history.back();
});

// ── Brand link ────────────────────────────────────────────────────────────────
document.getElementById('nav-brand').addEventListener('click', e => {
  e.preventDefault();
  Router.go('/');
});

// ── Boot ─────────────────────────────────────────────────────────────────────
Router.init();
