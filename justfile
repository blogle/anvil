default:
    just --list

fmt:
    cargo fmt --all

check:
    cargo fmt --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo nextest run --workspace
    just security-check

security-check:
    bash tests/credential-helper.sh
    bash tests/manifest-security.sh

test:
    cargo nextest run --workspace

lint:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

build:
    cargo build --workspace

build-ci-release:
    cargo build --workspace --profile ci-release

build-release:
    cargo build --workspace --release

nix-check:
    nix flake check

dev:
    cargo run -p anvild

image:
    nix build .#anvil-image -o result-anvil
    nix build .#anvil-sandbox-image -o result-anvil-sandbox

image-anvil:
    nix build .#anvil-image -o result-anvil

image-sandbox:
    nix build .#anvil-sandbox-image -o result-anvil-sandbox

load-sandbox-k3s local_tag="local-anvil7-{{`git rev-parse --short=12 HEAD`}}":
    nix build .#anvil-sandbox-image -o result-anvil-sandbox
    ANVIL_KUBECONFIG="${ANVIL_KUBECONFIG:-/workspace/kube_config/config}" nix run .#import-sandbox-image-k3s -- result-anvil-sandbox "{{local_tag}}" ghcr.io/blogle/anvil-sandbox:anvil7-dev

load-images:
    nix build .#anvil-image -o result-anvil
    nix build .#anvil-sandbox-image -o result-anvil-sandbox
    k3s ctr images import ./result-anvil
    k3s ctr images import ./result-anvil-sandbox

deploy:
    kubectl apply -k k8s/overlays/dev
    kubectl rollout status deployment/anvild -n anvil
    kubectl rollout status deployment/anvil-profile -n anvil
    kubectl rollout status deployment/anvil-mcp -n anvil
    kubectl rollout status deployment/anvil-router -n anvil
    just status

undeploy:
    kubectl delete -k k8s/overlays/dev

status:
    kubectl get all,sandbox,pvc -n anvil

logs service:
    kubectl logs -n anvil deployment/{{service}} -f

smoke:
    kubectl auth can-i --as=system:serviceaccount:anvil:anvild create sandboxes.agents.x-k8s.io -n anvil
    kubectl auth can-i --as=system:serviceaccount:anvil:anvild get pods -n anvil

smoke-clean:
    kubectl delete sandbox -n anvil -l app.kubernetes.io/managed-by=anvil

ci:
    just check
    just nix-check
    just build-ci-release
