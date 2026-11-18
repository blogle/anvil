default:
    @just --list

# Serve project documentation with live reload (fieldnotes workbench)
docs:
    nix run .#docs -- --root docs --project .

# Cheap admission checks (full ci.nix machinery arrives with M1)
ci-check:
    nix flake check

# Merge-candidate verification (deferred to M1 ci.nix machinery)
ci-verify:
    @echo "ci-verify: arrives with M1 ci.nix check/verify machinery"

# Validate changelog stubs
changelog-check:
    nix run .#sdlc -- changelog check
