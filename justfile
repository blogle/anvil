set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    just --list

fmt:
    cargo fmt --all

build:
    cargo build

test:
    cargo test

lint:
    cargo clippy --all-targets -- -D warnings

nix-check:
    nix flake check

check:
    just fmt-check
    just build
    just lint
    just test
    just nix-check

ci-fast:
    nix build --no-link .#ci.x86_64-linux.fast.fmt .#ci.x86_64-linux.fast.clippy

ci-verify:
    nix build --no-link .#ci.x86_64-linux.verify.build .#ci.x86_64-linux.verify.tests

fmt-check:
    cargo fmt --all -- --check
