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
  rendered="$(kustomize build "$repo_root/k8s/overlays/dev")"
  kind_rendered="$(kustomize build "$repo_root/k8s/overlays/kind")"
  rendered_file="$(mktemp)"
  trap 'rm -f "$rendered_file"' EXIT
  printf '%s\n' "$rendered" > "$rendered_file"
  # The base declares one authoritative PVC; neither test nor production
  # may synthesize a parallel Nix store.
  if [ "$(printf '%s\n' "$rendered" | grep -Ec '^  name: anvil-nix-shared
  require_text 'rendered credentials reference' 'secretRef:' "$rendered_file"
  gc="$(printf '%s\n' "$rendered" | awk '/^kind: CronJob$/{found=1} found{print} /^---$/{if(found) exit}')"
  if [ -z "$gc" ]; then
    printf 'manifest-security: rendered CronJob document was not found\n%s\n' "$rendered" >&2
    exit 1
  fi
  gc_file="$(mktemp)"
  printf '%s\n' "$gc" > "$gc_file"
  require_text 'rendered GC name' 'name: anvil-nix-gc' "$gc_file"
  require_text 'rendered GC schedule' 'schedule: 0 3 * * *' "$gc_file"
  require_text 'rendered GC concurrency policy' 'concurrencyPolicy: Forbid' "$gc_file"
  require_text 'rendered daemon node affinity' 'requiredDuringSchedulingIgnoredDuringExecution:' "$gc_file"
  require_text 'rendered shared PVC' 'claimName: anvil-nix-shared' "$gc_file"
  require_text 'rendered daemon remote mode' 'value: daemon' "$gc_file"
  require_text 'rendered bounded GC command' 'nix store gc --max' "$gc_file"
  require_text 'rendered low-water mark' '20 / 100' "$gc_file"
  require_text 'rendered target free space' '30 / 100' "$gc_file"
  rm -f "$gc_file"
fi

printf 'manifest security checks passed\n')" -ne 1 ]; then
    printf 'manifest-security: expected exactly one canonical shared Nix PVC\n' >&2
    exit 1
  fi
  if printf '%s\n' "$rendered" | grep -Eq 'claimName: anvil-nix$|  name: anvil-nix
  require_text 'rendered credentials reference' 'secretRef:' "$rendered_file"
  gc="$(printf '%s\n' "$rendered" | awk '/^kind: CronJob$/{found=1} found{print} /^---$/{if(found) exit}')"
  if [ -z "$gc" ]; then
    printf 'manifest-security: rendered CronJob document was not found\n%s\n' "$rendered" >&2
    exit 1
  fi
  gc_file="$(mktemp)"
  printf '%s\n' "$gc" > "$gc_file"
  require_text 'rendered GC name' 'name: anvil-nix-gc' "$gc_file"
  require_text 'rendered GC schedule' 'schedule: 0 3 * * *' "$gc_file"
  require_text 'rendered GC concurrency policy' 'concurrencyPolicy: Forbid' "$gc_file"
  require_text 'rendered daemon node affinity' 'requiredDuringSchedulingIgnoredDuringExecution:' "$gc_file"
  require_text 'rendered shared PVC' 'claimName: anvil-nix-shared' "$gc_file"
  require_text 'rendered daemon remote mode' 'value: daemon' "$gc_file"
  require_text 'rendered bounded GC command' 'nix store gc --max' "$gc_file"
  require_text 'rendered low-water mark' '20 / 100' "$gc_file"
  require_text 'rendered target free space' '30 / 100' "$gc_file"
  rm -f "$gc_file"
fi

printf 'manifest security checks passed\n'; then
    printf 'manifest-security: legacy anvil-nix claim still present\n' >&2
    exit 1
  fi
  printf '%s\n' "$kind_rendered" | grep -Fq 'name: anvil-nix-gc' || {
    printf 'manifest-security: Kind overlay omitted upstream Nix GC\n' >&2; exit 1;
  }
  printf '%s\n' "$kind_rendered" | grep -Fq 'claimName: anvil-nix-shared' || {
    printf 'manifest-security: Kind overlay drifted from canonical Nix PVC\n' >&2; exit 1;
  }
  require_text 'rendered GitHub credentials' 'name: github-app-credentials' "$rendered_file"
  require_text 'rendered credentials reference' 'secretRef:' "$rendered_file"
  gc="$(printf '%s\n' "$rendered" | awk '/^kind: CronJob$/{found=1} found{print} /^---$/{if(found) exit}')"
  if [ -z "$gc" ]; then
    printf 'manifest-security: rendered CronJob document was not found\n%s\n' "$rendered" >&2
    exit 1
  fi
  gc_file="$(mktemp)"
  printf '%s\n' "$gc" > "$gc_file"
  require_text 'rendered GC name' 'name: anvil-nix-gc' "$gc_file"
  require_text 'rendered GC schedule' 'schedule: 0 3 * * *' "$gc_file"
  require_text 'rendered GC concurrency policy' 'concurrencyPolicy: Forbid' "$gc_file"
  require_text 'rendered daemon node affinity' 'requiredDuringSchedulingIgnoredDuringExecution:' "$gc_file"
  require_text 'rendered shared PVC' 'claimName: anvil-nix-shared' "$gc_file"
  require_text 'rendered daemon remote mode' 'value: daemon' "$gc_file"
  require_text 'rendered bounded GC command' 'nix store gc --max' "$gc_file"
  require_text 'rendered low-water mark' '20 / 100' "$gc_file"
  require_text 'rendered target free space' '30 / 100' "$gc_file"
  rm -f "$gc_file"
fi

printf 'manifest security checks passed\n'