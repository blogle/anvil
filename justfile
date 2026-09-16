default:
    just --list

fmt:
    cargo fmt --all

check:
    cargo fmt --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo nextest run --workspace

test:
    cargo nextest run --workspace

lint:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

build:
    cargo build --workspace

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

load-images:
    nix build .#anvil-image -o result-anvil
    nix build .#anvil-sandbox-image -o result-anvil-sandbox
    k3s ctr images import ./result-anvil
    k3s ctr images import ./result-anvil-sandbox

deploy:
    just image
    just load-images
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
    @echo "Blocked: the installed Agent Sandbox controller is v0.5.3; required v1.0.2 router is absent. See docs/future.md."
    exit 1

smoke-clean:
    kubectl delete sandbox -n anvil -l app.kubernetes.io/managed-by=anvil

ci:
    just check
    just nix-check
    just build-release
