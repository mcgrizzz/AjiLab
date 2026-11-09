// ── Icons for recipes and folders ────────────────────────────────────────────
// A recipe with no cover photo can wear an icon instead: an emoji ("🦃") or
// one of the bundled Lucide icons ("lucide:wheat", public/vendor/lucide-food.js).
// Folders wear them too. The server checks the same rule (store/folders.ts
// normalizeIcon); a name this bundle doesn't have shows as no icon.
const RecipeIcons = (() => {
  // In picker order: bread and baking, sweets, savoury, the sea, produce,
  // drinks, the pantry, occasions.
  const EMOJI = [
    '🍞', '🥖', '🥐', '🥯', '🥨', '🫓', '🥞', '🧇', '🍰', '🎂', '🧁', '🥧', '🍪', '🍩', '🍫', '🍬', '🍮', '🍦', '🍨', '🍯',
    '🧈', '🧀', '🥚', '🍳', '🥓', '🥩', '🍗', '🍖', '🦃', '🍔', '🌭', '🍕', '🥪', '🌮', '🌯', '🥙', '🧆', '🥗', '🍲', '🍜',
    '🍝', '🍛', '🍣', '🍱', '🥟', '🍙', '🍚', '🥘', '🫕', '🥫', '🍤', '🦐', '🦞', '🦀', '🦪', '🐟', '🦑', '🥦', '🥕', '🌽',
    '🥔', '🍠', '🧄', '🧅', '🍄', '🌶️', '🫑', '🥒', '🥬', '🍅', '🍆', '🥑', '🫘', '🥜', '🌰', '🍎', '🍐', '🍊', '🍋', '🍌',
    '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '☕', '🍵', '🫖', '🧃', '🥛', '🍷', '🍺', '🍸', '🍹', '🍶',
    '🧂', '🫙', '🧫', '🌾', '🌿', '🌱', '🍽️', '🔪', '🥄', '🔥', '❄️', '🎃', '🎄', '🎉', '🎁', '❤️', '⭐', '🏠', '👵', '👨‍🍳',
  ];

  const graphemes = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;

  function lucideName(icon) {
    const m = /^lucide:([a-z0-9-]+)$/.exec(String(icon || ''));
    return m && typeof LUCIDE_FOOD !== 'undefined' && LUCIDE_FOOD[m[1]] ? m[1] : null;
  }

  // One emoji, as the server takes it.
  function isEmoji(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 32) return false;
    if (graphemes && [...graphemes.segment(text)].length !== 1) return false;
    return /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text);
  }

  function svg(name, cls = 'ri-svg') {
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${LUCIDE_FOOD[name]}</svg>`;
  }

  // The icon as markup for a slot (a card thumb, the header, a folder chip),
  // or `fallback` when there's none.
  function html(icon, fallback = '') {
    const name = lucideName(icon);
    if (name) return svg(name);
    if (isEmoji(icon)) return `<span class="ri-emoji" aria-hidden="true">${escHtml(String(icon).trim())}</span>`;
    return fallback;
  }

  const has = (icon) => !!(lucideName(icon) || isEmoji(icon));

  // The picker. `onPick(icon)` gets the choice ('' for "No icon"); `onBack`
  // runs on Back, so a picker opened from another dialog returns to it.
  function pick({ title = 'Choose an icon', current = '', onPick, onBack }) {
    const cell = (value, inner, label) => `<button type="button" class="ri-cell${value === current ? ' ri-cell-current' : ''}" data-icon="${escHtml(value)}" title="${escHtml(label)}" aria-label="${escHtml(label)}">${inner}</button>`;
    const icons = Object.keys(typeof LUCIDE_FOOD !== 'undefined' ? LUCIDE_FOOD : {})
      .map((name) => cell(`lucide:${name}`, svg(name), name.replace(/-/g, ' '))).join('');
    const emoji = EMOJI.map((e) => cell(e, `<span class="ri-emoji">${e}</span>`, e)).join('');
    showModal(`
      <div class="modal-title">${escHtml(title)}</div>
      <div class="ri-picker">
        <div class="ri-group-title">Icons</div>
        <div class="ri-grid">${icons}</div>
        <div class="ri-group-title">Emoji</div>
        <div class="ri-grid">${emoji}</div>
        <div class="field-group">
          <label class="field-label" for="ri-any">Any other emoji</label>
          <div class="ri-any-row">
            <input id="ri-any" class="field-input" autocomplete="off" placeholder="Type or paste one" />
            <button type="button" class="btn" id="ri-any-use" disabled>Use it</button>
          </div>
        </div>
      </div>
      <div class="modal-actions">
        ${current ? '<button type="button" class="btn btn-ghost ri-none" data-icon="">No icon</button>' : ''}
        <button type="button" class="btn btn-ghost" id="ri-back">${onBack ? 'Back' : 'Cancel'}</button>
      </div>`);
    const root = document.getElementById('modal-content');
    root.querySelectorAll('[data-icon]').forEach((button) => {
      button.addEventListener('click', () => onPick(button.dataset.icon));
    });
    const any = document.getElementById('ri-any');
    const use = document.getElementById('ri-any-use');
    any.addEventListener('input', () => { use.disabled = !isEmoji(any.value); });
    any.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !use.disabled) use.click(); });
    use.addEventListener('click', () => onPick(any.value.trim()));
    document.getElementById('ri-back').addEventListener('click', () => (onBack ? onBack() : closeModal()));
  }

  return { EMOJI, isEmoji, has, html, pick };
})();
