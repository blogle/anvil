#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_text() {
  local description="$1" needle="$2" haystack="$3"
  if ! grep -Fq -- "$needle" "$haystack"; then
    printf 'manifest-security: missing %s: %s\n' "$description" "$needle" >&2
    printf '%s\n' "--- $haystack ---" >&2
    cat "$haystack" >&2
    exit 1
  fi
}

test "$(grep -c 'name: github-app-credentials' "$repo_root/k8s/base/deployments.yaml")" -eq 1
grep -A2 -B2 -F 'name: github-app-credentials' "$repo_root/k8s/base/deployments.yaml" \
  | grep -Fq 'secretRef:'

secret_manifest="$repo_root/k8s/base/github-app-secret.yaml"
grep -Fq 'stringData: {}' "$secret_manifest"
! grep -Eiq 'gh[pousr]_[A-Za-z0-9_]+|-----BEGIN|private[_-]?key|client[_-]?secret' "$secret_manifest"

gc_manifest="$repo_root/k8s/base/anvil-nix-gc.yaml"
require_text 'GC schedule' 'schedule: "0 3 * * *"' "$gc_manifest"
require_text 'GC concurrency policy' 'concurrencyPolicy: Forbid' "$gc_manifest"
require_text 'daemon node affinity' 'requiredDuringSchedulingIgnoredDuringExecution:' "$gc_manifest"
require_text 'daemon affinity label' 'app.kubernetes.io/name: anvil-nix-daemon' "$gc_manifest"
require_text 'daemon remote mode' 'value: daemon' "$gc_manifest"
require_text 'shared PVC' 'claimName: anvil-nix-shared' "$gc_manifest"
require_text 'bounded GC command' 'nix store gc --max' "$gc_manifest"
require_text 'low-water mark' '20 / 100' "$gc_manifest"
require_text 'target free space' '30 / 100' "$gc_manifest"
if grep -Eiq 'rm[[:space:]]+-rf|nix-store[[:space:]]+--delete|delete-generations|gcroots' "$gc_manifest"; then
  printf 'manifest-security: GC manifest contains forbidden manual root/profile deletion\n' >&2
  exit 1
fi

smoke_script="$repo_root/tests/nix-daemon-smoke.sh"
require_text 'daemon executable smoke' 'test -x /bin/anvil-nix-daemon' "$smoke_script"
require_text 'daemon RPC smoke' 'NIX_REMOTE=daemon nix store info' "$smoke_script"
require_text 'bootstrap smoke' '--bootstrap' "$smoke_script"
if [ "$(grep -Fc 'tests/nix-daemon-smoke.sh' "$repo_root/.github/workflows/images.yaml")" -ne 2 ]; then
  printf 'manifest-security: expected smoke in merge-queue and publish jobs\n' >&2
  exit 1
fi

if command -v kustomize >/dev/null 2>&1; then
  for overlay in dev kind; do
    rendered="$(kustomize build "$repo_root/k8s/overlays/$overlay")"
    pvc_count="$(grep -Ec '^  name: anvil-nix-shared$' <<<"$rendered" || true)"
    if [ "$pvc_count" -ne 1 ]; then
      printf 'manifest-security: %s must declare exactly one canonical Nix PVC (got %s)\n' "$overlay" "$pvc_count" >&2
      exit 1
    fi
    if grep -Eq 'claimName: anvil-nix$|  name: anvil-nix$' <<<"$rendered"; then
      printf 'manifest-security: %s renders obsolete Nix PVC\n' "$overlay" >&2
      exit 1
    fi
    grep -Fq 'name: github-app-credentials' <<<"$rendered"
    grep -Fq 'secretRef:' <<<"$rendered"
    grep -Fq 'name: anvil-nix-gc' <<<"$rendered"
    grep -Fq 'claimName: anvil-nix-shared' <<<"$rendered"
    grep -Fq 'ANVIL_NIX_PVC: anvil-nix-shared' <<<"$rendered"
  done
fi

printf 'manifest security checks passed\n'
