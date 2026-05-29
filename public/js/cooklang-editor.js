import {
  Decoration,
  EditorState,
  EditorView,
  ViewPlugin,
  defaultKeymap,
  drawSelection,
  highlightSpecialChars,
  history,
  historyKeymap,
  indentWithTab,
  keymap,
  placeholder,
} from '../vendor/codemirror.js';

// Decoration constructors are cached so `Decoration.set` can dedupe identical
// instances and so we don't allocate a new mark per token on every redraw.
const SECTION_LINE_DECO = Decoration.line({ class: 'cm-cook-section-line' });
const SECTION_HEADER_DECO = Decoration.mark({ class: 'cm-cook-section-header' });
const META_LINE_DECO = Decoration.mark({ class: 'cm-cook-meta-line' });
const PUNCT_DECO = Decoration.mark({ class: 'cm-cook-punctuation' });
const INGREDIENT_DECO = Decoration.mark({ class: 'cm-cook-ingredient' });
const COOKWARE_DECO = Decoration.mark({ class: 'cm-cook-cookware' });
const TIMER_DECO = Decoration.mark({ class: 'cm-cook-timer' });
const TEMP_DECO = Decoration.mark({ class: 'cm-cook-temperature' });

function buildCooklangDecorations(view) {
  // Collect ranges in any order, then let Decoration.set sort them.
  // RangeSetBuilder would require monotonically increasing `from` positions
  // and crashes (with "Ranges must be added sorted by `from` position and
  // `startSide`") when, e.g., a temperature later in the line is appended
  // before per-character marks earlier in the line.
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    let lineStart = from;
    while (lineStart <= to) {
      const line = view.state.doc.lineAt(lineStart);
      collectCooklangLineDecorations(ranges, line.from, line.text);
      if (line.to >= to) break;
      lineStart = line.to + 1;
    }
  }
  return Decoration.set(ranges, true);
}

function collectCooklangLineDecorations(ranges, offset, text) {
  if (/^\s*=\s+\S/.test(text)) {
    ranges.push(SECTION_LINE_DECO.range(offset));
    ranges.push(SECTION_HEADER_DECO.range(offset, offset + text.length));
  }
  if (/^\s*>>/.test(text)) {
    ranges.push(META_LINE_DECO.range(offset, offset + text.length));
  }
  collectTemperatureDecorations(ranges, offset, text);

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    // The `^{...}` temperature sigil uses `%` to separate value from unit
    // (`^{23-25%C}`), so it's highlighted as a whole token here rather than by
    // the prose-temperature regex. Handle it before the `%`/brace punctuation
    // case so the inner chars fold into the single temperature mark.
    if (char === '^' && text[i + 1] === '{') {
      const end = findCooklangTokenEnd(text, i);
      ranges.push(TEMP_DECO.range(offset + i, offset + end));
      i = Math.max(i, end - 1);
      continue;
    }
    if (char === '{' || char === '}' || char === '%') {
      ranges.push(PUNCT_DECO.range(offset + i, offset + i + 1));
      continue;
    }
    if (char === '@' || char === '#' || char === '~') {
      const end = findCooklangTokenEnd(text, i);
      const deco = char === '@'
        ? INGREDIENT_DECO
        : char === '#'
          ? COOKWARE_DECO
          : TIMER_DECO;
      ranges.push(deco.range(offset + i, offset + end));
      i = Math.max(i, end - 1);
    }
  }
}

function collectTemperatureDecorations(ranges, offset, text) {
  const pattern = /\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*(?:°\s*)?(?:C|F)\b/gi;
  let match = pattern.exec(text);
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    ranges.push(TEMP_DECO.range(offset + start, offset + end));
    match = pattern.exec(text);
  }
}

function findCooklangTokenEnd(text, start) {
  let index = start + 1;
  let braceDepth = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '{') {
      braceDepth += 1;
      index += 1;
      continue;
    }
    if (char === '}') {
      if (braceDepth === 0) return index;
      braceDepth -= 1;
      index += 1;
      if (braceDepth === 0) return index;
      continue;
    }
    if (braceDepth === 0 && /[,.;:!?()[\]]/.test(char)) break;
    if (braceDepth === 0 && (char === '@' || char === '#' || char === '~')) break;
    index += 1;
  }
  return index;
}

const cooklangHighlightPlugin = ViewPlugin.fromClass(class {
  constructor(view) {
    this.decorations = buildCooklangDecorations(view);
  }

  update(update) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildCooklangDecorations(update.view);
    }
  }
}, {
  decorations: (value) => value.decorations,
});

function clampSelection(selection, length) {
  return {
    anchor: Math.min(selection.anchor, length),
    head: Math.min(selection.head, length),
  };
}

function replaceEditorText(view, nextValue) {
  const currentValue = view.state.doc.toString();
  if (currentValue === nextValue) return;
  view.dispatch({
    changes: { from: 0, to: currentValue.length, insert: nextValue },
    selection: clampSelection(view.state.selection.main, nextValue.length),
  });
}

function createCooklangEditor(container, options = {}) {
  const {
    onChange,
    placeholder: placeholderText = '',
    textarea = null,
    value = '',
  } = options;

  let syncingFromTextarea = false;
  let textareaListener = null;

  const view = new EditorView({
    parent: container,
    state: EditorState.create({
      doc: value,
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        cooklangHighlightPlugin,
        keymap.of([
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        placeholder(placeholderText),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          const nextValue = update.state.doc.toString();
          if (textarea && textarea.value !== nextValue) {
            textarea.value = nextValue;
          }
          if (textarea && !syncingFromTextarea) {
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          }
          onChange?.(nextValue, update);
        }),
      ],
    }),
  });

  if (textarea) {
    textarea.value = value;
    textareaListener = () => {
      if (textarea.value === view.state.doc.toString()) return;
      syncingFromTextarea = true;
      replaceEditorText(view, textarea.value);
      syncingFromTextarea = false;
    };
    textarea.addEventListener('input', textareaListener);
  }

  return {
    destroy() {
      if (textarea && textareaListener) {
        textarea.removeEventListener('input', textareaListener);
      }
      view.destroy();
    },
    focus() {
      view.focus();
    },
    getValue() {
      return view.state.doc.toString();
    },
    setValue(nextValue) {
      if (textarea && textarea.value !== nextValue) {
        textarea.value = nextValue;
      }
      replaceEditorText(view, nextValue);
    },
  };
}

window.CooklangEditor = {
  createCooklangEditor,
};
window.dispatchEvent(new Event('cooklang-editor-ready'));
