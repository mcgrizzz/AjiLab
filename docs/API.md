# RecipeVault HTTP API

All endpoints are under `/api`. Branch-scoped routes are exposed twice — once on the main branch (`/recipes/:slug/...`) and once on named branches (`/recipes/:slug/branches/:branch/...`). They share identical request/response shapes.

Authentication: none. Run behind a reverse proxy (nginx, Caddy, Cloudflare Tunnel, …) if you need it.

Content type: `application/json` for everything except image uploads (multipart) and image fetches (binary).

---

## Recipes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/recipes` | List recipes. Supports `?q=<search>` (substring match across title, slug, draft, version text, tags) |
| `POST` | `/recipes` | Create. Body: `{ title }`. Returns `{ id, slug, title }` |
| `GET` | `/recipes/:slug` | Full recipe with all branches, versions, draft, and counts |
| `PUT` | `/recipes/:slug` | Update title. Body: `{ title }`. Slug regenerates if needed |
| `DELETE` | `/recipes/:slug` | Delete recipe (cascades to branches, entries, images, cook logs) |

---

## Branches

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/recipes/:slug/branches` | List branches |
| `POST` | `/recipes/:slug/branches` | Create variant. Body: `{ name, source_version }` |
| `GET` | `/recipes/:slug/branches/:branch` | Get a specific branch (same shape as `GET /recipes/:slug`) |

A new recipe always gets a `main` branch automatically. Variants fork from a specific version on main.

---

## Draft

The draft is the mutable working copy on a branch. Exactly one per branch, enforced by `UNIQUE NULLS NOT DISTINCT (branch_id, version_string)` in the schema.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/draft` | Get the current draft. 404 if no draft exists |
| `PUT` | `…/draft` | Save. Body: `{ cooklang_text?, tags?, advance_beta? }` |
| `PUT` | `…/draft/notes` | Update notes in the cooklang frontmatter |
| `POST` | `…/draft/fork` | Replace draft contents with the branch head (latest released/beta) |
| `POST` | `…/draft/parse` | Parse cooklang text → structured JSON. Stateless. Body: `{ cooklang_text }` |

`advance_beta: true` on a draft save also creates (or updates) an auto-numbered beta snapshot version (`v1.1-beta.1`, `v1.1-beta.2`, …) so you have a stable anchor to share or compare against.

---

## Versions

Versions are immutable-ish snapshots. They have a non-null `version_string` and a status (`released`, `beta`, `archived`).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/versions` | List released versions for this branch |
| `GET` | `…/versions/:v` | Get one version |
| `PUT` | `…/versions/:v` | Edit version content. Body: `{ cooklang_text?, tags? }` |
| `PUT` | `…/versions/:v/notes` | Update notes inside the cooklang frontmatter |
| `DELETE` | `…/versions/:v` | Delete a version |
| `POST` | `…/versions/:v/fork` | Replace the draft with this version's content |
| `POST` | `…/release` | Release. Body: `{ version_string, status, changelog?, source_version? }` |
| `GET` | `…/compare` | Diff. Query: `?from=v1.0&to=v1.1`. `from`/`to` may also be `draft`, `cooklog:<id>`, or `cooklog-source:<id>` |

`POST …/release` releases the draft by default; pass `source_version` to release a specific existing version under a new name (re-release / status change).

`status` is one of `released`, `beta`, `archived`.

### Compare response

```json
{
  "from": { "version": "v1.0", "status": "released" },
  "to":   { "version": "v1.1", "status": "released" },
  "text_diff": "…unified patch…",
  "text_diff_lines": [ /* per-line inline diff with char-level tokens */ ],
  "ingredient_diff": { "added": [], "removed": [], "changed": [] },
  "step_changes": [ /* section-grouped step block changes */ ],
  "step_count_from": 7,
  "step_count_to": 8
}
```

---

## Cook logs

A cook log records one cooking session. It captures both the recipe text as it was (`source_cooklang_text` — immutable) and the text as actually cooked (`cooklang_text` — editable).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/cook-logs` | All cook logs on the branch, newest first |
| `POST` | `…/cook-logs` | Create. Body below |
| `GET` | `…/versions/:v/cook-logs` | Cook logs filtered to a specific version |
| `PUT` | `…/cook-logs/:id` | Update fields |
| `DELETE` | `…/cook-logs/:id` | Delete |
| `POST` | `…/cook-logs/:id/fork-to-draft` | Copy this log's cooklang into the draft |
| `POST` | `…/cook-logs/:id/promote` | Promote directly to a released version. Body: `{ version_string, status?, changelog? }` |

### POST body

```json
{
  "source": { "kind": "draft" },
  "source": { "kind": "version", "version_string": "v1.2" },

  "cooked_at": "2026-05-14T18:30:00Z",
  "outcome": "great",
  "what_worked": "...",
  "problems_found": "...",
  "changes_to_try_next": "...",
  "freeform_notes": "...",
  "cooklang_text": "(optional override of the snapshot from `source`)",
  "tags": ["weeknight", "kids-approved"]
}
```

`outcome` is required. `cooked_at` defaults to now.

---

## Images

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/images` | List images. Optional `?version=v1.0` or `?version=draft` to filter |
| `POST` | `…/images` | Upload. `multipart/form-data` with field `image` and optional `version` |
| `POST` | `/recipes/:slug/thumbnail` | Set the recipe thumbnail. Same multipart format. Replaces any existing thumbnail |
| `DELETE` | `/recipes/:slug/thumbnail` | Remove the thumbnail |
| `GET` | `/images/:id` | Serve the binary. Returns the raw image with its `Content-Type` and a 1-day cache header |
| `DELETE` | `/images/:id` | Delete |

Supported MIME types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`.

Images are stored as `BYTEA` in Postgres. The DB enforces at most one thumbnail per recipe via a partial unique index.

---

## Backlinks & sync

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/backlinks` | Other recipes whose entries reference this one |
| `POST` | `…/sync/preview` | Preview a 3-way merge of the branch's draft against the latest released main version |
| `POST` | `…/sync/apply` | Apply the merge if there are no conflicts |

Backlinks are maintained automatically: every `cooklang_text` write re-parses the text, extracts `@recipe-ref{}` references, and updates the `recipe_references` table.

Sync preview returns either `{ status: "clean", merged_text }` or `{ status: "conflict", conflicts: [...] }`.

---

## Status codes

| Code | Meaning |
|------|---------|
| `200` | Success |
| `201` | Resource created |
| `400` | Bad request — missing/invalid body, version_string conflict during release, malformed cooked_at, etc. |
| `404` | Recipe / version / cook log / image not found |
| `409` | Version string already exists when trying to release |

All error responses have the shape `{ "error": "<message>" }`.

---

## Branch-scoped path examples

Anywhere a route is shown with `…`, prepend either of:

```
/api/recipes/<slug>/                          # main branch
/api/recipes/<slug>/branches/<branch-slug>/   # named branch
```

So `…/cook-logs` is reachable as both:

```
GET /api/recipes/sourdough/cook-logs
GET /api/recipes/sourdough/branches/wholemeal/cook-logs
```
