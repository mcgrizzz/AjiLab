// ── Cooklang source text mutations (pure) ────────────────────────────────────
// These walk the cooklang source line-by-line to locate a specific (section,
// step) pair, then return modified text. The line-counting rules mirror the
// step-grouping conventions used during parsing (`>>` = metadata, `=` =
// section heading, `>` blocks = comments which DON'T count as steps).
//
// All operations are pure string→string functions. No DB access, no parser
// dependency — they operate directly on the raw cooklang text.

export interface StepLineRange {
  line_start: number;
  line_end: number;
}

export interface SectionLineRange {
  section_index: number;
  heading_line: number | null;
  content_end_line: number;
}

// Returns the last line index of YAML frontmatter (`---` ... `---`) when the
// first non-blank line of the text opens one. Returns -1 if no frontmatter.
// Used by section/step walkers to skip the metadata block — the Cooklang
// parser handles it via the YAML extractor, but the source-text walkers
// would otherwise count it as an unnamed pre-section step block and offset
// every subsequent section_index by one.
function findYamlFrontmatterEnd(lines: string[]): number {
  let i = 0;
  while (i < lines.length && lines[i].trim() === "") i++;
  if (i >= lines.length || lines[i].trim() !== "---") return -1;
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === "---") return j;
  }
  return -1; // unclosed: don't skip anything, fall back to default behavior
}

export function findStepLineRange(text: string, sectionIndex: number, stepNumber: number): StepLineRange | null {
  const lines = text.split("\n");
  const frontmatterEnd = findYamlFrontmatterEnd(lines);
  let currentSection = -1; // -1 = no section opened; first content sets to 0
  let stepCount = 0;       // step count within current section (1-indexed)
  let inBlock = false;
  let blockStartLine = -1;
  let blockIsStep = false;

  const flush = (endLine: number): StepLineRange | null => {
    if (inBlock && blockIsStep && currentSection === sectionIndex && stepCount === stepNumber) {
      inBlock = false;
      return { line_start: blockStartLine, line_end: endLine };
    }
    inBlock = false;
    return null;
  };

  for (let i = 0; i < lines.length; i++) {
    if (i <= frontmatterEnd) continue;
    const trimmed = lines[i].trim();
    if (/^>>/.test(trimmed)) {
      const r = flush(i - 1);
      if (r) return r;
      continue;
    }
    if (/^=\s/.test(trimmed)) {
      const r = flush(i - 1);
      if (r) return r;
      currentSection = currentSection < 0 ? 0 : currentSection + 1;
      stepCount = 0;
      continue;
    }
    if (trimmed === "") {
      const r = flush(i - 1);
      if (r) return r;
      continue;
    }
    if (!inBlock) {
      if (currentSection < 0) currentSection = 0;
      blockStartLine = i;
      blockIsStep = !/^>/.test(trimmed);
      if (blockIsStep) stepCount++;
      inBlock = true;
    }
  }
  return flush(lines.length - 1);
}

const DEVIATION_MARKERS = {
  added: "!+ ",
  skipped: "!- ",
} as const;

interface AnnotationMatch {
  kind: "ingredient" | "timer" | "inlineQuantity";
  // Offsets relative to the slice we scanned (the step's joined line text).
  sigil_start: number;       // position of `@` / `~` / `%` / `^`
  name_end: number;          // position just after the name (= position of `{`)
  brace_open: number;        // position of `{`
  brace_close: number;       // position of `}`
}

function scanAnnotations(text: string): AnnotationMatch[] {
  const out: AnnotationMatch[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    let kind: AnnotationMatch["kind"] | null = null;
    if (c === "@") kind = "ingredient";
    else if (c === "~") kind = "timer";
    else if (c === "%" || c === "^") kind = "inlineQuantity";
    if (!kind) { i++; continue; }
    const sigilStart = i;
    let j = i + 1;
    // For ingredient/timer, consume modifiers and name up to `{` or whitespace.
    // For %{ / ^{ the brace immediately follows the sigil.
    if (kind === "inlineQuantity") {
      if (text[j] !== "{") { i = j; continue; }
    } else {
      // Skip modifier chars: `?` `&` `+` `-` `@` (recipe ref prefix).
      while (j < text.length && "?&+-@".includes(text[j])) j++;
      // Path-style recipe reference: `./` or `/`.
      if (text[j] === "." && text[j + 1] === "/") j += 2;
      else if (text[j] === "/") j += 1;
      // Consume name up to `{` or a line break. Cooklang allows multi-word
      // names only when the annotation has `{...}`; without braces the name
      // is the first whitespace-delimited word. We can't tell which until
      // we look ahead, so scan to either `{` (with-brace form) or whitespace.
      const nameStart = j;
      let sawBrace = false;
      while (j < text.length) {
        const cc = text[j];
        if (cc === "{") { sawBrace = true; break; }
        if (cc === "\n" || cc === "@" || cc === "~" || cc === "%" || cc === "^") break;
        j++;
      }
      if (!sawBrace) {
        // No braces → annotation has no editable quantity. Advance past name.
        // Reset position to nameStart so we don't skip nested sigils.
        i = nameStart > sigilStart + 1 ? nameStart : sigilStart + 1;
        continue;
      }
    }
    const braceOpen = j;
    const braceClose = text.indexOf("}", braceOpen + 1);
    if (braceClose < 0) { i = j + 1; continue; }
    out.push({
      kind,
      sigil_start: sigilStart,
      name_end: braceOpen,
      brace_open: braceOpen,
      brace_close: braceClose,
    });
    i = braceClose + 1;
  }
  return out;
}

function composeBraceContent(quantity: string, units: string): string {
  const q = quantity.trim();
  const u = units.trim();
  if (!q && !u) return "";
  if (!u) return q;
  return `${q}%${u}`;
}

export function updateStepQuantity(
  text: string,
  sectionIndex: number,
  stepNumber: number,
  kind: "ingredient" | "timer" | "inlineQuantity",
  index: number,
  newQuantity: string,
  newUnits: string,
): string {
  const range = findStepLineRange(text, sectionIndex, stepNumber);
  if (!range) return text;
  const lines = text.split("\n");
  const stepLines = lines.slice(range.line_start, range.line_end + 1);
  const stepText = stepLines.join("\n");
  const annotations = scanAnnotations(stepText).filter((a) => a.kind === kind);
  if (index < 0 || index >= annotations.length) return text;
  const target = annotations[index];

  let nextStepText: string;
  if (kind === "ingredient" && newQuantity.trim() === "0") {
    // Strip the entire `@name{...}` annotation. Leaves the bare name as text.
    // We replace `@(modifiers)name{...}` with just the name body so the step
    // still reads naturally — e.g. `@flour{0%g}` → `flour`.
    const nameStart = findIngredientNameStart(stepText, target.sigil_start);
    const before = stepText.slice(0, target.sigil_start);
    const nameOnly = stepText.slice(nameStart, target.name_end);
    const after = stepText.slice(target.brace_close + 1);
    nextStepText = before + nameOnly + after;
  } else {
    const newContent = composeBraceContent(newQuantity, newUnits);
    const before = stepText.slice(0, target.brace_open + 1);
    const after = stepText.slice(target.brace_close);
    nextStepText = before + newContent + after;
  }

  const nextLines = nextStepText.split("\n");
  lines.splice(range.line_start, range.line_end - range.line_start + 1, ...nextLines);
  return lines.join("\n");
}

// Find the start of the ingredient's display name — i.e. the position after
// `@`, any modifier chars (`?&+-@`), and any path prefix (`./` or `/`).
function findIngredientNameStart(text: string, sigilStart: number): number {
  let j = sigilStart + 1;
  while (j < text.length && "?&+-@".includes(text[j])) j++;
  if (text[j] === "." && text[j + 1] === "/") j += 2;
  else if (text[j] === "/") j += 1;
  // Skip the path part up to `|` (alias separator) if present, then the alias
  // is the display name. Otherwise the rest is the name.
  const pipe = text.indexOf("|", j);
  const brace = text.indexOf("{", j);
  if (pipe >= 0 && (brace < 0 || pipe < brace)) return pipe + 1;
  return j;
}

// Strip cook log deviation markers from a recipe text. Used on promote /
// iterate so the markers (which only document what differed from source)
// don't leak into a released version or a forked draft.
//   `!+ ` / `!~ ` at line start → marker stripped, content kept
//   `!- ` at line start → entire line removed
//   `> ` notes and all other lines pass through unchanged
export function resolveDeviationMarkers(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*!-\s/.test(line)) continue;
    const m = line.match(/^(\s*)!([+~])\s+/);
    if (m) {
      out.push(m[1] + line.slice(m[0].length));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export function applyStepDeviation(
  text: string,
  sectionIndex: number,
  stepNumber: number,
  deviation: "added" | "skipped" | null,
): string {
  const range = findStepLineRange(text, sectionIndex, stepNumber);
  if (!range) return text;
  const lines = text.split("\n");
  const line = lines[range.line_start];
  // Strip any existing marker (including legacy `!~ ` from before the
  // modified marker was retired) so toggling state replaces cleanly.
  const stripped = line.replace(/^(\s*)!([+~\-])\s+/, "$1");
  const indentMatch = stripped.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : "";
  const body = stripped.slice(indent.length);
  const marker = deviation ? DEVIATION_MARKERS[deviation] : "";
  lines[range.line_start] = indent + marker + body;
  return lines.join("\n");
}

export function insertNoteAfterStep(
  text: string,
  sectionIndex: number,
  stepNumber: number,
  note: string,
): string {
  const range = findStepLineRange(text, sectionIndex, stepNumber);
  if (!range) return text;
  const lines = text.split("\n");
  const noteLine = `> ${note.replace(/\n+/g, " ").trim()}`;
  const after = range.line_end + 1;
  const nextLine = lines[after];
  if (nextLine === undefined) {
    lines.push("", noteLine);
  } else if (nextLine.trim() === "") {
    lines.splice(after + 1, 0, noteLine, "");
  } else {
    lines.splice(after, 0, "", noteLine, "");
  }
  return lines.join("\n");
}

export function deleteStep(text: string, sectionIndex: number, stepNumber: number): string {
  const range = findStepLineRange(text, sectionIndex, stepNumber);
  if (!range) return text;
  const lines = text.split("\n");
  let start = range.line_start;
  let end = range.line_end;
  if (start > 0 && lines[start - 1].trim() === "") start--;
  else if (end + 1 < lines.length && lines[end + 1].trim() === "") end++;
  lines.splice(start, end - start + 1);
  return lines.join("\n");
}

export function insertStepAfterStep(
  text: string,
  sectionIndex: number,
  stepNumber: number,
  content: string,
): string {
  const range = findStepLineRange(text, sectionIndex, stepNumber);
  if (!range) return text;
  const trimmed = content.replace(/\n+/g, " ").trim();
  if (!trimmed) return text;
  const lines = text.split("\n");
  const after = range.line_end + 1;
  // Insert a blank-line separator before the new step (so it's its own block)
  // and another blank line after if the next existing line is non-blank.
  const insert: string[] = lines[after - 1]?.trim() === "" ? [trimmed] : ["", trimmed];
  if (after < lines.length && lines[after].trim() !== "") insert.push("");
  lines.splice(after, 0, ...insert);
  return lines.join("\n");
}

// ── Section-level source text mutations ─────────────────────────────────────
// findAllSections walks the source and returns per-section line ranges.
// heading_line is null for the implicit section 0 (content before any `=`).
// content_end_line points at the last non-blank content line inside the section
// (or the heading line itself when the section is empty).

export function findAllSections(text: string): SectionLineRange[] {
  const lines = text.split("\n");
  const frontmatterEnd = findYamlFrontmatterEnd(lines);
  const out: SectionLineRange[] = [];
  let current: SectionLineRange | null = null;
  let nextIndex = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i <= frontmatterEnd) continue;
    const trimmed = lines[i].trim();
    if (/^=\s/.test(trimmed)) {
      if (current) out.push(current);
      current = { section_index: nextIndex++, heading_line: i, content_end_line: i };
      continue;
    }
    if (/^>>/.test(trimmed) || trimmed === "") continue;
    if (!current) {
      current = { section_index: nextIndex++, heading_line: null, content_end_line: i };
    } else {
      current.content_end_line = i;
    }
  }
  if (current) out.push(current);
  return out;
}

export function findSectionLineRange(text: string, sectionIndex: number): SectionLineRange | null {
  return findAllSections(text).find((s) => s.section_index === sectionIndex) || null;
}

export function insertStepInSection(text: string, sectionIndex: number, content: string): string {
  const range = findSectionLineRange(text, sectionIndex);
  if (!range) return text;
  const lines = text.split("\n");
  const after = range.content_end_line + 1;
  const trimmed = content.replace(/\n+/g, " ").trim();
  if (!trimmed) return text;
  // Insert with a leading blank line so the new step is a distinct block.
  const insert = lines[after - 1]?.trim() === "" ? [trimmed] : ["", trimmed];
  // Ensure a trailing blank line separates this step from following content.
  if (after < lines.length && lines[after].trim() !== "") insert.push("");
  lines.splice(after, 0, ...insert);
  return lines.join("\n");
}

export function insertSectionNote(text: string, sectionIndex: number, note: string): string {
  const range = findSectionLineRange(text, sectionIndex);
  if (!range) return text;
  if (range.heading_line === null) return insertRecipeNote(text, note);
  const lines = text.split("\n");
  const noteLine = `> ${note.replace(/\n+/g, " ").trim()}`;
  // Insert blank + note + blank right after the heading.
  const after = range.heading_line + 1;
  const insert: string[] = ["", noteLine];
  if (after < lines.length && lines[after].trim() !== "") insert.push("");
  lines.splice(after, 0, ...insert);
  return lines.join("\n");
}

export function renameSection(text: string, sectionIndex: number, newName: string): string {
  const range = findSectionLineRange(text, sectionIndex);
  if (!range || range.heading_line === null) return text;
  const lines = text.split("\n");
  lines[range.heading_line] = `= ${newName.trim()}`;
  return lines.join("\n");
}

export function insertRecipeNote(text: string, note: string): string {
  const lines = text.split("\n");
  const noteLine = `> ${note.replace(/\n+/g, " ").trim()}`;
  // Insert after any leading `>>` metadata block.
  let insertAt = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (/^>>/.test(trimmed) || trimmed === "") {
      insertAt = i + 1;
      continue;
    }
    break;
  }
  const insert: string[] = [];
  // Pad with blank lines so the note sits cleanly above subsequent content.
  if (insertAt > 0 && lines[insertAt - 1]?.trim() !== "") insert.push("");
  insert.push(noteLine);
  if (insertAt < lines.length && lines[insertAt].trim() !== "") insert.push("");
  lines.splice(insertAt, 0, ...insert);
  return lines.join("\n");
}
