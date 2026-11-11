#!/usr/bin/env bash
# Build the app and pack what the computer needs to run it (no secrets, no node_modules).
# Usage: scripts/pack.sh [output.tgz]
# On the computer: scripts/install-on-computer.sh <the .tgz> does the rest (it is also inside the pack).
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-hq-app.tgz}"
rm -rf server/dist web/dist
npm run build
tar -czf "$out" \
  package.json package-lock.json .env.example \
  server/package.json server/dist server/box \
  web/package.json web/dist web/src/avatar/shapes.gen.ts \
  scripts/install-on-computer.sh scripts/add-hq-to-hermes.py scripts/sign-in-link.sh
echo "packed $(du -h "$out" | cut -f1) -> $out"
