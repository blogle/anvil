#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s IMAGE_JSON LOCAL_TAG [BASE_IMAGE]\n' "$0" >&2
  printf 'example: %s result local-anvil7-6a12798-dirty ghcr.io/blogle/anvil-sandbox:anvil7-dev\n' "$0" >&2
}

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  usage
  exit 2
fi

image_json="$1"
local_tag="$2"
base_image="${3:-${ANVIL_K3S_BASE_IMAGE:-}}"
namespace="${ANVIL_K3S_NAMESPACE:-anvil}"
node="${ANVIL_K3S_NODE:-nandstorm}"
containerd_socket="${ANVIL_K3S_CONTAINERD_SOCKET:-/host/run/k3s/containerd/containerd.sock}"
kubeconfig="${ANVIL_KUBECONFIG:-${KUBECONFIG:-/workspace/kube_config/config}}"
loader_pod="${ANVIL_K3S_LOADER_POD:-}"

case "$local_tag" in
  ''|*/*|main|latest|sha-*)
    printf 'LOCAL_TAG must be a local-only tag without a registry: %s\n' "$local_tag" >&2
    exit 2
    ;;
esac

if [ ! -f "$image_json" ]; then
  printf 'image JSON does not exist: %s\n' "$image_json" >&2
  exit 1
fi

if [ -z "$base_image" ]; then
  printf 'set ANVIL_K3S_BASE_IMAGE or pass BASE_IMAGE to reuse an existing image\n' >&2
  exit 2
fi

command -v jq >/dev/null
command -v kubectl >/dev/null
command -v skopeo >/dev/null
command -v tar >/dev/null
command -v sha256sum >/dev/null

kubectl=(kubectl --kubeconfig "$kubeconfig")
ctr=(ctr --address "$containerd_socket" --namespace k8s.io)
local_image="docker.io/library/anvil-sandbox:$local_tag"
created_loader=false
cleanup() {
  if [ "$created_loader" = true ]; then
    "${kubectl[@]}" -n "$namespace" delete pod "$loader_pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  rm -rf "$oci_dir"
}
trap cleanup EXIT

if [ -z "$loader_pod" ]; then
  loader_pod="anvil-image-loader-$$"
  "${kubectl[@]}" -n "$namespace" run "$loader_pod" \
    --image=alpine:3.20 \
    --restart=Never \
    --overrides="{\"spec\":{\"nodeName\":\"$node\",\"containers\":[{\"name\":\"loader\",\"image\":\"alpine:3.20\",\"command\":[\"sleep\",\"1800\"],\"securityContext\":{\"privileged\":true},\"volumeMounts\":[{\"name\":\"host\",\"mountPath\":\"/host\"}]}],\"volumes\":[{\"name\":\"host\",\"hostPath\":{\"path\":\"/\"}}]}}" >/dev/null
  created_loader=true
  "${kubectl[@]}" -n "$namespace" wait --for=jsonpath='{.status.phase}'=Running "pod/$loader_pod" --timeout=120s >/dev/null
  "${kubectl[@]}" -n "$namespace" exec "$loader_pod" -- sh -c 'apk add --no-cache containerd-ctr >/dev/null 2>&1'
else
  "${kubectl[@]}" -n "$namespace" get pod "$loader_pod" >/dev/null
fi

oci_dir="$(mktemp -d "${TMPDIR:-/tmp}/anvil-sandbox-oci.XXXXXX")"
printf 'materializing local OCI metadata and layers\n'
skopeo --insecure-policy copy "nix:$image_json" "oci:$oci_dir:$local_tag" >/dev/null

local_manifest_digest="$(jq -r '.manifests[0].digest' "$oci_dir/index.json")"
local_manifest_file="$oci_dir/blobs/sha256/${local_manifest_digest#sha256:}"
local_manifest="$(jq -c . "$local_manifest_file")"
local_config_digest="$(jq -r '.config.digest' "$local_manifest_file")"
local_config_file="$oci_dir/blobs/sha256/${local_config_digest#sha256:}"
local_config="$(jq -c . "$local_config_file")"

remote_content="$("${kubectl[@]}" -n "$namespace" exec "$loader_pod" -- sh -c "${ctr[*]} content ls -q")"
remote_manifest_digest="$("${kubectl[@]}" -n "$namespace" exec "$loader_pod" -- sh -c "${ctr[*]} images list | awk '\$1 == \"$base_image\" {print \$3}'")"
remote_manifest=''
remote_config=''
if [ -n "$remote_manifest_digest" ]; then
  remote_manifest="$("${kubectl[@]}" -n "$namespace" exec "$loader_pod" -- sh -c "${ctr[*]} content get '$remote_manifest_digest'")"
  remote_config_digest="$(jq -r '.config.digest' <<<"$remote_manifest")"
  remote_config="$("${kubectl[@]}" -n "$namespace" exec "$loader_pod" -- sh -c "${ctr[*]} content get '$remote_config_digest'")"
fi

remote_has_digest() {
  printf '%s\n' "$remote_content" | awk -v digest="$1" '$0 == digest { found = 1 } END { exit !found }'
}

# Prefer the existing compressed descriptor when its diff ID matches. This
# lets containerd reuse its blob while the local image supplies only new data.
merged_layers='[]'
missing_layers=()
layer_count="$(jq '.layers | length' <<<"$local_manifest")"
for ((index = 0; index < layer_count; index++)); do
  local_layer="$(jq -c ".layers[$index]" <<<"$local_manifest")"
  local_diff_id="$(jq -r ".rootfs.diff_ids[$index]" <<<"$local_config")"
  selected_layer="$local_layer"
  if [ -n "$remote_manifest" ] && [ -n "$remote_config" ]; then
    remote_diff_id="$(jq -r ".rootfs.diff_ids[$index] // empty" <<<"$remote_config")"
    remote_layer="$(jq -c ".layers[$index] // empty" <<<"$remote_manifest")"
    remote_layer_digest="$(jq -r '.digest // empty' <<<"$remote_layer")"
    if [ "$remote_diff_id" = "$local_diff_id" ] && [ -n "$remote_layer_digest" ] && remote_has_digest "$remote_layer_digest"; then
      selected_layer="$remote_layer"
    fi
  fi
  merged_layers="$(jq -c --argjson layer "$selected_layer" '. + [$layer]' <<<"$merged_layers")"
  selected_digest="$(jq -r '.digest' <<<"$selected_layer")"
  if ! remote_has_digest "$selected_digest"; then
    local_digest="$(jq -r '.digest' <<<"$local_layer")"
    if [ "$selected_digest" != "$local_digest" ]; then
      printf 'remote base layer is unavailable and no local replacement exists: %s\n' "$selected_digest" >&2
      exit 1
    fi
    missing_layers+=("$selected_digest")
  fi
done

merged_manifest="$(jq -c --argjson layers "$merged_layers" '.layers = $layers' <<<"$local_manifest")"
merged_manifest_digest="sha256:$(printf '%s' "$merged_manifest" | sha256sum | cut -d' ' -f1)"
merged_manifest_size="$(printf '%s' "$merged_manifest" | wc -c)"
merged_manifest_file="$oci_dir/blobs/sha256/${merged_manifest_digest#sha256:}"
printf '%s' "$merged_manifest" > "$merged_manifest_file"

files=(oci-layout index.json "blobs/sha256/${local_config_digest#sha256:}" "blobs/sha256/${merged_manifest_digest#sha256:}")
for digest in "${missing_layers[@]}"; do
  files+=("blobs/sha256/${digest#sha256:}")
done

jq --arg digest "$merged_manifest_digest" --arg tag "$local_tag" --argjson size "$merged_manifest_size" \
  '.manifests = [{mediaType:"application/vnd.oci.image.manifest.v1+json", digest:$digest, size:$size, annotations:{"org.opencontainers.image.ref.name":$tag}}]' \
  "$oci_dir/index.json" > "$oci_dir/index.json.tmp"
mv "$oci_dir/index.json.tmp" "$oci_dir/index.json"

transfer_bytes=0
for digest in "${missing_layers[@]}"; do
  transfer_bytes=$((transfer_bytes + $(jq -r --arg digest "$digest" '.layers[] | select(.digest == $digest) | .size' <<<"$local_manifest")))
done
printf 'base image: %s\n' "$base_image"
printf 'local tag: %s\n' "$local_image"
printf 'new layer blobs: %d (%d bytes)\n' "${#missing_layers[@]}" "$transfer_bytes"

tar -C "$oci_dir" -cf - "${files[@]}" |
  "${kubectl[@]}" -n "$namespace" exec -i "$loader_pod" -- sh -c "${ctr[*]} images import --base-name docker.io/library/anvil-sandbox --digests -" >/dev/null

"${kubectl[@]}" -n "$namespace" exec "$loader_pod" -- sh -c "${ctr[*]} images list | awk '\$1 == \"$local_image\"'"
