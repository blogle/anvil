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
nix develop .#release-smoke --command bash tests/nix-daemon-smoke.sh ghcr.io/blogle/anvil-nix-daemon:main

receipts="${SDLC_RELEASE_RECEIPTS:-.sdlc/publication-receipts.json}"
mkdir -p "$(dirname "$receipts")"
receipt_tmp="$(mktemp)"
trap 'rm -f "$receipt_tmp"' EXIT
printf '{"schema":1,"artifacts":[]}' > "$receipt_tmp"

while IFS='|' read -r source target; do
  expected="$(skopeo inspect --raw "docker-daemon:$source" | sha256sum | cut -d' ' -f1)"
  for tag in "$SDLC_RELEASE_VERSION" "sha-$SDLC_RELEASE_MERGED_SHA" main latest; do
    remote="docker://$target:$tag"
    if skopeo inspect --authfile "$HOME/.docker/config.json" --raw "$remote" >/dev/null 2>&1; then
      actual="$(skopeo inspect --authfile "$HOME/.docker/config.json" --raw "$remote" | sha256sum | cut -d' ' -f1)"
      if [[ "$tag" == "$SDLC_RELEASE_VERSION" || "$tag" == "sha-$SDLC_RELEASE_MERGED_SHA" ]]; then
        [[ "$actual" == "$expected" ]] || { echo "immutable image tag $target:$tag already points to a different digest" >&2; exit 1; }
      elif [[ "$actual" != "$expected" ]]; then
        skopeo copy --all --dest-authfile "$HOME/.docker/config.json" "docker-daemon:$source" "$remote"
      fi
    else
      skopeo copy --all --dest-authfile "$HOME/.docker/config.json" "docker-daemon:$source" "$remote"
      actual="$expected"
    fi
    actual="$(skopeo inspect --authfile "$HOME/.docker/config.json" --raw "$remote" | sha256sum | cut -d' ' -f1)"
    [[ "$actual" == "$expected" ]] || { echo "published image $target:$tag digest differs from the built image" >&2; exit 1; }
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
trap - EXIT
