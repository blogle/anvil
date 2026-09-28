#!/usr/bin/env bash
set -euo pipefail

: "${ANVIL_SANDBOX_IMAGE:?set ANVIL_SANDBOX_IMAGE to the locally built sandbox image}"

canary_dir="${1:?usage: $0 CANARY_DIRECTORY}"
docker_canary_dir="$canary_dir"
if resolved_canary_dir="$(realpath "$canary_dir" 2>/dev/null)"; then
  docker_canary_dir="$resolved_canary_dir"
fi
container_name="${ANVIL_SANDBOX_CONTAINER:-anvil-sandbox-acceptance-$$}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --name "$container_name" --rm --entrypoint /bin/bash \
  -v "$docker_canary_dir:/workspace" \
  "$ANVIL_SANDBOX_IMAGE" -lc '
    set -euo pipefail
    agent_env=(env \
      HOME=/home/anvil \
      XDG_CONFIG_HOME=/home/anvil/.config \
      XDG_CACHE_HOME=/home/anvil/.cache \
      XDG_DATA_HOME=/home/anvil/.local/share \
      XDG_STATE_HOME=/home/anvil/.local/state \
      XDG_RUNTIME_DIR=/home/anvil/.local/state/runtime)
    test "$(setpriv --reuid=1000 --regid=1000 --init-groups -- "${agent_env[@]}" id -u)" = 1000
    test "$(setpriv --reuid=1000 --regid=1000 --init-groups -- "${agent_env[@]}" stat -c %u /nix/store)" = 0
    setpriv --reuid=1000 --regid=1000 --init-groups -- "${agent_env[@]}" /bin/test ! -w /nix/store
    cd /workspace
    ! pgrep -x nix-daemon >/dev/null
    setpriv --reuid=1000 --regid=1000 --init-groups -- "${agent_env[@]}" git --version
    setpriv --reuid=1000 --regid=1000 --init-groups -- "${agent_env[@]}" echo CANARY_OK
  '
