#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

test "$(grep -c 'name: github-app-credentials' "$repo_root/k8s/base/deployments.yaml")" -eq 1
grep -A2 -B2 -F 'name: github-app-credentials' "$repo_root/k8s/base/deployments.yaml" \
  | grep -Fq 'secretRef:'

secret_manifest="$repo_root/k8s/base/github-app-secret.yaml"
grep -Fq 'stringData: {}' "$secret_manifest"
! grep -Eiq 'gh[pousr]_[A-Za-z0-9_]+|-----BEGIN|private[_-]?key|client[_-]?secret' "$secret_manifest"

if command -v kustomize >/dev/null 2>&1; then
  rendered="$(kustomize build "$repo_root/k8s/overlays/dev")"
  test "$(printf '%s\n' "$rendered" | grep -c 'name: github-app-credentials')" -eq 2
  test "$(printf '%s\n' "$rendered" | grep -c 'secretRef:')" -eq 1
fi

printf 'manifest security checks passed\n'
