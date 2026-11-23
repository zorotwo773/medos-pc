#!/usr/bin/env bash
# Portable macOS release smoke test. Run on the target Mac after extraction.
# It never prints environment files or their values.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NO_LAUNCH=0

for arg in "$@"; do
  case "$arg" in
    --no-launch) NO_LAUNCH=1 ;;
    *) echo "Usage: bash mac/smoke-test.sh [--no-launch]" >&2; exit 2 ;;
  esac
done

fail() { echo "  ✗ $*" >&2; exit 1; }
check() { echo "  ✓ $*"; }
cleanup_after_launch() { bash "$ROOT_DIR/mac/stop.sh" >/dev/null 2>&1 || true; }

MAC_ARCH="$(uname -m)"
case "$MAC_ARCH" in
  arm64|aarch64) MAC_TOOLS_ARCH="arm64" ;;
  x86_64|amd64)  MAC_TOOLS_ARCH="x64" ;;
  *) fail "unsupported macOS architecture: $MAC_ARCH" ;;
esac
MAC_TOOLS="$ROOT_DIR/mac-tools/$MAC_TOOLS_ARCH"
PYTHON_EXE="$MAC_TOOLS/python/bin/python3"
NODE_EXE="$MAC_TOOLS/node/bin/node"
SWC_BINDING="$MAC_TOOLS/swc/node_modules/@next/swc-darwin-${MAC_TOOLS_ARCH}/next-swc.darwin-${MAC_TOOLS_ARCH}.node"

[ -x "$PYTHON_EXE" ] || fail "bundled Python is not executable: $PYTHON_EXE"
[ -x "$NODE_EXE" ] || fail "bundled Node is not executable: $NODE_EXE"
[ -f "$SWC_BINDING" ] || fail "missing Darwin SWC binding: $SWC_BINDING"
check "architecture $MAC_ARCH uses $MAC_TOOLS_ARCH portable tools"
"$PYTHON_EXE" --version >/dev/null || fail "bundled Python did not run"
"$PYTHON_EXE" -c 'import fastapi, uvicorn' || fail "bundled Python cannot import backend dependencies"
"$NODE_EXE" --version >/dev/null || fail "bundled Node did not run"
"$NODE_EXE" -e 'process.exit(0)' || fail "bundled Node did not execute JavaScript"
check "Python, Node, backend imports, and SWC binding"

bash -n "$ROOT_DIR/mac/start.sh" || fail "portable start script has invalid Bash syntax"
bash -n "$ROOT_DIR/mac/stop.sh" || fail "portable stop script has invalid Bash syntax"
check "bundled launch syntax"

if [ "$NO_LAUNCH" -eq 1 ]; then
  echo "  Structural/runtime checks passed (--no-launch)."
  exit 0
fi

bash "$ROOT_DIR/mac/start.sh" --no-browser || fail "portable launch failed"
trap cleanup_after_launch EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for i in $(seq 1 60); do
  curl -fsS --max-time 1 http://127.0.0.1:4321/ >/dev/null 2>&1 &&
    curl -fsS --max-time 1 http://127.0.0.1:8002/health >/dev/null 2>&1 &&
    curl -fsS --max-time 1 http://127.0.0.1:3000/ >/dev/null 2>&1 && break
  sleep 1
done

curl -fsS --max-time 2 http://127.0.0.1:4321/ >/dev/null 2>&1 || fail "status port 4321 did not become healthy"
curl -fsS --max-time 2 http://127.0.0.1:8002/health >/dev/null 2>&1 || fail "backend port 8002 did not become healthy"
curl -fsS --max-time 2 http://127.0.0.1:3000/ >/dev/null 2>&1 || fail "frontend port 3000 did not become healthy"
check "status, backend, and frontend ports"

bash "$ROOT_DIR/mac/stop.sh" || fail "portable stop failed"
sleep 1
for port in 4321 8002 3000; do
  if lsof -ti tcp:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $port is still listening after stop"
  fi
done
check "stop behavior"
trap - EXIT INT TERM
