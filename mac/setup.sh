#!/usr/bin/env bash
# =============================================================================
#  MedOS — macOS one-time setup
#
#  Brings a folder that was built/copied on Windows to life on a Mac:
#    • verifies (or installs, via Homebrew) Python 3.10+ and Node.js
#    • creates a fresh Python virtual environment in .venv
#    • installs the backend Python packages
#    • reinstalls the Node packages (Windows binaries can't run on macOS)
#    • builds the frontend once
#    • clears Gatekeeper quarantine and makes the .command shortcuts runnable
#
#  Run it once after copying the folder over:
#    bash mac/setup.sh           # full install (includes AI-chat ML stack)
#    bash mac/setup.sh --lite    # skip torch/faiss/transformers (much smaller,
#                                #   AI /chat disabled; every other feature works)
# =============================================================================
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_DIR="$ROOT_DIR/app"
BACKEND_DIR="$APP_DIR/backend"
MAC_ICON="$ROOT_DIR/mac/MedOS.icns"

MODE="full"
for a in "$@"; do
  case "$a" in
    --lite) MODE="lite" ;;
    --full) MODE="full" ;;
    *) echo "  (ignoring unknown option: $a)" ;;
  esac
done

echo "──────────────────────────────────────────────────────────"
echo "  MedOS · macOS setup        mode: $MODE        arch: $(uname -m)"
echo "──────────────────────────────────────────────────────────"

have() { command -v "$1" >/dev/null 2>&1; }

brew_or_instruct() { # <brew-pkg> <human name> <download URL>
  if have brew; then
    echo "  • Installing $2 via Homebrew…"
    brew install "$1"
  else
    echo "" >&2
    echo "  ✗ $2 is not installed, and Homebrew was not found." >&2
    echo "    Easiest fix — install Homebrew (one paste, from https://brew.sh):" >&2
    echo '       /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"' >&2
    echo "    …then re-run this setup. Or install $2 directly from $3" >&2
    exit 1
  fi
}

get_env_value() { # <file> <key>  -> prints value (quotes stripped) or ""
  [ -f "$1" ] || { printf ''; return; }
  local v
  v="$(grep -E "^[[:space:]]*$2[[:space:]]*=" "$1" 2>/dev/null | head -n1 \
       | sed -E "s/^[[:space:]]*$2[[:space:]]*=[[:space:]]*//")"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

set_env_value() { # <file> <key> <value>  — replace KEY=... in place, or append
  local file="$1" key="$2" val="$3" tmp found=0 changed=0 line stripped key_token newline
  tmp="$(mktemp)"
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      stripped="${line#"${line%%[![:space:]]*}"}"
      case "$stripped" in
        *=*)
          key_token="${stripped%%=*}"
          key_token="${key_token#"${key_token%%[![:space:]]*}"}"
          key_token="${key_token%"${key_token##*[![:space:]]}"}"
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

gen_secret() {
  python3 -c 'import secrets,string; a=string.ascii_letters+string.digits; print("".join(secrets.choice(a) for _ in range(48)))'
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

write_app_launcher() { # <app name> <executable name> <bundle id> <script body>
  local app_name="$1" exe_name="$2" bundle_id="$3" script_body="$4"
  local app_dir="$ROOT_DIR/$app_name.app"
  local contents="$app_dir/Contents"
  local macos="$contents/MacOS"
  local resources="$contents/Resources"
  local icon_block=""
  rm -rf "$app_dir"
  mkdir -p "$macos" "$resources"
  if [ -f "$MAC_ICON" ]; then
    cp "$MAC_ICON" "$resources/MedOS.icns" 2>/dev/null || true
    icon_block='  <key>CFBundleIconFile</key>
  <string>MedOS</string>'
  fi
  cat > "$contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>$app_name</string>
  <key>CFBundleExecutable</key>
  <string>$exe_name</string>
  <key>CFBundleIdentifier</key>
  <string>$bundle_id</string>
$icon_block
  <key>CFBundleName</key>
  <string>$app_name</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
  <key>CFBundleVersion</key>
  <string>1</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF
  printf '%s\n' "$script_body" > "$macos/$exe_name"
  chmod +x "$macos/$exe_name"
  touch "$app_dir"
}

create_app_launchers() {
  write_app_launcher "MedOS" "MedOS" "local.medos.launcher" '#!/usr/bin/env bash
ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$ROOT_DIR/app/mac-launch.log"
mkdir -p "$ROOT_DIR/app"
cd "$ROOT_DIR" || exit 1
/usr/bin/osascript -e '"'"'display notification "Starting MedOS..." with title "MedOS"'"'"' >/dev/null 2>&1 || true
{
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] Starting MedOS from MedOS.app"
  bash "$ROOT_DIR/mac/start.sh"
  status=$?
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] mac/start.sh exited $status"
} >> "$LOG" 2>&1
if [ "$status" -ne 0 ]; then
  /usr/bin/osascript -e '"'"'display alert "MedOS did not start" message "If this is the first launch, run MedOS-Setup.command once. Otherwise check app/mac-launch.log, app/backend.err, and app/frontend.err in the MedOS folder." as critical buttons {"OK"} default button "OK"'"'"' >/dev/null 2>&1 || true
fi
exit "$status"'

  write_app_launcher "MedOS Stop" "MedOSStop" "local.medos.stop" '#!/usr/bin/env bash
ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
LOG="$ROOT_DIR/app/mac-launch.log"
mkdir -p "$ROOT_DIR/app"
cd "$ROOT_DIR" || exit 1
{
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] Stopping MedOS from MedOS Stop.app"
  bash "$ROOT_DIR/mac/stop.sh"
  status=$?
  echo "[$(date "+%Y-%m-%d %H:%M:%S")] mac/stop.sh exited $status"
} >> "$LOG" 2>&1
if [ "$status" -eq 0 ]; then
  /usr/bin/osascript -e '"'"'display notification "MedOS stopped." with title "MedOS"'"'"' >/dev/null 2>&1 || true
else
  /usr/bin/osascript -e '"'"'display alert "MedOS did not stop cleanly" message "Check app/mac-launch.log in the MedOS folder." as critical buttons {"OK"} default button "OK"'"'"' >/dev/null 2>&1 || true
fi
exit "$status"'
}

create_mac_icon() {
  local source="$ROOT_DIR/medos.ico"
  local iconset="$ROOT_DIR/mac/MedOS.iconset"
  [ -f "$source" ] || return 0
  command -v iconutil >/dev/null 2>&1 || return 0
  "$VENV_PY" - "$source" "$iconset" <<'PY' || true
from pathlib import Path
import shutil
import sys

try:
    from PIL import Image
except Exception:
    raise SystemExit(0)

src = Path(sys.argv[1])
iconset = Path(sys.argv[2])
if iconset.exists():
    shutil.rmtree(iconset)
iconset.mkdir(parents=True, exist_ok=True)

img = Image.open(src)
try:
    sizes = sorted(img.ico.sizes(), key=lambda s: s[0] * s[1])
    img = img.ico.getimage(sizes[-1])
except Exception:
    pass
img = img.convert("RGBA")

outputs = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024),
]
for name, size in outputs:
    canvas = img.resize((size, size), Image.LANCZOS)
    canvas.save(iconset / name)
PY
  if [ -d "$iconset" ]; then
    iconutil -c icns "$iconset" -o "$MAC_ICON" >/dev/null 2>&1 || true
    rm -rf "$iconset"
  fi
}

# ── Python 3.10+ ─────────────────────────────────────────────────────────────
if ! have python3; then
  brew_or_instruct python "Python 3" "https://www.python.org/downloads/macos/"
fi
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,10) else 1)'; then
  echo "  ✗ Python 3.10 or newer is required (found $(python3 --version 2>&1))." >&2
  echo "    Install a newer Python (brew install python) and re-run." >&2
  exit 1
fi
echo "  ✓ $(python3 --version)"

# ── Node.js + npm ────────────────────────────────────────────────────────────
if ! have node || ! have npm; then
  brew_or_instruct node "Node.js" "https://nodejs.org/en/download/"
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  if have brew; then
    echo "  • Updating Node.js via Homebrew (MedOS requires Node 20+)…"
    brew install node || brew upgrade node
  fi
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1; then
  echo "  ✗ Node.js 20 or newer is required (found $(node --version 2>&1))." >&2
  echo "    Install Node 20+ and re-run setup." >&2
  exit 1
fi
echo "  ✓ Node $(node --version)   npm $(npm --version)"

# ── Python virtual environment + packages ────────────────────────────────────
cd "$ROOT_DIR"
if [ ! -x "$ROOT_DIR/.venv/bin/python" ]; then
  echo "  • Creating Python virtual environment (.venv)…"
  rm -rf "$ROOT_DIR/.venv"            # a venv copied from Windows is unusable here
  python3 -m venv "$ROOT_DIR/.venv"
fi
VENV_PY="$ROOT_DIR/.venv/bin/python"
echo "  • Upgrading pip…"
"$VENV_PY" -m pip install --upgrade pip wheel >/dev/null

REQ="$BACKEND_DIR/requirements.txt"
if [ "$MODE" = "lite" ]; then
  REQ="$BACKEND_DIR/requirements-core.txt"
else
  echo "    (full mode downloads torch / faiss / transformers — several GB; this can take a while)"
fi
echo "  • Installing Python packages from $(basename "$REQ")…"
"$VENV_PY" -m pip install -r "$REQ"
echo "  ✓ Backend packages installed."
# Cosmetic only — must never be able to abort setup, so swallow any failure.
create_mac_icon || true

# ── Frontend packages + build ────────────────────────────────────────────────
cd "$APP_DIR"
ensure_session_env
echo "  • Reinstalling Node packages (dropping any Windows binaries)…"
rm -rf node_modules .next
npm install
echo "  • Building the frontend once (1–3 min)…"
NODE_OPTIONS="--max-old-space-size=4096" npm run build
echo "  ✓ Frontend built."

# ── macOS housekeeping ───────────────────────────────────────────────────────
cd "$ROOT_DIR"
create_app_launchers
# Strip the "downloaded from the internet" quarantine so double-clicking the
# .app/.command shortcuts doesn't trigger a Gatekeeper warning.
xattr -dr com.apple.quarantine "$ROOT_DIR" 2>/dev/null || true
# Make the launchers executable so they open on double-click.
chmod +x "$SCRIPT_DIR"/*.sh 2>/dev/null || true
chmod +x "$ROOT_DIR"/*.command 2>/dev/null || true
chmod +x "$ROOT_DIR/MedOS.app/Contents/MacOS/MedOS" 2>/dev/null || true
chmod +x "$ROOT_DIR/MedOS Stop.app/Contents/MacOS/MedOSStop" 2>/dev/null || true

echo ""
echo "  ✅ Setup complete."
echo ""
echo "     Start MedOS :  double-click  MedOS.app       (hidden, opens browser)"
echo "     Stop  MedOS :  double-click  MedOS Stop.app  (hidden)"
echo "     Troubleshoot: double-click  MedOS.command    (visible Terminal)"
echo ""
if [ "$MODE" = "lite" ]; then
  echo "     Note: lite install — the AI /chat tab is disabled. Re-run"
  echo "           'bash mac/setup.sh' (full) later if you want it."
  echo ""
fi
