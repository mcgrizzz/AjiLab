#!/bin/sh
set -e

# Auto-pull latest code from the remote when the container starts.
# Requires the repo to be mounted at /app (see docker-compose.yml).
# Set AUTO_PULL=false to disable.
if [ "${AUTO_PULL:-true}" = "true" ] && [ -d ".git" ]; then
  echo "[ajilab] Pulling latest code..."
  BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  git pull origin "$BRANCH" || echo "[ajilab] Warning: git pull failed — continuing with existing code"
fi

# Install/update Node dependencies.
# Needed on first start when node_modules volume is empty, and after pulls that
# change package.json.
echo "[ajilab] Installing dependencies..."
npm install --silent

# Rebuild the CodeMirror vendor bundle.
echo "[ajilab] Building editor bundle..."
npm run build:editor --silent

# applySchema() runs inside the server, but Postgres readiness is gated by the
# compose healthcheck so the server starts only after the DB is up.
echo "[ajilab] Starting server..."
exec npm start
