// ── Version-string helpers (pure) ────────────────────────────────────────────
// Manipulates AjiLab version strings (`v1.0`, `v1.1-beta.2`, …) and answers
// "which version is the latest one I'd diff against?" given a sorted list.

import type { RecipeStatus, VersionRecord } from "../recipe-store.ts";

export function incrementVersionString(version: string): string {
  const clean = version.replace(/^v/, "");
  if (clean.includes("-beta")) return `v${clean.replace(/-beta.*$/, "")}`;
  const parts = clean.split(".");
  if (parts.length >= 2) {
    parts[parts.length - 1] = String(parseInt(parts[parts.length - 1] || "0", 10) + 1);
    return `v${parts.join(".")}`;
  }
  return `${version}.1`;
}

export function stripBetaSuffix(version: string): string {
  return version.includes("-beta") ? `v${version.replace(/^v/, "").replace(/-beta.*$/, "")}` : version;
}

export function sortVersions(versions: VersionRecord[]): VersionRecord[] {
  return [...versions].sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function latestVersionByStatus(versions: VersionRecord[], status: Exclude<RecipeStatus, "draft">): VersionRecord | null {
  return versions.find((version) => version.status === status) || null;
}

export function latestComparableVersion(versions: VersionRecord[]): VersionRecord | null {
  return versions
    .filter((version) => version.status === "released" || version.status === "beta")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0] || null;
}

// The beta a draft's next snapshot would get (`v1.1-beta.2`).
export function nextAutoBetaBase(versions: VersionRecord[], draft: VersionRecord, latestReleased: string | null, latestBeta: string | null): string {
  const seed = draft.parent_version
    ? (draft.parent_version.includes("-beta") ? stripBetaSuffix(draft.parent_version) : incrementVersionString(draft.parent_version))
    : (latestReleased ? incrementVersionString(latestReleased) : (latestBeta ? stripBetaSuffix(latestBeta) : "v1.0"));
  let candidate = seed;
  while (versions.some((v) => v.version_string === candidate)) candidate = incrementVersionString(candidate);
  return candidate;
}

export function nextAutoBetaVersion(versions: VersionRecord[], base: string): string {
  const prefix = `${base}-beta.`;
  const max = versions
    .map((v) => v.version_string || "")
    .filter((s) => s.startsWith(prefix))
    .map((s) => Number(s.slice(prefix.length)))
    .filter((n) => Number.isFinite(n))
    .reduce((m, n) => Math.max(m, n), 0);
  return `${prefix}${max + 1}`;
}

export function nextBetaForDraft(versions: VersionRecord[], draft: VersionRecord | null, latestReleased: string | null, latestBeta: string | null): string | null {
  if (!draft) return null;
  return nextAutoBetaVersion(versions, nextAutoBetaBase(versions, draft, latestReleased, latestBeta));
}
