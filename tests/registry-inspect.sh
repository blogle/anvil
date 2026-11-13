#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf '#!%s\n' "$(command -v bash)" > "$tmp/skopeo"
cat >> "$tmp/skopeo" <<'MOCK'
case "$MOCK_RESULT" in
  present) printf '{"schemaVersion":2}\n' ;;
  absent) printf 'time="now" level=fatal msg="...: manifest unknown"\n' >&2; exit 1 ;;
  unauthorized) printf 'unauthorized: token=do-not-print\n' >&2; exit 1 ;;
esac
MOCK
chmod +x "$tmp/skopeo"
export PATH="$tmp:$PATH"

manifest="$tmp/manifest.json"
MOCK_RESULT=present bash "$repo_root/scripts/registry-inspect-existing.sh" auth.json docker://ghcr.io/example/image:tag "$manifest"
[[ "$(<"$manifest")" == '{"schemaVersion":2}' ]]

if MOCK_RESULT=absent bash "$repo_root/scripts/registry-inspect-existing.sh" auth.json docker://ghcr.io/example/image:tag "$manifest"; then
  echo 'manifest unknown was not classified as absent' >&2
  exit 1
else
  [[ "$?" -eq 1 ]]
fi

if output="$(MOCK_RESULT=unauthorized bash "$repo_root/scripts/registry-inspect-existing.sh" auth.json docker://ghcr.io/example/image:tag "$manifest" 2>&1)"; then
  echo 'unauthorized inspect was not rejected' >&2
  exit 1
else
  [[ "$?" -eq 2 ]]
fi
[[ "$output" == *'refusing to publish'* ]]
[[ "$output" != *'do-not-print'* ]]

if MOCK_RESULT=absent bash "$repo_root/scripts/registry-inspect-existing.sh" auth.json docker://registry.example/image:tag "$manifest"; then
  echo 'non-GHCR missing tag was classified as absent' >&2
  exit 1
else
  [[ "$?" -eq 2 ]]
fi

printf 'registry inspect fail-closed checks passed\n'
