// Client-side Cooklang renderer
// Takes parsed recipe JSON from the server and renders HTML

const CL = {
  // Render the full ingredient list with scaling
  renderIngredients(ingredients, scale = 1, options = {}) {
    if (!ingredients || ingredients.length === 0) {
      return '<p class="text-muted">No ingredients listed.</p>';
    }
    const items = ingredients.map(ing => {
      const rawQty = ing.quantity !== '' && ing.quantity !== null && ing.quantity !== undefined;
      const isFrac = rawQty && /[\/⅛¼⅓⅜½⅝⅔¾⅞]/.test(String(ing.quantity));
      const qty = rawQty ? scaleQty(ing.quantity, scale, isFrac) : '';
      const unit = ing.units || '';
      const qtyStr = qty ? `${qty}${unit ? ' ' + unit : ''}` : unit || '';
      const canScale = rawQty && !isNaN(parseFloat(String(ing.quantity)));
      const token = rawQty && options.resolveIngredientToken ? options.resolveIngredientToken(ing) : null;
      const isSelectable = !!token;
      const actionAttr = isSelectable
        ? ` data-draft-token-id="${escHtml(token.id)}" onclick="RecipeView.selectDraftQuantity('${escHtml(token.id)}', this)"`
        : (canScale
          ? ` data-orig="${escHtml(String(ing.quantity))}" onclick="RecipeView.editIngredientQty(this)" title="Click to scale recipe by this ingredient"`
          : '');
      return `<li class="ingredient-item">
        <span class="ing-qty${canScale && !isSelectable ? ' ing-qty-editable' : ''}${isSelectable ? ' ing-qty-selectable' : ''}"${actionAttr}>${escHtml(qtyStr)}</span>
        <span class="ing-name">${escHtml(ing.name)}</span>
      </li>`;
    }).join('');
    return `<ul class="ingredient-list">${items}</ul>`;
  },

  renderIngredientSummary(summary, scale = 1, options = {}) {
    const mode = options.mode === 'sectioned' ? 'sectioned' : 'flat';
    if (mode !== 'sectioned' || !summary?.has_multiple_sections) {
      return this.renderIngredients(summary?.flat || [], scale, options);
    }
    const sections = (summary.sections || [])
      .filter(section => Array.isArray(section.ingredients) && section.ingredients.length > 0);
    if (!sections.length) {
      return this.renderIngredients(summary?.flat || [], scale, options);
    }
    const hasNamedSections = sections.some(section => !!section.name);
    const rendered = sections.map(section => {
      const heading = ingredientSummaryLabel(section.name, hasNamedSections);
      return `<div class="ingredient-summary-section">
        ${heading ? `<div class="ingredient-summary-section-title">${escHtml(heading)}</div>` : ''}
        ${this.renderIngredients(section.ingredients || [], scale, options)}
      </div>`;
    }).join('');
    return `<div class="ingredient-summary ingredient-summary-sectioned">${rendered}</div>`;
  },

  // Render steps with highlighted inline tokens
  renderSteps(steps, scale = 1, cookMode = false, metadata = {}, showAmounts = false, options = {}) {
    if (!steps || steps.length === 0) {
      return '<p class="text-muted">No steps listed.</p>';
    }
    const metaKeys = Object.keys(metadata || {}).map(k => k.toLowerCase());
    const knownMeta = ['title','source','author','servings','description','category','cuisine','yield','tags','prep time','cook time','total time','url','image'];
    const items = steps.map((step) => {
      if (step.length === 1 && step[0]?.type === 'comment') {
        return `<li class="step-comment">${escHtml(step[0].value || '')}</li>`;
      }
      const plainText = getPlainTextStepText(step);
      if (plainText !== null) {
        if (/^\s*=\s+/.test(plainText)) {
          return `<li class="step-section">${escHtml(plainText.replace(/^\s*=\s+/, ''))}</li>`;
        }
        if (/^\s*(>\s|--\s?)/.test(plainText)) {
          return `<li class="step-comment">${escHtml(plainText.replace(/^\s*(>\s+|--\s*)/, ''))}</li>`;
        }
        const mm = plainText.match(/^\s*([a-zA-Z][a-zA-Z0-9 _-]*):\s/);
        if (mm) {
          const key = mm[1].trim().toLowerCase();
          if (metaKeys.includes(key) || knownMeta.includes(key)) return '';
        }
      }
      const html = step.map(token => {
        if (typeof token === 'string') return escHtml(token);
        switch (token.type) {
          case 'ingredient': {
            const hoverAttrs = token.reference_target === 'step' && token.reference_step_id
              ? ` data-ref-step-id="${escHtml(token.reference_step_id)}" onmouseenter="StepHoverCtrl.enter(this)" onmouseleave="StepHoverCtrl.leave(this)"`
              : '';
            let s = `<span class="s-ingredient${hoverAttrs ? ' s-ingredient-ref' : ''}"${hoverAttrs}>${escHtml(token.name)}`;
            if (showAmounts && token.quantity) {
              const isFrac = /[\/⅛¼⅓⅜½⅝⅔¾⅞]/.test(String(token.quantity));
              const q = scaleQty(token.quantity, scale, isFrac);
              s += `<span class="s-ing-amt"> (${escHtml(q)}${token.units ? ' ' + escHtml(token.units) : ''})</span>`;
            }
            return s + '</span>';
          }
          case 'cookware':
            return `<span class="s-cookware">${escHtml(token.name)}</span>`;
          case 'timer': {
            const secs = timerToSeconds(token.quantity, token.units);
            const matchedToken = token.quantity && options.resolveTimerToken ? options.resolveTimerToken(token) : null;
            const attr = matchedToken ? ` data-draft-token-id="${escHtml(matchedToken.id)}" onclick="RecipeView.selectDraftQuantity('${escHtml(matchedToken.id)}', this)"` : '';
            if (cookMode && secs > 0) {
              return `<span class="timer-display${matchedToken ? ' draft-token-selectable' : ''}" data-seconds="${secs}" data-state="idle"
                ${matchedToken ? attr : 'onclick="TimerCtrl.toggle(this)"'}>⏱ ${escHtml(token.value)}</span>`;
            }
            return `<span class="s-timer${matchedToken ? ' draft-token-selectable' : ''}"${attr}>⏱ ${escHtml(token.value)}</span>`;
          }
          case 'inlineQuantity': {
            const isTemp = /^°?[FCfc]$|fahrenheit|celsius/i.test(token.units || '');
            const cls = isTemp ? 's-temp' : 's-quantity';
            const matchedToken = token.quantity && options.resolveInlineQuantityToken ? options.resolveInlineQuantityToken(token) : null;
            const value = isTemp
              ? formatInlineTemperatureToken(token, options.temperatureUnit)
              : escHtml(token.value);
            return `<span class="${cls}${matchedToken ? ' draft-token-selectable' : ''}"${matchedToken ? ` data-draft-token-id="${escHtml(matchedToken.id)}" onclick="RecipeView.selectDraftQuantity('${escHtml(matchedToken.id)}', this)"` : ''}>${value}</span>`;
          }
          case 'text':
          case 'comment':
            return highlightTemps(token.value, options.temperatureUnit);
          default:
            return escHtml(token.value || '');
        }
      }).join('');
      const doneClick = cookMode ? ` onclick="this.classList.toggle('done')"` : '';
      const stepId = getRenderedStepId(step);
      const dataAttrs = stepId
        ? ` data-step-id="${escHtml(stepId)}"`
        : '';
      return `<li class="step-item"${dataAttrs}${doneClick}><span class="step-num"></span><span class="step-text">${html}</span></li>`;
    }).filter(s => s !== '').join('');
    const cls = cookMode ? 'step-list cook-mode' : 'step-list';
    return `<ol class="${cls}">${items}</ol>`;
  },

  renderCookware(cookwares) {
    if (!cookwares || cookwares.length === 0) return '';
    const chips = cookwares.map(c => `<span class="cookware-chip">${escHtml(c)}</span>`).join('');
    return `<div class="cookware-list">${chips}</div>`;
  },
};

// ── Timer controller ──────────────────────────────────────────────────────────
const TimerCtrl = {
  intervals: new Map(),

  toggle(el) {
    const state = el.dataset.state;
    if (state === 'idle') this.start(el);
    else if (state === 'running') this.pause(el);
    else if (state === 'paused') this.start(el);
    else if (state === 'done') this.reset(el);
  },

  start(el) {
    if (!el.dataset.remaining) {
      el.dataset.remaining = el.dataset.seconds;
    }
    el.dataset.state = 'running';
    el.classList.add('running');
    el.classList.remove('done');
    const id = setInterval(() => {
      let rem = parseInt(el.dataset.remaining) - 1;
      el.dataset.remaining = rem;
      el.textContent = `⏱ ${formatTime(rem)}`;
      if (rem <= 0) {
        clearInterval(id);
        this.intervals.delete(el);
        el.dataset.state = 'done';
        el.classList.remove('running');
        el.classList.add('done');
        el.textContent = '✓ Done!';
        if ('vibrate' in navigator) navigator.vibrate([200, 100, 200]);
      }
    }, 1000);
    this.intervals.set(el, id);
    this.updateLabel(el);
  },

  pause(el) {
    const id = this.intervals.get(el);
    if (id) { clearInterval(id); this.intervals.delete(el); }
    el.dataset.state = 'paused';
    el.classList.remove('running');
    this.updateLabel(el);
  },

  reset(el) {
    const id = this.intervals.get(el);
    if (id) { clearInterval(id); this.intervals.delete(el); }
    el.dataset.state = 'idle';
    el.dataset.remaining = el.dataset.seconds;
    el.classList.remove('running', 'done');
    this.updateLabel(el);
  },

  updateLabel(el) {
    const rem = parseInt(el.dataset.remaining || el.dataset.seconds);
    el.textContent = `⏱ ${formatTime(rem)}`;
  },
};

const StepHoverCtrl = {
  activeTarget: null,

  enter(el) {
    this.clear();
    const stepId = el?.dataset?.refStepId;
    if (!stepId) return;
    const list = el.closest('.step-list');
    if (!list) return;
    const target = list.querySelector(`.step-item[data-step-id="${cssEscape(stepId)}"]`);
    if (!target) return;
    target.classList.add('step-item-ref-highlight');
    el.classList.add('s-ingredient-ref-active');
    this.activeTarget = { target, el };
  },

  leave() {
    this.clear();
  },

  clear() {
    if (!this.activeTarget) return;
    this.activeTarget.target?.classList.remove('step-item-ref-highlight');
    this.activeTarget.el?.classList.remove('s-ingredient-ref-active');
    this.activeTarget = null;
  },
};

// ── Utilities ──────────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scaleQty(qty, factor, useFractions = false) {
  if (factor === 1) return String(qty);
  const n = parseFloat(qty);
  if (isNaN(n)) return String(qty);
  const scaled = n * factor;
  if (scaled === Math.floor(scaled)) return String(scaled);
  if (useFractions) {
    const frac = scaled % 1;
    const fracs = [[1/8,'⅛'],[1/4,'¼'],[1/3,'⅓'],[3/8,'⅜'],[1/2,'½'],[5/8,'⅝'],[2/3,'⅔'],[3/4,'¾'],[7/8,'⅞']];
    for (const [v, s] of fracs) {
      if (Math.abs(frac - v) < 0.03) {
        return scaled < 1 ? s : `${Math.floor(scaled)}${s}`;
      }
    }
  }
  return scaled.toFixed(2).replace(/\.?0+$/, '');
}

function timerToSeconds(qty, units) {
  const n = parseFloat(qty) || 0;
  const u = (units || '').toLowerCase();
  if (u.includes('hour') || u === 'h') return n * 3600;
  if (u.includes('min') || u === 'm') return n * 60;
  if (u.includes('sec') || u === 's') return n;
  return n * 60; // default to minutes
}

function highlightTemps(text, preferredUnit = 'F') {
  const pattern = /(\d+(?:\.\d+)?)(?:\s*([-–])\s*(\d+(?:\.\d+)?))?\s*(°\s*)?(degrees?\s+)?([FCfc]|fahrenheit|celsius)\b/gi;
  let html = '';
  let lastIndex = 0;
  let match = pattern.exec(text);
  while (match) {
    html += escHtml(text.slice(lastIndex, match.index));
    html += `<span class="s-temp">${formatMatchedTemperature(match, preferredUnit)}</span>`;
    lastIndex = match.index + match[0].length;
    match = pattern.exec(text);
  }
  html += escHtml(text.slice(lastIndex));
  return html;
}

function formatInlineTemperatureToken(token, preferredUnit = 'F') {
  const canonical = canonicalTemperatureUnit(token.units);
  if (!canonical || preferredUnit === canonical) {
    return escHtml(token.value);
  }
  const numeric = parseFloat(token.quantity);
  if (!Number.isFinite(numeric)) return escHtml(token.value);
  return escHtml(formatTemperatureValue(convertTemperatureValue(numeric, canonical, preferredUnit), preferredUnit));
}

function formatMatchedTemperature(match, preferredUnit = 'F') {
  const startValue = parseFloat(match[1]);
  const endValue = match[3] ? parseFloat(match[3]) : null;
  const separator = match[2] || '-';
  const sourceUnit = canonicalTemperatureUnit(match[6]);
  if (!sourceUnit || !Number.isFinite(startValue)) return escHtml(match[0]);
  const targetUnit = preferredUnit === 'C' ? 'C' : 'F';
  const first = formatTemperatureNumber(convertTemperatureValue(startValue, sourceUnit, targetUnit));
  if (endValue === null || !Number.isFinite(endValue)) {
    return escHtml(`${first}°${targetUnit}`);
  }
  const second = formatTemperatureNumber(convertTemperatureValue(endValue, sourceUnit, targetUnit));
  return escHtml(`${first}${separator}${second}°${targetUnit}`);
}

function canonicalTemperatureUnit(unit) {
  const raw = String(unit || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'c' || raw === '°c' || raw === 'celsius') return 'C';
  if (raw === 'f' || raw === '°f' || raw === 'fahrenheit') return 'F';
  return null;
}

function convertTemperatureValue(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  if (fromUnit === 'C' && toUnit === 'F') return (value * 9 / 5) + 32;
  if (fromUnit === 'F' && toUnit === 'C') return (value - 32) * 5 / 9;
  return value;
}

function formatTemperatureNumber(value) {
  const rounded = Math.abs(value - Math.round(value)) < 0.05
    ? Math.round(value)
    : Number(value.toFixed(1));
  return String(rounded).replace(/\.0$/, '');
}

function formatTemperatureValue(value, unit) {
  return `${formatTemperatureNumber(value)}°${unit}`;
}

function ingredientSummaryLabel(name, hasNamedSections) {
  if (name) return name;
  return hasNamedSections ? 'General' : '';
}

function getRenderedStepId(step) {
  for (const token of step || []) {
    if (typeof token === 'string') continue;
    if (token?.step_id) return token.step_id;
  }
  return null;
}

function getPlainTextStepText(step) {
  if (!Array.isArray(step) || step.length === 0) return null;
  let text = '';
  for (const token of step) {
    if (typeof token === 'string') {
      text += token;
      continue;
    }
    if (token?.type !== 'text') {
      return null;
    }
    text += token.value || '';
  }
  return text;
}

function cssEscape(value) {
  if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}

function formatTime(secs) {
  if (secs <= 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}
