#!/usr/bin/env bash
set -euo pipefail

flake_ref="${1:-.}"
mode="${ANVIL_IMAGE_BENCHMARK_MODE:-build}"

case "$mode" in
  build)
    run_image() {
      nix build --no-link "$flake_ref#$1"
    }
    ;;
  push)
    run_image() {
      nix run "$flake_ref#$1.copyToRegistry"
    }
    ;;
  *)
    printf 'ANVIL_IMAGE_BENCHMARK_MODE must be build or push\n' >&2
    exit 2
    ;;
esac

# Warm the baseline so the first measured row is a real no-op rebuild/push.
run_image anvil-sandbox-image >/dev/null
printf '| scenario | seconds |\n|---|---:|\n'
for scenario in \
  anvil-sandbox-image \
  anvil-sandbox-image-env-cmd \
  anvil-sandbox-image-entrypoint \
  anvil-sandbox-image-opencode \
  anvil-sandbox-image-chromium; do
  start_ns="$(date +%s%N)"
  run_image "$scenario" >/dev/null
  end_ns="$(date +%s%N)"
  elapsed_ms=$(( (end_ns - start_ns) / 1000000 ))
  case "$scenario" in
    anvil-sandbox-image) label="no-op image build" ;;
    anvil-sandbox-image-env-cmd) label="Env/Cmd-only change" ;;
    anvil-sandbox-image-entrypoint) label="entrypoint change" ;;
    anvil-sandbox-image-opencode) label="OpenCode version change" ;;
    anvil-sandbox-image-chromium) label="Chromium version change" ;;
  esac
  printf '| %s | %.3f |\n' "$label" "$((elapsed_ms / 1000)).$((elapsed_ms % 1000))"
done
