# AjiLab

A self-hosted recipe manager with first-class versioning. Write recipes in [Cooklang](https://cooklang.org), release named versions, track cook sessions, and compare changes over time.

All content — recipes, branches, versions, cook logs, images — lives in a single PostgreSQL database. Back up with `pg_dump`, scale with replication, recover anywhere Postgres runs.

---

## Quick start (Docker)

```bash
git clone <repo-url> ajilab && cd ajilab
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" > .env
docker compose up -d
```

Open **http://localhost:3000**.

The `app` service auto-pulls from git on every restart, so deploying an update is just `docker compose restart app`.

---

## Local development (no Docker)

```bash
# 1. Start Postgres locally (or point at an existing instance)
docker run -d --name pg -p 5432:5432 \
  -e POSTGRES_DB=recipevault \
  -e POSTGRES_USER=recipevault \
  -e POSTGRES_PASSWORD=recipevault \
  postgres:16-alpine

# 2. Install + run
npm install
DATABASE_URL=postgresql://recipevault:recipevault@localhost:5432/recipevault npm start
```

---

## Configuration

| Variable          | Default                                                            | Description                |
|-------------------|--------------------------------------------------------------------|----------------------------|
| `PORT`            | `3000`                                                             | HTTP port                  |
| `DATABASE_URL`    | `postgresql://recipevault:recipevault@localhost:5432/recipevault`  | Postgres connection string |
| `DATABASE_POOL_MAX` | `10`                                                             | Max pool connections       |

The server applies `src/schema.sql` on startup (idempotent — safe to restart).

---

## How it works

**Versioning** — git for recipes:

1. Every recipe has one mutable **draft** per branch — edit it freely
2. **Release** turns the draft into an immutable version with a status (`released` / `beta` / `archived`) and an optional changelog
3. The draft remains, ready for the next iteration
4. **Fork** any version back into the draft at any time
5. **Compare** any two versions to see what changed (ingredients + full text diff)

**Branches** — variants of a recipe with independent draft + version history, forked from a chosen source version. A branch can be **synced** back to main via 3-way merge.

**Cook logs** — record each cooking session against a draft or version. Each log captures outcome, what worked, problems, and changes to try, plus an editable snapshot of the recipe as actually cooked. Cook logs can be **forked** back to the draft or **promoted** straight to a new release.

**Cross-references** — recipes can reference other recipes (`@<recipe-slug>{}`). The `recipe_references` table is maintained automatically whenever an entry is saved; the `/backlinks` endpoint surfaces incoming references.

**Structural diff** — the compare view doesn't just show a text patch. It produces three layers:
- Inline character-level diff per changed line
- Step-block diff (changes grouped by `= section` boundaries)
- Ingredient diff (added / removed / quantity-changed, unit-normalized so `0.5 kg` vs `500 g` is *not* a change)

See [`src/compare.ts`](src/compare.ts) and [`src/ingredient-compare.js`](src/ingredient-compare.js).

**Full-text search** — the `entries` table has a `tsvector GENERATED ALWAYS AS (to_tsvector('english', cooklang_text)) STORED` column with a GIN index. `?q=…` on `/recipes` uses a simple substring match today, but the underlying schema is ready for `to_tsquery` / `plainto_tsquery` upgrades without a migration.

**3-way merge** — branches can sync from main using a true 3-way diff against the common ancestor (the branch's `forked_from_entry_id` or `last_merged_upstream_entry_id`). Non-overlapping edits merge cleanly; overlapping edits surface as structured `conflicts` in the response. See [`src/recipe-store.ts`](src/recipe-store.ts) `mergeCooklangText`.

---

## Data model

The schema lives in [`src/schema.sql`](src/schema.sql). Six tables:

| Table              | Purpose |
|--------------------|---------|
| `recipes`          | Top-level recipe (id, slug, title) |
| `branches`         | Branches per recipe; `forked_from_entry_id` points at the source version |
| `entries`          | **Unified draft + version table.** `version_string IS NULL ↔ draft` |
| `images`           | `BYTEA` payload + metadata; `is_thumbnail` flag (DB-enforced unique per recipe) |
| `cook_logs`        | One row per cooking session, with source entry + actual-as-cooked text |
| `recipe_references`| Backlink graph between entries and target recipes |

Notes and servings live in the cooklang frontmatter and are parsed on read — no dedicated columns. Tags are native `TEXT[]`. Full-text search is built in via a `tsvector GENERATED ALWAYS AS` column on `entries`.

---

## Cooklang syntax

```
---
servings: 4
notes: |-
  Source: Grandma's notebook, p. 47
---

Melt @butter{100%g} in a #saucepan{}.
Add @flour{2%tbsp} and whisk for ~{2%minutes}.
Pour in @milk{500%ml} gradually.
Season with @salt{} and @pepper{}.
```

| Syntax | Meaning |
|--------|---------|
| `@name{qty%unit}` | Ingredient |
| `@name{}` | Ingredient (no quantity) |
| `#name{}` | Cookware |
| `~{qty%unit}` | Timer |
| YAML frontmatter | Servings, notes, metadata |

### AjiLab Cooklang extensions

On top of stock Cooklang, AjiLab adds a handful of extensions. They all live in either YAML frontmatter (parsed before the recipe body) or ingredient modifier sigils.

#### Computed metrics

Define derived values from ingredient quantities using `metric.<name>` keys in the frontmatter. Each formula is a tiny arithmetic expression with safe variable lookups (no `eval`, no library — just a tokenizer + recursive-descent parser in [`src/metric-expr.ts`](src/metric-expr.ts)).

```
---
servings: 4
metric.total flour: flour.g + whole_wheat_flour.g | g
metric.hydration: 100 * water.g / metric.total_flour | %
metric.salt pct: 100 * salt.g / metric.total_flour | %
metric._total mass: flour.g + water.g + salt.g + yeast.g
metric.bakers pct: 100 * water.g / metric._total_mass | %
---

Mix @flour{400%g}, @whole wheat flour{100%g}, @water{350%ml}, @salt{10%g}, @yeast{3%g}.
```

| Feature | Detail |
|---------|--------|
| Reference an ingredient | `<name>.<unit>` — `flour.g`, `water.ml`. Multi-word names use underscores: `whole_wheat_flour.g`. Case-insensitive |
| Unit conversion | Mass: `mg`/`g`/`kg` cross-convert. Volume: `ml`/`l` cross-convert. Mixing categories errors |
| Reference another metric | `metric.<name>` — resolved in declaration order, so forward references fail intentionally |
| Format hint | Trailing `\| %`, `\| g`, etc. — controls display, not the value |
| Hidden intermediates | Prefix the name with `_` (e.g. `metric._total_mass`) — value is computed and available to later metrics but not rendered in the UI |
| `&` deduplication | `@&flour{300%g}` after `@flour{200%g}` sums to 500g for the metric layer |

Metrics surface in the API as `parsed.metrics: ComputedMetric[]` with `value`, `display`, and `error` fields. Errors are per-metric — one bad formula doesn't break the others.

#### Recipe references

Reference another recipe from your library, optionally pinned to a version:

```
Use @./mother-doughs/sourdough-starter{50%g} as the levain.
Top with a dollop of @./sauces/aioli/v1.2{}.
```

| Pattern | Meaning |
|---------|---------|
| `@<slug>{}` | Bare reference — resolves to the recipe's latest released version |
| `@./<category>/<slug>{}` | Path-style reference. The leading `./` flags it as a recipe ref so the parser doesn't treat it as an ingredient |
| `@./<category>/<slug>/<version>{}` | Version-pinned. `<version>` matches `v1.0`, `v1.2.3`, `v2.0-beta.1`, … |

Backlinks are populated automatically: every time an entry's text is saved, references are extracted and the `recipe_references` table is updated. `GET /backlinks` returns recipes that point at the current one.

#### Ingredient annotations

| Sigil | Meaning |
|-------|---------|
| `@ingredient{}` | Required ingredient |
| `@?ingredient{}` | **Optional** — flagged in the UI, omitted from "you'll need" lists |
| `@-ingredient{}` | **Hidden** — counts in totals but not shown in the ingredient summary |
| `@&ingredient{}` | **Reference to prior** — totals merge with the earlier definition (stock Cooklang) |
| `@&(~1)ingredient{}` | **Intermediate prep** — points at a prior section; shown in the section that consumes it, excluded from flat totals |
| `@@recipe-slug{}` or `@./path/{}` | Recipe reference (see above) |

#### Sections

Group steps under named headings. AjiLab tracks sections separately for both the UI and the diff:

```
= Levain

Mix @starter{20%g} + @flour{50%g} + @water{50%g}. Rest for ~{8%hours}.

= Dough

Combine @&(=1)levain{}, @flour{450%g}, @water{300%ml}, @salt{10%g}.
```

Section headers (`= Title`) drive the **step-block diff** — the compare view groups changes by section instead of showing a flat line-by-line patch.

#### Editable quantities

Every `{qty%unit}` token in the body is also surfaced in the API as a typed `EditableQuantityToken` with `numericValue`, `units`, and `rangeStart`/`rangeEnd` text offsets. The editor uses these for inline scale-up/down without rewriting the underlying text. Live in [`src/draft-quantity.js`](src/draft-quantity.js).

---

## API

HTTP API surface — recipes, branches, draft/versions, cook logs, images, backlinks, sync — is documented in **[docs/API.md](docs/API.md)**. All endpoints under `/api`. Branch-scoped routes are mirrored on `/recipes/:slug/branches/:branch/...`.

---

## Backup & restore

Everything is one Postgres database. The `docker-compose.yml` ships with three backup layers, each optional.

### 1. Automatic nightly local backup *(on by default)*

The `backup` service runs as a sidecar. It:

- Takes a `pg_dump -Fc` snapshot at **02:00 local time** every day
- Writes to `./backups/ajilab-<timestamp>.dump`
- Symlinks `./backups/latest.dump` to the newest file
- Prunes dumps older than `BACKUP_RETENTION_DAYS` (default 30)
- Takes an immediate snapshot at container start so a fresh install has a backup within minutes

Override retention in `.env`:

```env
BACKUP_RETENTION_DAYS=90
```

### 2. Off-site cloud backup *(opt-in)*

Uncomment the `cloud-backup` service in `docker-compose.yml` to sync `./backups/` to any cloud provider via [rclone](https://rclone.org/): S3, Cloudflare R2, Backblaze B2, GCS, SFTP, Dropbox, Google Drive, …

```bash
# 1. Configure a remote once
rclone config

# 2. Copy the config into the repo
cp ~/.config/rclone/rclone.conf ./rclone.conf

# 3. Set the destination in .env
echo 'RCLONE_REMOTE=r2:my-bucket/ajilab' >> .env

# 4. Uncomment the cloud-backup block in docker-compose.yml, then:
docker compose up -d
```

The sidecar resyncs hourly. Both the local and the cloud copy survive — the cloud is just a mirror.

### 3. Manual ad-hoc backup

```bash
docker compose exec -T db pg_dump -U recipevault -Fc recipevault > my-backup.dump
```

### Restore

```bash
# Restores into the running stack, dropping existing data first
npm run restore -- ./backups/latest.dump

# Or, manually
docker compose exec -T db pg_restore -U recipevault -d recipevault --clean --if-exists < backup.dump
docker compose restart app
```

`scripts/restore.ts` verifies the dump's magic header, wipes the target schema, streams the file into `pg_restore` via `docker compose exec`, and leaves you a clean DB. The app should be idle during restore.

### Point-in-time recovery

The nightly dump model gives you at-most-24h data loss. If you need finer granularity, swap the `backup` sidecar for [`pgBackRest`](https://pgbackrest.org/) or [`wal-g`](https://github.com/wal-g/wal-g) — both run as additional Postgres-side services that archive WAL segments continuously to object storage and replay them on restore. Overkill for a recipe app but documented in case.

---

## Running outside Docker

```ini
# /etc/systemd/system/ajilab.service
[Unit]
Description=AjiLab
After=network.target postgresql.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/ajilab
ExecStart=/usr/bin/npm start
Restart=on-failure
Environment=PORT=3000
Environment=DATABASE_URL=postgresql://recipevault:secret@localhost:5432/recipevault

[Install]
WantedBy=multi-user.target
```

---

## Project structure

```
ajilab/
├── Dockerfile
├── docker-compose.yml      # app + db + nightly pg_dump
├── entrypoint.sh
├── docs/
│   └── API.md              # HTTP API reference
├── src/
│   ├── server.ts           # Hono bootstrap + applySchema()
│   ├── routes.ts           # All HTTP handlers
│   ├── db.ts               # postgres.js client
│   ├── schema.sql          # Full DB schema
│   ├── recipe-store.ts     # All DB access
│   ├── cooklang.ts         # Cooklang parser + metrics + references
│   ├── metric-expr.ts      # Safe arithmetic evaluator for metrics
│   ├── compare.ts          # Inline + step-block diff
│   ├── ingredient-compare.js
│   └── draft-quantity.js
├── scripts/
│   └── restore.ts          # Restore a pg_dump into the running stack
├── public/                 # SPA + PWA + CodeMirror bundle
├── test/                   # node:test unit suites
└── package.json
```

---

## Performance notes

`recipe-store.ts` is optimized for the network round-trip cost of Postgres:

- **Parallel loads** — `loadRecipeRecord` runs the entries, cook-log-count, and latest-cook-log queries in parallel via `Promise.all`
- **No hidden N+1** — `listRecipes` parallelizes the per-recipe hydration
- **Branch IDs are cached on the loaded record** — write paths reuse `recipe.branch.id` instead of round-tripping for it
- **Batched reference syncs** — `recipe_references` updates use a single multi-row `INSERT … ON CONFLICT` instead of a loop
- **Schema indexes** — GIN on `search_vector` and `tags`, btree on `branch_id`, `recipe_id`, and `cook_logs(branch_id, cooked_at DESC)`
- **Tuned Postgres defaults** — the `db` service in docker-compose ships with `shared_buffers=128MB`, `effective_cache_size=384MB`, `work_mem=4MB`, `max_connections=50` — sized for a single VPS

