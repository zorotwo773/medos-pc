#!/usr/bin/env bash
# Double-click to stop MedOS.
# Terminal alternative:  bash MedOS-Stop.command
cd "$(dirname "$0")" || exit 1
clear
bash mac/stop.sh "$@"
echo ""
read -r -p "Press Return to close…" _
