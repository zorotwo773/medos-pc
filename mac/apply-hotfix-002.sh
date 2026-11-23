#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOTFIX_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd -P)
TARGET_INPUT=${1:-}
if [ -z "$TARGET_INPUT" ]; then
  printf '%s\n' "Drag the original MedOS folder into Terminal, then press Return:"
  IFS= read -r TARGET_INPUT
fi
case "$TARGET_INPUT" in
  \"*\") TARGET_INPUT=${TARGET_INPUT#\"}; TARGET_INPUT=${TARGET_INPUT%\"} ;;
esac
if [ ! -d "$TARGET_INPUT" ]; then
  echo "MedOS hotfix: that folder does not exist."
  exit 2
fi
TARGET_ROOT=$(CDPATH= cd -- "$TARGET_INPUT" && pwd -P)
START_SCRIPT="$TARGET_ROOT/mac/start.sh"
APP_DIR="$HOME/Applications/MedOS.app"
DESKTOP_LINK="$HOME/Desktop/MedOS.app"

if [ ! -f "$START_SCRIPT" ]; then
  echo "MedOS hotfix: mac/start.sh was not found."
  echo "Extract this update inside the original MedOS folder, then run it again."
  exit 2
fi

# Update the small installer modules without touching medical data or progress.
for relative in \
  setup_center/cli.py setup_center/server.py setup_center/portable.py \
  setup_center/repair.py setup_center/shortcuts.py setup_center/static/app.js
do
  source_file="$HOTFIX_ROOT/$relative"
  target_file="$TARGET_ROOT/$relative"
  [ -f "$source_file" ] || { echo "MedOS hotfix is incomplete: $relative"; exit 2; }
  mkdir -p "$(dirname -- "$target_file")"
  chmod u+w "$target_file" 2>/dev/null || true
  cp "$source_file" "$target_file"
done

owned_bundle() {
  candidate=$1
  [ -d "$candidate" ] || return 1
  plist="$candidate/Contents/Info.plist"
  [ -f "$plist" ] || return 1
  identifier=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist" 2>/dev/null || true)
  [ "$identifier" = "org.medos.desktop" ] || [ "$identifier" = "local.medos.launcher" ]
}

mkdir -p "$HOME/Applications" "$HOME/Desktop"
if [ -e "$APP_DIR" ] || [ -L "$APP_DIR" ]; then
  if [ -L "$APP_DIR" ] || ! owned_bundle "$APP_DIR"; then
    echo "MedOS hotfix stopped: ~/Applications/MedOS.app is not an owned MedOS shortcut."
    exit 3
  fi
  rm -rf "$APP_DIR"
fi

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
printf '%s\n' "$TARGET_ROOT" > "$APP_DIR/Contents/Resources/target-root"
if [ -f "$TARGET_ROOT/setup_center/assets/MedOS.icns" ]; then
  cp "$TARGET_ROOT/setup_center/assets/MedOS.icns" "$APP_DIR/Contents/Resources/MedOS.icns"
fi

cat > "$APP_DIR/Contents/MacOS/MedOS" <<'LAUNCHER'
#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
RESOURCE_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../Resources" && pwd)
IFS= read -r TARGET_ROOT < "$RESOURCE_DIR/target-root"
case "$TARGET_ROOT" in /*) ;; *) exit 64 ;; esac
if /bin/bash "$TARGET_ROOT/mac/start.sh" --no-browser; then
  /usr/bin/open "http://127.0.0.1:4321" >/dev/null 2>&1 || true
  exit 0
else
  STATUS=$?
  exit "$STATUS"
fi
LAUNCHER
chmod 755 "$APP_DIR/Contents/MacOS/MedOS"

cat > "$APP_DIR/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>MedOS</string>
<key>CFBundleExecutable</key><string>MedOS</string>
<key>CFBundleIconFile</key><string>MedOS.icns</string>
<key>CFBundleIdentifier</key><string>org.medos.desktop</string>
<key>CFBundleName</key><string>MedOS</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.1.4</string>
<key>CFBundleVersion</key><string>2</string>
</dict></plist>
PLIST

if [ -e "$DESKTOP_LINK" ] || [ -L "$DESKTOP_LINK" ]; then
  if [ -L "$DESKTOP_LINK" ]; then
    rm "$DESKTOP_LINK"
  elif owned_bundle "$DESKTOP_LINK"; then
    rm -rf "$DESKTOP_LINK"
  else
    echo "MedOS hotfix stopped: Desktop/MedOS.app is not an owned MedOS shortcut."
    exit 3
  fi
fi
ln -s "$APP_DIR" "$DESKTOP_LINK"
xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true

echo "MedOS shortcut repaired. Opening MedOS at the correct local address..."
/usr/bin/open "$APP_DIR"
