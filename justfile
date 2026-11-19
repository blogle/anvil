set shell := ["bash", "-euo", "pipefail", "-c"]

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
    nix build --no-link .#anvil .#anvild .#anvilctl .#anvil-router

# Validate changelog stubs
changelog-check:
    nix run .#sdlc -- changelog check

# Preview the next release from .changes stubs
release-plan:
    nix run .#sdlc -- changelog plan

# Consumer-owned promotion hook; replace with artifact promotion once images exist
release-publish version:
    gh release view "v{{version}}" >/dev/null 2>&1 || gh release create "v{{version}}" --title "v{{version}}" --generate-notes
