default:
    just --list

fmt:
    cargo fmt --all

check:
    just frontend-check
    cargo fmt --check
    cargo clippy --workspace --all-targets --all-features -- -D warnings
    cargo nextest run --workspace
    just security-check

frontend-build:
    cd web && npm ci && npm run build

frontend-test:
    cd web && npm ci && npm test

frontend-check:
    cd web && npm ci && npm test && npm run build

security-check:
    bash tests/credential-helper.sh
    bash tests/manifest-security.sh

test:
    cargo nextest run --workspace

lint:
    cargo clippy --workspace --all-targets --all-features -- -D warnings

# Build all development binaries with the workspace-wide Nix dependency cache.
build:
    just frontend-build
    cargo build --workspace

build-ci-release:
    cargo build --workspace --profile ci-release

build-release:
    cargo build --workspace --release

nix-check:
    nix flake check

dev:
    just frontend-build
    mkdir -p .anvil/dev/profile/config .anvil/dev/profile/home
    cp dev/opencode-e2e.jsonc .anvil/dev/profile/config/opencode.jsonc
    cargo build -p anvild -p anvil-test-model
    PC_PORT_NUM=8090 process-compose -f dev/process-compose.yaml up

dev-full:
    just frontend-build
    mkdir -p .anvil/dev/profile/config .anvil/dev/profile/home
    cp dev/opencode-e2e.jsonc .anvil/dev/profile/config/opencode.jsonc
    cargo build -p anvild -p anvil-test-model -p anvil-mcp -p anvil-router
    PC_PORT_NUM=8090 process-compose -f dev/process-compose.yaml -f dev/process-compose-full.yaml up

e2e:
    bash tests/local-e2e.sh

e2e-ui:
    bash tests/local-e2e.sh --ui

e2e-sandbox-image:
    bash tests/sandbox-oci-acceptance.sh

e2e-k8s:
    bash tests/kind-acceptance.sh

image:
    nix build .#anvil-image -o result-anvil
    nix build .#anvil-sandbox-image -o result-anvil-sandbox
    nix build .#anvil-nix-daemon-image -o result-anvil-nix-daemon

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
    kubectl rollout status deployment/anvil-nix-daemon -n anvil
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

# Install the official SDLC and Mergify skills through Vercel's pinned CLI.
skills:
    skills add https://github.com/blogle/sdlc/tree/v1.2.4/skills/sdlc --skill sdlc --agent opencode --yes
    skills add https://github.com/Mergifyio/mergify-cli --skill '*' --agent opencode --yes

skills-update:
    skills update -p -y

ci:
    just check
    just nix-check
    just build-ci-release

# The SDLC publisher supplies the exact source identity. Promote the existing
# sha-tagged images; never rebuild them in the release hook.
release-publish version:
    #!/usr/bin/env bash
    set -euo pipefail
    version="{{version}}"
    test "$version" = "${SDLC_RELEASE_VERSION}"
    case "$version" in
      ''|*[!0-9.]*|.*|*.) exit 1 ;;
    esac
    test -n "${SDLC_RELEASE_MERGED_SHA}"
    test "${SDLC_RELEASE_MERGED_SHA}" = "$(git rev-parse --verify "${SDLC_RELEASE_MERGED_SHA}^{commit}")"
    test "${SDLC_RELEASE_MERGED_SHA}" = "$(git rev-parse HEAD)"
    test "${SDLC_RELEASE_SOURCE_SHA}" = "$(git rev-parse "${SDLC_RELEASE_MERGED_SHA}^1")"
    test -n "${SDLC_RELEASE_RECEIPTS}"
    test -n "${GH_TOKEN:-}"
    command -v skopeo >/dev/null
    username="${GHCR_USERNAME:-github-actions[bot]}"
    receipts="$(mktemp)"
    trap 'rm -f "$receipts"' EXIT
    for spec in \
      'anvil|ghcr.io/blogle/anvil' \
      'anvil-sandbox|ghcr.io/blogle/anvil-sandbox' \
      'anvil-nix-daemon|ghcr.io/blogle/anvil-nix-daemon'; do
      name="${spec%%|*}"
      image="${spec#*|}"
      source="docker://${image}:sha-${SDLC_RELEASE_SOURCE_SHA}"
      digest="$(skopeo inspect --creds "${username}:${GH_TOKEN}" "$source" | jq -er .Digest)"
      [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
      immutable="docker://${image}@${digest}"
      for tag in "$version" "v${version}"; do
        skopeo copy --all --src-creds "${username}:${GH_TOKEN}" --dest-creds "${username}:${GH_TOKEN}" "$immutable" "docker://${image}:${tag}"
      done
      jq -n --arg name "$name" --arg image "$image" --arg digest "$digest" --arg version "$version" --arg merged "${SDLC_RELEASE_MERGED_SHA}" --arg source "${SDLC_RELEASE_SOURCE_SHA}" '{name: $name, image: $image, digest: $digest, tags: [$version, ("v" + $version)], version: $version, merged_sha: $merged, source_main_sha: $source}' >> "$receipts"
    done
    mkdir -p "$(dirname "${SDLC_RELEASE_RECEIPTS}")"
    jq -s --arg version "$version" --arg merged "${SDLC_RELEASE_MERGED_SHA}" --arg source "${SDLC_RELEASE_SOURCE_SHA}" '{schema: 1, version: $version, merged_sha: $merged, source_main_sha: $source, artifacts: .}' "$receipts" > "${SDLC_RELEASE_RECEIPTS}"
