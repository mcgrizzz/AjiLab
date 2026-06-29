// ── Shared helpers (no this / no DOM globals) ─────────────────────────────────

function tagChip(tag) {
  return `<span class="tag-chip" data-tag="${escHtml(tag)}">${escHtml(tag)}<span class="rm" onclick="RecipeView.removeTag(this)">✕</span></span>`;
}

function recipePathForSelection(slug, version, branch = 'main', scale = 1) {
  const base = version && !version.is_draft && version.version_string
    ? `/recipe/${slug}/versions/${encodeURIComponent(version.version_string)}`
    : `/recipe/${slug}`;
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
