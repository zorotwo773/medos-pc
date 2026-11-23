#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
bash "$ROOT/linux/setup.sh" --if-needed
exec "$ROOT/.medos-linux/venv/bin/python" "$ROOT/linux/launch.py" "$@"
