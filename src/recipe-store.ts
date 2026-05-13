import fs from "fs";
import path from "path";
import { DATA_DIR, db, generateId, q, slugify } from "./db.ts";
import { parseCooklang, parseReferencePath } from "./cooklang.ts";
import type { ParsedIngredient, ParsedRecipe, ParsedStep, RecipeReferenceResolution } from "./cooklang.ts";

export type RecipeStatus = "draft" | "released" | "beta" | "archived";
export type RecipeBranchKind = "main" | "variant";

interface RecipeBranchMeta {
  id: string;
  slug: string;
  name: string;
  kind: RecipeBranchKind;
  upstream_branch_slug: string | null;
  forked_from_version_id: string | null;
  last_merged_upstream_version_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
}

interface RecipeMeta {
  id: string;
  slug: string;
  title: string;
  thumbnail_image_id?: string | null;
  created_at: string;
  updated_at: string;
  branches?: RecipeBranchMeta[];
}

interface VersionMeta {
  id: string;
  branch_slug: string;
  version_string: string | null;
  status: RecipeStatus;
  changelog: string;
  parent_version: string | null;
  current_beta_version?: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  is_draft: boolean;
}

type VersionRecord = Omit<VersionMeta, "tags"> & {
  recipe_id: string;
  cooklang_text: string;
  notes: string | null;
  servings: string | null;
  tags: string;
  is_inherited_source?: boolean;
};

export type CookLogSourceKind = "draft" | "version";

export interface CookLogRecord {
  id: string;
  recipe_id: string;
  branch_slug: string;
  /** Legacy column kept in sync with source_version_string for back-compat. */
  version_string: string | null;
  source_kind: CookLogSourceKind;
  source_version_string: string | null;
  cooklang_text: string;
  /** Immutable snapshot of the source's cooklang_text at log-creation time. */
  source_cooklang_text: string;
  tags: string[];
  cooked_at: string;
  outcome: string;
  what_worked: string;
  problems_found: string;
  changes_to_try_next: string;
  freeform_notes: string;
  created_at: string;
  updated_at: string;
}

export interface BranchCounts {
  releases_count: number;
  betas_count: number;
  cook_logs_count: number;
}

interface RecipeBranchRecord extends RecipeBranchMeta {
  latest_released: string | null;
  latest_beta: string | null;
  versions: VersionRecord[];
  draft: VersionRecord | null;
  source_version: VersionRecord | null;
  has_unreleased_changes: boolean;
  draft_change_label: string | null;
  current_best_release: VersionRecord | null;
  active_experiment: VersionRecord | null;
  latest_cook_log: CookLogRecord | null;
  counts: BranchCounts;
}

interface RecipeRecord extends RecipeMeta {
  branch_slug: string;
  branch: RecipeBranchRecord;
  branches: RecipeBranchRecord[];
  latest_released: string | null;
  latest_beta: string | null;
  versions: VersionRecord[];
  draft: VersionRecord | null;
  source_version: VersionRecord | null;
  has_unreleased_changes: boolean;
  draft_change_label: string | null;
  current_best_release: VersionRecord | null;
  active_experiment: VersionRecord | null;
  latest_cook_log: CookLogRecord | null;
  counts: BranchCounts;
}

type MergeEdit = {
  baseStart: number;
  baseEnd: number;
  replacement: string[];
};

const MAIN_BRANCH_SLUG = "main";
const RECIPES_DIR = path.join(DATA_DIR, "recipes");
const insertLegacyRecipeRow = db.prepare(`
  INSERT INTO recipes (id, slug, title, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    slug = excluded.slug,
    title = excluded.title,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
`);

fs.mkdirSync(RECIPES_DIR, { recursive: true });

function nowIso(): string {
  return new Date().toISOString();
}

function safeVersionSegment(version: string): string {
  return encodeURIComponent(version);
}

function recipeDir(slug: string): string {
  return path.join(RECIPES_DIR, slug);
}

function recipeMetaPath(slug: string): string {
  return path.join(recipeDir(slug), "recipe.json");
}

function branchesDir(slug: string): string {
  return path.join(recipeDir(slug), "branches");
}

function branchDir(slug: string, branchSlug: string): string {
  return path.join(branchesDir(slug), branchSlug);
}

function branchMetaPath(slug: string, branchSlug: string): string {
  return path.join(branchDir(slug, branchSlug), "branch.json");
}

function draftDir(slug: string, branchSlug: string): string {
  return path.join(branchDir(slug, branchSlug), "draft");
}

function versionsDir(slug: string, branchSlug: string): string {
  return path.join(branchDir(slug, branchSlug), "versions");
}

function versionDir(slug: string, branchSlug: string, version: string): string {
  return path.join(versionsDir(slug, branchSlug), safeVersionSegment(version));
}

function legacyDraftDir(slug: string): string {
  return path.join(recipeDir(slug), "draft");
}

function legacyVersionsDir(slug: string): string {
  return path.join(recipeDir(slug), "versions");
}

function imageDir(slug: string, branchSlug: string | null, versionKey: string | null): string {
  if (!branchSlug) return path.join(recipeDir(slug), "images");
  if (versionKey === "draft") return path.join(draftDir(slug, branchSlug), "images");
  if (versionKey) return path.join(versionDir(slug, branchSlug, versionKey), "images");
  return path.join(branchDir(slug, branchSlug), "images");
}

function cookLogsDir(slug: string, branchSlug: string): string {
  return path.join(branchDir(slug, branchSlug), "cook-logs");
}

function cookLogPath(slug: string, branchSlug: string, id: string): string {
  return path.join(cookLogsDir(slug, branchSlug), `${id}.json`);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function readText(filePath: string): string {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function writeText(filePath: string, text: string): void {
  fs.writeFileSync(filePath, text, "utf8");
}

function imageExtension(filename: string, mimeType: string): string {
  const fromName = path.extname(filename || "").toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  switch (mimeType) {
    case "image/jpeg": return ".jpg";
    case "image/png": return ".png";
    case "image/webp": return ".webp";
    case "image/gif": return ".gif";
    default: return "";
  }
}

function imageFilePath(
  slug: string,
  branchSlug: string | null,
  versionKey: string | null,
  id: string,
  filename: string,
  mimeType: string,
): string {
  return path.join(imageDir(slug, branchSlug, versionKey), `${id}${imageExtension(filename, mimeType)}`);
}

function writeImageAsset(
  slug: string,
  branchSlug: string | null,
  versionKey: string | null,
  image: { id: string; filename: string; mime_type: string; data: Buffer },
): string {
  const filePath = imageFilePath(slug, branchSlug, versionKey, image.id, image.filename, image.mime_type);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, image.data);
  return filePath;
}

function removeImageAsset(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

function parseVersionMetadata(text: string) {
  const meta = parseCooklang(text).metadata || {};
  const frontmatterNotes = decodeNotes(extractFrontmatterField(text, ["notes", "Notes"]));
  const frontmatterServings = extractFrontmatterField(text, ["servings", "Servings", "yield", "Yield"]);
  const metadataNotes = decodeNotes(meta.notes || meta.Notes || null);
  const preambleNotes = extractMalformedPreambleNotes(text);
  const legacySectionNotes = extractLegacyNotesSection(text);
  return {
    notes: frontmatterNotes || metadataNotes || [preambleNotes, legacySectionNotes].filter(Boolean).join("\n").trim() || null,
    servings: frontmatterServings || meta.servings || meta.Servings || meta.yield || meta.Yield || null,
  };
}

function encodeNotes(notes: string | null): string {
  return String(notes || "").replace(/\r\n/g, "\n").replace(/\n/g, "\\n");
}

function decodeNotes(notes: string | null): string | null {
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

function normalizeVersion(recipe: RecipeMeta, meta: VersionMeta, text: string): VersionRecord {
  const parsed = parseVersionMetadata(text);
  return {
    ...meta,
    recipe_id: recipe.id,
    cooklang_text: text,
    notes: parsed.notes,
    servings: parsed.servings,
    tags: JSON.stringify(meta.tags || []),
  };
}

function parseTags(tags: string | string[] | undefined): string[] {
  if (Array.isArray(tags)) return tags;
  return JSON.parse(tags || "[]");
}

function sortVersions(versions: VersionRecord[]): VersionRecord[] {
  return [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function latestVersionByStatus(versions: VersionRecord[], status: Exclude<RecipeStatus, "draft">): VersionRecord | null {
  return versions.find((version) => version.status === status) || null;
}

function incrementVersionString(version: string): string {
  const clean = version.replace(/^v/, "");
  if (clean.includes("-beta")) return `v${clean.replace(/-beta.*$/, "")}`;
  const parts = clean.split(".");
  if (parts.length >= 2) {
    parts[parts.length - 1] = String(parseInt(parts[parts.length - 1] || "0", 10) + 1);
    return `v${parts.join(".")}`;
  }
  return `${version}.1`;
}

function stripBetaSuffix(version: string): string {
  return version.includes("-beta") ? `v${version.replace(/^v/, "").replace(/-beta.*$/, "")}` : version;
}

function splitFrontmatter(text: string) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end !== -1) {
      return {
        eol,
        hadTrailingNewline,
        frontmatter: lines.slice(1, end),
        body: lines.slice(end + 1),
      };
    }
  }
  return {
    eol,
    hadTrailingNewline,
    frontmatter: [],
    body: lines,
  };
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
      for (const line of value.replace(/\r\n/g, "\n").split("\n")) {
        cleaned.push(`  ${line}`);
      }
    } else {
      cleaned.push(`${key}: ${value}`);
    }
  }

  const nextLines = ["---", ...cleaned, "---", ...body];
  let nextText = nextLines.join(eol);
  if (hadTrailingNewline && !nextText.endsWith(eol)) nextText += eol;
  return nextText;
}

export function upsertNotesInCooklang(text: string, notes: string): string {
  const cleaned = stripLegacyMetadataPreamble(stripLegacyNotesSection(stripMalformedPreambleNotes(text)));
  return upsertFrontmatterField(cleaned, "notes", notes, ["notes", "Notes"], "block");
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
    if (index >= firstFrontmatter) {
      cleaned.push(...lines.slice(index));
      break;
    }
    if (inMetadata && (/^\s*>>\s*[^:]+:/.test(line) || /^\s*$/.test(line))) {
      cleaned.push(line);
      continue;
    }
    if (inMetadata) {
      continue;
    }
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
    if (!skipping && /^=\s*notes\s*$/i.test(line.trim())) {
      skipping = true;
      continue;
    }
    if (skipping && /^=\s+/.test(line.trim())) {
      skipping = false;
      cleaned.push(line);
      continue;
    }
    if (!skipping) cleaned.push(line);
  }

  while (cleaned.length > 1 && cleaned[cleaned.length - 1] === "" && cleaned[cleaned.length - 2] === "") {
    cleaned.pop();
  }
  return cleaned.join(eol);
}

function upsertServingsInCooklang(text: string, servings: string): string {
  const cleaned = stripLegacyMetadataPreamble(stripMalformedPreambleNotes(text));
  return upsertFrontmatterField(cleaned, "servings", servings, ["servings", "Servings", "yield", "Yield"], "scalar");
}

function stripLegacyMetadataPreamble(text: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const cleaned: string[] = [];
  let skippingLegacy = true;
  for (const line of lines) {
    if (skippingLegacy && (/^\s*>>\s*[^:]+:/.test(line) || /^\s*$/.test(line))) {
      continue;
    }
    skippingLegacy = false;
    cleaned.push(line);
  }
  return cleaned.join(eol);
}

function removeDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function recipeExists(slug: string): boolean {
  return fs.existsSync(recipeMetaPath(slug));
}

function loadRecipeMeta(slug: string): RecipeMeta | null {
  const metaPath = recipeMetaPath(slug);
  if (!fs.existsSync(metaPath)) return null;
  const recipe = readJson<RecipeMeta>(metaPath);
  return migrateRecipeIfNeeded(recipe);
}

function mainBranchMeta(timestamp: string): RecipeBranchMeta {
  return {
    id: generateId(),
    slug: MAIN_BRANCH_SLUG,
    name: "Main",
    kind: "main",
    upstream_branch_slug: null,
    forked_from_version_id: null,
    last_merged_upstream_version_id: null,
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
  };
}

function writeRecipeMeta(recipe: RecipeMeta): void {
  ensureDir(recipeDir(recipe.slug));
  writeJson(recipeMetaPath(recipe.slug), recipe);
}

function writeBranchMeta(recipeSlug: string, branch: RecipeBranchMeta): void {
  ensureDir(branchDir(recipeSlug, branch.slug));
  writeJson(branchMetaPath(recipeSlug, branch.slug), branch);
}

function migrateRecipeIfNeeded(recipe: RecipeMeta): RecipeMeta {
  let changed = false;
  const timestamp = recipe.updated_at || recipe.created_at || nowIso();
  ensureDir(recipeDir(recipe.slug));
  ensureDir(branchesDir(recipe.slug));

  if (!recipe.branches || recipe.branches.length === 0) {
    recipe.branches = [mainBranchMeta(timestamp)];
    changed = true;
  }

  const hasMain = recipe.branches.some((branch) => branch.slug === MAIN_BRANCH_SLUG);
  if (!hasMain) {
    recipe.branches.unshift(mainBranchMeta(timestamp));
    changed = true;
  }

  if (fs.existsSync(legacyDraftDir(recipe.slug)) || fs.existsSync(legacyVersionsDir(recipe.slug))) {
    ensureDir(branchDir(recipe.slug, MAIN_BRANCH_SLUG));
    if (fs.existsSync(legacyDraftDir(recipe.slug)) && !fs.existsSync(draftDir(recipe.slug, MAIN_BRANCH_SLUG))) {
      fs.renameSync(legacyDraftDir(recipe.slug), draftDir(recipe.slug, MAIN_BRANCH_SLUG));
    }
    if (fs.existsSync(legacyVersionsDir(recipe.slug)) && !fs.existsSync(versionsDir(recipe.slug, MAIN_BRANCH_SLUG))) {
      fs.renameSync(legacyVersionsDir(recipe.slug), versionsDir(recipe.slug, MAIN_BRANCH_SLUG));
    }
    changed = true;
  }

  for (const branch of recipe.branches) {
    ensureDir(branchDir(recipe.slug, branch.slug));
    const branchFile = branchMetaPath(recipe.slug, branch.slug);
    if (!fs.existsSync(branchFile)) {
      writeBranchMeta(recipe.slug, branch);
    } else {
      const diskBranch = readJson<RecipeBranchMeta>(branchFile);
      if (JSON.stringify(diskBranch) !== JSON.stringify(branch)) {
        writeBranchMeta(recipe.slug, branch);
      }
    }

    const draftMetaFile = path.join(draftDir(recipe.slug, branch.slug), "meta.json");
    if (fs.existsSync(draftMetaFile)) {
      const draftMeta = readJson<VersionMeta>(draftMetaFile);
      if (!draftMeta.branch_slug) {
        draftMeta.branch_slug = branch.slug;
        writeJson(draftMetaFile, draftMeta);
      }
    }

    const branchVersionsDir = versionsDir(recipe.slug, branch.slug);
    if (fs.existsSync(branchVersionsDir)) {
      for (const entry of fs.readdirSync(branchVersionsDir)) {
        const metaFile = path.join(branchVersionsDir, entry, "meta.json");
        if (!fs.existsSync(metaFile)) continue;
        const meta = readJson<VersionMeta>(metaFile);
        if (!meta.branch_slug) {
          meta.branch_slug = branch.slug;
          writeJson(metaFile, meta);
        }
      }
    }
  }

  if (changed) writeRecipeMeta(recipe);
  return recipe;
}

function loadBranchMeta(recipe: RecipeMeta, branchSlug: string): RecipeBranchMeta | null {
  const fromRecipe = recipe.branches?.find((branch) => branch.slug === branchSlug) || null;
  const branchFile = branchMetaPath(recipe.slug, branchSlug);
  if (fs.existsSync(branchFile)) return readJson<RecipeBranchMeta>(branchFile);
  if (fromRecipe) {
    writeBranchMeta(recipe.slug, fromRecipe);
    return fromRecipe;
  }
  return null;
}

function loadVersionFromDir(recipe: RecipeMeta, branchSlug: string, dir: string): VersionRecord {
  const meta = readJson<VersionMeta>(path.join(dir, "meta.json"));
  if (!meta.branch_slug) {
    meta.branch_slug = branchSlug;
    writeJson(path.join(dir, "meta.json"), meta);
  }
  const content = readText(path.join(dir, "content.cook"));
  return normalizeVersion(recipe, meta, content);
}

function writeDraft(slug: string, branchSlug: string, meta: VersionMeta, content: string): void {
  const dir = draftDir(slug, branchSlug);
  ensureDir(dir);
  writeJson(path.join(dir, "meta.json"), meta);
  writeText(path.join(dir, "content.cook"), content);
}

function writeVersion(slug: string, branchSlug: string, meta: VersionMeta, content: string): void {
  const dir = versionDir(slug, branchSlug, meta.version_string || "");
  ensureDir(dir);
  writeJson(path.join(dir, "meta.json"), meta);
  writeText(path.join(dir, "content.cook"), content);
}

function loadVersions(recipe: RecipeMeta, branchSlug: string): VersionRecord[] {
  const root = versionsDir(recipe.slug, branchSlug);
  if (!fs.existsSync(root)) return [];
  return sortVersions(
    fs.readdirSync(root)
      .map((entry) => path.join(root, entry))
      .filter((entry) => fs.statSync(entry).isDirectory())
      .map((entry) => loadVersionFromDir(recipe, branchSlug, entry))
  );
}

function loadDraft(recipe: RecipeMeta, branchSlug: string): VersionRecord | null {
  const dir = draftDir(recipe.slug, branchSlug);
  return fs.existsSync(path.join(dir, "meta.json")) ? loadVersionFromDir(recipe, branchSlug, dir) : null;
}

function latestComparableVersion(branch: Pick<RecipeBranchRecord, "versions">): VersionRecord | null {
  return branch.versions
    .filter((version) => version.status === "released" || version.status === "beta")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] || null;
}

function sameDraftState(
  version: VersionRecord | null | undefined,
  nextText: string,
  nextTags: string[],
): boolean {
  if (!version) return false;
  return version.cooklang_text === nextText && JSON.stringify(parseTags(version.tags)) === JSON.stringify(nextTags);
}

function hasDraftChanges(branch: Pick<RecipeBranchRecord, "draft" | "versions">): boolean {
  if (!branch.draft?.cooklang_text.trim()) return false;
  const latestStableOrBeta = latestComparableVersion(branch as RecipeBranchRecord);
  if (!latestStableOrBeta) return true;
  if (branch.draft.updated_at.localeCompare(latestStableOrBeta.updated_at) <= 0) return false;
  return branch.draft.cooklang_text !== latestStableOrBeta.cooklang_text;
}

function draftChangeLabel(branch: Pick<RecipeBranchRecord, "draft" | "versions">): string | null {
  if (!hasDraftChanges(branch)) return null;
  const latestStableOrBeta = latestComparableVersion(branch as RecipeBranchRecord);
  if (!latestStableOrBeta?.version_string) return "Draft in progress";
  return `Draft differs from ${latestStableOrBeta.version_string}`;
}

function findVersionById(recipe: RecipeMeta, versionId: string | null | undefined): VersionRecord | null {
  if (!versionId) return null;
  for (const branch of recipe.branches || []) {
    const version = loadVersions(recipe, branch.slug).find((entry) => entry.id === versionId);
    if (version) return version;
  }
  return null;
}

function selectActiveExperiment(
  branch: Pick<RecipeBranchRecord, "draft" | "versions">,
  latestReleased: VersionRecord | null,
  latestBeta: VersionRecord | null,
): VersionRecord | null {
  if (branch.draft && hasDraftChanges(branch)) return branch.draft;
  if (latestBeta && (!latestReleased || latestBeta.created_at.localeCompare(latestReleased.created_at) > 0)) {
    return latestBeta;
  }
  return null;
}

function loadBranchRecord(recipe: RecipeMeta, branchMeta: RecipeBranchMeta): RecipeBranchRecord {
  const versions = loadVersions(recipe, branchMeta.slug);
  const draft = loadDraft(recipe, branchMeta.slug);
  const latestReleased = latestVersionByStatus(versions, "released");
  const latestBeta = latestVersionByStatus(versions, "beta");
  const sourceVersion = branchMeta.kind === "variant"
    ? findVersionById(recipe, branchMeta.forked_from_version_id)
    : null;
  const releasesCount = versions.filter((version) => version.status === "released").length;
  const betasCount = versions.filter((version) => version.status === "beta").length;
  const cookLogsCountRow = q.cookLogCountByBranch.get(recipe.id, branchMeta.slug) as { n: number } | undefined;
  const cookLogsCount = cookLogsCountRow?.n || 0;
  const latestCookLog = loadLatestCookLogForBranch(recipe.slug, branchMeta.slug, recipe.id);
  const record: RecipeBranchRecord = {
    ...branchMeta,
    versions,
    draft,
    source_version: sourceVersion,
    latest_released: latestReleased?.version_string || null,
    latest_beta: latestBeta?.version_string || null,
    has_unreleased_changes: false,
    draft_change_label: null,
    current_best_release: latestReleased,
    active_experiment: null,
    latest_cook_log: latestCookLog,
    counts: {
      releases_count: releasesCount,
      betas_count: betasCount,
      cook_logs_count: cookLogsCount,
    },
  };
  record.has_unreleased_changes = hasDraftChanges(record);
  record.draft_change_label = draftChangeLabel(record);
  record.active_experiment = selectActiveExperiment(record, latestReleased, latestBeta);
  return record;
}

function loadAllRecipeMetas(): RecipeMeta[] {
  if (!fs.existsSync(RECIPES_DIR)) return [];
  return fs.readdirSync(RECIPES_DIR)
    .map((entry) => loadRecipeMeta(entry))
    .filter((recipe): recipe is RecipeMeta => !!recipe);
}

function loadRecipeRecordFromMeta(recipe: RecipeMeta, branchSlug = MAIN_BRANCH_SLUG): RecipeRecord {
  const branches = (recipe.branches || [])
    .map((branch) => loadBranchMeta(recipe, branch.slug) || branch)
    .map((branch) => loadBranchRecord(recipe, branch));
  const branch = branches.find((entry) => entry.slug === branchSlug) || branches.find((entry) => entry.slug === MAIN_BRANCH_SLUG);
  if (!branch) throw new Error("branch not found");
  return {
    ...recipe,
    branches,
    branch_slug: branch.slug,
    branch,
    latest_released: branch.latest_released,
    latest_beta: branch.latest_beta,
    versions: branch.versions,
    draft: branch.draft,
    source_version: branch.source_version,
    has_unreleased_changes: branch.has_unreleased_changes,
    draft_change_label: branch.draft_change_label,
    current_best_release: branch.current_best_release,
    active_experiment: branch.active_experiment,
    latest_cook_log: branch.latest_cook_log,
    counts: branch.counts,
  };
}

function syncRecipeRow(recipe: RecipeMeta): void {
  insertLegacyRecipeRow.run(recipe.id, recipe.slug, recipe.title, recipe.created_at, recipe.updated_at);
}

function requireRecipe(slug: string, branchSlug = MAIN_BRANCH_SLUG): RecipeRecord {
  const recipe = getRecipeBySlug(slug, branchSlug);
  if (!recipe) throw new Error("not found");
  return recipe;
}

function fileSafeUniqueSlug(title: string, excludeSlug?: string): string {
  const base = slugify(title);
  let slug = base || "recipe";
  let suffix = 2;
  while (true) {
    const existing = loadRecipeMeta(slug);
    if (!existing || existing.slug === excludeSlug) return slug;
    slug = `${base || "recipe"}-${suffix++}`;
  }
}

function branchSafeUniqueSlug(recipe: RecipeMeta, name: string): string {
  const base = slugify(name) || "branch";
  const taken = new Set((recipe.branches || []).map((branch) => branch.slug));
  let slug = base;
  let suffix = 2;
  while (taken.has(slug)) slug = `${base}-${suffix++}`;
  return slug;
}

function bootstrapLegacyRecipes(): void {
  const legacyRecipes = q.legacyRecipes.all() as any[];
  for (const legacyRecipe of legacyRecipes) {
    if (recipeExists(legacyRecipe.slug)) continue;

    const timestamp = legacyRecipe.updated_at || legacyRecipe.created_at || nowIso();
    const recipe: RecipeMeta = {
      id: legacyRecipe.id,
      slug: legacyRecipe.slug,
      title: legacyRecipe.title,
      thumbnail_image_id: legacyRecipe.thumbnail_image_id || null,
      created_at: legacyRecipe.created_at,
      updated_at: timestamp,
      branches: [mainBranchMeta(timestamp)],
    };
    writeRecipeMeta(recipe);
    writeBranchMeta(recipe.slug, recipe.branches[0]);

    const legacyVersions = q.legacyVersionsByRecipe.all(legacyRecipe.id) as any[];
    for (const legacyVersion of legacyVersions) {
      let content = String(legacyVersion.cooklang_text || "");
      if (legacyVersion.notes) content = upsertNotesInCooklang(content, String(legacyVersion.notes));
      if (legacyVersion.servings) content = upsertServingsInCooklang(content, String(legacyVersion.servings));

      const meta: VersionMeta = {
        id: legacyVersion.id,
        branch_slug: MAIN_BRANCH_SLUG,
        version_string: legacyVersion.version_string || null,
        status: legacyVersion.status,
        changelog: legacyVersion.changelog || "",
        parent_version: legacyVersion.parent_version || null,
        tags: JSON.parse(legacyVersion.tags || "[]"),
        created_at: legacyVersion.created_at,
        updated_at: legacyVersion.created_at,
        is_draft: !!legacyVersion.is_draft,
        current_beta_version: null,
      };

      if (meta.is_draft) writeDraft(recipe.slug, MAIN_BRANCH_SLUG, meta, content);
      else if (meta.version_string) writeVersion(recipe.slug, MAIN_BRANCH_SLUG, meta, content);
    }
  }
}

bootstrapLegacyRecipes();

export function listRecipes(search?: string) {
  const needle = search?.trim().toLowerCase();
  return loadAllRecipeMetas()
    .map((recipe) => loadRecipeRecordFromMeta(recipe, MAIN_BRANCH_SLUG))
    .filter((recipe) => {
      if (!needle) return true;
      const haystack = [
        recipe.title,
        recipe.slug,
        recipe.draft?.cooklang_text || "",
        ...recipe.versions.flatMap((version) => [version.cooklang_text, ...parseTags(version.tags)]),
      ].join("\n").toLowerCase();
      return haystack.includes(needle);
    })
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((recipe) => ({
      id: recipe.id,
      slug: recipe.slug,
      title: recipe.title,
      thumbnail_image_id: recipe.thumbnail_image_id || null,
      created_at: recipe.created_at,
      updated_at: recipe.updated_at,
      latest_released: recipe.latest_released,
      latest_beta: recipe.latest_beta,
      has_unreleased_changes: recipe.has_unreleased_changes,
      draft_change_label: recipe.draft_change_label,
      current_best_release: recipe.current_best_release ? {
        version_string: recipe.current_best_release.version_string,
        created_at: recipe.current_best_release.created_at,
        changelog: recipe.current_best_release.changelog || "",
      } : null,
      latest_cook_log: recipe.latest_cook_log ? {
        id: recipe.latest_cook_log.id,
        version_string: recipe.latest_cook_log.version_string,
        cooked_at: recipe.latest_cook_log.cooked_at,
        outcome: recipe.latest_cook_log.outcome,
      } : null,
      counts: recipe.counts,
    }));
}

export function createRecipe(title: string) {
  const timestamp = nowIso();
  const main = mainBranchMeta(timestamp);
  const recipe: RecipeMeta = {
    id: generateId(),
    slug: fileSafeUniqueSlug(title),
    title,
    thumbnail_image_id: null,
    created_at: timestamp,
    updated_at: timestamp,
    branches: [main],
  };
  const draft = createDraftMeta(MAIN_BRANCH_SLUG, [], null, timestamp);

  writeRecipeMeta(recipe);
  writeBranchMeta(recipe.slug, main);
  writeDraft(recipe.slug, MAIN_BRANCH_SLUG, draft, "");
  syncRecipeRow(recipe);
  return { id: recipe.id, slug: recipe.slug, title: recipe.title };
}

export function getRecipeBySlug(slug: string, branchSlug = MAIN_BRANCH_SLUG): RecipeRecord | null {
  const recipe = loadRecipeMeta(slug);
  return recipe ? loadRecipeRecordFromMeta(recipe, branchSlug) : null;
}

export function listRecipeBranches(slug: string): RecipeBranchRecord[] {
  const recipe = requireRecipe(slug);
  return recipe.branches;
}

export function getRecipeBranch(slug: string, branchSlug: string): RecipeRecord | null {
  return getRecipeBySlug(slug, branchSlug);
}

export function getVersionByString(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG): VersionRecord | null {
  const recipe = getRecipeBySlug(slug, branchSlug);
  return recipe?.versions.find((version) => version.version_string === versionString) || null;
}

export function updateRecipeTitle(slug: string, title: string): { slug: string } {
  const recipe = requireRecipe(slug);
  const newSlug = fileSafeUniqueSlug(title, slug);
  const nextUpdatedAt = nowIso();
  const nextRecipe: RecipeMeta = {
    id: recipe.id,
    slug: newSlug,
    title,
    thumbnail_image_id: recipe.thumbnail_image_id || null,
    created_at: recipe.created_at,
    updated_at: nextUpdatedAt,
    branches: recipe.branches.map((branch) => ({
      id: branch.id,
      slug: branch.slug,
      name: branch.name,
      kind: branch.kind,
      upstream_branch_slug: branch.upstream_branch_slug,
      forked_from_version_id: branch.forked_from_version_id,
      last_merged_upstream_version_id: branch.last_merged_upstream_version_id,
      created_at: branch.created_at,
      updated_at: branch.updated_at,
      archived_at: branch.archived_at || null,
    })),
  };

  if (newSlug !== slug) {
    ensureDir(RECIPES_DIR);
    fs.renameSync(recipeDir(slug), recipeDir(newSlug));
  }

  writeRecipeMeta(nextRecipe);
  q.updateRecipeTitle.run(nextRecipe.title, nextRecipe.slug, nextRecipe.updated_at, nextRecipe.id);
  return { slug: newSlug };
}

export function deleteRecipe(slug: string): void {
  const recipe = requireRecipe(slug);
  removeDir(recipeDir(slug));
  q.deleteRecipe.run(recipe.id);
}

function updateRecipeAndBranchMeta(recipe: RecipeRecord, branchMeta: RecipeBranchMeta, updatedAt: string): void {
  const recipeMeta: RecipeMeta = {
    id: recipe.id,
    slug: recipe.slug,
    title: recipe.title,
    thumbnail_image_id: recipe.thumbnail_image_id || null,
    created_at: recipe.created_at,
    updated_at: updatedAt,
    branches: recipe.branches.map((branch) => branch.slug === branchMeta.slug ? branchMeta : {
      id: branch.id,
      slug: branch.slug,
      name: branch.name,
      kind: branch.kind,
      upstream_branch_slug: branch.upstream_branch_slug,
      forked_from_version_id: branch.forked_from_version_id,
      last_merged_upstream_version_id: branch.last_merged_upstream_version_id,
      created_at: branch.created_at,
      updated_at: branch.updated_at,
      archived_at: branch.archived_at || null,
    }),
  };
  writeRecipeMeta(recipeMeta);
  writeBranchMeta(recipe.slug, branchMeta);
  q.touchRecipeTime.run(updatedAt, recipe.id);
}

function resolveBranchBaseSource(recipe: RecipeRecord): VersionRecord | null {
  if (recipe.branch.draft) return recipe.branch.draft;
  const head = latestComparableVersion(recipe.branch);
  if (head) return head;
  return recipe.source_version;
}

function createDraftMeta(branchSlug: string, tags: string[], parentVersion: string | null, timestamp = nowIso()): VersionMeta {
  return {
    id: generateId(),
    branch_slug: branchSlug,
    version_string: null,
    status: "draft",
    changelog: "",
    parent_version: parentVersion,
    current_beta_version: null,
    tags,
    created_at: timestamp,
    updated_at: timestamp,
    is_draft: true,
  };
}

function nextAutoBetaBase(branch: RecipeBranchRecord, draft: VersionRecord): string {
  const seed = draft.parent_version
    ? (draft.parent_version.includes("-beta") ? stripBetaSuffix(draft.parent_version) : incrementVersionString(draft.parent_version))
    : (branch.latest_released ? incrementVersionString(branch.latest_released) : (branch.latest_beta ? stripBetaSuffix(branch.latest_beta) : "v1.0"));

  let candidate = seed;
  while (branch.versions.some((version) => version.version_string === candidate)) {
    candidate = incrementVersionString(candidate);
  }
  return candidate;
}

function nextAutoBetaVersion(branch: RecipeBranchRecord, draft: VersionRecord): string {
  const base = nextAutoBetaBase(branch, draft);
  const prefix = `${base}-beta.`;
  const maxSuffix = branch.versions
    .map((version) => version.version_string || "")
    .filter((versionString) => versionString.startsWith(prefix))
    .map((versionString) => Number(versionString.slice(prefix.length)))
    .filter((value) => Number.isFinite(value))
    .reduce((max, value) => Math.max(max, value), 0);
  return `${prefix}${maxSuffix + 1}`;
}

function latestAutoBetaForBase(branch: RecipeBranchRecord, base: string): VersionRecord | null {
  const prefix = `${base}-beta.`;
  return branch.versions.find((version) => version.version_string?.startsWith(prefix)) || null;
}

function writeDraftSnapshotIfNeeded(
  recipe: RecipeRecord,
  draft: VersionRecord | null,
  nextMeta: VersionMeta,
  nextText: string,
  advanceBeta: boolean,
): string | null {
  const nextTags = nextMeta.tags;
  const currentBetaVersion = draft?.current_beta_version || nextMeta.current_beta_version || null;
  if (!nextText.trim()) return null;
  if (sameDraftState(draft, nextText, nextTags) && (!advanceBeta || currentBetaVersion)) return currentBetaVersion;

  if (!advanceBeta && currentBetaVersion) {
    const currentBeta = recipe.versions.find((version) => version.version_string === currentBetaVersion);
    if (currentBeta) {
      const updatedMeta: VersionMeta = {
        id: currentBeta.id,
        branch_slug: recipe.branch.slug,
        version_string: currentBeta.version_string,
        status: currentBeta.status,
        changelog: currentBeta.changelog,
        parent_version: currentBeta.parent_version,
        current_beta_version: currentBeta.current_beta_version || null,
        tags: nextTags,
        created_at: currentBeta.created_at,
        updated_at: nextMeta.updated_at,
        is_draft: false,
      };
      writeVersion(recipe.slug, recipe.branch.slug, updatedMeta, nextText);
      return currentBetaVersion;
    }
  }

  if (!advanceBeta) return currentBetaVersion;

  const draftRecord = draft || normalizeVersion(recipe, nextMeta, nextText);
  const base = nextAutoBetaBase(recipe.branch, draftRecord);
  const previousBeta = latestAutoBetaForBase(recipe.branch, base);
  const snapshotVersion = nextAutoBetaVersion(recipe.branch, draftRecord);
  const snapshotMeta: VersionMeta = {
    id: generateId(),
    branch_slug: recipe.branch.slug,
    version_string: snapshotVersion,
    status: "beta",
    changelog: "",
    parent_version: previousBeta?.version_string || nextMeta.parent_version || null,
    current_beta_version: null,
    tags: nextTags,
    created_at: nextMeta.updated_at,
    updated_at: nextMeta.updated_at,
    is_draft: false,
  };
  writeVersion(recipe.slug, recipe.branch.slug, snapshotMeta, nextText);
  return snapshotVersion;
}

function ensureBranchDraft(recipe: RecipeRecord): { draft: VersionRecord | null; created: boolean } {
  if (recipe.draft) return { draft: recipe.draft, created: false };
  const source = resolveBranchBaseSource(recipe);
  if (!source) return { draft: null, created: false };
  const timestamp = nowIso();
  const meta = createDraftMeta(recipe.branch.slug, parseTags(source.tags), source.version_string, timestamp);
  writeDraft(recipe.slug, recipe.branch.slug, meta, source.cooklang_text);
  const branchMeta = { ...recipe.branch, updated_at: timestamp };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
  return { draft: normalizeVersion(recipe, meta, source.cooklang_text), created: true };
}

export function createRecipeBranch(slug: string, input: { name: string; source_version: string }) {
  const recipe = requireRecipe(slug, MAIN_BRANCH_SLUG);
  const source = recipe.versions.find((version) => version.version_string === input.source_version);
  if (!source) throw new Error("source version not found");
  if (!["released", "beta"].includes(source.status)) throw new Error("source version must be released or beta");
  const timestamp = nowIso();
  const branchMeta: RecipeBranchMeta = {
    id: generateId(),
    slug: branchSafeUniqueSlug(recipe, input.name),
    name: input.name.trim(),
    kind: "variant",
    upstream_branch_slug: MAIN_BRANCH_SLUG,
    forked_from_version_id: source.id,
    last_merged_upstream_version_id: source.id,
    created_at: timestamp,
    updated_at: timestamp,
    archived_at: null,
  };
  const nextRecipeMeta: RecipeMeta = {
    id: recipe.id,
    slug: recipe.slug,
    title: recipe.title,
    thumbnail_image_id: recipe.thumbnail_image_id || null,
    created_at: recipe.created_at,
    updated_at: timestamp,
    branches: [
      ...recipe.branches.map((branch) => ({
        id: branch.id,
        slug: branch.slug,
        name: branch.name,
        kind: branch.kind,
        upstream_branch_slug: branch.upstream_branch_slug,
        forked_from_version_id: branch.forked_from_version_id,
        last_merged_upstream_version_id: branch.last_merged_upstream_version_id,
        created_at: branch.created_at,
        updated_at: branch.updated_at,
        archived_at: branch.archived_at || null,
      })),
      branchMeta,
    ],
  };
  writeRecipeMeta(nextRecipeMeta);
  writeBranchMeta(recipe.slug, branchMeta);
  q.touchRecipeTime.run(timestamp, recipe.id);
  return loadRecipeRecordFromMeta(nextRecipeMeta, branchMeta.slug);
}

export function updateDraft(
  slug: string,
  updates: { cooklang_text?: string; tags?: string[] },
  options: { advance_beta?: boolean } = {},
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = requireRecipe(slug, branchSlug);
  const ensured = ensureBranchDraft(recipe);
  const draft = ensured.draft;
  if (!draft) throw new Error("no draft");
  const nextUpdatedAt = nowIso();
  const nextTags = updates.tags ?? parseTags(draft.tags);
  const nextText = updates.cooklang_text ?? draft.cooklang_text;
  const snapshotVersion = writeDraftSnapshotIfNeeded(
    recipe,
    draft,
    {
      ...draft,
      branch_slug: recipe.branch.slug,
      tags: nextTags,
      updated_at: nextUpdatedAt,
      is_draft: true,
      status: "draft",
      version_string: null,
    },
    nextText,
    options.advance_beta === true,
  );
  const nextMeta: VersionMeta = {
    ...draft,
    branch_slug: recipe.branch.slug,
    tags: nextTags,
    updated_at: nextUpdatedAt,
    is_draft: true,
    status: "draft",
    version_string: null,
    current_beta_version: snapshotVersion ?? draft.current_beta_version ?? null,
  };
  writeDraft(recipe.slug, recipe.branch.slug, nextMeta, nextText);
  const branchMeta = { ...recipe.branch, updated_at: nextUpdatedAt };
  updateRecipeAndBranchMeta(recipe, branchMeta, nextUpdatedAt);
  return { ok: true, snapshot_version: snapshotVersion };
}

function resolveVersionKey(recipe: RecipeRecord, versionString: string | null | undefined): string | null {
  if (!versionString) return null;
  if (versionString === "draft") return "draft";
  return recipe.versions.some((version) => version.version_string === versionString) ? versionString : null;
}

function resolveVersionId(recipe: RecipeRecord, versionString: string | null | undefined): string | null {
  if (!versionString || versionString === "draft") return null;
  return recipe.versions.find((version) => version.version_string === versionString)?.id || null;
}

export function listRecipeImages(slug: string, versionString?: string | null, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = requireRecipe(slug, branchSlug);
  const versionKey = resolveVersionKey(recipe, versionString);
  if (versionString && !versionKey) throw new Error("version not found");
  return q.imagesByRecipeAndBranchAndVersion.all(recipe.id, branchSlug, versionKey, versionKey) as Array<{
    id: string;
    recipe_id: string;
    version_id: string | null;
    branch_slug: string;
    version_key: string | null;
    filename: string;
    mime_type: string;
    created_at: string;
  }>;
}

export function attachRecipeImage(
  slug: string,
  image: { filename: string; mime_type: string; data: Buffer; version_string?: string | null },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = requireRecipe(slug, branchSlug);
  const versionKey = resolveVersionKey(recipe, image.version_string);
  const versionId = resolveVersionId(recipe, image.version_string);
  if (image.version_string && !versionKey) throw new Error("version not found");
  const id = generateId();
  writeImageAsset(recipe.slug, branchSlug, versionKey, { id, filename: image.filename, mime_type: image.mime_type, data: image.data });
  q.insertImage.run(id, recipe.id, versionId, branchSlug, versionKey, image.filename, image.mime_type);
  return { id, filename: image.filename, version_id: versionId, branch_slug: branchSlug, version_key: versionKey };
}

export function setRecipeThumbnail(
  slug: string,
  image: { filename: string; mime_type: string; data: Buffer } | null,
) {
  const recipe = requireRecipe(slug);
  const timestamp = nowIso();
  const currentThumbnailId = recipe.thumbnail_image_id || null;
  if (!image) {
    if (currentThumbnailId) deleteRecipeImage(currentThumbnailId);
    const nextRecipe: RecipeMeta = {
      id: recipe.id,
      slug: recipe.slug,
      title: recipe.title,
      thumbnail_image_id: null,
      created_at: recipe.created_at,
      updated_at: timestamp,
      branches: recipe.branches.map((branch) => ({
        id: branch.id,
        slug: branch.slug,
        name: branch.name,
        kind: branch.kind,
        upstream_branch_slug: branch.upstream_branch_slug,
        forked_from_version_id: branch.forked_from_version_id,
        last_merged_upstream_version_id: branch.last_merged_upstream_version_id,
        created_at: branch.created_at,
        updated_at: branch.updated_at,
        archived_at: branch.archived_at || null,
      })),
    };
    writeRecipeMeta(nextRecipe);
    q.touchRecipeTime.run(timestamp, recipe.id);
    return { ok: true, thumbnail_image_id: null };
  }

  const id = generateId();
  writeImageAsset(recipe.slug, null, null, { id, filename: image.filename, mime_type: image.mime_type, data: image.data });
  q.insertImage.run(id, recipe.id, null, MAIN_BRANCH_SLUG, null, image.filename, image.mime_type);
  q.updateRecipeThumbnail.run(id, timestamp, recipe.id);
  if (currentThumbnailId) deleteRecipeImage(currentThumbnailId);
  const nextRecipe: RecipeMeta = {
    id: recipe.id,
    slug: recipe.slug,
    title: recipe.title,
    thumbnail_image_id: id,
    created_at: recipe.created_at,
    updated_at: timestamp,
    branches: recipe.branches.map((branch) => ({
      id: branch.id,
      slug: branch.slug,
      name: branch.name,
      kind: branch.kind,
      upstream_branch_slug: branch.upstream_branch_slug,
      forked_from_version_id: branch.forked_from_version_id,
      last_merged_upstream_version_id: branch.last_merged_upstream_version_id,
      created_at: branch.created_at,
      updated_at: branch.updated_at,
      archived_at: branch.archived_at || null,
    })),
  };
  writeRecipeMeta(nextRecipe);
  return { ok: true, thumbnail_image_id: id };
}

export function deleteRecipeImage(id: string) {
  const image = q.imageById.get(id) as any;
  if (image?.slug) {
    removeImageAsset(imageFilePath(image.slug, image.version_key ? (image.branch_slug || MAIN_BRANCH_SLUG) : null, image.version_key || null, image.id, image.filename, image.mime_type));
  }
  q.clearRecipeThumbnailByImage.run(id);
  q.deleteImage.run(id);
}

interface CookLogRow {
  id: string;
  recipe_id: string;
  branch_slug: string;
  version_string: string | null;
  source_kind: string | null;
  source_version_string: string | null;
  cooklang_text: string | null;
  source_cooklang_text: string | null;
  tags: string | null;
  cooked_at: string;
  outcome: string;
  what_worked: string;
  problems_found: string;
  changes_to_try_next: string;
  freeform_notes: string;
  created_at: string;
  updated_at: string;
}

function rowToCookLog(row: CookLogRow): CookLogRecord {
  const sourceKind: CookLogSourceKind = row.source_kind === "draft" ? "draft" : "version";
  return {
    id: row.id,
    recipe_id: row.recipe_id,
    branch_slug: row.branch_slug,
    version_string: row.version_string ?? null,
    source_kind: sourceKind,
    source_version_string: row.source_version_string ?? row.version_string ?? null,
    cooklang_text: row.cooklang_text || "",
    source_cooklang_text: row.source_cooklang_text || "",
    tags: parseTags(row.tags),
    cooked_at: row.cooked_at,
    outcome: row.outcome || "",
    what_worked: row.what_worked || "",
    problems_found: row.problems_found || "",
    changes_to_try_next: row.changes_to_try_next || "",
    freeform_notes: row.freeform_notes || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function cookLogCooklangPath(slug: string, branchSlug: string, id: string): string {
  return path.join(cookLogsDir(slug, branchSlug), `${id}.cook`);
}

function hydrateCookLogFromFs(slug: string, branchSlug: string, row: CookLogRow): CookLogRecord {
  const base = rowToCookLog(row);
  try {
    const filePath = cookLogPath(slug, branchSlug, row.id);
    if (fs.existsSync(filePath)) {
      const fileData = readJson<Partial<CookLogRecord>>(filePath);
      base.cooked_at = fileData.cooked_at ?? base.cooked_at;
      base.outcome = fileData.outcome ?? base.outcome;
      base.what_worked = fileData.what_worked ?? base.what_worked;
      base.problems_found = fileData.problems_found ?? base.problems_found;
      base.changes_to_try_next = fileData.changes_to_try_next ?? base.changes_to_try_next;
      base.freeform_notes = fileData.freeform_notes ?? base.freeform_notes;
      if (typeof fileData.cooklang_text === "string") base.cooklang_text = fileData.cooklang_text;
      if (typeof fileData.source_cooklang_text === "string") base.source_cooklang_text = fileData.source_cooklang_text;
      if (Array.isArray(fileData.tags)) base.tags = fileData.tags.map(String);
      if (fileData.source_kind === "draft" || fileData.source_kind === "version") base.source_kind = fileData.source_kind;
      if (fileData.source_version_string !== undefined) base.source_version_string = fileData.source_version_string ?? null;
      if (fileData.version_string !== undefined) base.version_string = fileData.version_string ?? null;
    }
  } catch {
    // fall back to DB row
  }
  // The .cook sidecar is the authoritative source for the cooklang body when
  // present — it survives JSON-shape changes and is human-diffable on disk.
  try {
    const cookPath = cookLogCooklangPath(slug, branchSlug, row.id);
    if (fs.existsSync(cookPath)) {
      base.cooklang_text = fs.readFileSync(cookPath, "utf8");
    }
  } catch {
    // ignore
  }
  return base;
}

function writeCookLogFile(slug: string, log: CookLogRecord): void {
  const filePath = cookLogPath(slug, log.branch_slug, log.id);
  ensureDir(path.dirname(filePath));
  writeJson(filePath, log);
  const cookPath = cookLogCooklangPath(slug, log.branch_slug, log.id);
  if (log.cooklang_text) {
    fs.writeFileSync(cookPath, log.cooklang_text, "utf8");
  } else if (fs.existsSync(cookPath)) {
    fs.rmSync(cookPath, { force: true });
  }
}

function loadLatestCookLogForBranch(slug: string, branchSlug: string, recipeId: string): CookLogRecord | null {
  const row = q.latestCookLogForBranch.get(recipeId, branchSlug) as CookLogRow | undefined;
  if (!row) return null;
  return hydrateCookLogFromFs(slug, branchSlug, row);
}

export function listBranchCookLogs(slug: string, branchSlug: string = MAIN_BRANCH_SLUG): CookLogRecord[] {
  const recipe = requireRecipe(slug, branchSlug);
  const rows = q.cookLogsByBranch.all(recipe.id, branchSlug) as CookLogRow[];
  return rows.map((row) => hydrateCookLogFromFs(slug, branchSlug, row));
}

export function listVersionCookLogs(
  slug: string,
  versionString: string,
  branchSlug: string = MAIN_BRANCH_SLUG,
): CookLogRecord[] {
  const recipe = requireRecipe(slug, branchSlug);
  const rows = q.cookLogsByBranchVersion.all(recipe.id, branchSlug, versionString, versionString) as CookLogRow[];
  return rows.map((row) => hydrateCookLogFromFs(slug, branchSlug, row));
}

export function getCookLog(
  slug: string,
  id: string,
  branchSlug: string = MAIN_BRANCH_SLUG,
): CookLogRecord | null {
  const recipe = requireRecipe(slug, branchSlug);
  const row = q.cookLogById.get(id) as CookLogRow | undefined;
  if (!row || row.recipe_id !== recipe.id || row.branch_slug !== branchSlug) return null;
  return hydrateCookLogFromFs(slug, branchSlug, row);
}

interface CookLogInput {
  cooked_at?: string;
  outcome: string;
  what_worked?: string;
  problems_found?: string;
  changes_to_try_next?: string;
  freeform_notes?: string;
  /** Optional override of the snapshot taken from `source`. */
  cooklang_text?: string;
  tags?: string[];
}

export type CookLogSourceSpec =
  | { kind: "draft" }
  | { kind: "version"; version_string: string };

function validateCookedAt(raw: string | undefined): string {
  if (!raw) return nowIso();
  const trimmed = String(raw).trim();
  if (!trimmed) return nowIso();
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new Error("invalid cooked_at");
  return parsed.toISOString();
}

function resolveCookLogSource(
  recipe: RecipeRecord,
  source: CookLogSourceSpec,
): { cooklang_text: string; tags: string[]; version_string: string | null } {
  if (source.kind === "draft") {
    if (!recipe.draft) throw new Error("draft not found");
    return {
      cooklang_text: recipe.draft.cooklang_text || "",
      tags: parseTags(recipe.draft.tags),
      version_string: null,
    };
  }
  const version = recipe.versions.find(
    (entry) => entry.version_string === source.version_string && !entry.is_draft,
  );
  if (!version) throw new Error("version not found");
  return {
    cooklang_text: version.cooklang_text || "",
    tags: parseTags(version.tags),
    version_string: version.version_string,
  };
}

export function createCookLog(
  slug: string,
  source: CookLogSourceSpec,
  input: CookLogInput,
  branchSlug: string = MAIN_BRANCH_SLUG,
): CookLogRecord {
  const recipe = requireRecipe(slug, branchSlug);
  const resolved = resolveCookLogSource(recipe, source);
  const outcome = String(input.outcome || "").trim();
  if (!outcome) throw new Error("outcome is required");
  const cookedAt = validateCookedAt(input.cooked_at);
  const timestamp = nowIso();
  const cooklangText = typeof input.cooklang_text === "string"
    ? input.cooklang_text
    : resolved.cooklang_text;
  const tags = Array.isArray(input.tags)
    ? input.tags.map((t) => String(t))
    : resolved.tags;
  const log: CookLogRecord = {
    id: generateId(),
    recipe_id: recipe.id,
    branch_slug: branchSlug,
    version_string: resolved.version_string,
    source_kind: source.kind,
    source_version_string: resolved.version_string,
    cooklang_text: cooklangText,
    source_cooklang_text: resolved.cooklang_text,
    tags,
    cooked_at: cookedAt,
    outcome,
    what_worked: String(input.what_worked || ""),
    problems_found: String(input.problems_found || ""),
    changes_to_try_next: String(input.changes_to_try_next || ""),
    freeform_notes: String(input.freeform_notes || ""),
    created_at: timestamp,
    updated_at: timestamp,
  };
  writeCookLogFile(slug, log);
  q.insertCookLog.run(
    log.id,
    log.recipe_id,
    log.branch_slug,
    log.version_string,
    log.source_kind,
    log.source_version_string,
    log.cooklang_text,
    log.source_cooklang_text,
    JSON.stringify(log.tags),
    log.cooked_at,
    log.outcome,
    log.what_worked,
    log.problems_found,
    log.changes_to_try_next,
    log.freeform_notes,
    log.created_at,
    log.updated_at,
  );
  const branchMeta = recipe.branches.find((branch) => branch.slug === branchSlug);
  if (branchMeta) {
    const nextBranchMeta: RecipeBranchMeta = {
      id: branchMeta.id,
      slug: branchMeta.slug,
      name: branchMeta.name,
      kind: branchMeta.kind,
      upstream_branch_slug: branchMeta.upstream_branch_slug,
      forked_from_version_id: branchMeta.forked_from_version_id,
      last_merged_upstream_version_id: branchMeta.last_merged_upstream_version_id,
      created_at: branchMeta.created_at,
      updated_at: timestamp,
      archived_at: branchMeta.archived_at || null,
    };
    updateRecipeAndBranchMeta(recipe, nextBranchMeta, timestamp);
  }
  return log;
}

export function updateCookLog(
  slug: string,
  id: string,
  patch: Partial<CookLogInput>,
  branchSlug: string = MAIN_BRANCH_SLUG,
): CookLogRecord {
  const existing = getCookLog(slug, id, branchSlug);
  if (!existing) throw new Error("cook log not found");
  const next: CookLogRecord = {
    ...existing,
    cooked_at: patch.cooked_at !== undefined ? validateCookedAt(patch.cooked_at) : existing.cooked_at,
    outcome: patch.outcome !== undefined ? String(patch.outcome).trim() : existing.outcome,
    what_worked: patch.what_worked !== undefined ? String(patch.what_worked) : existing.what_worked,
    problems_found: patch.problems_found !== undefined ? String(patch.problems_found) : existing.problems_found,
    changes_to_try_next: patch.changes_to_try_next !== undefined ? String(patch.changes_to_try_next) : existing.changes_to_try_next,
    freeform_notes: patch.freeform_notes !== undefined ? String(patch.freeform_notes) : existing.freeform_notes,
    cooklang_text: patch.cooklang_text !== undefined ? String(patch.cooklang_text) : existing.cooklang_text,
    tags: Array.isArray(patch.tags) ? patch.tags.map((t) => String(t)) : existing.tags,
    updated_at: nowIso(),
  };
  if (!next.outcome) throw new Error("outcome is required");
  writeCookLogFile(slug, next);
  q.updateCookLog.run(
    next.cooked_at,
    next.outcome,
    next.what_worked,
    next.problems_found,
    next.changes_to_try_next,
    next.freeform_notes,
    next.cooklang_text,
    JSON.stringify(next.tags),
    next.updated_at,
    next.id,
  );
  return next;
}

export function deleteCookLog(slug: string, id: string, branchSlug: string = MAIN_BRANCH_SLUG): void {
  const existing = getCookLog(slug, id, branchSlug);
  if (!existing) return;
  fs.rmSync(cookLogPath(slug, branchSlug, id), { force: true });
  fs.rmSync(cookLogCooklangPath(slug, branchSlug, id), { force: true });
  q.deleteCookLog.run(id);
}

export function readRecipeImage(id: string): { data: Buffer; mime_type: string } | null {
  const image = q.imageById.get(id) as any;
  if (!image?.slug) return null;
  const branchSlug = image.version_key ? (image.branch_slug || MAIN_BRANCH_SLUG) : null;
  const filePath = imageFilePath(image.slug, branchSlug, image.version_key || null, image.id, image.filename, image.mime_type);
  if (fs.existsSync(filePath)) {
    return { data: fs.readFileSync(filePath), mime_type: image.mime_type };
  }
  if (image.data && image.data.length > 0) {
    const data = Buffer.from(image.data);
    writeImageAsset(image.slug, branchSlug, image.version_key || null, {
      id: image.id,
      filename: image.filename,
      mime_type: image.mime_type,
      data,
    });
    q.clearImageData.run(image.id);
    return { data, mime_type: image.mime_type };
  }
  return null;
}

function migrateStoredImagesToFiles(): void {
  const rows = q.imagesNeedingMigration.all() as any[];
  for (const row of rows) {
    if (!row?.slug || !row?.data || row.data.length === 0) continue;
    const branchSlug = row.version_key ? (row.branch_slug || MAIN_BRANCH_SLUG) : null;
    writeImageAsset(row.slug, branchSlug, row.version_key || null, {
      id: row.id,
      filename: row.filename,
      mime_type: row.mime_type,
      data: Buffer.from(row.data),
    });
    q.clearImageData.run(row.id);
  }
}

migrateStoredImagesToFiles();

function releaseSourceVersion(
  recipe: RecipeRecord,
  source: VersionRecord,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
) {
  if (!source.cooklang_text.trim()) throw new Error(source.is_draft ? "draft is empty" : "version is empty");
  if (recipe.versions.some((version) => version.version_string === release.version_string)) {
    throw new Error("version already exists");
  }

  const timestamp = nowIso();
  const previousComparable = latestComparableVersion(recipe.branch);
  const releasedMeta: VersionMeta = {
    id: source.is_draft ? generateId() : source.id,
    branch_slug: recipe.branch.slug,
    version_string: release.version_string,
    status: release.status,
    changelog: release.changelog || "",
    parent_version: previousComparable?.version_string || source.parent_version || null,
    current_beta_version: null,
    tags: parseTags(source.tags),
    created_at: source.created_at,
    updated_at: timestamp,
    is_draft: false,
  };
  writeVersion(recipe.slug, recipe.branch.slug, releasedMeta, source.cooklang_text);

  if (source.is_draft) {
    for (const image of listRecipeImages(recipe.slug, "draft", recipe.branch.slug)) {
      deleteRecipeImage(image.id);
    }
    removeDir(draftDir(recipe.slug, recipe.branch.slug));
  }

  const branchMeta = { ...recipe.branch, updated_at: timestamp };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
  return { ok: true, version_string: release.version_string };
}

export function releaseDraft(
  slug: string,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = requireRecipe(slug, branchSlug);
  const draft = recipe.draft;
  if (!draft) throw new Error("no draft to release");
  return releaseSourceVersion(recipe, draft, release);
}

export function releaseVersion(
  slug: string,
  sourceVersionString: string,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = requireRecipe(slug, branchSlug);
  const source = recipe.versions.find((version) => version.version_string === sourceVersionString);
  if (!source) throw new Error("version not found");
  return releaseSourceVersion(recipe, source, release);
}

export function promoteCookLog(
  slug: string,
  logId: string,
  release: { version_string: string; status: "released" | "beta" | "archived"; changelog?: string },
  branchSlug = MAIN_BRANCH_SLUG,
) {
  const recipe = requireRecipe(slug, branchSlug);
  const log = getCookLog(slug, logId, branchSlug);
  if (!log) throw new Error("cook log not found");
  if (!log.cooklang_text.trim()) throw new Error("cook log has no recipe text to promote");
  // Synthetic VersionRecord just for releaseSourceVersion. is_draft=false so it
  // skips the draft-cleanup branch; the log itself is preserved.
  const syntheticSource: VersionRecord = {
    id: generateId(),
    recipe_id: recipe.id,
    branch_slug: recipe.branch.slug,
    version_string: null,
    status: "released",
    changelog: "",
    parent_version: log.source_version_string,
    current_beta_version: null,
    tags: JSON.stringify(log.tags || []),
    created_at: log.created_at,
    updated_at: log.updated_at,
    notes: null,
    servings: null,
    is_draft: false,
    cooklang_text: log.cooklang_text,
  };
  return releaseSourceVersion(recipe, syntheticSource, release);
}

export function forkVersionToDraft(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((entry) => entry.version_string === versionString);
  if (!version) throw new Error("version not found");

  const timestamp = nowIso();
  const draftMeta: VersionMeta = {
    id: recipe.draft?.id || generateId(),
    branch_slug: recipe.branch.slug,
    version_string: null,
    status: "draft",
    changelog: "",
    parent_version: version.version_string,
    current_beta_version: null,
    tags: parseTags(version.tags),
    created_at: recipe.draft?.created_at || timestamp,
    updated_at: timestamp,
    is_draft: true,
  };

  writeDraft(slug, recipe.branch.slug, draftMeta, version.cooklang_text);
  const branchMeta = { ...recipe.branch, updated_at: timestamp };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
}

// Fork a cook log into the draft so the next iteration starts from "what I
// actually cooked" instead of from a release. Parent is the log's source
// (the version or draft it was snapshotted from) so once the user saves with
// advance_beta, the new beta lands in the right lineage.
export function forkCookLogToDraft(slug: string, logId: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = requireRecipe(slug, branchSlug);
  const log = getCookLog(slug, logId, branchSlug);
  if (!log) throw new Error("cook log not found");
  if (!log.cooklang_text.trim()) throw new Error("cook log has no recipe text to fork");

  const timestamp = nowIso();
  const draftMeta: VersionMeta = {
    id: recipe.draft?.id || generateId(),
    branch_slug: recipe.branch.slug,
    version_string: null,
    status: "draft",
    changelog: "",
    parent_version: log.source_version_string,
    current_beta_version: null,
    tags: Array.isArray(log.tags) ? log.tags.map(String) : [],
    created_at: recipe.draft?.created_at || timestamp,
    updated_at: timestamp,
    is_draft: true,
  };
  writeDraft(slug, recipe.branch.slug, draftMeta, log.cooklang_text);
  const branchMeta = { ...recipe.branch, updated_at: timestamp };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
  return { ok: true };
}

export function forkBranchHeadToDraft(slug: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = requireRecipe(slug, branchSlug);
  const source = latestComparableVersion(recipe.branch) || recipe.source_version;
  if (!source) throw new Error("no branch head to fork");
  const timestamp = nowIso();
  const draftMeta: VersionMeta = {
    id: recipe.draft?.id || generateId(),
    branch_slug: recipe.branch.slug,
    version_string: null,
    status: "draft",
    changelog: "",
    parent_version: source.version_string,
    current_beta_version: null,
    tags: parseTags(source.tags),
    created_at: recipe.draft?.created_at || timestamp,
    updated_at: timestamp,
    is_draft: true,
  };
  writeDraft(slug, recipe.branch.slug, draftMeta, source.cooklang_text);
  const branchMeta = { ...recipe.branch, updated_at: timestamp };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
  return { ok: true };
}

export function updateVersionContent(slug: string, versionString: string, cooklangText: string, tags?: string[], branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((entry) => entry.version_string === versionString);
  if (!version) throw new Error("version not found");

  const timestamp = nowIso();
  const nextMeta: VersionMeta = {
    id: version.id,
    branch_slug: recipe.branch.slug,
    version_string: version.version_string,
    status: version.status,
    changelog: version.changelog,
    parent_version: version.parent_version,
    current_beta_version: version.current_beta_version || null,
    tags: tags ?? parseTags(version.tags),
    created_at: version.created_at,
    updated_at: timestamp,
    is_draft: false,
  };

  writeVersion(slug, recipe.branch.slug, nextMeta, cooklangText);
  const branchMeta = { ...recipe.branch, updated_at: timestamp };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
}

export function updateDraftNotes(slug: string, notes: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = requireRecipe(slug, branchSlug);
  const draft = recipe.draft;
  if (!draft) throw new Error("no draft");
  const timestamp = nowIso();
  const nextMeta: VersionMeta = {
    ...draft,
    branch_slug: recipe.branch.slug,
    tags: parseTags(draft.tags),
    updated_at: timestamp,
    is_draft: true,
    version_string: null,
    status: "draft",
    current_beta_version: draft.current_beta_version || null,
  };
  const nextText = upsertNotesInCooklang(draft.cooklang_text, notes.trim());
  const snapshotVersion = writeDraftSnapshotIfNeeded(recipe, draft, nextMeta, nextText, false);
  nextMeta.current_beta_version = snapshotVersion ?? nextMeta.current_beta_version;
  writeDraft(slug, recipe.branch.slug, nextMeta, nextText);
  const branchMeta = { ...recipe.branch, updated_at: timestamp };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
}

export function updateVersionNotes(slug: string, versionString: string, notes: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((entry) => entry.version_string === versionString);
  if (!version) throw new Error("version not found");

  const timestamp = nowIso();
  const nextMeta: VersionMeta = {
    id: version.id,
    branch_slug: recipe.branch.slug,
    version_string: version.version_string,
    status: version.status,
    changelog: version.changelog,
    parent_version: version.parent_version,
    current_beta_version: version.current_beta_version || null,
    tags: parseTags(version.tags),
    created_at: version.created_at,
    updated_at: timestamp,
    is_draft: false,
  };
  writeVersion(slug, recipe.branch.slug, nextMeta, upsertNotesInCooklang(version.cooklang_text, notes.trim()));
  const branchMeta = { ...recipe.branch, updated_at: timestamp };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
}

export function deleteVersion(slug: string, versionString: string, branchSlug = MAIN_BRANCH_SLUG) {
  const recipe = requireRecipe(slug, branchSlug);
  const version = recipe.versions.find((entry) => entry.version_string === versionString);
  if (!version) throw new Error("version not found");
  if (version.is_draft) throw new Error("cannot delete draft");

  for (const image of listRecipeImages(slug, versionString, recipe.branch.slug)) {
    deleteRecipeImage(image.id);
  }
  removeDir(versionDir(slug, recipe.branch.slug, versionString));
  const branchMeta = { ...recipe.branch, updated_at: nowIso() };
  updateRecipeAndBranchMeta(recipe, branchMeta, branchMeta.updated_at);
}

function lineEdits(base: string, next: string): MergeEdit[] {
  if (base === next) return [];
  const baseLines = base.split("\n");
  const nextLines = next.split("\n");
  let prefix = 0;
  while (prefix < baseLines.length && prefix < nextLines.length && baseLines[prefix] === nextLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < (baseLines.length - prefix) &&
    suffix < (nextLines.length - prefix) &&
    baseLines[baseLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
  ) suffix += 1;
  return [{
    baseStart: prefix,
    baseEnd: baseLines.length - suffix,
    replacement: nextLines.slice(prefix, nextLines.length - suffix),
  }];
}

function editsOverlap(a: MergeEdit, b: MergeEdit): boolean {
  const aStart = a.baseStart;
  const aEnd = a.baseEnd;
  const bStart = b.baseStart;
  const bEnd = b.baseEnd;
  if (aStart === aEnd && bStart === bEnd) return aStart === bStart;
  return aStart < bEnd && bStart < aEnd;
}

function applyEdits(baseLines: string[], edits: MergeEdit[]): string {
  const ordered = [...edits].sort((a, b) => a.baseStart - b.baseStart);
  const out: string[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    out.push(...baseLines.slice(cursor, edit.baseStart));
    out.push(...edit.replacement);
    cursor = edit.baseEnd;
  }
  out.push(...baseLines.slice(cursor));
  return out.join("\n");
}

function mergeCooklangText(base: string, ours: string, theirs: string) {
  if (theirs === base) {
    return { status: "noop" as const, merged_text: ours, conflicts: [] };
  }
  if (ours === base || ours === theirs) {
    return { status: "clean" as const, merged_text: theirs, conflicts: [] };
  }
  if (theirs === ours) {
    return { status: "clean" as const, merged_text: ours, conflicts: [] };
  }

  const ourEdits = lineEdits(base, ours);
  const theirEdits = lineEdits(base, theirs);
  const conflicts: Array<Record<string, unknown>> = [];
  for (const ourEdit of ourEdits) {
    for (const theirEdit of theirEdits) {
      if (!editsOverlap(ourEdit, theirEdit)) continue;
      if (JSON.stringify(ourEdit) === JSON.stringify(theirEdit)) continue;
      conflicts.push({
        base_start: ourEdit.baseStart,
        base_end: Math.max(ourEdit.baseEnd, theirEdit.baseEnd),
        ours: ourEdit.replacement.join("\n"),
        theirs: theirEdit.replacement.join("\n"),
      });
    }
  }
  if (conflicts.length) return { status: "conflict" as const, merged_text: null, conflicts };
  const merged = applyEdits(base.split("\n"), [...ourEdits, ...theirEdits]);
  return { status: "clean" as const, merged_text: merged, conflicts: [] };
}

function syncPreviewContext(slug: string, branchSlug: string) {
  const recipe = requireRecipe(slug, branchSlug);
  if (recipe.branch.kind !== "variant" || recipe.branch.upstream_branch_slug !== MAIN_BRANCH_SLUG) {
    throw new Error("only main -> variant sync is supported");
  }
  const mainRecipe = requireRecipe(slug, MAIN_BRANCH_SLUG);
  const base = findVersionById(recipe, recipe.branch.last_merged_upstream_version_id || recipe.branch.forked_from_version_id);
  const theirs = latestComparableVersion(mainRecipe.branch);
  const ours = recipe.draft || latestComparableVersion(recipe.branch) || recipe.source_version;
  if (!base || !theirs || !ours) throw new Error("sync baseline unavailable");
  return { recipe, base, theirs, ours };
}

export function previewBranchSync(slug: string, branchSlug: string) {
  const { recipe, base, theirs, ours } = syncPreviewContext(slug, branchSlug);
  const merged = mergeCooklangText(base.cooklang_text, ours.cooklang_text, theirs.cooklang_text);
  return {
    branch_slug: recipe.branch.slug,
    base_version: base.version_string,
    upstream_version: theirs.version_string,
    branch_version: ours.is_draft ? "draft" : ours.version_string,
    status: merged.status,
    merged_text: merged.merged_text,
    conflicts: merged.conflicts,
  };
}

export function applyBranchSync(slug: string, branchSlug: string) {
  const preview = previewBranchSync(slug, branchSlug);
  if (preview.status === "conflict") return preview;
  const recipe = requireRecipe(slug, branchSlug);
  const ensured = ensureBranchDraft(recipe);
  const draft = ensured.draft;
  if (!draft) throw new Error("no draft");
  const upstream = requireRecipe(slug, MAIN_BRANCH_SLUG).versions.find((version) => version.version_string === preview.upstream_version);
  if (!upstream) throw new Error("upstream version not found");
  const timestamp = nowIso();
  const nextMeta: VersionMeta = {
    ...draft,
    branch_slug: recipe.branch.slug,
    tags: parseTags(draft.tags),
    updated_at: timestamp,
    version_string: null,
    status: "draft",
    is_draft: true,
    current_beta_version: draft.current_beta_version || null,
  };
  writeDraft(recipe.slug, recipe.branch.slug, nextMeta, preview.merged_text || draft.cooklang_text);
  const branchMeta: RecipeBranchMeta = {
    ...recipe.branch,
    last_merged_upstream_version_id: upstream.id,
    updated_at: timestamp,
  };
  updateRecipeAndBranchMeta(recipe, branchMeta, timestamp);
  return {
    ...preview,
    ok: true,
    draft_created: ensured.created,
  };
}

// ── Recipe reference resolution ──────────────────────────────────────────────

export interface BacklinkRecord {
  from_slug: string;
  from_title: string;
  from_version: string | null;
  pinned: boolean;
}

function resolveOne(rawName: string): RecipeReferenceResolution {
  const { slug, version, categoryPath } = parseReferencePath(rawName);
  const recipe = slug ? loadRecipeMeta(slug) : null;
  if (!recipe) {
    return {
      found: false,
      slug,
      raw_path: String(rawName || ""),
      category_path: categoryPath,
      version_string: version,
      pinned: !!version,
      title: null,
      url: null,
    };
  }
  const branchMeta = (recipe.branches || []).find((branch) => branch.slug === MAIN_BRANCH_SLUG);
  const branch = branchMeta ? loadBranchRecord(recipe, branchMeta) : null;
  const targetVersion = version || branch?.current_best_release?.version_string || null;
  return {
    found: true,
    slug,
    raw_path: String(rawName || ""),
    category_path: categoryPath,
    version_string: targetVersion,
    pinned: !!version,
    title: recipe.title,
    url: targetVersion
      ? `/recipe/${slug}/versions/${encodeURIComponent(targetVersion)}`
      : `/recipe/${slug}`,
  };
}

function refKey(entry: { reference_path?: string | null; name?: string }): string {
  return (entry.reference_path && entry.reference_path.length > 0)
    ? entry.reference_path
    : (entry.name || "");
}

export function enrichRecipeReferences(parsed: ParsedRecipe): ParsedRecipe {
  if (!parsed?.ingredients) return parsed;
  const cache = new Map<string, RecipeReferenceResolution>();
  const resolve = (rawPath: string): RecipeReferenceResolution => {
    if (cache.has(rawPath)) return cache.get(rawPath)!;
    const resolution = resolveOne(rawPath);
    cache.set(rawPath, resolution);
    return resolution;
  };
  for (const ingredient of parsed.ingredients) {
    if (!ingredient.recipe_reference) continue;
    ingredient.recipe_reference_resolution = resolve(refKey(ingredient));
  }
  if (parsed.ingredient_summary?.flat) {
    for (const ingredient of parsed.ingredient_summary.flat) {
      if (!ingredient.recipe_reference) continue;
      ingredient.recipe_reference_resolution = resolve(refKey(ingredient));
    }
  }
  if (parsed.ingredient_summary?.sections) {
    for (const section of parsed.ingredient_summary.sections) {
      for (const ingredient of section.ingredients || []) {
        if (!ingredient.recipe_reference) continue;
        ingredient.recipe_reference_resolution = resolve(refKey(ingredient));
      }
    }
  }
  if (parsed.steps) {
    for (const stepTokens of parsed.steps) {
      for (const token of stepTokens) {
        if (token.type !== "ingredient" || !token.recipe_reference) continue;
        token.recipe_reference_resolution = resolve(refKey(token));
      }
    }
  }
  return parsed;
}

export function collectUnresolvedReferences(parsed: ParsedRecipe): Array<{ raw_path: string; slug: string }> {
  const unresolved: Array<{ raw_path: string; slug: string }> = [];
  const seen = new Set<string>();
  for (const ingredient of parsed?.ingredients || []) {
    if (!ingredient.recipe_reference) continue;
    const res = ingredient.recipe_reference_resolution
      || resolveOne(refKey(ingredient));
    if (res.found) continue;
    if (seen.has(res.raw_path)) continue;
    seen.add(res.raw_path);
    unresolved.push({ raw_path: res.raw_path, slug: res.slug });
  }
  return unresolved;
}

export function listBacklinks(slug: string): BacklinkRecord[] {
  if (!loadRecipeMeta(slug)) throw new Error("not found");
  const results: BacklinkRecord[] = [];
  for (const recipe of loadAllRecipeMetas()) {
    if (recipe.slug === slug) continue;
    let matched = false;
    let matchedVersion: string | null = null;
    let pinned = false;
    for (const branch of recipe.branches || []) {
      if (matched) break;
      const versions = loadVersions(recipe, branch.slug);
      const draft = loadDraft(recipe, branch.slug);
      const candidates: VersionRecord[] = [];
      if (draft) candidates.push(draft);
      for (const v of versions) {
        if (v.status === "released" || v.status === "beta") candidates.push(v);
      }
      for (const version of candidates) {
        const parsed = parseCooklang(version.cooklang_text || "");
        for (const ingredient of parsed.ingredients || []) {
          if (!ingredient.recipe_reference) continue;
          const { slug: refSlug, version: refVersion } = parseReferencePath(refKey(ingredient));
          if (refSlug !== slug) continue;
          matched = true;
          matchedVersion = refVersion;
          pinned = !!refVersion;
          break;
        }
        if (matched) break;
      }
    }
    if (matched) {
      results.push({
        from_slug: recipe.slug,
        from_title: recipe.title,
        from_version: matchedVersion,
        pinned,
      });
    }
  }
  return results;
}
