#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/anvil-kind-e2e.XXXXXX")"
cluster="anvil-e2e-${$}"
kubeconfig="$tmp/kubeconfig"
export KUBECONFIG="$kubeconfig"
created=0
cleanup() {
  if [ "$created" = 1 ]; then KUBECONFIG="$kubeconfig" kind delete cluster --name "$cluster" >/dev/null 2>&1 || true; fi
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

kind create cluster --name "$cluster" --kubeconfig "$kubeconfig" --wait 120s
created=1
kubectl --kubeconfig "$kubeconfig" cluster-info
kubectl --kubeconfig "$kubeconfig" apply -f "$root/k8s/vendor/agent-sandbox/v1.0.2/sandbox.yaml"
kubectl --kubeconfig "$kubeconfig" -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
kubectl --kubeconfig "$kubeconfig" wait --for=condition=Established --timeout=120s crd/sandboxes.agents.x-k8s.io
kubectl --kubeconfig "$kubeconfig" explain sandbox.spec --api-version=agents.x-k8s.io/v1beta1

# Prove this lane's current context and API operations are the isolated Kind
# control plane; this never reads the user's default kubeconfig.
kubectl --kubeconfig "$kubeconfig" auth can-i get sandboxes.agents.x-k8s.io --all-namespaces

if [ -n "${ANVIL_KIND_ACCEPTANCE_POD:-}" ]; then
  ANVIL_SANDBOX_POD="$ANVIL_KIND_ACCEPTANCE_POD" \
    ANVIL_NAMESPACE="${ANVIL_NAMESPACE:-anvil}" \
    bash "$root/tests/sandbox-acceptance.sh"
else
  printf 'Kind cluster and Agent Sandbox schema/controller lane passed; set ANVIL_KIND_ACCEPTANCE_POD after deploying the fixture workload to run shared runtime parity.\n'
fi
