#!/bin/sh
set -eu

# Matched against setup-drive.json's release_id, not a per-drive id: one built
# release must run from the SSD, the USB, or a plain extracted folder.
EXPECTED_RELEASE_ID="__MEDOS_RELEASE_ID__"
SCRIPT_DIR=$(/usr/bin/dirname "$0")
CONTENTS=$(CDPATH= cd "$SCRIPT_DIR/.." && /bin/pwd -P)
RESOURCES="$CONTENTS/Resources"

show_error() {
  MESSAGE=$1
  /bin/echo "MedOS Setup: $MESSAGE" >&2
  case "$MESSAGE" in
    "MedOS is on more than one"*)
      MESSAGE="$MESSAGE Open MedOS Setup from the folder you want to use, or disconnect the other drive."
      ;;
  esac
  # Pass failure details as data so quotes and paths never become AppleScript.
  /usr/bin/osascript - "$MESSAGE" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run arguments
  display dialog ((item 1 of arguments) & return & return & "See START HERE - README.html for recovery steps.") with title "MedOS Setup" buttons {"OK"} default button "OK" with icon stop
end run
APPLESCRIPT
}

PROCESS_ARCH=$(/usr/bin/uname -m)
case "$PROCESS_ARCH" in
  arm64|aarch64)
    PHYSICAL_ARCH=arm64
    ;;
  x86_64|amd64)
    TRANSLATED=$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || /usr/bin/printf '0')
    if [ "$TRANSLATED" = "1" ]; then
      PHYSICAL_ARCH=arm64
    else
      PHYSICAL_ARCH=x64
    fi
    ;;
  *)
    show_error "This Mac architecture is not supported: $PROCESS_ARCH"
    exit 2
    ;;
esac

if [ "$PHYSICAL_ARCH" = "arm64" ]; then
  RUNTIME_ORDER="arm64 x64"
else
  RUNTIME_ORDER="x64"
fi
RUNTIME_ARCH=""
SOURCE_RUNTIME=""
SOURCE_PYTHON=""
for CANDIDATE_ARCH in $RUNTIME_ORDER; do
  CANDIDATE_RUNTIME="$RESOURCES/runtime/$CANDIDATE_ARCH/mac-tools"
  CANDIDATE_PYTHON="$CANDIDATE_RUNTIME/python/bin/python3"
  if [ -x "$CANDIDATE_PYTHON" ]; then
    RUNTIME_ARCH=$CANDIDATE_ARCH
    SOURCE_RUNTIME=$CANDIDATE_RUNTIME
    SOURCE_PYTHON=$CANDIDATE_PYTHON
    break
  fi
done
if [ -z "$SOURCE_PYTHON" ]; then
  show_error "No bundled installer runtime is complete for this Mac."
  exit 2
fi

is_matching_root() {
  [ -f "$1/setup-drive.json" ] || return 1
  "$SOURCE_PYTHON" -B -E -s -c 'import json, os, sys
path, expected = sys.argv[1:]
if os.path.getsize(path) > 1048576:
    raise SystemExit(1)
try:
    with open(path, "r", encoding="utf-8") as source:
        value = json.load(source)
except (OSError, UnicodeError, ValueError):
    raise SystemExit(1)
raise SystemExit(0 if isinstance(value, dict) and value.get("release_id") == expected else 1)' "$1/setup-drive.json" "$EXPECTED_RELEASE_ID"
}

resolve_dir() {
  (CDPATH= cd "$1" 2>/dev/null && /bin/pwd -P) || return 1
}

# Prefer the release folder this installer was opened from, the way the Windows
# launcher uses its own directory. Scanning only /Volumes/*/ meant that copying
# or extracting MedOS into a folder on the drive — the normal result of
# unzipping the release — reported the drive as missing.
DRIVE_ROOT=""
APP_DIR=$(resolve_dir "$CONTENTS/../.." || /bin/echo "")
if [ -n "$APP_DIR" ]; then
  for CANDIDATE in "$APP_DIR" "$APP_DIR/.."; do
    RESOLVED=$(resolve_dir "$CANDIDATE" || /bin/echo "")
    [ -n "$RESOLVED" ] || continue
    if is_matching_root "$RESOLVED"; then
      DRIVE_ROOT=$RESOLVED
      break
    fi
  done
fi

if [ -z "$DRIVE_ROOT" ]; then
  # Detached installer (copied to /Applications or the Downloads folder): look
  # at each mounted volume and one folder level inside it.
  CANDIDATE_ROOTS=""
  for MARKER in /Volumes/*/setup-drive.json /Volumes/*/*/setup-drive.json; do
    [ -f "$MARKER" ] || continue
    RESOLVED=$(resolve_dir "${MARKER%/setup-drive.json}" || /bin/echo "")
    [ -n "$RESOLVED" ] || continue
    is_matching_root "$RESOLVED" || continue
    CANDIDATE_ROOTS="$CANDIDATE_ROOTS$RESOLVED
"
  done
  CANDIDATE_ROOTS=$(/bin/echo "$CANDIDATE_ROOTS" | /usr/bin/sort -u | /usr/bin/sed '/^$/d')
  MATCH_COUNT=$(/bin/echo "$CANDIDATE_ROOTS" | /usr/bin/sed '/^$/d' | /usr/bin/wc -l | /usr/bin/tr -d ' ')
  if [ "$MATCH_COUNT" -eq 0 ]; then
    show_error "The matching MedOS release folder was not found. Extract the complete release, then open MedOS Setup from inside that folder. If it is on an external drive, reconnect that drive first."
    exit 2
  fi
  if [ "$MATCH_COUNT" -gt 1 ]; then
    show_error "MedOS is on more than one connected drive."
    exit 2
  fi
  DRIVE_ROOT=$CANDIDATE_ROOTS
fi

CACHE_PARENT="$HOME/Library/Caches/MedOSSetup"
CACHE_ROOT="$CACHE_PARENT/$EXPECTED_RELEASE_ID"
/bin/mkdir -p "$CACHE_ROOT"
/usr/bin/ditto "$RESOURCES/setup_center" "$CACHE_ROOT/setup_center"
/usr/bin/ditto "$SOURCE_RUNTIME" "$CACHE_ROOT/runtime"

CACHED_PYTHON="$CACHE_ROOT/runtime/python/bin/python3"
if [ ! -x "$CACHED_PYTHON" ]; then
  show_error "The cached installer runtime could not be prepared."
  exit 2
fi

MEDOS_INTERNAL_FORWARD_TOKEN=$("$CACHED_PYTHON" -B -E -s -c 'import secrets; print(secrets.token_hex(32))')
if [ "${#MEDOS_INTERNAL_FORWARD_TOKEN}" -ne 64 ]; then
  show_error "A secure network session could not be created."
  exit 2
fi
case "$MEDOS_INTERNAL_FORWARD_TOKEN" in
  *[!0-9a-f]*)
    show_error "A secure network session could not be created."
    exit 2
    ;;
esac
MEDOS_NETWORK_ACCESS_SETTINGS="$HOME/Library/Application Support/MedOS/network-access.json"
export MEDOS_INTERNAL_FORWARD_TOKEN MEDOS_NETWORK_ACCESS_SETTINGS
export NODE_ENV=production

CDPATH= cd "$CACHE_ROOT"
exec "$CACHED_PYTHON" -B -E -s -m setup_center serve --drive-root "$DRIVE_ROOT"
