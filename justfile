set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load

default:
    @just --list

# Serve project documentation with live reload (fieldnotes workbench)
docs:
    nix run .#docs -- --root docs --project .

# Cheap admission checks: format, lint, unit tests
ci-check:
    nix build --no-link .#checks.x86_64-linux.fmt .#checks.x86_64-linux.clippy .#checks.x86_64-linux.test

# Merge-candidate verification: distributable packages build
ci-verify:
    nix build --no-link .#anvil .#anvild .#anvilctl .#anvil-router .#anvil-sandbox-image

# Load the sandbox image into the local podman store
sandbox-load:
    nix develop -c bash -c 'out=$(nix build .#anvil-sandbox-image.copyToPodman --print-out-paths --no-link 2>/dev/null); $out/bin/*'

# Run the full signal-to-reprompt scenario through a real Podman sandbox
sandbox-smoke: sandbox-load
    nix develop -c env ANVIL_TEST_PODMAN=1 ANVIL_TEST_SANDBOX_IMAGE=docker.io/library/anvil-sandbox:latest cargo test -p anvild --test feedback

# Verify the production provider through a disposable Kind cluster
agent-sandbox-smoke: sandbox-load
    nix develop -c nix shell nixpkgs#kind nixpkgs#kubectl nixpkgs#docker-client --command bash scripts/agent-sandbox-smoke.sh

# Provision ANVIL_SECRET_KEY into .env if absent (the daemon refuses to boot without it)
keygen:
    @if grep -q '^ANVIL_SECRET_KEY=' .env 2>/dev/null; then \
        echo "anvil: .env already has ANVIL_SECRET_KEY"; \
    else \
        umask 077; \
        echo "ANVIL_SECRET_KEY=$(nix shell nixpkgs#openssl -c openssl rand -hex 32)" >> .env; \
        echo "anvild: wrote a fresh ANVIL_SECRET_KEY into .env"; \
    fi

# Onboard the GitHub App and provider credentials from .env into the daemon (daemon must be running)
auth-onboard:
    #!/usr/bin/env bash
    set -euo pipefail
    nix run .#anvil -- inbox >/dev/null 2>&1 || { echo "the daemon is unreachable (start it with: just daemon)"; exit 1; }
    test -n "${GITHUB_APP_ID:-}" || { echo "GITHUB_APP_ID missing from .env (cp .env.example .env and fill it in)"; exit 1; }
    test -n "${GITHUB_INSTALLATION_ID:-}" || { echo "GITHUB_INSTALLATION_ID missing from .env (cp .env.example .env and fill it in)"; exit 1; }
    test -n "${GITHUB_APP_PRIVATE_KEY_FILE:-}" || { echo "GITHUB_APP_PRIVATE_KEY_FILE missing from .env (cp .env.example .env and fill it in)"; exit 1; }
    key_file="${GITHUB_APP_PRIVATE_KEY_FILE/#"~"/$HOME}"
    test -f "$key_file" || { echo "GITHUB_APP_PRIVATE_KEY_FILE does not exist: $key_file"; exit 1; }
    nix run .#anvil -- auth add github-app-id --secret "${GITHUB_APP_ID}"
    nix run .#anvil -- auth add github-installation-id --secret "${GITHUB_INSTALLATION_ID}"
    nix run .#anvil -- auth add github-app-private-key < "$key_file"
    for pair in ${PROVIDER_KEYS:-}; do
        name="${pair%%=*}"; value="${pair#*=}"
        echo "onboarding ${name}"
        nix run .#anvil -- auth add "$name" --secret "$value"
    done
    if test -n "${OPENCODE_AUTH_JSON_FILE:-}"; then
        auth_json="${OPENCODE_AUTH_JSON_FILE/#"~"/$HOME}"
        test -f "$auth_json" || { echo "OPENCODE_AUTH_JSON_FILE does not exist: $auth_json"; exit 1; }
        nix run .#anvil -- auth add "opencode-auth:chatgpt" < "$auth_json"
    fi
    nix run .#anvil -- auth list

# Run the daemon (reads .env from the working directory)
daemon:
    nix run .#anvild

# Validate changelog stubs
changelog-check:
    nix run .#sdlc -- changelog check

# Preview the next release from .changes stubs
release-plan:
    nix run .#sdlc -- changelog plan

# Consumer-owned promotion hook; replace with artifact promotion once images exist
release-publish version:
    gh release view "v{{version}}" >/dev/null 2>&1 || gh release create "v{{version}}" --title "v{{version}}" --generate-notes
