#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 3 ]; then
  echo "usage: runtime-select.sh RELEASE_ROOT [PROCESS_ARCH] [TRANSLATED]" >&2
  exit 2
fi

RELEASE_ROOT=$1
PROCESS_ARCH=${2:-$(/usr/bin/uname -m)}
if [ "$#" -ge 3 ]; then
  TRANSLATED=$3
elif [ "$PROCESS_ARCH" = "x86_64" ] || [ "$PROCESS_ARCH" = "amd64" ]; then
  TRANSLATED=$(/usr/sbin/sysctl -in sysctl.proc_translated 2>/dev/null || printf '0')
else
  TRANSLATED=0
fi

case "$PROCESS_ARCH" in
  arm64|aarch64)
    PHYSICAL_ARCH=arm64
    ;;
  x86_64|amd64)
    if [ "$TRANSLATED" = "1" ]; then
      PHYSICAL_ARCH=arm64
    else
      PHYSICAL_ARCH=x64
    fi
    ;;
  *)
    echo "unsupported macOS architecture: $PROCESS_ARCH" >&2
    exit 2
    ;;
esac

runtime_complete() {
  candidate=$1
  architecture=$2
  [ -f "$candidate/python/bin/python3" ] &&
    [ -f "$candidate/node/bin/node" ] &&
    [ -f "$candidate/node/bin/npm" ] &&
    [ -f "$candidate/swc/node_modules/@next/swc-darwin-$architecture/next-swc.darwin-$architecture.node" ]
}

if [ "$PHYSICAL_ARCH" = "arm64" ]; then
  ORDER="arm64 x64"
else
  ORDER="x64"
fi

for architecture in $ORDER; do
  candidate="$RELEASE_ROOT/mac-tools/$architecture"
  if runtime_complete "$candidate" "$architecture"; then
    printf '%s\n%s\n' "$architecture" "$candidate"
    exit 0
  fi
done

echo "no complete bundled macOS runtime: $ORDER" >&2
exit 2
