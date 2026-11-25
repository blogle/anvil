#!/usr/bin/env bash
set -euo pipefail

dir=$(mktemp -d)
cluster="anvil-as-$(basename "$dir" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9-')"
export KUBECONFIG="$dir/kubeconfig"
export KIND_EXPERIMENTAL_PROVIDER=docker
trap 'kind delete cluster --name "$cluster" --kubeconfig "$KUBECONFIG"; rm -rf -- "$dir"' EXIT

cargo build -p anvild --bin anvild
target=$(cargo metadata --no-deps --format-version 1 | jq -er .target_directory)
cp "$target/debug/anvild" "$dir/anvild"
export ANVIL_TEST_KIND_FIXTURE="$dir"
unset ANVIL_SECRET_KEY

kind create cluster --name "$cluster" --kubeconfig "$KUBECONFIG" --wait 90s --config - <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
    extraMounts:
      - hostPath: /nix/store
        containerPath: /nix/store
        readOnly: true
      - hostPath: /nix/var/nix/daemon-socket
        containerPath: /nix/var/nix/daemon-socket
        readOnly: true
      - hostPath: "$dir"
        containerPath: /anvil-smoke
YAML

printf '%s\n' '{"default":[{"type":"reject"}],"transports":{"containers-storage":{"":[{"type":"insecureAcceptAnything"}]}}}' > "$dir/policy.json"
skopeo --policy "$dir/policy.json" copy containers-storage:docker.io/library/anvil-sandbox:latest "docker-archive:$dir/sandbox.tar:docker.io/library/anvil-sandbox:latest"
kind load image-archive "$dir/sandbox.tar" --name "$cluster"
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.12/sandbox.yaml
kubectl wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=60s
kubectl rollout status -n agent-sandbox-system deployment/agent-sandbox-controller --timeout=90s
cargo test -p anvild --test agent_sandbox -- --ignored --nocapture --exact controller_runs_anvil_image_and_signals_with_a_persistent_workspace
