#!/usr/bin/env bash
# First-time native Linux dependencies; normal launches do not install packages.
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
fail() { printf '\nMedOS Linux setup: %s\n' "$1" >&2; exit 2; }
[ "$(uname -s)" = Linux ] || fail 'Use the Mac or Windows launcher on this computer.'
command -v python3 >/dev/null || fail 'Install Python 3.11–3.14 (3.12 recommended) and its venv package, then retry.'
command -v node >/dev/null || fail 'Install native Node.js 22 LTS version 22.13+ (including npm), then retry. See the user guide.'
command -v npm >/dev/null || fail 'npm is missing from this Node.js installation. Install Node.js with npm, then retry.'
python3 -c 'import sys; raise SystemExit(not (3, 11) <= sys.version_info < (3, 15))' || fail 'The verified dependencies need Python 3.11–3.14 (3.12 recommended).'
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20 || (a===20 && b>=9) ? 0 : 1)' || fail 'This Node.js is too old. Install Node.js 22 LTS version 22.13+ (minimum runtime 20.9).'
[ -f app/.next/BUILD_ID ] && [ -f app/package-lock.json ] && [ -d data ] || fail 'Extract the COMPLETE release first. A source checkout also needs a frontend build and data.'
[ -f app/backend/requirements-core.txt ] && [ -f linux/requirements-lock.txt ] || fail 'The Linux dependency files are missing. Extract the complete release or apply the complete update.'
mkdir -p .medos-linux
stamp="$(python3 - "$ROOT" <<'PY'
import hashlib, pathlib, platform, sys
root=pathlib.Path(sys.argv[1])
h=hashlib.sha256()
for rel in ('app/package-lock.json','app/backend/requirements-core.txt','linux/requirements-lock.txt'):
    h.update((root/rel).read_bytes())
print('|'.join((str(root), platform.machine(), platform.python_version(), h.hexdigest())))
PY
)"
if [ "${1:-}" = --if-needed ] && [ -x .medos-linux/venv/bin/python ] && [ -f app/node_modules/next/package.json ] && [ -f .medos-linux/setup.stamp ] && [ "$(cat .medos-linux/setup.stamp)" = "$stamp" ]; then
  exit 0
fi
printf '\nPreparing native Linux dependencies. This first setup needs internet.\nMedical content and progress stay in place. PyTorch is optional and is not needed for reference browsing.\n'
python3 -m venv .medos-linux/venv || fail 'Could not create a virtual environment. Install python3-venv on Ubuntu/Debian, and use a writable Linux filesystem.'
.medos-linux/venv/bin/python -m pip install --disable-pip-version-check -r app/backend/requirements-core.txt -r linux/requirements-lock.txt || fail 'Python dependency installation failed. Check the error above and your internet connection, then retry.'
(cd app && npm ci --no-audit --no-fund) || fail 'Native frontend dependency installation failed. Check Node version, disk space and network, then retry.'
.medos-linux/venv/bin/python -c 'import fastapi,uvicorn,pydantic,dotenv,itsdangerous,httpx,Crypto,cryptography,multipart,selectolax,PIL,fitz' || fail 'A required backend dependency could not load.'
printf '%s\n' "$stamp" > .medos-linux/setup.stamp
printf '\nLinux setup complete. Open START HERE - LINUX.sh to run MedOS.\n'
