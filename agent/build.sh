#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cargo build --release --locked
cp target/release/tug-agent tug-agent
chmod 700 tug-agent
printf '%s\n' 'Agent built: agent/tug-agent'
