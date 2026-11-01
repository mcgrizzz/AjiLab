// ── Shared helpers (no this / no DOM globals) ─────────────────────────────────

function tagChip(tag) {
  return `<span class="tag-chip" data-tag="${escHtml(tag)}">${escHtml(tag)}<span class="rm" onclick="RecipeView.removeTag(this)">✕</span></span>`;
}

function recipePathForSelection(slug, version, branch = 'main', scale = 1) {
  let base = `/recipe/${slug}`;
  if (version?.kind === 'test' && version.test_number) base = `/recipe/${slug}/tests/${version.test_number}`;
  else if (version && !version.is_draft && version.version_string && !version.is_current) {
    base = `/recipe/${slug}/versions/${encodeURIComponent(version.version_string)}`;
  }
  const params = new URLSearchParams();
  if (branch && branch !== 'main') params.set('branch', branch);
  if (scale && scale !== 1) params.set('scale', String(scale));
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function escJs(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function normalizeNotes(value) {
  return String(value || '').replace(/\\n/g, '\n');
}

function formatMultilineText(value) {
  return escHtml(value).replace(/\n/g, '<br>');
}

function renderDraftQuantityPanel(token) {
  if (!token) return '';
  const percentDisabled = token.numericValue === null ? 'disabled' : '';
  return `
    <div class="editor-sidecar-card editor-sidecar-card-simple">
      <div class="editor-sidecar-head">
        <div class="editor-sidecar-title-wrap">
          <div class="editor-sidecar-title">Adjust Quantity</div>
          <div class="editor-sidecar-name">${escHtml(token.label)}</div>
        </div>
        <button class="btn btn-sm btn-ghost editor-sidecar-close" onclick="RecipeView.clearDraftQuantitySelection()" aria-label="Close quantity editor">×</button>
      </div>
      <div class="editor-sidecar-current editor-sidecar-current-large">${escHtml(token.quantityText)}${token.units ? ` <span class="text-muted">${escHtml(token.units)}</span>` : ''}</div>
      <div class="editor-sidecar-presets">
        <button class="btn btn-sm editor-sidecar-preset" ${percentDisabled} onclick="RecipeView.setDraftQuantityPreset(5)">+5%</button>
        <button class="btn btn-sm editor-sidecar-preset" ${percentDisabled} onclick="RecipeView.setDraftQuantityPreset(10)">+10%</button>
        <button class="btn btn-sm editor-sidecar-preset" ${percentDisabled} onclick="RecipeView.scaleDraftQuantityPercent(2, 100)">2x</button>
        <button class="btn btn-sm editor-sidecar-preset" ${percentDisabled} onclick="RecipeView.scaleDraftQuantityPercent(0.5, -50)">0.5x</button>
      </div>
      <div class="editor-sidecar-stack">
        <label class="editor-sidecar-inline-label" for="draft-override-value">Set quantity</label>
        <div class="editor-sidecar-control">
          <input id="draft-override-value" class="field-input" type="text" value="${escHtml(token.quantityText)}" oninput="RecipeView.handleDraftQuantityAbsoluteInput()" />
          <span class="editor-sidecar-unit">${escHtml(token.units || '')}</span>
        </div>
      </div>
      <div class="editor-sidecar-divider"><span>or</span></div>
      <div class="editor-sidecar-stack">
        <label class="editor-sidecar-inline-label" for="draft-custom-percent">Change by %</label>
        <div class="editor-sidecar-control">
          <input id="draft-custom-percent" class="field-input" type="number" step="0.1" placeholder="5" ${percentDisabled} oninput="RecipeView.handleDraftQuantityPercentInput()" />
          <span class="editor-sidecar-unit">%</span>
        </div>
      </div>
      <div class="editor-sidecar-preview">
        <span class="editor-sidecar-preview-label">Final target quantity</span>
        <span class="editor-sidecar-preview-value" id="draft-pending-preview">${escHtml(token.quantityText)}</span>
      </div>
      <div class="editor-sidecar-actions">
        <button class="btn btn-sm btn-ghost" onclick="RecipeView.clearDraftQuantitySelection()">Cancel</button>
        <button class="btn btn-sm btn-primary" onclick="RecipeView.applyDraftQuantityPending()">Apply changes</button>
      </div>
      ${token.numericValue === null ? '<p class="text-muted editor-sidecar-note">Percent changes only work for numeric quantities.</p>' : ''}
    </div>`;
}

function formatPercentChange(value) {
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded > 0 ? '+' : '';
  return `(${sign}${formatEditableQuantity(rounded)}%)`;
}

function formatEditableQuantity(value) {
  if (!Number.isFinite(value)) return '';
  const rounded = Math.round(value * 100) / 100;
  if (rounded === Math.floor(rounded)) return String(rounded);
  return rounded.toFixed(2).replace(/\.?0+$/, '');
}

// "today", "yesterday", "May 24", or "May 24, 2025" for another year.
function shortDate(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(now) - day(date)) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}

// Sidebars stick while you scroll only if they fit on screen; a taller one
// scrolls with the page, so it never needs a scrollbar of its own.
const StickyFit = (() => {
  let observer = null;
  let watched = [];
  const check = (el) => {
    if (!el.isConnected) return;
    const nav = document.getElementById('topnav')?.offsetHeight || 0;
    const tray = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--timer-tray-h')) || 0;
    el.classList.toggle('sticky-fits', el.offsetHeight <= window.innerHeight - nav - tray - 32);
  };
  window.addEventListener('resize', () => watched.forEach(check));
  window.addEventListener('timer-tray-resize', () => watched.forEach(check));
  return {
    watch(elements) {
      observer?.disconnect();
      watched = elements.filter(Boolean);
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver((entries) => entries.forEach((entry) => check(entry.target)));
        watched.forEach((el) => observer.observe(el));
      }
      watched.forEach(check);
    },
  };
})();

// The editor's save pill for a RecipeEditState session.
function editorSaveView(session) {
  const status = String(session?.status || 'Saved');
  if (status === 'Saving…') return { state: 'saving', text: 'Saving…', title: 'Saving your changes.' };
  if (status.startsWith('Could not save')) {
    return { state: 'error', text: 'Not saved', action: 'Retry', title: 'The last save failed. Your changes are kept in this browser.' };
  }
  if (session?.dirty && session?.recovered) {
    return { state: 'recovered', text: 'Recovered changes', action: 'Save', title: 'Unsaved changes from an earlier visit were restored. Review them, then save.' };
  }
  if (session?.dirty) {
    return session.autosave
      ? { state: 'unsaved', text: 'Unsaved', title: 'Saves automatically in a moment.' }
      : { state: 'unsaved', text: 'Unsaved changes', title: 'Use Save changes to save.' };
  }
  return { state: 'saved', text: 'Saved', title: 'All changes saved.' };
}

// Where a text offset sits in a recipe: in the frontmatter, or in the body as
// (section name, its occurrence, step k of that section; 0 = the heading).
// Mirrors how the parser groups steps: paragraphs split by blank lines,
// `>` notes and `>>` metadata don't count.
function cooklangCursorSpot(text, offset) {
  const lines = String(text || '').split('\n');
  const cursorLine = String(text || '').slice(0, Math.max(0, offset)).split('\n').length - 1;
  let bodyStart = 0;
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  if (lines[first]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > first && line.trim() === '---');
    if (close > 0) {
      if (cursorLine <= close) return { kind: 'frontmatter' };
      bodyStart = close + 1;
    }
  }
  let section = null;
  const seen = new Map();
  let occurrence = 0;
  let step = 0;
  let inParagraph = false;
  for (let i = bodyStart; i <= cursorLine && i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { inParagraph = false; continue; }
    if (/^=/.test(line)) {
      section = line.replace(/^=+\s*/, '').replace(/\s*=+$/, '').trim() || null;
      const key = section || '';
      occurrence = seen.get(key) || 0;
      seen.set(key, occurrence + 1);
      step = 0;
      inParagraph = false;
      continue;
    }
    if (line.startsWith('>>')) { inParagraph = false; continue; }
    if (!inParagraph) {
      inParagraph = true;
      if (!line.startsWith('>') && !line.startsWith('--')) step += 1;
    }
  }
  return { kind: 'body', section, occurrence, step };
}

// The preview element for a cursor spot: the section heading, or step k under it.
function findPreviewTarget(box, spot) {
  if (!box || !spot) return null;
  if (spot.kind === 'frontmatter') return box.firstElementChild;
  const items = [...(box.querySelector('.step-list')?.children || [])];
  if (!items.length) return null;
  let start = 0;
  let heading = null;
  if (spot.section) {
    let seen = 0;
    const idx = items.findIndex((li) => {
      if (!li.classList.contains('step-section')) return false;
      const name = (li.querySelector('.step-section-name')?.textContent || '').trim();
      if (name !== spot.section) return false;
      return seen++ === spot.occurrence;
    });
    if (idx < 0) return null;
    heading = items[idx];
    start = idx + 1;
  }
  if (spot.step <= 0) return heading || items[0];
  let count = 0;
  let last = heading;
  for (let i = start; i < items.length; i++) {
    const li = items[i];
    if (li.classList.contains('step-section')) break;
    if (!li.classList.contains('step-item')) continue;
    count += 1;
    last = li;
    if (count === spot.step) return li;
  }
  return last;
}

// Set the recipe's `title:` (frontmatter, or a `>> title:` line).
function replaceTitleLine(text, title) {
  const value = /[:#]|^[\s'"&*!|>%@`{[]/.test(title) ? JSON.stringify(title) : title;
  const source = String(text || '');
  const fm = source.match(/^(\s*---\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/);
  if (fm && /^title\s*:/m.test(fm[2])) {
    const body = fm[2].replace(/^(title\s*:[ \t]*).*$/m, (m, key) => `${key}${value}`);
    return fm[1] + body + fm[3] + source.slice(fm[0].length);
  }
  if (/^\s*>>\s*title\s*:/m.test(source)) {
    return source.replace(/^(\s*>>\s*title\s*:[ \t]*).*$/m, (m, key) => `${key}${title}`);
  }
  return source;
}

// ── Versions, tests and the working copy ───────────────────────────────────
// The server labels every entry: "v1.1", "Test 4", "Working copy". Tests are
// stored under internal names (test-4, or an old v1.1-beta.1); never show those.

function entryByKey(recipe, versionString) {
  if (!versionString || versionString === 'draft') return recipe?.draft || null;
  return (recipe?.versions || []).find((v) => v.version_string === versionString) || null;
}

function entryLabelFor(recipe, versionString) {
  if (!versionString || versionString === 'draft') return 'Working copy';
  return entryByKey(recipe, versionString)?.label || versionString;
}

// "Test 4 · more water"
function entryTitle(entry) {
  if (!entry) return '';
  return entry.kind === 'test' && entry.testing ? `${entry.label} · ${entry.testing}` : (entry.label || entry.version_string || '');
}

// What a test came to: "adopted as v1.1", "stopped", "superseded".
function testStateText(entry) {
  if (!entry || entry.kind !== 'test') return '';
  if (entry.open) return 'open';
  if (entry.closed_as === 'adopted') return entry.adopted_as ? `adopted as ${entry.adopted_as}` : 'adopted';
  if (entry.closed_as === 'rebased') return 're-based';
  if (entry.closed_as === 'superseded') return 'superseded';
  return 'stopped';
}

// Option lists for pickers: versions (current first), then tests (open
// first). The working copy isn't a sheet, so it's never listed.
function sheetOptionGroups(recipe) {
  const all = (recipe?.versions || []).filter((v) => !v.is_draft && v.version_string);
  const versions = all.filter((v) => v.kind === 'version')
    .map((v) => ({ val: v.version_string, label: v.is_current ? `${v.label} · current` : v.label }));
  const tests = all.filter((v) => v.kind === 'test')
    .sort((a, b) => (b.open - a.open) || ((b.test_number || 0) - (a.test_number || 0)))
    .map((v) => ({ val: v.version_string, label: `${entryTitle(v)} · ${testStateText(v)}` }));
  return [
    ...(versions.length ? [{ label: 'Versions', options: versions }] : []),
    ...(tests.length ? [{ label: 'Tests', options: tests }] : []),
  ];
}

function sheetOptionsHtml(groups, selected) {
  return groups.map((group) => `<optgroup label="${escHtml(group.label)}">${group.options.map((o) =>
    `<option value="${escHtml(o.val)}" ${o.val === selected ? 'selected' : ''}>${escHtml(o.label)}</option>`).join('')}</optgroup>`).join('');
}

// Badge colour by what it is: green version, amber test, grey working copy.
function versionBadgeClass(recipe, versionString) {
  if (!versionString) return 'badge-draft';
  const entry = entryByKey(recipe, versionString);
  if (entry) return entry.kind === 'test' ? 'badge-beta' : (entry.kind === 'working_copy' ? 'badge-draft' : 'badge-released');
  return /-beta|^test-/.test(versionString) ? 'badge-beta' : 'badge-released';
}

// "2×" badge for a cook log made at another scale; '' at 1×.
function cookLogScaleBadge(log) {
  const scale = Number(log?.scale) || 1;
  if (scale === 1) return '';
  return ` <span class="badge badge-scale" title="Cooked at ${formatEditableQuantity(scale)}× — amounts are as cooked">${formatEditableQuantity(scale)}×</span>`;
}

function makeDraftTokenResolver(tokens) {
  const ordered = [...tokens];
  let index = 0;
  return () => ordered[index++] || null;
}

function buildDraftIngredientTokenOrder(preview, tokens, mode) {
  const summary = preview?.ingredient_summary;
  if (!summary || !tokens?.length) return tokens || [];
  const orderedIngredients = mode === 'sectioned' && summary.has_multiple_sections
    ? summary.sections.flatMap(section => section.ingredients || [])
    : (summary.flat || []);
  if (!orderedIngredients.length) return tokens;
  const pools = new Map();
  for (const token of tokens) {
    const key = draftIngredientTokenKey(token.label, token.units);
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(token);
  }
  const ordered = [];
  for (const ingredient of orderedIngredients) {
    const exactKey = draftIngredientTokenKey(ingredient.name, ingredient.units);
    const exactPool = pools.get(exactKey);
    if (exactPool?.length) { ordered.push(exactPool.shift()); continue; }
    const fallbackKey = draftIngredientTokenKey(ingredient.name, '');
    const fallbackPool = pools.get(fallbackKey);
    if (fallbackPool?.length) ordered.push(fallbackPool.shift());
  }
  for (const remaining of pools.values()) ordered.push(...remaining);
  return ordered;
}

function draftIngredientTokenKey(name, units) {
  return `${String(name || '').trim().toLowerCase()}::${String(units || '').trim().toLowerCase()}`;
}

function emptyIngredientSummary() {
  return { mode_default: 'flat', flat: [], sections: [], has_multiple_sections: false };
}

function resolveIngredientSummaryMode(parsed, currentMode) {
  const hasMultipleSections = !!parsed?.ingredient_summary?.has_multiple_sections;
  if (currentMode === 'sectioned' && hasMultipleSections) return 'sectioned';
  if (currentMode === 'flat') return 'flat';
  return hasMultipleSections ? 'sectioned' : 'flat';
}

function renderIngredientSummaryToggle(parsed, mode) {
  if (!parsed?.ingredient_summary?.has_multiple_sections) return '';
  return `<div class="ingredient-summary-toggle" role="tablist" aria-label="Ingredient summary mode">
    <button class="ingredient-summary-toggle-btn${mode === 'sectioned' ? ' active' : ''}" onclick="RecipeView.setIngredientSummaryMode('sectioned')">By section</button>
    <button class="ingredient-summary-toggle-btn${mode === 'flat' ? ' active' : ''}" onclick="RecipeView.setIngredientSummaryMode('flat')">All together</button>
  </div>`;
}

function suggestNextVersion(last) {
  const clean = last.replace(/^v/, '');
  if (clean.includes('-beta')) return 'v' + clean.replace(/-beta.*$/, '');
  const parts = clean.split('.');
  if (parts.length >= 2) {
    parts[parts.length - 1] = String(parseInt(parts[parts.length - 1] || 0) + 1);
    return 'v' + parts.join('.');
  }
  return last + '.1';
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ── Print helpers ─────────────────────────────────────────────────────────────

let printRequest;
async function triggerPrint(container = document.getElementById('view-container')) {
  if (printRequest) return printRequest;
  printRequest = (async () => {
    await waitForPrintReady(container);
    window.print();
  })();
  try {
    await printRequest;
  } finally {
    printRequest = null;
  }
}

async function waitForPrintReady(container) {
  if (!container) return;
  if (document.fonts?.ready) {
    try { await document.fonts.ready; } catch {}
  }
  await waitForNextPaint();
  const images = [...container.querySelectorAll('img')];
  await Promise.all(images.map(waitForImageReady));
  await waitForNextPaint();
}

function waitForImageReady(img) {
  if (img.complete) {
    return img.decode ? img.decode().catch(() => {}) : Promise.resolve();
  }
  return new Promise(resolve => {
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
  });
}

function waitForNextPaint() {
  return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

// Scale factors from click-to-scale can be long (16 fl oz / 1 L = 0.4731…);
// keep the exact value for math but show three decimals.
function roundScale(scale) {
  return Math.round(scale * 1000) / 1000;
}

// A ⋯ menu under `btn`: items are { label, onClick, danger?, title? } or
// 'sep'. Same look as the step menus.
function openActionMenu(event, btn, items) {
  event?.stopPropagation();
  document.querySelectorAll('.step-action-menu').forEach((m) => m.remove());
  const menu = document.createElement('div');
  menu.className = 'step-action-menu';
  menu.setAttribute('role', 'menu');
  const actions = [];
  menu.innerHTML = items.filter(Boolean).map((item) => {
    if (item === 'sep') return '<div class="step-action-sep"></div>';
    actions.push(item.onClick);
    return `<button class="step-action-item${item.danger ? ' step-action-danger' : ''}" role="menuitem" data-i="${actions.length - 1}"${item.title ? ` title="${escHtml(item.title)}"` : ''}>${escHtml(item.label)}</button>`;
  }).join('');
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + window.scrollY + 4}px`;
  menu.style.left = `${Math.max(8, r.right + window.scrollX - menu.offsetWidth)}px`;
  menu.addEventListener('click', (e) => {
    const item = e.target.closest('.step-action-item');
    if (!item) return;
    menu.remove();
    actions[Number(item.dataset.i)]?.();
  });
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  menu.querySelector('.step-action-item')?.focus();
}
