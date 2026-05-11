import fs from "fs";
import path from "path";
import { DATA_DIR, db, generateId, q, slugify } from "./db.js";
import { parseCooklang } from "./cooklang.js";

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

interface RecipeBranchRecord extends RecipeBranchMeta {
  latest_released: string | null;
  latest_beta: string | null;
  versions: VersionRecord[];
  draft: VersionRecord | null;
  source_version: VersionRecord | null;
  has_unreleased_changes: boolean;
  draft_change_label: string | null;
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

function loadBranchRecord(recipe: RecipeMeta, branchMeta: RecipeBranchMeta): RecipeBranchRecord {
  const versions = loadVersions(recipe, branchMeta.slug);
  const draft = loadDraft(recipe, branchMeta.slug);
  const latestReleased = latestVersionByStatus(versions, "released");
  const latestBeta = latestVersionByStatus(versions, "beta");
  const sourceVersion = branchMeta.kind === "variant"
    ? findVersionById(recipe, branchMeta.forked_from_version_id)
    : null;
  const record: RecipeBranchRecord = {
    ...branchMeta,
    versions,
    draft,
    source_version: sourceVersion,
    latest_released: latestReleased?.version_string || null,
    latest_beta: latestBeta?.version_string || null,
    has_unreleased_changes: false,
    draft_change_label: null,
  };
  record.has_unreleased_changes = hasDraftChanges(record);
  record.draft_change_label = draftChangeLabel(record);
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
