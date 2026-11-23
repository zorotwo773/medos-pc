#!/usr/bin/env bash
# =============================================================================
#  MedOS — generate the double-clickable .app launchers
#
#  Produces  MedOS.app  and  "MedOS Stop.app"  inside $ROOT_DIR. These are tiny
#  LSUIElement (no-Dock) bundles whose executable is a shell script that calls
#  mac/start.sh or mac/stop.sh. They give the polished, Terminal-free daily
#  launchers; the .command files remain as visible troubleshooting fallbacks.
#
#  Inputs (env):  ROOT_DIR  (required) — the MedOS folder to write the apps into
#                 MAC_ICON  (optional) — path to a .icns to embed
#
#  Used by mac/setup.sh and by PACK_RELEASE_MAC.sh. Can also be run directly:
#     ROOT_DIR=/path/to/MedOS bash mac/make_app_launchers.sh
#
#  NOTE: mac/setup.sh currently carries an inline copy of this logic for its own
#  flow; if you change the bundle layout, keep both in sync.
# =============================================================================
set -uo pipefail

ROOT_DIR="${ROOT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
MAC_ICON="${MAC_ICON:-$ROOT_DIR/mac/MedOS.icns}"

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

# Run when executed directly (not when sourced).
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  create_app_launchers
  echo "  ✓ Created MedOS.app and 'MedOS Stop.app' in $ROOT_DIR"
fi
