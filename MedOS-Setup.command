#!/usr/bin/env bash
# Double-click to set up MedOS on this Mac (one time).
# If double-clicking is blocked, open Terminal and run:  bash MedOS-Setup.command
cd "$(dirname "$0")" || exit 1
clear
echo "Setting up MedOS for macOS — this runs once and may take a while."
echo ""
bash mac/setup.sh "$@"
status=$?
echo ""
if [ "$status" -eq 0 ]; then
  echo "All set. You can close this window and double-click MedOS.command to launch."
else
  echo "Setup did not finish (exit $status). Scroll up to see what went wrong."
fi
echo ""
read -r -p "Press Return to close…" _
