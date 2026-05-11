import {
  Decoration,
  EditorState,
  EditorView,
  RangeSetBuilder,
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

function buildCooklangDecorations(view) {
  const builder = new RangeSetBuilder();
  for (const { from, to } of view.visibleRanges) {
    let lineStart = from;
    while (lineStart <= to) {
      const line = view.state.doc.lineAt(lineStart);
      addCooklangLineDecorations(builder, line.from, line.text);
      if (line.to >= to) break;
      lineStart = line.to + 1;
    }
  }
  return builder.finish();
}

function addCooklangLineDecorations(builder, offset, text) {
  if (/^\s*=\s+\S/.test(text)) {
    builder.add(offset, offset, Decoration.line({ class: 'cm-cook-section-line' }));
    builder.add(offset, offset + text.length, Decoration.mark({ class: 'cm-cook-section-header' }));
  }
  if (/^\s*>>/.test(text)) {
    builder.add(offset, offset + text.length, Decoration.mark({ class: 'cm-cook-meta-line' }));
  }
  addTemperatureDecorations(builder, offset, text);

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{' || char === '}' || char === '%') {
      builder.add(offset + i, offset + i + 1, Decoration.mark({ class: 'cm-cook-punctuation' }));
      continue;
    }
    if (char === '@' || char === '#' || char === '~') {
      const end = findCooklangTokenEnd(text, i);
      const className = char === '@'
        ? 'cm-cook-ingredient'
        : char === '#'
          ? 'cm-cook-cookware'
          : 'cm-cook-timer';
      builder.add(offset + i, offset + end, Decoration.mark({ class: className }));
      i = Math.max(i, end - 1);
    }
  }
}

function addTemperatureDecorations(builder, offset, text) {
  const pattern = /\b\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*(?:°\s*)?(?:C|F)\b/gi;
  let match = pattern.exec(text);
  while (match) {
    const start = match.index;
    const end = start + match[0].length;
    builder.add(offset + start, offset + end, Decoration.mark({ class: 'cm-cook-temperature' }));
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
