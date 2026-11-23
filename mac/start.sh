#!/usr/bin/env bash
# =============================================================================
#  MedOS — macOS launcher
#
#  The Mac counterpart of START.ps1 / app\START.ps1. Starts the backend,
#  frontend, and a live browser status page, all in the background, then opens
#  your browser. You can close the Terminal window afterwards — MedOS keeps
#  running. Stop it with mac/stop.sh (or the "MedOS-Stop" shortcut).
#
#  Usage:
#    bash mac/start.sh                 # start everything + open browser
#    bash mac/start.sh --no-browser    # start, don't open the browser
#    bash mac/start.sh --backend-only  # only the FastAPI backend
#    bash mac/start.sh --frontend-only # only the Next.js frontend
#
#  Logs: app/backend.log · app/backend.err · app/frontend.log · app/frontend.err
# =============================================================================
set -uo pipefail   # NOT -e: kills/cleanup are best-effort and may "fail" by design

# Homebrew puts node/python here; a Finder-launched Terminal may have a thin PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# ── Resolve paths (works whether double-clicked or run from a shell) ─────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT_DIR/app"
BACKEND_DIR="$APP_DIR/backend"

# Repair modes lost when a portable bundle is extracted by a tool that ignores
# ZIP Unix permissions. Keep this deliberately narrow: medical data is never
# traversed or made executable.
repair_portable_permissions() {
  chmod +x "$SCRIPT_DIR/start.sh" "$SCRIPT_DIR/runtime-select.sh" "$SCRIPT_DIR/stop.sh" "$SCRIPT_DIR/setup.sh" 2>/dev/null || true
  chmod +x "$ROOT_DIR/MedOS.command" "$ROOT_DIR/MedOS-Setup.command" 2>/dev/null || true
  chmod +x "$ROOT_DIR/MedOS.app/Contents/MacOS/MedOS" 2>/dev/null || true
  chmod +x "$APP_DIR/node_modules/.bin/next" 2>/dev/null || true
  [ -n "${MAC_TOOLS:-}" ] || return 0
  case "$MAC_TOOLS" in
    "$ROOT_DIR/mac-tools/arm64"|"$ROOT_DIR/mac-tools/x64") ;;
    *) return 0 ;;
  esac
  [ -d "$MAC_TOOLS/python/bin" ] && find "$MAC_TOOLS/python/bin" -type f -exec chmod +x {} \; 2>/dev/null || true
  [ -d "$MAC_TOOLS/node/bin" ] && find "$MAC_TOOLS/node/bin" -type f -exec chmod +x {} \; 2>/dev/null || true
}

# ── Self-heal Gatekeeper quarantine (pre-built bundle, first run only) ───────
# A downloaded+unzipped bundle re-acquires com.apple.quarantine on its embedded
# python/node binaries, which macOS would otherwise block. Clear it once (only
# when a bundled runtime is present — setup-based installs have no mac-tools/).
if [ -d "$ROOT_DIR/mac-tools" ] && [ ! -f "$ROOT_DIR/mac-tools/.quarantine-cleared" ]; then
  xattr -dr com.apple.quarantine "$ROOT_DIR/mac-tools" "$ROOT_DIR/app" "$ROOT_DIR"/*.app 2>/dev/null || true
  : > "$ROOT_DIR/mac-tools/.quarantine-cleared" 2>/dev/null || true
fi

# ── Resolve one complete physical-architecture runtime candidate ─────────────
RUNTIME_SELECTION="$(/bin/sh "$SCRIPT_DIR/runtime-select.sh" "$ROOT_DIR")" || {
  echo "  ✗ MedOS: no complete bundled runtime is available." >&2
  exit 1
}
MAC_TOOLS_ARCH=$(printf '%s\n' "$RUNTIME_SELECTION" | /usr/bin/sed -n '1p')
MAC_TOOLS=$(printf '%s\n' "$RUNTIME_SELECTION" | /usr/bin/sed -n '2p')
if [ -z "$MAC_TOOLS_ARCH" ] || [ -z "$MAC_TOOLS" ] || [ ! -d "$MAC_TOOLS" ]; then
  echo "  ✗ MedOS: bundled runtime selection returned an invalid result." >&2
  exit 1
fi
MEDOS_RUNTIME_ARCH=$MAC_TOOLS_ARCH
export MEDOS_RUNTIME_ARCH
repair_portable_permissions

# Inject Darwin Next.js SWC binary so Windows-shipped node_modules can run.
SWC_DIR="$MAC_TOOLS/swc/node_modules/@next/swc-darwin-${MEDOS_RUNTIME_ARCH}"
SWC_BINDING="$SWC_DIR/next-swc.darwin-${MEDOS_RUNTIME_ARCH}.node"
if [ -n "$MAC_TOOLS" ] && [ -f "$SWC_BINDING" ]; then
  mkdir -p "$APP_DIR/node_modules/@next"
  base="$(basename "$SWC_DIR")"
  rm -rf "$APP_DIR/node_modules/@next/$base"
  cp -R "$SWC_DIR" "$APP_DIR/node_modules/@next/$base" 2>/dev/null || true
fi

# ── Flags (accept both --kebab and the Windows -PascalCase spellings) ────────
BACKEND_ONLY=0; FRONTEND_ONLY=0; NO_BROWSER=0
for arg in "$@"; do
  case "$arg" in
    --backend-only|-BackendOnly)   BACKEND_ONLY=1 ;;
    --frontend-only|-FrontendOnly) FRONTEND_ONLY=1 ;;
    --no-browser|-NoBrowser)       NO_BROWSER=1 ;;
    *) echo "  (ignoring unknown option: $arg)" ;;
  esac
done

# ── Pick the Python interpreter ──────────────────────────────────────────────
# Priority: bundled runtime (zero-setup / torrent) → repo .venv (setup.sh) → system.
if [ -n "$MAC_TOOLS" ] && [ -x "$MAC_TOOLS/python/bin/python3" ]; then
  PYTHON_EXE="$MAC_TOOLS/python/bin/python3"
elif [ -x "$ROOT_DIR/mac-tools/python/bin/python3" ]; then
  PYTHON_EXE="$ROOT_DIR/mac-tools/python/bin/python3"
elif [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PYTHON_EXE="$ROOT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_EXE="$(command -v python3)"
else
  echo "  ✗ MedOS: python3 not found. Run the setup first:  bash mac/setup.sh" >&2
  exit 1
fi

# ── Pick Node ────────────────────────────────────────────────────────────────
# A bundled Node (zero-setup / torrent) takes precedence over the system one.
if [ -n "$MAC_TOOLS" ] && [ -x "$MAC_TOOLS/node/bin/node" ]; then
  export PATH="$MAC_TOOLS/node/bin:$PATH"
elif [ -x "$ROOT_DIR/mac-tools/node/bin/node" ]; then
  export PATH="$ROOT_DIR/mac-tools/node/bin:$PATH"
fi
if ! command -v node >/dev/null 2>&1; then
  echo "  ✗ MedOS: Node.js not found. Run the setup first:  bash mac/setup.sh" >&2
  exit 1
fi
NODE_EXE="$(command -v node)"

# ── File locations the status server tails ───────────────────────────────────
BACKEND_LOG="$APP_DIR/backend.log";  BACKEND_ERR="$APP_DIR/backend.err";  BACKEND_PID="$APP_DIR/backend.pid"
FRONTEND_LOG="$APP_DIR/frontend.log"; FRONTEND_ERR="$APP_DIR/frontend.err"; FRONTEND_PID="$APP_DIR/frontend.pid"
STATUS_PID="$APP_DIR/status.pid"
STATUS_PORT=4321

# ── .env helpers (mirror the PowerShell Get/Set-MedosEnvValue) ───────────────
get_env_value() { # <file> <key>  → prints value (quotes stripped) or ""
  [ -f "$1" ] || { printf ''; return; }
  local v
  v="$(grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" 2>/dev/null | head -n1 \
       | sed -E "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//")"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

set_env_value() { # <file> <key> <value>  — replace KEY=… in place, or append
  local file="$1" key="$2" val="$3" tmp found=0 changed=0 line stripped key_token newline
  tmp="$(mktemp)"
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      stripped="${line#"${line%%[![:space:]]*}"}"   # left-trim the line
      case "$stripped" in
        *=*)
          key_token="${stripped%%=*}"                              # text before '='
          key_token="${key_token#"${key_token%%[![:space:]]*}"}"   # ltrim key
          key_token="${key_token%"${key_token##*[![:space:]]}"}"   # rtrim key
          if [ "$key_token" = "$key" ]; then
            newline="$key=$val"
            [ "$line" = "$newline" ] || changed=1
            printf '%s\n' "$newline"; found=1; continue
          fi ;;
      esac
      printf '%s\n' "$line"
    done < "$file" > "$tmp"
  fi
  if [ "$found" -eq 0 ]; then
    printf '%s=%s\n' "$key" "$val" >> "$tmp"
    changed=1
  fi
  if [ "$changed" -eq 1 ] || [ ! -f "$file" ]; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
  fi
}

gen_secret() { # random → base64 → alnum only → exactly 48 chars (matches START.ps1)
  "$PYTHON_EXE" -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(48)))'
}

ensure_session_env() {
  local backend_env="$BACKEND_DIR/.env" frontend_env="$APP_DIR/.env" secret
  secret="$(get_env_value "$backend_env" MEDOS_SESSION_SECRET)"
  [ -z "$secret" ] && secret="$(get_env_value "$frontend_env" MEDOS_SESSION_SECRET)"
  [ -z "$secret" ] && secret="$(gen_secret)"

  if [ ! -f "$backend_env" ]; then
    cat > "$backend_env" <<EOF
BACKEND_PORT=8002
ALLOWED_ORIGINS=http://localhost:3000
UTD_DB_PATH=
AMBOSS_DIR=
UTD_PASSWORD=
MEDOS_SESSION_SECRET=$secret
MEDOS_SKIP_REFERENCE_WARMUP=1
EOF
  else
    set_env_value "$backend_env" MEDOS_SESSION_SECRET "$secret"
  fi
  set_env_value "$frontend_env" MEDOS_SESSION_SECRET "$secret"
  export MEDOS_SESSION_SECRET="$secret"
}

import_env_file() { # load KEY=VALUE lines from <file> into this shell's env
  [ -f "$1" ] || return 0
  local line k v
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#"${line%%[![:space:]]*}"}"          # left-trim
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    k="${line%%=*}"; v="${line#*=}"
    k="$(printf '%s' "$k" | tr -d '[:space:]')"
    case "$k" in [A-Za-z_]*) ;; *) continue ;; esac    # valid identifier only
    v="${v#"${v%%[![:space:]]*}"}"                     # left-trim value
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}" # strip surrounding quotes
    export "$k=$v"
  done < "$1"
}

# ── Detect the LAN IP (Wi-Fi first, then anything private) ───────────────────
detect_lan_ip() {
  local ip="" iface
  for iface in en0 en1 en2 en3 en4 en5 en6; do
    ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    [ -n "$ip" ] && { printf '%s' "$ip"; return; }
  done
  ip="$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -vE '^127\.|^169\.254\.' | head -n1)"
  [ -n "$ip" ] && { printf '%s' "$ip"; return; }
  printf 'localhost'
}

kill_pidfile() { # <pidfile> — kill the process and its children, then remove file
  [ -f "$1" ] || return 0
  local p; p="$(cat "$1" 2>/dev/null)"
  case "$p" in ''|*[!0-9]*) ;; *) pkill -P "$p" 2>/dev/null || true; kill "$p" 2>/dev/null || true ;; esac
  rm -f "$1"
}

kill_port() { # <port>
  local pids; pids="$(lsof -ti tcp:"$1" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
}

# ── Prepare environment ──────────────────────────────────────────────────────
ensure_session_env
import_env_file "$BACKEND_DIR/.env"
export NODE_ENV=production
MEDOS_INTERNAL_FORWARD_TOKEN="$("$PYTHON_EXE" -B -E -s -c 'import secrets; print(secrets.token_hex(32))')"
if [ "${#MEDOS_INTERNAL_FORWARD_TOKEN}" -ne 64 ]; then
  echo "  ✗ MedOS: secure network session could not be created." >&2
  exit 1
fi
case "$MEDOS_INTERNAL_FORWARD_TOKEN" in
  *[!0-9a-f]*) echo "  ✗ MedOS: secure network session could not be created." >&2; exit 1 ;;
esac
MEDOS_NETWORK_ACCESS_SETTINGS="$HOME/Library/Application Support/MedOS/network-access.json"
export MEDOS_INTERNAL_FORWARD_TOKEN MEDOS_NETWORK_ACCESS_SETTINGS
LAN_IP="$(detect_lan_ip)"
export MEDOS_LAN_IP="$LAN_IP"

# ── Locate the medical data ──────────────────────────────────────────────────
# Default: ./data next to the app. A shared/external data pack is honoured via
# MEDOS_ROOT in backend/.env (set it with mac/attach-data.sh). config.py reads
# the same variable, so the backend and this check always agree.
DATA_ROOT="${MEDOS_ROOT:-$ROOT_DIR}"
if [ ! -d "$DATA_ROOT/data" ]; then
  echo "  ⚠ MedOS: no medical data found at $DATA_ROOT/data"
  echo "    The app will still start, but reference content stays empty until you"
  echo "    attach the shared data pack:  bash mac/attach-data.sh /path/to/MedOS-data"
fi

# ── Stop any previous instance ───────────────────────────────────────────────
kill_pidfile "$BACKEND_PID"
kill_pidfile "$FRONTEND_PID"
kill_pidfile "$STATUS_PID"
for p in 8002 3000 "$STATUS_PORT"; do kill_port "$p"; done
sleep 1

# ── Rebuild the frontend on first run or when source changed (= START.ps1) ───
if [ "$BACKEND_ONLY" -eq 0 ]; then
  if [ ! -d "$APP_DIR/node_modules" ]; then
    echo "  ✗ MedOS: frontend dependencies are missing. Run the setup first:  bash mac/setup.sh" >&2
    exit 1
  fi
  # Shipped builds carry .next/.medos-shipped — a marker that this .next was built
  # by the packager and must NEVER be rebuilt on a recipient's machine (a rebuild
  # starves the backend at boot until it falls over). Mirrors app/START.ps1.
  if [ -f "$APP_DIR/.next/.medos-shipped" ]; then
    echo "  ✓ MedOS: using the prebuilt frontend (shipped build — no rebuild)."
    BACKEND_ONLY_SKIP_BUILD=1
  fi
  BUILD_ID="$APP_DIR/.next/BUILD_ID"
  build_reason=""
  if [ "${BACKEND_ONLY_SKIP_BUILD:-0}" -eq 1 ]; then
    build_reason=""
  elif [ ! -f "$BUILD_ID" ]; then
    build_reason="First launch"
  else
    # Only true frontend SOURCE counts. The .env files are deliberately excluded:
    # The frontend server reads MEDOS_SESSION_SECRET at runtime (proxy.ts), not at build
    # time, so a rewritten secret must not trigger a needless rebuild.
    newer="$(find "$APP_DIR/app" "$APP_DIR/components" "$APP_DIR/lib" \
                  "$APP_DIR/package.json" "$APP_DIR/next.config.ts" "$APP_DIR/proxy.ts" \
                  -newer "$BUILD_ID" 2>/dev/null | head -n1)"
    [ -n "$newer" ] && build_reason="Source changed"
  fi
  if [ -n "$build_reason" ]; then
    echo "  $build_reason — rebuilding frontend (1–3 min)…"
    if ! ( cd "$APP_DIR" && NODE_OPTIONS="--max-old-space-size=4096" \
        "$NODE_EXE" "$APP_DIR/node_modules/next/dist/bin/next" build ); then
      echo "  ✗ Frontend build failed. See the output above." >&2
      exit 1
    fi
    echo "  ✓ Build complete."
  fi
fi

# ── Start the status page server (port 4321) ────────────────────────────────
export PYTHONPATH="$APP_DIR"
( cd "$APP_DIR" && nohup "$PYTHON_EXE" status_server.py >/dev/null 2>&1 </dev/null & echo $! > "$STATUS_PID" )

# Wait up to ~3 s for it to bind, then open the browser to the status page.
for i in $(seq 1 30); do
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:${STATUS_PORT}" 2>/dev/null; then break; fi
  sleep 0.1
done
if [ "$NO_BROWSER" -eq 0 ]; then
  open "http://127.0.0.1:${STATUS_PORT}" 2>/dev/null || true
fi

# ── Start the backend (FastAPI / uvicorn, in-process) ────────────────────────
if [ "$FRONTEND_ONLY" -eq 0 ]; then
  : > "$BACKEND_LOG"; : > "$BACKEND_ERR"
  ( cd "$BACKEND_DIR" && PYTHONPATH="$BACKEND_DIR" \
      nohup "$PYTHON_EXE" main.py >"$BACKEND_LOG" 2>"$BACKEND_ERR" </dev/null & echo $! > "$BACKEND_PID" )
fi

# ── Start the frontend through the raw-socket MedOS boundary ────────────────
if [ "$BACKEND_ONLY" -eq 0 ]; then
  : > "$FRONTEND_LOG"; : > "$FRONTEND_ERR"
  ( cd "$APP_DIR" && NODE_OPTIONS="--max-old-space-size=4096" \
      nohup "$NODE_EXE" medos_server.mjs --production >"$FRONTEND_LOG" 2>"$FRONTEND_ERR" </dev/null & echo $! > "$FRONTEND_PID" )
fi

# ── Report ───────────────────────────────────────────────────────────────────
echo ""
echo "  ───────────────────────────────────────────────"
echo "   MedOS is starting."
echo "   Status page : http://127.0.0.1:${STATUS_PORT}  (auto-redirects when ready)"
echo "   On this Mac : http://localhost:3000"
if [ "$LAN_IP" != "localhost" ]; then
  echo "   Phone/iPad  : http://${LAN_IP}:3000   (same Wi-Fi)"
fi
echo "   Stop        : bash mac/stop.sh   (or the MedOS-Stop shortcut)"
echo "   Logs        : app/backend.log · app/frontend.log"
echo "  ───────────────────────────────────────────────"
echo ""
