#!/usr/bin/env bash
set -euo pipefail

authfile="$1"
remote="$2"
manifest_file="$3"
inspect_error="$(mktemp)"
trap 'rm -f "$inspect_error"' EXIT

# Keep diagnostics private and bounded: skopeo can print auth-related details
# on stderr, and an inspect failure must never be interpreted as absence.
if (ulimit -f 8; skopeo inspect --authfile "$authfile" --raw "$remote" > "$manifest_file" 2> "$inspect_error"); then
  exit 0
fi

if [[ "$remote" == docker://ghcr.io/* ]] && LC_ALL=C grep -Eiq 'manifest unknown|name unknown' "$inspect_error"; then
  exit 1
fi

echo "unable to inspect registry tag; refusing to publish without verifying its state" >&2
exit 2
