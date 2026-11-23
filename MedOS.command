#!/usr/bin/env bash
# Double-click to start MedOS. It launches in the background and opens your
# browser; you can close this window once the app appears.
# Terminal alternative:  bash MedOS.command
cd "$(dirname "$0")" || exit 1
clear
if bash mac/start.sh "$@"; then
  echo "This window can be closed — MedOS keeps running in the background."
  echo "(To stop it later, use MedOS-Stop.command.)"
else
  status=$?
  echo "MedOS did not start (exit $status). Scroll up to see what went wrong."
fi
echo ""
read -r -p "Press Return to close…" _
