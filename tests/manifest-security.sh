#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

test "$(grep -c 'name: github-app-credentials' "$repo_root/k8s/base/deployments.yaml")" -eq 1
grep -A2 -B2 -F 'name: github-app-credentials' "$repo_root/k8s/base/deployments.yaml" \
  | grep -Fq 'secretRef:'

secret_manifest="$repo_root/k8s/base/github-app-secret.yaml"
grep -Fq 'stringData: {}' "$secret_manifest"
! grep -Eiq 'gh[pousr]_[A-Za-z0-9_]+|-----BEGIN|private[_-]?key|client[_-]?secret' "$secret_manifest"

gc_manifest="$repo_root/k8s/base/anvil-nix-gc.yaml"
grep -Fq 'schedule: "0 3 * * *"' "$gc_manifest"
grep -Fq 'concurrencyPolicy: Forbid' "$gc_manifest"
grep -Fq 'requiredDuringSchedulingIgnoredDuringExecution:' "$gc_manifest"
grep -Fq 'app.kubernetes.io/name: anvil-nix-daemon' "$gc_manifest"
grep -Fq 'value: daemon' "$gc_manifest"
grep -Fq 'claimName: anvil-nix' "$gc_manifest"
grep -Fq 'nix store gc --max' "$gc_manifest"
grep -Fq '20 / 100' "$gc_manifest"
grep -Fq '30 / 100' "$gc_manifest"
! grep -Eiq 'delete|remove|gcroot|profile' "$gc_manifest"

smoke_script="$repo_root/tests/nix-daemon-smoke.sh"
grep -Fq 'test -x /bin/anvil-nix-daemon' "$smoke_script"
grep -Fq 'NIX_REMOTE=daemon nix store info' "$smoke_script"
grep -Fq -- '--bootstrap' "$smoke_script"
test "$(grep -Fc 'tests/nix-daemon-smoke.sh' "$repo_root/.github/workflows/images.yaml")" -eq 2

if command -v kustomize >/dev/null 2>&1; then
  rendered="$(kustomize build "$repo_root/k8s/overlays/dev")"
  test "$(printf '%s\n' "$rendered" | grep -c 'name: github-app-credentials')" -eq 2
  test "$(printf '%s\n' "$rendered" | grep -c 'secretRef:')" -eq 1
  gc="$(printf '%s\n' "$rendered" | awk '/^kind: CronJob$/{found=1} found{print} /^---$/{if(found) exit}')"
  printf '%s\n' "$gc" | grep -Fq 'name: anvil-nix-gc'
  printf '%s\n' "$gc" | grep -Fq 'schedule: "0 3 * * *"'
  printf '%s\n' "$gc" | grep -Fq 'concurrencyPolicy: Forbid'
  printf '%s\n' "$gc" | grep -Fq 'requiredDuringSchedulingIgnoredDuringExecution:'
  printf '%s\n' "$gc" | grep -Fq 'claimName: anvil-nix'
  printf '%s\n' "$gc" | grep -Fq 'value: daemon'
  printf '%s\n' "$gc" | grep -Fq 'nix store gc --max'
  printf '%s\n' "$gc" | grep -Fq '20 / 100'
  printf '%s\n' "$gc" | grep -Fq '30 / 100'
fi

printf 'manifest security checks passed\n'
