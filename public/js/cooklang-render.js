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
      const nameHtml = renderIngredientName(ing);
      const noteHtml = ing.note ? ` <span class="ing-note">(${escHtml(ing.note)})</span>` : '';
      const optionalHtml = ing.optional ? ' <span class="ing-optional">(optional)</span>' : '';
      const itemCls = ing.optional ? 'ingredient-item ingredient-item-optional' : 'ingredient-item';
      return `<li class="${itemCls}">
        <span class="ing-qty${canScale && !isSelectable ? ' ing-qty-editable' : ''}${isSelectable ? ' ing-qty-selectable' : ''}"${actionAttr}>${escHtml(qtyStr)}</span>
        ${nameHtml}${noteHtml}${optionalHtml}
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
  renderSteps(steps, scale = 1, metadata = {}, showAmounts = false, options = {}) {
    if (!steps || steps.length === 0) {
      return '<p class="text-muted">No steps listed.</p>';
    }
    const metaKeys = Object.keys(metadata || {}).map(k => k.toLowerCase());
    const knownMeta = ['title','source','author','servings','description','category','cuisine','yield','tags','prep time','cook time','total time','url','image'];
    const items = steps.map((step) => {
      if (step.length === 1 && step[0]?.type === 'comment') {
        return `<li class="step-comment">${renderTextWithBreaks(step[0].value || '', options.temperatureUnit)}</li>`;
      }
      const plainText = getPlainTextStepText(step);
      if (plainText !== null) {
        if (/^\s*=\s+/.test(plainText)) {
          const sectionId = step?.[0]?.section_id;
          const sectionAttr = sectionId ? ` data-section-id="${escHtml(sectionId)}"` : '';
          return `<li class="step-section"${sectionAttr}>${escHtml(plainText.replace(/^\s*=\s+/, ''))}</li>`;
        }
        if (/^\s*(>\s|--\s?)/.test(plainText)) {
          return `<li class="step-comment">${escHtml(plainText.replace(/^\s*(>\s+|--\s*)/, ''))}</li>`;
        }
        const mm = plainText.match(/^\s*([a-zA-Z][a-zA-Z0-9 _.-]*):\s/);
        if (mm) {
          const key = mm[1].trim().toLowerCase();
          // metric.* keys are stripped by the parser layer; this is a defensive
          // catch so a leftover `metric.foo: ...` line can never render as text.
          if (metaKeys.includes(key) || knownMeta.includes(key) || key.startsWith('metric.')) return '';
        }
      }
      const html = step.map(token => {
        if (typeof token === 'string') return escHtml(token);
        switch (token.type) {
          case 'ingredient': {
            const prepRef = buildPrepReferenceAttrs(token);
            const amtHtml = (showAmounts && token.quantity) ? (() => {
              const isFrac = /[\/⅛¼⅓⅜½⅝⅔¾⅞]/.test(String(token.quantity));
              const q = scaleQty(token.quantity, scale, isFrac);
              return `<span class="s-ing-amt"> (${escHtml(q)}${token.units ? ' ' + escHtml(token.units) : ''})</span>`;
            })() : '';
            const noteHtml = token.note ? ` <span class="s-component-note">(${escHtml(token.note)})</span>` : '';
            const optHtml = token.optional ? ' <span class="s-component-optional">(optional)</span>' : '';
            if (token.recipe_reference) {
              return renderRecipeReferenceChip(token) + amtHtml + noteHtml + optHtml;
            }
            if (prepRef) {
              return `<span class="s-ingredient s-ingredient-prep-ref${token.optional ? ' s-ingredient-optional' : ''}"${prepRef.attrs} title="${escHtml(prepRef.title)}"><span class="s-prep-arrow" aria-hidden="true">↩</span>${escHtml(token.name)}${amtHtml}</span>${noteHtml}${optHtml}`;
            }
            return `<span class="s-ingredient${token.optional ? ' s-ingredient-optional' : ''}">${escHtml(token.name)}${amtHtml}</span>${noteHtml}${optHtml}`;
          }
          case 'cookware': {
            const noteHtml = token.note ? ` <span class="s-component-note">(${escHtml(token.note)})</span>` : '';
            return `<span class="s-cookware">${escHtml(token.name)}</span>${noteHtml}`;
          }
          case 'timer': {
            const matchedToken = token.quantity && options.resolveTimerToken ? options.resolveTimerToken(token) : null;
            const attr = matchedToken ? ` data-draft-token-id="${escHtml(matchedToken.id)}" onclick="RecipeView.selectDraftQuantity('${escHtml(matchedToken.id)}', this)"` : '';
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
            return renderTextWithBreaks(token.value, options.temperatureUnit);
          default:
            return escHtml(token.value || '');
        }
      }).join('');
      const stepId = getRenderedStepId(step);
      const dataAttrs = stepId
        ? ` data-step-id="${escHtml(stepId)}"`
        : '';
      return `<li class="step-item"${dataAttrs}><span class="step-num"></span><span class="step-text">${html}</span></li>`;
    }).filter(s => s !== '').join('');
    return `<ol class="step-list">${items}</ol>`;
  },

  renderMetrics(metrics) {
    if (!Array.isArray(metrics) || metrics.length === 0) return '';
    // Hidden metrics still parse and compute (so later metrics can reference
    // them) but stay out of the chip strip.
    const visible = metrics.filter((m) => !m.hidden);
    if (visible.length === 0) return '';
    const chips = visible.map((m) => {
      const safeName = escHtml(m.name);
      if (m.error) {
        const tip = escHtml(m.error);
        return `<span class="metric-chip metric-chip-error" title="${tip}"><span class="metric-name">${safeName}</span> <span class="metric-icon" aria-hidden="true">⚠</span></span>`;
      }
      const tip = m.formula ? escHtml(`${m.formula}${m.format_unit ? ' | ' + m.format_unit : ''}`) : '';
      return `<span class="metric-chip"${tip ? ` title="${tip}"` : ''}><span class="metric-name">${safeName}</span> <span class="metric-value">${escHtml(m.display || '')}</span></span>`;
    }).join('');
    return `<div class="recipe-metrics">${chips}</div>`;
  },

  renderCookware(cookwares) {
    if (!cookwares || cookwares.length === 0) return '';
    const seen = new Set();
    const unique = [];
    for (const c of cookwares) {
      const key = String(c || '').trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(c);
    }
    if (unique.length === 0) return '';
    const chips = unique.map(c => `<span class="cookware-chip">${escHtml(c)}</span>`).join('');
    return `<div class="cookware-list">${chips}</div>`;
  },
};

const StepHoverCtrl = {
  activeTarget: null,

  enter(el) {
    this.clear();
    const target = resolvePrepRefTarget(el);
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

  jump(el) {
    const target = resolvePrepRefTarget(el);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('step-item-ref-flash');
    setTimeout(() => target.classList.remove('step-item-ref-flash'), 1200);
  },
};

function resolvePrepRefTarget(el) {
  const stepId = el?.dataset?.refStepId;
  const sectionId = el?.dataset?.refSectionId;
  if (!stepId && !sectionId) return null;
  const list = el.closest('.step-list');
  if (!list) return null;
  return stepId
    ? list.querySelector(`.step-item[data-step-id="${cssEscape(stepId)}"]`)
    : list.querySelector(`.step-section[data-section-id="${cssEscape(sectionId)}"]`);
}

function buildPrepReferenceAttrs(token) {
  if (token.reference_target === 'step' && token.reference_step_id) {
    const stepNum = token.reference_step_number;
    const label = stepNum ? `step ${stepNum}` : 'an earlier step';
    return {
      label,
      title: `From ${label}`,
      attrs: ` data-ref-step-id="${escHtml(token.reference_step_id)}"`
        + ` onmouseenter="StepHoverCtrl.enter(this)"`
        + ` onmouseleave="StepHoverCtrl.leave(this)"`
        + ` onclick="StepHoverCtrl.jump(this)"`,
    };
  }
  if (token.reference_target === 'section' && token.reference_section_id) {
    const name = token.reference_section_name;
    const label = name ? name : 'an earlier section';
    return {
      label,
      title: `From ${label}`,
      attrs: ` data-ref-section-id="${escHtml(token.reference_section_id)}"`
        + ` onmouseenter="StepHoverCtrl.enter(this)"`
        + ` onmouseleave="StepHoverCtrl.leave(this)"`
        + ` onclick="StepHoverCtrl.jump(this)"`,
    };
  }
  return null;
}

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
  const str = String(qty);
  // Ranges like "1-2" or "200-300": scale both endpoints independently so
  // "200-300 g" at 2× becomes "400-600 g" instead of "400 g".
  const rangeMatch = str.match(/^\s*(\d+(?:\.\d+)?)\s*([-–])\s*(\d+(?:\.\d+)?)\s*$/);
  if (rangeMatch) {
    const a = scaleSingleNumber(rangeMatch[1], factor, useFractions);
    const b = scaleSingleNumber(rangeMatch[3], factor, useFractions);
    return `${a}${rangeMatch[2]}${b}`;
  }
  return scaleSingleNumber(str, factor, useFractions);
}

function scaleSingleNumber(qty, factor, useFractions) {
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

function renderTextWithBreaks(text, preferredUnit) {
  // Cooklang explicit line break: backslash at EOL — the parser strips the
  // backslash but preserves the newline. Implicit line breaks inside a step
  // are folded to spaces by the parser, so any \n that reaches us is a
  // forced break.
  return String(text || '')
    .split(/\r?\n/)
    .map(part => highlightTemps(part, preferredUnit))
    .join('<br>');
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

function renderRecipeReferenceChip(refLike) {
  const res = refLike?.recipe_reference_resolution;
  const displayName = refLike?.name || '';
  const canonicalPath = refLike?.reference_path || '';
  const aliasProvided = displayName && canonicalPath && displayName !== canonicalPath;
  const aliasLabel = aliasProvided ? displayName : '';
  if (res && res.found && res.url) {
    const escUrl = escHtml(res.url);
    const jsUrl = String(res.url).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const pinSuffix = res.pinned && res.version_string
      ? ` <span class="ref-pin">@${escHtml(res.version_string)}</span>`
      : '';
    const label = aliasLabel || res.title || displayName || canonicalPath;
    return `<a class="ingredient-reference" href="${escUrl}" onclick="event.preventDefault(); Router.go('${jsUrl}')">${escHtml(label)}${pinSuffix}</a>`;
  }
  const brokenLabel = aliasLabel || displayName || canonicalPath || (res?.raw_path || '');
  return `<span class="ingredient-reference broken" title="Recipe not found">${escHtml(brokenLabel)}</span>`;
}

function renderIngredientName(ing) {
  if (ing?.recipe_reference) {
    return renderRecipeReferenceChip(ing);
  }
  return `<span class="ing-name">${escHtml(ing.name)}</span>`;
}
