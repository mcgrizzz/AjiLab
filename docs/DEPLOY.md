# Deployment & configuration

## Moving data between databases

Copy all data from one AjiLab Postgres database to another:

```bash
SOURCE_DATABASE_URL=postgres://user:pass@old-host/db npm run transfer
```

`TARGET_DATABASE_URL` defaults to `DATABASE_URL` (the current app's database). Set it explicitly to copy in either direction.

```bash
# Remote → local Docker (most common: switching from hosted to self-hosted)
SOURCE_DATABASE_URL=postgres://user:pass@remote-host/db \
npm run transfer

# Local → remote
SOURCE_DATABASE_URL=postgres://localhost/ajilab \
TARGET_DATABASE_URL=postgres://user:pass@remote-host/db \
npm run transfer
```

The script is safe to run multiple times — it skips rows already in the target. Pass `--overwrite` to replace them:

```bash
SOURCE_DATABASE_URL=postgres://... npm run transfer -- --overwrite
```

The target schema is applied automatically so the target database can be completely empty.

---

## Docker (recommended)

```bash
git clone <repo-url> ajilab && cd ajilab
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" > .env
docker compose up -d
```

The stack: Postgres 18, the Node app, and a nightly backup sidecar. The app auto-pulls from git and applies the schema on every restart.

**Update:**
```bash
docker compose restart ajilab
```

**Logs:**
```bash
docker compose logs -f ajilab
docker compose logs -f ajilab-backup
```

---

## Local development (without Docker)

```bash
# Spin up just Postgres
docker run -d --name pg -p 5432:5432 \
  -e POSTGRES_DB=ajilab \
  -e POSTGRES_USER=ajilab \
  -e POSTGRES_PASSWORD=ajilab \
  postgres:18-alpine

npm install
DATABASE_URL=postgresql://ajilab:ajilab@localhost:5432/ajilab npm start
# or for watch mode:
DATABASE_URL=postgresql://ajilab:ajilab@localhost:5432/ajilab npm run dev
```

---

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port |
| `DATABASE_URL` | `postgresql://ajilab:ajilab@localhost:5432/ajilab` | Postgres connection string |
| `DATABASE_POOL_MAX` | `10` | Max pool connections |
| `AUTO_PULL` | `true` | Git pull on container start |
| `BACKUP_RETENTION_DAYS` | `30` | Days to keep nightly dumps |
| `RCLONE_REMOTE` | — | Cloud sync destination (enable the `cloud-backup` service in docker-compose) |

Set these in a `.env` file next to `docker-compose.yml`.

---

## Running as a systemd service (Linux, no Docker)

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
Environment=DATABASE_URL=postgresql://ajilab:secret@localhost:5432/ajilab

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now ajilab
```

---

## Schema

The schema is in `src/schema.sql` and is applied automatically on startup (idempotent). Six tables:

| Table | Purpose |
|-------|---------|
| `recipes` | Top-level recipe (id, slug, title) |
| `branches` | Branches per recipe |
| `entries` | Unified draft + version table — draft has `version_string IS NULL` |
| `images` | Binary image data (`BYTEA`) + metadata |
| `cook_logs` | One row per cooking session |
| `recipe_references` | Backlink graph between entries and recipes |

Full-text search is a `tsvector GENERATED ALWAYS AS` column on `entries` with a GIN index.

---

## Project structure

```
ajilab/
├── Dockerfile
├── docker-compose.yml
├── entrypoint.sh
├── docs/
│   ├── API.md
│   ├── BACKUP.md
│   └── DEPLOY.md
├── src/
│   ├── server.ts           # Hono bootstrap
│   ├── routes.ts           # HTTP handlers
│   ├── db.ts               # postgres.js client
│   ├── schema.sql
│   ├── recipe-store.ts     # All DB access
│   ├── cooklang.ts         # Parser + metrics + references
│   ├── metric-expr.ts      # Arithmetic evaluator for metrics
│   ├── compare.ts          # Diff logic
│   ├── ingredient-compare.js
│   └── draft-quantity.js
├── scripts/
│   └── restore.ts
├── public/                 # SPA + CodeMirror
└── test/
```
