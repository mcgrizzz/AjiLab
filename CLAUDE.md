# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AjiLab — a self-hosted recipe lab. Users write Cooklang recipes and improve them by testing: the **working copy** (stored as the draft) is saved as a fixed, numbered **test** ("Test 4 · more water"), cooked from paper, and **adopted** into the next **version** (v1.2; the newest is "current"). Cooks are recorded against the version or test they were cooked from, and everything can be diffed. See `docs/VERSIONING-DESIGN.md`. Branches and 3-way merge exist in the API only.

## Commands

```bash
npm start                 # tsx --experimental-wasm-modules src/server.ts
npm run dev               # same with --watch
npm test                  # node test runner via tsx, runs test/*.test.js
npm run build:editor      # esbuild → public/vendor/codemirror.js (REQUIRED before first start)
npm run restore           # scripts/restore.ts — restores a pg_dump file
npm run transfer          # scripts/transfer.ts — copies data between Postgres instances

# Run a single test file:
tsx --test test/cooklang.test.js

# Full stack (Postgres + app + nightly backup):
docker compose up -d
```

`--experimental-wasm-modules` is required because `@cooklang/cooklang` ships as WASM.

Local dev without Docker needs Postgres 18 reachable at `DATABASE_URL` (defaults to `postgresql://ajilab:ajilab@localhost:5432/ajilab`). The schema applies itself on startup — no migration tool.

## Architecture

### Request flow

`src/server.ts` mounts `src/routes.ts` at `/api/*`, then serves `public/` as static + SPA fallback. The schema is applied at boot via `applySchema()` from `src/db.ts` (idempotent — safe on every restart).

### Branch routes pattern (important)

`routes.ts::installBranchRoutes(prefix, includeRecipeCrud)` is called **twice**:
- once with `prefix = "/recipes/:slug"` and `includeRecipeCrud = true` — the main branch
- once with `prefix = "/recipes/:slug/branches/:branchSlug"` — variant branches

Every route that operates on a branch (draft, versions, cook logs, images, compare) exists at both prefixes. `activeBranch(c)` reads the param. When adding a route that should be branch-aware, add it inside `installBranchRoutes` — don't define it twice.

### Data model (`src/schema.sql`)

The key idea: **the working copy, tests and versions share one `entries` table**. The stored status values predate the interface words:
- `version_string IS NULL` + `status = 'draft'` → the working copy. Its `changelog` holds the pending "Testing:" line.
- `test_number IS NOT NULL` (status `beta`, or `archived` for an old archived beta) → a test. `changelog` is its Testing line; `closed_as` (adopted/stopped/rebased/superseded, NULL = open). New tests are named `test-N` internally; older ones keep `v1.1-beta.1`. Never show `version_string` for a test; use the derived `label`.
- `status = 'released'` → a version; the newest by `created_at` is current. `from_entry_id` / `from_cook_log_id` record what it was adopted from.
- The loader derives `kind`, `label`, `testing`, `base_version`, `is_current`, `open`, `adopted_as` per entry (`src/store/lineage.ts`). Adopting a test made from an older version 3-way merges it into the current one and refuses on a conflict (`adoptedText` in `recipe-store.ts`).
- A test is fixed: editing its text or notes is refused (`TestFixedError`, HTTP 409). Its Testing line can change.
- `prints` records each sheet (version or test, never the working copy) and scale that went on paper, one per sheet, scale and day; the recipe record carries `recent_prints`, and a new cook starts from the newest unrecorded one (`RecipeEditState.cookStart`).
- A cook (`cook_logs`) is recorded on its own screen (`/recipe/<slug>/cooks/new`, `/cooks/<id>`): its text is the sheet at the cook's scale, edited one value at a time through the `step-action` route; nothing is required, not even the outcome. `intended` holds the differences marked "I meant this" as `{kind, name, n}` keys (`CookSheet.buildFields`).
- `entries.updated_at` moves only when the text or tags change (`touch_entry_content`), not on bookkeeping like closing a test.
- One-time data steps run inside guarded `DO` blocks recorded in `app_migrations`, so a restart never re-runs them.
- Notes and servings are **not columns** — they live in the Cooklang frontmatter (`>> servings:`, `>> notes:`) and are parsed on read. Don't add columns for them.
- `parent_version` / `current_beta_version` are strings, not FK UUIDs, because version_strings are immutable once assigned (saves a JOIN on every read).
- `search_vector` is a GENERATED tsvector on `entries`.

### `src/recipe-store.ts` — all DB access

Every other file goes through this module. Roughly four sections:
1. **Cooklang text manipulation** (pure, no I/O) — frontmatter upsert, notes/servings extraction, version-string increment.
2. **Row → record mappers** — `EntryRow → VersionRecord`, `BranchRow → RecipeBranchMeta`, `CookLogRow → CookLogRecord`.
3. **Record assembly** — `loadRecipeRecord(slug, branchSlug)` walks the tables and returns a fully-assembled `RecipeRecord` with all branches, draft, versions, latest_released/beta, cook log counts.
4. **3-way merge** — `mergeCooklangText(base, ours, theirs)` for branch sync; line-level edits with overlap detection.

### `src/cooklang.ts` — parsing + extensions

Wraps `@cooklang/cooklang` and adds AjiLab-specific syntax on top:
- `^{300%F}` — temperature sigil (custom extension); extracted to placeholders before parsing, re-injected as steps after.
- `%{2-3%tbsp}` — inline quantity (no ingredient); used in computed-metric inputs.
- `@?`, `@-`, `@&`, `@&(=N)` — annotated ingredients (optional/hidden/repeat-reference/intermediate). Parsed by `collectComponentAnnotations`.
- `!+ ` / `!- ` — cook log deviation markers (added/skipped step). Resolved at render via `resolveDeviationMarkers`.
- `@./slug/v1.0{}` — recipe reference. `parseReferencePath` splits slug/version/categoryPath.
- **Cook log diff annotation** — `pairCookLogStepsToSource` aligns log steps to source steps by position + Jaccard similarity (threshold 0.3, nearby radius 2), then `annotateStepDiff` attaches per-token diff fields used by the renderer.

`parseCooklang(text)` is the single entry point and returns a `ParsedRecipe` with sections, steps, ingredient summary, computed metrics, and editable quantity tokens.

### Computed metrics (`src/metric-expr.ts` + `cooklang.ts::extractComputedMetrics`)

`metric.<name>: <formula> | <unit>` keys in YAML frontmatter. Formula refs ingredients as `flour.g`, earlier metrics as `metric.<name>`, and gets evaluated against the parsed ingredient summary (normalized to base units via `convertMetricQuantity`). Underscored metric names (`metric._total`) are hidden from the UI but available to other formulas.

### Diff (`src/compare.ts`)

Three layers: ingredient diff (unit-normalized via `metric-expr` conversions), step diff (grouped by `= Section`), inline character-level diff inside changed lines (via the `diff` npm package).

### Frontend (`public/js/`)

Vanilla JS SPA, ES modules. Files prefixed `views-*` are screens (`views-index`, `views-recipe-overview`, `views-recipe-editor`, `views-recipe-viewer`, `views-recipe-versions`, `views-recipe-cook-logs`, `views-cook` (recording a cook, with its pure value model in `cook-sheet.js`), `views-print`). `cooklang-render.js` is the renderer used by all viewers; `cooklang-editor.js` is the CodeMirror editor with custom Cooklang syntax highlighting. `api.js` is the thin fetch wrapper.

The CodeMirror bundle is built separately into `public/vendor/codemirror.js` — re-run `npm run build:editor` after touching `src/browser/codemirror-vendor.js`.

### Styles (`public/css/`)

Linked in order from `index.html` (plain `<link>`s, no `@import`): `tokens.css` → `base.css` → `components.css` → `index.css` → `recipe.css` → `editor.css` → `compare.css` → `cook.css` → `print.css`. **Every colour is a named token in `tokens.css`** (one light block, shared with `.print-sheet`, and the only dark-mode block); other files use `var(--…)` only. `test/css.test.js` fails on a literal colour outside `tokens.css`, a selector defined twice in one context, or a second dark-mode block. New colours: add a token by role (light and, if needed, dark value) and keep text at 4.5:1.

## Conventions

- All Postgres access goes through `recipe-store.ts`. Routes should not import `sql` directly.
- When mutating cooklang text from the server, use the `upsert*InCooklang` helpers rather than string-splicing the frontmatter yourself — they handle legacy formats and aliases.
- Don't add new columns for things that belong in cooklang frontmatter (notes, servings, tags-that-are-already-there).
- `MAIN_BRANCH = "main"` is the canonical slug; `MAIN_BRANCH_SLUG` in `recipe-store.ts` is the same constant for that module.
- The Cooklang spec is the source of truth — extensions added here (`^{}`, `%{}`, `!+`/`!-`, `@?`/`@-`/`@&`) must remain backward-compatible: standard Cooklang renderers should still display the recipe sanely.
