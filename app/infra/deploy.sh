#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# MedOS — deploy / update the running stack on the OCI VM.
#
# Run from anywhere on the VM:
#     bash ~/medos/app/infra/deploy.sh
#
# What it does
#   1. Pull the latest commit on the deploy branch (default: main).
#   2. Build the backend + frontend images (only changed layers rebuild).
#   3. Bring services up with `compose up -d --remove-orphans`.
#   4. Tail the logs for 10 seconds so a botched start is obvious.
#   5. Record the SHA we just deployed so a future rollback is easy.
#
# Idempotent and quick to re-run.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_DIR="${REPO_DIR:-$HOME/medos}"
BRANCH="${BRANCH:-main}"
COMPOSE_FILE="app/infra/docker-compose.yml"
ENV_FILE="app/infra/.env.production"
STATE_FILE="app/infra/.last_deploy_sha"

log()  { printf '\n\033[1;34m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[deploy warn]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[deploy fail]\033[0m %s\n' "$*" >&2; exit 1; }

cd "$REPO_DIR" || die "Repo not found at $REPO_DIR. Set REPO_DIR=... if it lives elsewhere."

# ─── 1. Pull latest ────────────────────────────────────────────────────────
log "Fetching origin/$BRANCH…"
git fetch --quiet origin "$BRANCH"
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"

if [[ "$local_sha" == "$remote_sha" ]]; then
    log "Already on the latest commit ($local_sha). Re-running compose anyway."
else
    log "Updating: $local_sha → $remote_sha"
    git checkout "$BRANCH" --quiet
    git reset --hard "origin/$BRANCH" --quiet
fi

# ─── 2. Sanity-check env + compose file ────────────────────────────────────
[[ -f "$COMPOSE_FILE" ]] || die "Missing $COMPOSE_FILE — wrong checkout?"
[[ -f "$ENV_FILE" ]]     || die "Missing $ENV_FILE — copy infra/.env.production.example first."

# Refuse to start if MEDOS_SESSION_SECRET still looks like the template default.
if grep -q '^MEDOS_SESSION_SECRET=please-replace' "$ENV_FILE"; then
    die "MEDOS_SESSION_SECRET in $ENV_FILE is still the placeholder. Rotate it (see HOSTING.md)."
fi
if grep -q '^MEDOS_ACCESS_CODE=change-me' "$ENV_FILE"; then
    die "MEDOS_ACCESS_CODE in $ENV_FILE is still the placeholder. Set it before deploying."
fi

# ─── 3. Build + up ─────────────────────────────────────────────────────────
log "Building images (this is slow on first run — torch+faiss are big)…"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build

log "Starting services…"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d --remove-orphans

# ─── 4. Quick health sniff ─────────────────────────────────────────────────
log "Waiting 5s for services to settle…"
sleep 5
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps

log "Last 30 lines of each service's logs:"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail=30

# Tag the deployed SHA so rollback is just `git reset --hard <previous>` + rerun
echo "$(git rev-parse HEAD)" > "$STATE_FILE"

log "Done. Visit your Funnel URL — should be live within ~30s of the backend healthcheck passing."
log "Run 'tailscale status' to see the URL if you've forgotten it."
