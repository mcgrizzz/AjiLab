#!/usr/bin/env bash
# Deploy AjiLab to the self-hosted box.
#
# The server runs AjiLab from a git checkout bind-mounted into the container
# (the host has no git, so all git commands run inside the container). This
# fast-forwards that checkout to what's on GitHub, then restarts the container,
# or rebuilds it if build inputs changed (Dockerfile, entrypoint.sh,
# docker-compose.yml), and waits for the server to come back up.
# Push your commits before running it.
#
# Usage: scripts/deploy.sh [--build]
#   --build   always rebuild + recreate the container after pulling
#
# Overridable via env:
#   DEPLOY_HOST       ssh target                      (server@bridgewater)
#   DEPLOY_STACK_DIR  compose project dir on server   (remote-box, relative to ~)
#   DEPLOY_SERVICE    compose service name            (ajilab)
#   DEPLOY_BRANCH     branch the server tracks        (master)
#   DEPLOY_TIMEOUT    seconds to wait for startup     (300)
set -euo pipefail

HOST="${DEPLOY_HOST:-server@bridgewater}"
STACK_DIR="${DEPLOY_STACK_DIR:-remote-box}"
SERVICE="${DEPLOY_SERVICE:-ajilab}"
BRANCH="${DEPLOY_BRANCH:-master}"
TIMEOUT="${DEPLOY_TIMEOUT:-300}"
FORCE_BUILD=0

for arg in "$@"; do
  case "$arg" in
    --build) FORCE_BUILD=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

# The server fetches from GitHub itself, so the deploy target is whatever the
# server sees on origin/$BRANCH. Local HEAD is only used to warn about unpushed work.
LOCAL="$(git rev-parse HEAD)"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "[deploy] note: you have uncommitted changes; they will not be deployed."
fi

echo "[deploy] deploying origin/$BRANCH to $HOST:~/$STACK_DIR ($SERVICE)"

ssh "$HOST" bash -s -- "$STACK_DIR" "$SERVICE" "$BRANCH" "$LOCAL" "$TIMEOUT" "$FORCE_BUILD" <<'REMOTE'
set -euo pipefail
STACK_DIR=$1 SERVICE=$2 BRANCH=$3 LOCAL=$4 TIMEOUT=$5 FORCE_BUILD=$6
cd "$STACK_DIR"

# </dev/null: this script arrives on ssh's stdin, and `docker compose exec`
# would otherwise consume the rest of it.
app_git() { docker compose exec -T -w /app "$SERVICE" git -c safe.directory=/app "$@" </dev/null; }

# Wait until the server logs its startup line, then fail if the pull failed.
wait_for_start() {
  local since=$1 deadline=$((SECONDS + TIMEOUT)) logs
  while :; do
    logs="$(docker compose logs --no-color --no-log-prefix --since "$since" "$SERVICE" 2>&1 </dev/null || true)"
    grep -q "AjiLab running" <<<"$logs" && break
    if (( SECONDS >= deadline )); then
      tail -40 <<<"$logs"
      echo "[deploy] timed out after ${TIMEOUT}s waiting for $SERVICE to start" >&2
      return 1
    fi
    sleep 3
  done
  if grep -q "git pull failed" <<<"$logs"; then
    grep -B3 "git pull failed" <<<"$logs" >&2
    echo "[deploy] git pull failed inside the container" >&2
    return 1
  fi
}

OLD="$(app_git rev-parse HEAD)"
app_git fetch --quiet origin "$BRANCH"
TARGET="$(app_git rev-parse FETCH_HEAD)"
echo "[remote] running ${OLD:0:7}, origin/$BRANCH is ${TARGET:0:7}"
if [ "$LOCAL" != "$TARGET" ]; then
  echo "[remote] warning: your local HEAD (${LOCAL:0:7}) differs from origin/$BRANCH; unpushed commits won't be deployed."
fi

# Fast-forward explicitly rather than trusting the entrypoint's best-effort
# pull, so a failure stops the deploy instead of being ignored.
if [ "$OLD" != "$TARGET" ]; then
  echo "[remote] fast-forwarding checkout"
  app_git merge --ff-only FETCH_HEAD
fi

NEW="$(app_git rev-parse HEAD)"
if [ "$NEW" != "$TARGET" ]; then
  echo "[deploy] checkout is on ${NEW:0:7}, expected ${TARGET:0:7}" >&2
  app_git status -sb >&2 || true
  exit 1
fi

BUILD_CHANGES=""
if [ "$OLD" != "$NEW" ]; then
  BUILD_CHANGES="$(app_git diff --name-only "$OLD" "$NEW" -- Dockerfile entrypoint.sh .dockerignore docker-compose.yml)"
fi

since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if [ "$FORCE_BUILD" = 1 ] || [ -n "$BUILD_CHANGES" ]; then
  if [ -n "$BUILD_CHANGES" ]; then
    echo "[remote] build inputs changed: $(tr '\n' ' ' <<<"$BUILD_CHANGES")"
  fi
  echo "[remote] rebuilding and recreating $SERVICE"
  docker compose up -d --build --no-deps "$SERVICE" </dev/null
elif [ "$OLD" != "$NEW" ]; then
  echo "[remote] restarting $SERVICE"
  docker compose restart "$SERVICE" </dev/null
else
  echo "[remote] already up to date at ${NEW:0:7}"
  exit 0
fi
wait_for_start "$since"
echo "[remote] deployed ${OLD:0:7} -> ${NEW:0:7}"
REMOTE
