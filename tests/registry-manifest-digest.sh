#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '#!%s\n' "$(command -v bash)" > "$tmp/skopeo"
cat >> "$tmp/skopeo" <<'MOCK'
set -euo pipefail
[[ "$1" == inspect && "$2" == --authfile && "$4" == --raw ]]
printf '{"schemaVersion":2}\n'
MOCK
chmod +x "$tmp/skopeo"

authfile="$tmp/auth.json"
remote='docker://registry.example/image:tag'
manifest_file="$tmp/manifest.json"
expected="$(printf '{\"schemaVersion\":2}\n' | sha256sum | cut -d' ' -f1)"
actual="$(PATH="$tmp:$PATH" bash "$repo_root/scripts/registry-manifest-digest.sh" "$authfile" "$remote" "$manifest_file")"
[[ "$actual" == "$expected" ]]
[[ "$(sha256sum "$manifest_file" | cut -d' ' -f1)" == "$expected" ]]

# Command substitution discards the manifest's trailing newline; the digest
# helper must hash the exact bytes emitted by skopeo instead.
captured="$(PATH="$tmp:$PATH" skopeo inspect --authfile "$authfile" --raw "$remote")"
stripped="$(printf '%s' "$captured" | sha256sum | cut -d' ' -f1)"
[[ "$actual" != "$stripped" ]]

printf 'registry raw manifest digest checks passed\n'
