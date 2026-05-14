# Backup & restore

All data lives in a single Postgres database — recipes, versions, cook logs, images. One `pg_dump` covers everything.

---

## Automatic nightly backups

The `backup` service in `docker-compose.yml` runs automatically alongside the app. It:

- Dumps the database at **02:00 local time** every night
- Writes to `./backups/ajilab-<timestamp>.dump` (compressed Postgres custom format)
- Keeps a `./backups/latest.dump` symlink pointing at the newest file
- Takes a snapshot immediately on container start, so a fresh install has a backup within minutes
- Prunes dumps older than `BACKUP_RETENTION_DAYS` (default 30 days)

Override retention in `.env`:
```env
BACKUP_RETENTION_DAYS=90
```

---

## Cloud / off-site backup

Uncomment the `cloud-backup` service in `docker-compose.yml` to sync `./backups/` to any cloud provider via [rclone](https://rclone.org/): S3, Cloudflare R2, Backblaze B2, GCS, SFTP, Dropbox, …

```bash
# 1. Configure a remote once
rclone config

# 2. Copy config into the repo
cp ~/.config/rclone/rclone.conf ./rclone.conf

# 3. Set destination in .env
echo 'RCLONE_REMOTE=r2:my-bucket/ajilab' >> .env

# 4. Uncomment the cloud-backup block in docker-compose.yml, then:
docker compose up -d
```

The sidecar resyncs hourly.

---

## Manual backup

```bash
docker compose exec -T db pg_dump -U recipevault -Fc recipevault > my-backup.dump
```

---

## Restore

**Via the restore script (recommended):**

```bash
# Stop the app first so no writes happen mid-restore
docker compose stop app

npm run restore -- ./backups/latest.dump

docker compose start app
```

`scripts/restore.ts` verifies the file is a valid Postgres dump, wipes the schema, and streams it into the running `db` container.

**Manual restore:**

```bash
docker compose exec -T db pg_restore \
  -U recipevault -d recipevault \
  --clean --if-exists --no-owner --no-acl \
  < backup.dump
docker compose restart app
```

**Sanity check after restore:**

```bash
docker compose exec db psql -U recipevault -d recipevault -c "
  SELECT 'recipes'   AS t, COUNT(*) FROM recipes
  UNION ALL
  SELECT 'entries',  COUNT(*) FROM entries
  UNION ALL
  SELECT 'images',   COUNT(*) FROM images
  UNION ALL
  SELECT 'cook_logs', COUNT(*) FROM cook_logs;
"
```

---

## Disaster recovery (volume lost)

```bash
# Start just the DB
docker compose up -d db

# Wait for it to be ready
docker compose exec db pg_isready -U recipevault

# Restore from your most recent backup
npm run restore -- ./backups/latest.dump

# Start the app
docker compose up -d app
```

---

## Point-in-time recovery

The nightly dump model gives you at most 24h data loss. For continuous recovery, replace the `backup` sidecar with [`pgBackRest`](https://pgbackrest.org/) or [`wal-g`](https://github.com/wal-g/wal-g), which archive WAL segments to object storage and enable replay to any point in time.
