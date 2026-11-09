// ── What counts as an icon (pure) ───────────────────────────────────────────
// One emoji ("🦃", "👩🏽‍🍳", "🇯🇵") or a bundled icon ("lucide:wheat"). Used for
// the icon set on a recipe or folder, and for `icon:` in a recipe's
// frontmatter. The client checks the same rule (public/js/recipe-icons.js).

const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });

// The icon, trimmed, or null when it isn't one.
export function iconOrNull(raw: unknown): string | null {
  const icon = String(raw ?? "").trim();
  if (!icon) return null;
  if (/^lucide:[a-z0-9-]{1,40}$/.test(icon)) return icon;
  const single = icon.length <= 32 && [...graphemes.segment(icon)].length === 1;
  if (single && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(icon)) return icon;
  return null;
}
