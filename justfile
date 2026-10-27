set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    just --list

fmt:
    cargo fmt --all
    bun run fmt

build:
    cargo build
    bun run typecheck

test:
    cargo test
    bun run test

lint:
    cargo clippy --all-targets -- -D warnings

nix-check:
    nix flake check

docs port="8765" host="127.0.0.1":
    nix run .#docs -- --root docs --project . --port "{{port}}" --host "{{host}}"

check:
    just deps
    just fmt-check
    just build
    just lint
    just test
    just nix-check

fmt-check:
    cargo fmt --all -- --check
    bun run fmt:check

deps:
    bun install --frozen-lockfile
