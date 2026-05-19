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
