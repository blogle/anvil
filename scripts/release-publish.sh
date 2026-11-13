#!/usr/bin/env bash
set -euo pipefail

: "${SDLC_RELEASE_VERSION:?release workflow must set SDLC_RELEASE_VERSION}"
: "${SDLC_RELEASE_MERGED_SHA:?release workflow must set SDLC_RELEASE_MERGED_SHA}"
test "$(git rev-parse HEAD)" = "$SDLC_RELEASE_MERGED_SHA"
test "$(git rev-parse HEAD:.sdlc/release.json)" != ""

registry="ghcr.io/${GITHUB_REPOSITORY,,}"
docker load < "$(nix build --no-link --print-out-paths .#anvil-image)"
nix run .#anvil-sandbox-image.copyToDockerDaemon
nix run .#anvil-nix-daemon-image.copyToDockerDaemon
daemon_image_id="$(docker image inspect --format '{{.Id}}' ghcr.io/blogle/anvil-nix-daemon:main)"
nix develop .#release-smoke --command bash tests/nix-daemon-smoke.sh "$daemon_image_id"

receipts="${SDLC_RELEASE_RECEIPTS:-.sdlc/publication-receipts.json}"
receipt_dir="$(dirname "$receipts")"
mkdir -p "$receipt_dir"
receipt_tmp="$(mktemp "$receipt_dir/.publication-receipts.XXXXXX")"
remote_manifest_tmp="$(mktemp "$receipt_dir/.remote-manifest.XXXXXX")"
source_manifest="$(mktemp "$receipt_dir/.source-manifest.XXXXXX")"
source_config="$(mktemp "$receipt_dir/.source-config.XXXXXX")"
remote_config=""
cleanup() {
  rm -f "$receipt_tmp" "$receipt_tmp.next" "$remote_manifest_tmp" "$source_manifest" "$source_config"
  if [[ -n "$remote_config" ]]; then
    rm -f "$remote_config"
  fi
}
trap cleanup EXIT
printf '{"schema":1,"artifacts":[]}' > "$receipt_tmp"

content_identity() {
  bash scripts/image-content-identity.sh "$1"
}

while IFS='|' read -r source target; do
  skopeo inspect --raw "docker-daemon:$source" > "$source_manifest"
  skopeo inspect --config "docker-daemon:$source" > "$source_config"
  expected_identity="$(content_identity "$source_config" < "$source_manifest")"
  for tag in "$SDLC_RELEASE_VERSION" "sha-$SDLC_RELEASE_MERGED_SHA" main latest; do
    remote="docker://$target:$tag"
    if bash scripts/registry-inspect-existing.sh "$HOME/.docker/config.json" "$remote" "$remote_manifest_tmp"; then
      remote_config="$(mktemp "$receipt_dir/.remote-config.XXXXXX")"
      skopeo inspect --authfile "$HOME/.docker/config.json" --config "$remote" > "$remote_config"
      actual_identity="$(content_identity "$remote_config" < "$remote_manifest_tmp")"
      rm -f "$remote_config"
      remote_config=""
      if [[ "$tag" == "$SDLC_RELEASE_VERSION" || "$tag" == "sha-$SDLC_RELEASE_MERGED_SHA" ]]; then
        [[ "$actual_identity" == "$expected_identity" ]] || { echo "immutable image tag $target:$tag already points to different image content" >&2; exit 1; }
      elif [[ "$actual_identity" != "$expected_identity" ]]; then
        skopeo copy --all --dest-authfile "$HOME/.docker/config.json" "docker-daemon:$source" "$remote"
      fi
    else
      inspect_status=$?
      if [[ "$inspect_status" -ne 1 ]]; then
        exit "$inspect_status"
      fi
      skopeo copy --all --dest-authfile "$HOME/.docker/config.json" "docker-daemon:$source" "$remote"
    fi
    actual="$(bash scripts/registry-manifest-digest.sh "$HOME/.docker/config.json" "$remote" "$remote_manifest_tmp")"
    remote_config="$(mktemp "$receipt_dir/.remote-config.XXXXXX")"
    skopeo inspect --authfile "$HOME/.docker/config.json" --config "$remote" > "$remote_config"
    actual_identity="$(content_identity "$remote_config" < "$remote_manifest_tmp")"
    rm -f "$remote_config"
    remote_config=""
    [[ "$actual_identity" == "$expected_identity" ]] || { echo "published image $target:$tag content differs from the built image" >&2; exit 1; }
    if [[ "$tag" == "$SDLC_RELEASE_VERSION" || "$tag" == "sha-$SDLC_RELEASE_MERGED_SHA" ]]; then
      jq --arg name "$target:$tag" --arg digest "sha256:$actual" \
        --arg version "$SDLC_RELEASE_VERSION" --arg merged "$SDLC_RELEASE_MERGED_SHA" \
        --arg source "$(jq -r .source_main_sha .sdlc/release.json)" \
        '.artifacts += [{name:$name,digest:$digest,version:$version,merged_sha:$merged,source_main_sha:$source}]' \
        "$receipt_tmp" > "$receipt_tmp.next"
      mv "$receipt_tmp.next" "$receipt_tmp"
    fi
  done
done <<EOF
anvil:dev|$registry
ghcr.io/blogle/anvil-sandbox:main|ghcr.io/blogle/anvil-sandbox
ghcr.io/blogle/anvil-nix-daemon:main|ghcr.io/blogle/anvil-nix-daemon
EOF

mv "$receipt_tmp" "$receipts"
