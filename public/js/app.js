// ── Router ────────────────────────────────────────────────────────────────────
const Router = {
  routes: [
    { pattern: /^\/$/, view: 'index' },
    { pattern: /^\/recipe\/([^/]+)\/versions\/([^/]+)$/, view: 'recipe-version' },
    { pattern: /^\/recipe\/([^/]+)\/tests\/(\d+)$/, view: 'recipe-test' },
    { pattern: /^\/recipe\/([^/]+)\/print$/, view: 'recipe-print' },
    { pattern: /^\/recipe\/([^/]+)$/, view: 'recipe' },
  ],

  async go(path, replace = false) {
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    await this.dispatch(path);
  },

  async dispatch(path) {
    RecipeView.destroyDraftEditor();
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
            scale: url.searchParams.get('scale'),
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
            scale: url.searchParams.get('scale'),
          });
          return;
        }
        if (route.view === 'recipe-test') {
          backBtn.classList.remove('hidden');
          addBtn.classList.remove('hidden');
          await RecipeView.render(container, m[1], {
            testNumber: Number(m[2]),
            branch: url.searchParams.get('branch') || 'main',
            tab: url.searchParams.get('tab') || 'overview',
            scale: url.searchParams.get('scale'),
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
            scale: url.searchParams.get('scale'),
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
// Once the user types into a modal, a stray backdrop click or Esc no longer
// closes it — only the modal's own Cancel/Close buttons do.
let modalDirty = false;
let pendingConfirm = null;

function showModal(html) {
  settleConfirm(false);
  modalDirty = false;
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function closeModal() {
  settleConfirm(false);
  modalDirty = false;
  document.getElementById('modal-overlay').classList.add('hidden');
}

function isModalOpen() {
  return !document.getElementById('modal-overlay').classList.contains('hidden');
}

// Backdrop click / Esc: close unless that would throw away typed input.
function requestCloseModal() {
  if (!isModalOpen()) return;
  if (modalDirty) {
    showToast('You have unsaved input. Use Cancel to discard it.');
    return;
  }
  closeModal();
}

document.getElementById('modal-content').addEventListener('input', () => { modalDirty = true; });

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) requestCloseModal();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !e.defaultPrevented) requestCloseModal();
});

function settleConfirm(value) {
  const resolve = pendingConfirm;
  pendingConfirm = null;
  if (resolve) resolve(value);
}

// Promise-based replacement for window.confirm(). bodyHtml must be escaped by
// the caller. Resolves true on confirm, false on cancel/close. Danger dialogs
// start focused on Cancel so Enter never triggers the destructive choice.
function confirmModal({ title, bodyHtml = '', confirmLabel = 'Confirm', danger = false }) {
  showModal(`
    <div class="modal-title">${escHtml(title)}</div>
    <div class="confirm-modal-body">${bodyHtml}</div>
    <div class="modal-actions">
      <button id="confirm-modal-cancel" class="btn ${danger ? '' : 'btn-ghost'}" onclick="closeModal()">Cancel</button>
      <button id="confirm-modal-ok" class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}">${escHtml(confirmLabel)}</button>
    </div>`);
  return new Promise((resolve) => {
    pendingConfirm = resolve;
    const ok = document.getElementById('confirm-modal-ok');
    ok.addEventListener('click', () => {
      settleConfirm(true);
      document.getElementById('modal-overlay').classList.add('hidden');
    });
    // Focus right away so a fast Enter can't hit the button that opened us.
    (danger ? document.getElementById('confirm-modal-cancel') : ok).focus();
  });
}

document.addEventListener('keydown', e => {
  if (e.key !== 'p' && e.key !== 'P') return;
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.shiftKey || e.altKey) return;
  const onRecipePage = /^\/recipe\/[^/]+(?:\/(?:versions|tests)\/[^/]+)?\/?$/.test(location.pathname);
  if (!onRecipePage) return;
  if (typeof RecipeView === 'undefined' || typeof RecipeView.openPrintView !== 'function') return;
  e.preventDefault();
  RecipeView.openPrintView();
});

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
// options.action = { label, onClick } adds a button (e.g. Undo) and keeps the
// toast up longer so there's time to use it.
function showToast(msg, options = {}) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('toast-has-action', !!options.action);
  if (options.action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = options.action.label;
    button.addEventListener('click', () => {
      clearTimeout(toastTimer);
      el.classList.add('hidden');
      options.action.onClick();
    });
    el.append(' ', button);
  }
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), options.duration || (options.action ? 10000 : 2600));
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
    await Router.go(`/recipe/${r.slug}?tab=editor`);
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
