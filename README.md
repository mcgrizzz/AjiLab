# RecipeVault

A self-hosted recipe manager with first-class versioning. Write recipes in [Cooklang](https://cooklang.org), release named versions, track cook sessions, and compare changes over time.

All content — recipes, branches, versions, cook logs, images — lives in a single PostgreSQL database. Back up with `pg_dump`, scale with replication, recover anywhere Postgres runs.

---

## Quick start (Docker)

```bash
git clone <repo-url> recipevault && cd recipevault
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
| `@<other-recipe>{}` | Reference another recipe |
| YAML frontmatter | Servings, notes, etc. |

---

## API

All endpoints under `/api`. Branch-scoped routes work on both the main branch (`/recipes/:slug/...`) and named branches (`/recipes/:slug/branches/:branch/...`).

**Recipes**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/recipes` | List all recipes (supports `?q=search`) |
| `POST` | `/recipes` | Create recipe `{title}` |
| `GET` | `/recipes/:slug` | Get recipe with all versions |
| `PUT` | `/recipes/:slug` | Update title |
| `DELETE` | `/recipes/:slug` | Delete recipe (cascades) |

**Branches**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/recipes/:slug/branches` | List |
| `POST` | `/recipes/:slug/branches` | Create `{name, source_version}` |
| `GET` | `/recipes/:slug/branches/:branch` | Get with versions |

**Draft / Versions** *(branch-scoped)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/draft` | Get current draft |
| `PUT` | `…/draft` | Save `{cooklang_text, tags, advance_beta?}` |
| `PUT` | `…/draft/notes` | Set draft notes |
| `POST` | `…/draft/fork` | Fork branch head → draft |
| `POST` | `…/draft/parse` | Parse cooklang text → JSON |
| `GET` | `…/versions` | List released versions |
| `GET` | `…/versions/:v` | Get version |
| `PUT` | `…/versions/:v` | Edit version content |
| `PUT` | `…/versions/:v/notes` | Edit notes |
| `DELETE` | `…/versions/:v` | Delete |
| `POST` | `…/versions/:v/fork` | Fork → draft |
| `POST` | `…/release` | Release `{version_string, status, changelog, source_version?}` |
| `GET` | `…/compare` | `?from=v1.0&to=v1.1` |

**Cook logs** *(branch-scoped)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/cook-logs` | List branch logs |
| `POST` | `…/cook-logs` | Create `{source, cooked_at, outcome, …}` |
| `GET` | `…/versions/:v/cook-logs` | Filter by version |
| `PUT` | `…/cook-logs/:id` | Update |
| `DELETE` | `…/cook-logs/:id` | Delete |
| `POST` | `…/cook-logs/:id/fork-to-draft` | Fork to draft |
| `POST` | `…/cook-logs/:id/promote` | Promote to release |

**Images** *(branch-scoped)*

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/images` | List (`?version=v1.0`) |
| `POST` | `…/images` | Upload (multipart, field `image`) |
| `POST` | `/recipes/:slug/thumbnail` | Set thumbnail |
| `DELETE` | `/recipes/:slug/thumbnail` | Remove thumbnail |
| `GET` | `/images/:id` | Serve binary |
| `DELETE` | `/images/:id` | Delete |

**Other**

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `…/backlinks` | Recipes that reference this recipe |
| `POST` | `…/sync/preview` | Preview branch → main 3-way merge |
| `POST` | `…/sync/apply` | Apply merge |

---

## Backup & restore

Everything is one Postgres database. The `docker-compose.yml` ships with three backup layers, each optional.

### 1. Automatic nightly local backup *(on by default)*

The `backup` service runs as a sidecar. It:

- Takes a `pg_dump -Fc` snapshot at **02:00 local time** every day
- Writes to `./backups/recipevault-<timestamp>.dump`
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
echo 'RCLONE_REMOTE=r2:my-bucket/recipevault' >> .env

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

## Migrating from the legacy file-based version

If you're upgrading from a pre-Postgres install (when data lived in `data/recipes/*` + a SQLite index), there's a one-shot migration:

```bash
# 1. Stop the old app
docker compose stop app

# 2. Snapshot the legacy data
cp -r data data.pre-postgres.bak

# 3. Boot Postgres
docker compose up -d db

# 4. Dry-run the migration to validate
docker compose run --rm app npm run migrate -- --dry-run

# 5. Run it for real
docker compose run --rm app npm run migrate

# 6. Start the new app
docker compose up -d app
```

The script reads `data/recipes/*` and `data/recipevault.db`, writes to Postgres in a single transaction, and prints row counts. Keep `data.pre-postgres.bak` for at least a month.

To validate before cutover, boot the old and new apps on different ports and run:

```bash
OLD_URL=http://localhost:3001 NEW_URL=http://localhost:3000 npm run diff-api
```

---

## Running outside Docker

```ini
# /etc/systemd/system/recipevault.service
[Unit]
Description=RecipeVault
After=network.target postgresql.service

[Service]
Type=simple
User=youruser
WorkingDirectory=/opt/recipevault
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
recipevault/
├── Dockerfile
├── docker-compose.yml      # app + db + nightly pg_dump
├── entrypoint.sh
├── src/
│   ├── server.ts           # Hono server bootstrap
│   ├── routes.ts           # All HTTP handlers
│   ├── db.ts               # postgres.js client + applySchema()
│   ├── schema.sql          # Full DB schema
│   ├── recipe-store.ts     # All DB access; preserves a stable function API
│   ├── cooklang.ts         # Server-side Cooklang parser
│   ├── compare.ts          # Inline + step-block diff
│   ├── ingredient-compare.js
│   ├── metric-expr.ts
│   └── draft-quantity.js
├── scripts/
│   ├── migrate-to-postgres.ts  # One-shot legacy → Postgres migration
│   ├── restore.ts              # Restore a pg_dump into the running stack
│   └── diff-api.ts             # Response-diff validator
├── public/                 # SPA + PWA + CodeMirror bundle
├── test/                   # node:test unit suites
└── package.json
```

---

## Known gaps from the v2 rewrite

- The legacy `test/recipe-store.test.js` (moved to `.legacy`) was built around the synchronous file-based API and needs to be rewritten against a test Postgres database. Other test suites (`cooklang`, `compare`, `draft-quantity`, `metric-expr`) are pure and unaffected.
- The `scripts/migrate-to-postgres.ts` migration script has not been exercised against a large real dataset yet — run it with `--dry-run` first and check the row counts before committing.
