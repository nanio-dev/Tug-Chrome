#!/bin/sh
# Run as the desktop user, never with sudo. The binary installs into that user's data directory.
set -eu
if [ "$(id -u)" -eq 0 ]; then
  printf '%s\n' 'Run this installer as your normal desktop user, without sudo.' >&2
  exit 1
fi
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
chmod u+x ./tug-agent
./tug-agent --install
printf '%s\n' 'Tug Agent installed. Return to Tug; the extension will connect automatically.'
