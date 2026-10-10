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

canary_script="$repo_root/runtime/nix-deployment-canary"
require_text "fresh Nix derivation" "name = \"anvil-deployment-canary-" "$canary_script"
require_text "direct derivation expression" "expression='derivation {" "$canary_script"
if grep -Fq -- '--argstr nonce' "$canary_script"; then
  printf 'manifest-security: canary must not pass an unapplied lambda to nix-instantiate\n' >&2
  exit 1
fi
require_text "canary performs a real build" "nix-store --realise" "$canary_script"
require_text "directory-source chmod canary" "chmod -R u+w source" "$canary_script"
require_text "canary script baked into daemon" "daemonCanary" "$repo_root/nix/sandbox.nix"
require_text "OCI smoke executes canary" 'docker exec "$container" /bin/anvil-nix-deployment-canary' "$repo_root/tests/nix-daemon-smoke.sh"
require_text "deployment startup canary" "command: [/bin/anvil-nix-deployment-canary]" "$repo_root/k8s/base/anvil-nix-daemon.yaml"
canary_manifest="$repo_root/k8s/base/anvil-nix-canary.yaml"
require_text "periodic builder canary" 'schedule: "*/15 * * * *"' "$canary_manifest"
require_text "read-only canary mount" 'readOnly: true' "$canary_manifest"
require_text "bounded canary execution" 'activeDeadlineSeconds: 180' "$canary_manifest"
require_text "canary output cleanup" 'nix-store --delete "$output"' "$canary_script"
require_text "daemon derivation cleanup" 'nix-store --delete "$drv"' "$canary_script"
entrypoint="$repo_root/runtime/nix-daemon-entrypoint"
require_text "daemon fails closed on unsafe build metadata" 'refusing to repair shared state at daemon startup' "$entrypoint"
if grep -Eq 'normalize_build_state|chown root:root /nix|chmod u-s,g-s /nix' "$entrypoint"; then
  printf 'manifest-security: daemon entrypoint must not repair populated Nix volumes on restart\n' >&2
  exit 1
fi
if grep -Fq 'fsGroup:' "$repo_root/crates/anvild/src/lib.rs"; then
  printf 'manifest-security: generated sandbox must not set Pod fsGroup on shared volumes\n' >&2
  exit 1
fi
require_text "sandbox shared PVC without volume-level read-only" '"claimName":pvc}}' "$repo_root/crates/anvild/src/lib.rs"
require_text "Kind checks generated Sandbox fsGroup" '($pod.securityContext.fsGroup == null)' "$repo_root/tests/kind-acceptance.sh"
require_text "Kind builds fresh derivations across lifecycle" 'fresh_sandbox_build "$api_b_pod" "anvil-lifecycle-after-remove-${cluster}"' "$repo_root/tests/kind-acceptance.sh"

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
