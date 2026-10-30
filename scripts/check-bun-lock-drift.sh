#!/usr/bin/env bash
set -euo pipefail

generated="$(mktemp)"
drifted="$(mktemp)"
trap 'rm -f "$generated" "$drifted"' EXIT

bun2nix -o "$generated"
cmp "$generated" bun.nix
cp "$generated" "$drifted"
printf '\n# deliberate drift probe\n' >> "$drifted"
if cmp -s "$drifted" bun.nix; then
  printf 'bun.nix drift probe was not detected\n' >&2
  exit 1
fi
printf 'generated bun.nix matches; deliberate drift detected\n'
