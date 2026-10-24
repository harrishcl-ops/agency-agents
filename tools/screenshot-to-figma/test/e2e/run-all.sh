#!/usr/bin/env bash
# Full visual regression: capture fixtures, render with the real renderer in the
# Figma emulator, and score against the originals (before/after pixel snapping).
set -euo pipefail
cd "$(dirname "$0")/../.."
export CHROMIUM="${CHROMIUM:-/opt/pw-browsers/chromium-1243/chrome-linux64/chrome}"
node test/e2e/capture.mjs >/dev/null
npx esbuild test/e2e/harness.ts --bundle --platform=node --format=esm --packages=external --outfile=test/e2e/out/harness.mjs --log-level=warning
npx esbuild src/plugin/harness.ts --bundle --minify --target=es2017 --format=iife --outfile=test/e2e/out/renderer.min.js --log-level=warning
for n in ${FIXTURES:-landing mobile dashboard}; do
  node test/e2e/out/harness.mjs prepare "$n" --no-snap >/dev/null
  node test/e2e/out/harness.mjs prepare "$n" >/dev/null
  printf "%-10s before snapping: " "$n"; node test/e2e/emu/run.mjs "$n" .nosnap | tail -1 | sed 's/^[a-z]*: //'
  printf "%-10s after snapping:  " "$n"; node test/e2e/emu/run.mjs "$n" | tail -1 | sed 's/^[a-z]*: //'
done
