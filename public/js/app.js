// ── Router ────────────────────────────────────────────────────────────────────
const Router = {
  routes: [
    { pattern: /^\/$/, view: 'index' },
    { pattern: /^\/recipe\/([^/]+)\/versions\/([^/]+)$/, view: 'recipe-version' },
    { pattern: /^\/recipe\/([^/]+)\/tests\/([^/]+)$/, view: 'recipe-test' },
    { pattern: /^\/recipe\/([^/]+)\/print$/, view: 'recipe-print' },
    { pattern: /^\/recipe\/([^/]+)\/cooks\/([^/]+)$/, view: 'recipe-cook' },
    { pattern: /^\/recipe\/([^/]+)$/, view: 'recipe' },
  ],

  async go(path, replace = false) {
    if (replace) history.replaceState({}, '', path);
    else history.pushState({}, '', path);
    await this.dispatch(path);
  },

  async dispatch(path) {
    RecipeView.destroyDraftEditor();
    CookView.leave();
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
            testKey: decodeURIComponent(m[2]),
            branch: url.searchParams.get('branch') || 'main',
            tab: url.searchParams.get('tab') || 'overview',
            scale: url.searchParams.get('scale'),
          });
          return;
        }
        if (route.view === 'recipe-cook') {
          backBtn.classList.remove('hidden');
          addBtn.classList.add('hidden');
          await CookView.render(container, m[1], {
            id: m[2] === 'new' ? null : m[2],
            branch: url.searchParams.get('branch') || 'main',
            sheet: url.searchParams.get('sheet'),
            scale: url.searchParams.get('scale'),
            pick: url.searchParams.get('pick') === '1',
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
document.getElementById('nav-add').addEventListener('click', () => openNewRecipe());

function openNewRecipe() {
  showModal(`
    <div class="modal-title">New recipe</div>
    <div class="field-group mt8">
      <label class="field-label" for="new-recipe-title">Recipe name</label>
      <input id="new-recipe-title" class="field-input" placeholder="e.g. Sourdough Bagels" autofocus />
    </div>
    <button type="button" class="link-btn import-switch" onclick="openImportRecipe()">Import one from a link…</button>
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
}

// ── Import from a link ───────────────────────────────────────────────────────
// No AI here: copy a prompt (import-prompt.js) into a chat assistant, paste
// its reply back. The reply is parsed and summed up before anything is made.
let importCheckTimer;
let importChecked = null;

function openImportRecipe() {
  importChecked = null;
  showModal(`
    <div class="modal-title">Import a recipe</div>
    <p class="import-intro">Copy a prompt into a chat assistant (Claude, ChatGPT, …). It reads the page and replies with the recipe written the AjiLab way.</p>
    <ol class="import-steps">
      <li class="field-group">
        <label class="field-label" for="import-url">Link to the recipe</label>
        <div class="import-row">
          <input id="import-url" class="field-input" type="url" inputmode="url" placeholder="https://…" autocomplete="off" />
          <button type="button" class="btn" id="import-copy" onclick="copyImportPrompt()">Copy prompt</button>
        </div>
        <span class="import-hint">No link? Leave it empty and paste the recipe into the chat after the prompt.</span>
        <details class="import-prompt">
          <summary>See the prompt</summary>
          <textarea id="import-prompt-text" class="field-input" readonly aria-label="The prompt"></textarea>
        </details>
      </li>
      <li class="field-group">
        <label class="field-label" for="import-reply">Paste the reply</label>
        <textarea id="import-reply" class="field-input import-reply" placeholder="The assistant’s reply"></textarea>
        <p id="import-check" class="import-check" aria-live="polite"></p>
        <div id="import-title-group" class="field-group import-title" hidden>
          <label class="field-label" for="import-title">Recipe name</label>
          <input id="import-title" class="field-input" />
        </div>
      </li>
    </ol>
    <div class="modal-actions">
      <button class="btn btn-ghost" onclick="openNewRecipe()">Back</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="import-create" onclick="createImportedRecipe()" disabled>Create</button>
    </div>`);
  const url = document.getElementById('import-url');
  const refreshPrompt = () => {
    document.getElementById('import-prompt-text').value = ImportPrompt.build({ url: url.value });
  };
  refreshPrompt();
  url.addEventListener('input', refreshPrompt);
  document.getElementById('import-reply').addEventListener('input', () => {
    clearTimeout(importCheckTimer);
    importCheckTimer = setTimeout(checkImportReply, 250);
  });
  document.getElementById('import-title').addEventListener('input', updateImportCreate);
  setTimeout(() => url.focus(), 80);
}

async function copyImportPrompt() {
  const text = ImportPrompt.build({ url: document.getElementById('import-url')?.value });
  const button = document.getElementById('import-copy');
  try {
    await navigator.clipboard.writeText(text);
    if (button) button.textContent = 'Copied';
    setTimeout(() => { if (button?.isConnected) button.textContent = 'Copy prompt'; }, 2000);
  } catch {
    // No clipboard (an insecure page, or refused): show it to copy by hand.
    const details = document.querySelector('.import-prompt');
    const area = document.getElementById('import-prompt-text');
    if (details) details.open = true;
    area?.focus();
    area?.select();
    showToast("Couldn't copy. The prompt is selected: copy it yourself.");
  }
}

async function checkImportReply() {
  const reply = document.getElementById('import-reply');
  const check = document.getElementById('import-check');
  if (!reply || !check) return;
  const text = ImportPrompt.fromReply(reply.value);
  importChecked = null;
  check.className = 'import-check';
  if (!text) { check.textContent = ''; updateImportCreate(); return; }
  try {
    const parsed = await API.post('/parse', { cooklang_text: text });
    if (document.getElementById('import-reply') !== reply || ImportPrompt.fromReply(reply.value) !== text) return;
    const sum = ImportPrompt.summarize(parsed);
    if (sum.error || (!sum.ingredients && sum.steps < 2)) {
      check.classList.add('import-check-bad');
      check.textContent = sum.error ? `Couldn't read it: ${sum.error}` : "That doesn't look like a recipe yet. Paste the whole reply.";
    } else {
      const count = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
      check.textContent = `${sum.title ? `“${sum.title}”: ` : ''}${[count(sum.ingredients, 'ingredient'), count(sum.steps, 'step'), sum.sections ? count(sum.sections, 'section') : ''].filter(Boolean).join(', ')}.`;
      importChecked = { text, title: sum.title };
    }
    const titleGroup = document.getElementById('import-title-group');
    if (titleGroup) titleGroup.hidden = !importChecked || !!importChecked.title;
  } catch (e) {
    check.classList.add('import-check-bad');
    check.textContent = `Couldn't check it: ${e.message}`;
  }
  updateImportCreate();
}

function importTitle() {
  return importChecked?.title || document.getElementById('import-title')?.value.trim() || '';
}

function updateImportCreate() {
  const button = document.getElementById('import-create');
  if (button) button.disabled = !importChecked || !importTitle();
}

async function createImportedRecipe() {
  const title = importTitle();
  if (!importChecked || !title) return;
  const button = document.getElementById('import-create');
  if (button) button.disabled = true;
  let created;
  try {
    created = await API.post('/recipes', { title });
  } catch (e) {
    showToast('Error: ' + e.message);
    updateImportCreate();
    return;
  }
  try {
    await API.put(`/recipes/${created.slug}/draft`, { cooklang_text: importChecked.text });
  } catch (e) {
    showToast(`Made “${title}”, but couldn't save the recipe text: ${e.message}`);
  }
  closeModal();
  await Router.go(`/recipe/${created.slug}?tab=editor`);
}

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
