#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/anvil-sandbox-oci.XXXXXX")"
cleanup() {
  chmod -R u+w "$tmp/bundle" 2>/dev/null || true
  rm -rf "$tmp"
}
trap cleanup EXIT

image="$(nix build --no-link --print-out-paths .#anvil-sandbox-image)"
oci="$tmp/oci"
bundle="$tmp/bundle"
mkdir -p "$oci"
skopeo --insecure-policy copy "nix:$image" "oci:$oci:anvil-sandbox" >/dev/null
umoci unpack --rootless --image "$oci:anvil-sandbox" "$bundle"

config="$(skopeo inspect --config "oci:$oci:anvil-sandbox")"
jq -e '.config.User == "0:0" and (.config.Cmd | index("/bin/sandbox-entrypoint"))' <<<"$config" >/dev/null
rootfs="$bundle/rootfs"
ANVIL_ROOTFS="$rootfs" bash "$root/tests/sandbox-runtime-assertions.sh"
printf 'OCI export, unpack, config and static filesystem contract passed\n'

runtime_supported=0
if unshare --user --map-root-user sh -c 'setpriv --reuid=1000 --regid=1000 --clear-groups true' >/dev/null 2>&1; then
  runtime_supported=1
fi
if [ "$runtime_supported" = 1 ]; then
  printf 'supported: exact root-to-UID-1000 nested user-namespace probe passed; running shared runtime assertions with crun\n'
  mkdir -p "$rootfs/tmp" "$rootfs/home/anvil/workspace"
  cp "$root/tests/sandbox-runtime-assertions.sh" "$rootfs/tmp/sandbox-runtime-assertions.sh"
  cat >"$rootfs/tmp/anvil-runtime-acceptance.sh" <<'EOF'
#!/bin/bash
set -euo pipefail
NIX_REMOTE=local nix-store --init >/dev/null 2>&1 || true
env -u NIX_REMOTE nix-daemon --daemon &
nix_daemon_pid=$!
for _ in $(seq 1 50); do
  if [ -S /nix/var/nix/daemon-socket/socket ] && kill -0 "$nix_daemon_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
kill -0 "$nix_daemon_pid"
test -S /nix/var/nix/daemon-socket/socket
export HOME=/home/anvil
export XDG_CONFIG_HOME="$HOME/.config" XDG_CACHE_HOME="$HOME/.cache"
export XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
export XDG_RUNTIME_DIR="$XDG_STATE_HOME/runtime" DISPLAY=:99 ANVIL_PROJECT=anvil
mkdir -p "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
Xvfb "$DISPLAY" -screen 0 1280x1024x24 -nolisten tcp >/tmp/anvil-xvfb.log 2>&1 &
git config --global user.name Anvil
git config --global user.email anvil@users.noreply.github.com
ANVIL_RUNTIME_EXEC() { /bin/bash -lc "$1"; }
export -f ANVIL_RUNTIME_EXEC
exec setpriv --reuid=1000 --regid=1000 --init-groups -- /bin/bash -lc \
  'cd "$HOME/workspace/anvil" && source /tmp/sandbox-runtime-assertions.sh'
EOF
  chmod 0755 "$rootfs/tmp/anvil-runtime-acceptance.sh"
  mkdir -p "$tmp/crun"
  jq --arg workspace "$root" '
    .process.args = ["/bin/bash", "/tmp/anvil-runtime-acceptance.sh"]
    | .process.cwd = "/"
    | .mounts += [{"destination":"/home/anvil/workspace/anvil","type":"bind","source":$workspace,"options":["rbind","rw","nosuid","nodev"]}]
  ' "$bundle/config.json" >"$tmp/config.json"
  mv "$tmp/config.json" "$bundle/config.json"
  crun run --root "$tmp/crun" --bundle "$bundle" anvil-sandbox-acceptance
  printf 'supported: exact root-to-UID-1000 crun runtime assertions passed\n'
else
  printf 'unsupported by current nested user-namespace environment: exact root-to-UID-1000 crun execution omitted; shared static OCI assertions passed\n'
fi
