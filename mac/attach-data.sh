#!/usr/bin/env bash
# =============================================================================
#  MedOS — attach the shared data pack (macOS / Linux)
#
#  Use this only when the medical data lives SOMEWHERE ELSE than inside the app
#  folder — e.g. the shared "MedOS-data" pack sits on an external SSD and you
#  don't want to copy 37 GB. It records that location in backend/.env as
#  MEDOS_ROOT; config.py then resolves all data/* paths from there.
#
#  If you instead just drop the `data/` folder INTO the app folder, you don't
#  need this at all — the app finds ./data automatically.
#
#  Usage:
#    bash mac/attach-data.sh /Volumes/MySSD/MedOS-data
#    bash mac/attach-data.sh            # auto-detect a sibling MedOS-data* folder
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_ENV="$ROOT_DIR/app/backend/.env"

set_env_value() { # <file> <key> <value> — replace KEY=… in place, or append
  local file="$1" key="$2" val="$3" tmp found=0 line stripped key_token
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
            printf '%s=%s\n' "$key" "$val"; found=1; continue
          fi ;;
      esac
      printf '%s\n' "$line"
    done < "$file" > "$tmp"
  fi
  [ "$found" -eq 0 ] && printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$file"
}

# ── Resolve the data-pack location ───────────────────────────────────────────
DATA_PACK="${1:-}"
if [ -z "$DATA_PACK" ]; then
  # Auto-detect a sibling folder named MedOS-data* that contains a data/ dir.
  for cand in "$ROOT_DIR"/../MedOS-data* "$ROOT_DIR"/MedOS-data*; do
    if [ -d "$cand/data" ]; then DATA_PACK="$cand"; break; fi
  done
fi

if [ -z "$DATA_PACK" ]; then
  echo "  ✗ No data pack given and none auto-detected." >&2
  echo "    Usage: bash mac/attach-data.sh /path/to/MedOS-data" >&2
  exit 1
fi

if [ ! -d "$DATA_PACK/data" ]; then
  echo "  ✗ '$DATA_PACK' does not contain a 'data' folder — is that the data pack?" >&2
  exit 1
fi

# Absolute, normalized path (so it survives launches from any working dir).
DATA_PACK_ABS="$(cd "$DATA_PACK" && pwd)"

if [ ! -f "$BACKEND_ENV" ]; then
  echo "  ✗ $BACKEND_ENV not found. Run mac/setup.sh (or launch once) first." >&2
  exit 1
fi

set_env_value "$BACKEND_ENV" MEDOS_ROOT "$DATA_PACK_ABS"

echo "  ✓ Attached data pack:"
echo "      $DATA_PACK_ABS/data"
echo "    Recorded as MEDOS_ROOT in app/backend/.env."
echo "    Start MedOS normally now (MedOS.app or bash mac/start.sh)."
