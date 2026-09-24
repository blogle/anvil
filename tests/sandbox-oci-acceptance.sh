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
test -x "$rootfs/usr/bin/env"
test -x "$rootfs/bin/sandbox-entrypoint"
mapped_root="$(id -u)"
mapped_group="$(id -g)"
test "$(stat -c %u "$rootfs/nix/store")" = "$mapped_root"
test "$(stat -c %u:%g "$rootfs/nix/var")" = "$mapped_root:$mapped_group"
store_mode="$(stat -c %a "$rootfs/nix/store")"
(( (8#$store_mode & 022) == 0 ))
test "$(stat -c %a "$rootfs/tmp")" = 1777
test -d "$rootfs/home/anvil" && test -x "$rootfs/home/anvil"
test -x "$rootfs/bin/opencode"
test -x "$rootfs/bin/chromium"
test -x "$rootfs/bin/Xvfb"
printf 'OCI export, unpack, config and static filesystem contract passed\n'

runtime_supported=0
if unshare --user --map-root-user sh -c 'setpriv --reuid=1000 --regid=1000 --clear-groups true' >/dev/null 2>&1; then
  runtime_supported=1
fi
if [ "$runtime_supported" = 1 ]; then
  printf 'nested user namespace probe passed; crun execution requested\n'
  # crun's rootless mapping needs the caller's subordinate uid/gid mappings to
  # represent both container root and the production agent UID 1000.
  mkdir -p "$tmp/crun"
  crun run --root "$tmp/crun" --bundle "$bundle" anvil-sandbox-acceptance
  printf 'exact root -> agent UID 1000 runtime contract passed\n'
else
  printf 'UNSUPPORTED: nested user namespace cannot map container root -> agent UID 1000; exact crun execution subtest omitted\n'
fi
