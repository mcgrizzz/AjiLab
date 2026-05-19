// ── Cooklang frontmatter manipulation (pure, no I/O) ─────────────────────────
// Reads/writes the YAML-style frontmatter block at the top of a cooklang
// recipe. Used by the store to surface `notes` and `servings` as first-class
// fields without giving them their own DB columns — they live in the cooklang
// text and we parse them on read.
//
// Also handles two legacy layouts encountered in older recipes:
//   1. malformed preamble: `>> notes:` followed by continuation lines without
//      a closing `---`
//   2. `= Notes` section: a free-form notes section before any release used
//      this convention before frontmatter existed.

import { parseCooklang } from "../cooklang.ts";

export function parseVersionMetadata(text: string) {
  const meta = parseCooklang(text).metadata || {};
  const frontmatterNotes = decodeNotes(extractFrontmatterField(text, ["notes", "Notes"]));
  const frontmatterServings = extractFrontmatterField(text, ["servings", "Servings", "yield", "Yield"]);
  const metadataNotes = decodeNotes(meta.notes || meta.Notes || null);
  const preambleNotes = extractMalformedPreambleNotes(text);
  const legacySectionNotes = extractLegacyNotesSection(text);
  return {
    notes: frontmatterNotes || metadataNotes
      || [preambleNotes, legacySectionNotes].filter(Boolean).join("\n").trim() || null,
    servings: frontmatterServings || meta.servings || meta.Servings || meta.yield || meta.Yield || null,
  };
}

export function upsertNotesInCooklang(text: string, notes: string): string {
  const cleaned = stripLegacyMetadataPreamble(stripLegacyNotesSection(stripMalformedPreambleNotes(text)));
  return upsertFrontmatterField(cleaned, "notes", notes, ["notes", "Notes"], "block");
}

export function upsertServingsInCooklang(text: string, servings: string): string {
  const cleaned = stripLegacyMetadataPreamble(stripMalformedPreambleNotes(text));
  return upsertFrontmatterField(cleaned, "servings", servings, ["servings", "Servings", "yield", "Yield"], "scalar");
}

export function encodeNotes(notes: string | null): string {
  return String(notes || "").replace(/\r\n/g, "\n").replace(/\n/g, "\\n");
}

export function decodeNotes(notes: string | null): string | null {
  if (!notes) return null;
  return String(notes).replace(/\\n/g, "\n");
}

function extractFrontmatterField(text: string, aliases: string[]): string | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return null;
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    const match = line.match(/^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    const value = match[2] ?? "";
    if (!aliases.some((alias) => alias.toLowerCase() === key.toLowerCase())) continue;
    if (value === "|-" || value === "|") {
      const block: string[] = [];
      for (let inner = index + 1; inner < end; inner += 1) {
        const blockLine = lines[inner];
        if (!blockLine.startsWith("  ")) break;
        block.push(blockLine.slice(2));
        index = inner;
      }
      return block.join("\n").trim();
    }
    return value.trim() || null;
  }
  return null;
}

function extractMalformedPreambleNotes(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inMetadata = true;
  let sawNotesKey = false;
  const continuation: string[] = [];
  for (const line of lines) {
    if (inMetadata && /^\s*>>\s*notes\s*:/i.test(line)) {
      sawNotesKey = true;
      continue;
    }
    if (inMetadata && /^\s*>>\s*[^:]+:/.test(line)) continue;
    if (inMetadata && /^\s*$/.test(line)) continue;
    if (inMetadata && line.trim() === "---") break;
    if (inMetadata && sawNotesKey) {
      continuation.push(line.trim());
      continue;
    }
    inMetadata = false;
    break;
  }
  return continuation.filter(Boolean).join("\n").trim() || null;
}

function extractLegacyNotesSection(text: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^=\s*notes\s*$/i.test(line.trim()));
  if (start === -1) return null;
  const collected: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^=\s+/.test(line.trim())) break;
    const normalized = line.replace(/^\s*>\s?/, "").trim();
    if (!normalized) {
      if (collected.length) collected.push("");
      continue;
    }
    collected.push(normalized);
  }
  return collected.join("\n").trim() || null;
}

function splitFrontmatter(text: string) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end !== -1) {
      return { eol, hadTrailingNewline, frontmatter: lines.slice(1, end), body: lines.slice(end + 1) };
    }
  }
  return { eol, hadTrailingNewline, frontmatter: [], body: lines };
}

function upsertFrontmatterField(text: string, key: string, value: string, aliases: string[] = [key], mode: "scalar" | "block" = "scalar"): string {
  const { eol, hadTrailingNewline, frontmatter, body } = splitFrontmatter(text);
  const aliasSet = new Set(aliases.map((alias) => alias.toLowerCase()));
  const cleaned: string[] = [];
  for (let index = 0; index < frontmatter.length; index += 1) {
    const line = frontmatter[index];
    const match = line.match(/^([A-Za-z][A-Za-z0-9 _-]*):\s*(.*)$/);
    if (!match) {
      cleaned.push(line);
      continue;
    }
    const field = match[1].trim().toLowerCase();
    if (!aliasSet.has(field)) {
      cleaned.push(line);
      continue;
    }
    const currentValue = match[2] ?? "";
    if (currentValue === "|-" || currentValue === "|") {
      while (index + 1 < frontmatter.length && frontmatter[index + 1].startsWith("  ")) index += 1;
    }
  }
  if (value.trim()) {
    if (mode === "block") {
      cleaned.push(`${key}: |-`);
      for (const line of value.replace(/\r\n/g, "\n").split("\n")) cleaned.push(`  ${line}`);
    } else {
      cleaned.push(`${key}: ${value}`);
    }
  }
  const nextLines = ["---", ...cleaned, "---", ...body];
  let nextText = nextLines.join(eol);
  if (hadTrailingNewline && !nextText.endsWith(eol)) nextText += eol;
  return nextText;
}

function stripMalformedPreambleNotes(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const firstFrontmatter = lines.findIndex((line) => line.trim() === "---");
  if (firstFrontmatter <= 0) return text;
  const cleaned: string[] = [];
  let inMetadata = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index >= firstFrontmatter) { cleaned.push(...lines.slice(index)); break; }
    if (inMetadata && (/^\s*>>\s*[^:]+:/.test(line) || /^\s*$/.test(line))) { cleaned.push(line); continue; }
    if (inMetadata) continue;
    cleaned.push(line);
  }
  return cleaned.join(eol);
}

function stripLegacyNotesSection(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const cleaned: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (!skipping && /^=\s*notes\s*$/i.test(line.trim())) { skipping = true; continue; }
    if (skipping && /^=\s+/.test(line.trim())) { skipping = false; cleaned.push(line); continue; }
    if (!skipping) cleaned.push(line);
  }
  while (cleaned.length > 1 && cleaned[cleaned.length - 1] === "" && cleaned[cleaned.length - 2] === "") cleaned.pop();
  return cleaned.join(eol);
}

function stripLegacyMetadataPreamble(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const cleaned: string[] = [];
  let skippingLegacy = true;
  for (const line of lines) {
    if (skippingLegacy && (/^\s*>>\s*[^:]+:/.test(line) || /^\s*$/.test(line))) continue;
    skippingLegacy = false;
    cleaned.push(line);
  }
  return cleaned.join(eol);
}
