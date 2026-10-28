set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    just --list

deps:
    bun install --frozen-lockfile

lock-check:
    bash scripts/check-bun-lock-drift.sh

fmt:
    bun run fmt

fmt-check:
    bun run fmt:check

typecheck:
    bun run typecheck

test:
    bun test

check: deps lock-check fmt-check typecheck test

ci-check:
    nix flake check

ci-verify:
    nix build .#ci.x86_64-linux.verify.typescript --no-link

docs port="8765" host="127.0.0.1":
    nix run .#docs -- --root docs --project . --port "{{port}}" --host "{{host}}"
