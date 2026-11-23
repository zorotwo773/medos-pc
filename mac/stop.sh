#!/usr/bin/env bash
# =============================================================================
#  MedOS — macOS stop (the counterpart of STOP.bat)
#  Kills the backend, frontend, and status server by PID, then sweeps the ports
#  as a fallback so nothing is left listening.
# =============================================================================
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT_DIR/app"

echo "Stopping MedOS…"

# 1) Kill by recorded PID (and any child processes) ──────────────────────────
for f in backend.pid frontend.pid status.pid; do
  pf="$APP_DIR/$f"
  if [ -f "$pf" ]; then
    pid="$(cat "$pf" 2>/dev/null)"
    case "$pid" in
      ''|*[!0-9]*) ;;
      *) pkill -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true ;;
    esac
    rm -f "$pf"
  fi
done

# 2) Fallback: kill whatever is still listening on the MedOS ports ───────────
for p in 8002 3000 4321; do
  pids="$(lsof -ti tcp:"$p" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
done

# 3) Give anything stubborn a moment, then force-kill leftovers ──────────────
sleep 1
for p in 8002 3000 4321; do
  pids="$(lsof -ti tcp:"$p" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
done

echo "Done. Start again with:  bash mac/start.sh  (or the MedOS shortcut)"
