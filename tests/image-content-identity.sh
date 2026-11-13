#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$repo_root/scripts/image-content-identity.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

digest() { printf 'sha256:%s' "$(printf '%s' "$1" | sha256sum | cut -d' ' -f1)"; }
manifest() {
  local media="$1" one="$2" two="$3"
  jq -cn --arg media "$media" --arg one "$one" --arg two "$two" \
    '{schemaVersion:2,mediaType:"application/vnd.oci.image.manifest.v1+json",config:{mediaType:"application/vnd.oci.image.config.v1+json",digest:"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",size:12},layers:[{mediaType:$media,digest:$one,size:9},{mediaType:$media,digest:$two,size:11}]}'
}
config() {
  jq -cn --arg first "$1" --arg env "MODE=prod" --arg cmd "serve" \
    '{rootfs:{type:"layers",diff_ids:[$first,"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]},config:{Env:[$env],Cmd:[$cmd],User:"app",Entrypoint:["/entrypoint"],WorkingDir:"/srv/app"}}'
}

source_config="$tmp/source-config.json"
same_config="$tmp/same-config.json"
config "$(digest first)" > "$source_config"
cp "$source_config" "$same_config"
source="$(manifest application/vnd.oci.image.layer.v1.tar+gzip "$(digest compressed-one)" "$(digest compressed-two)")"
rewritten="$(manifest application/vnd.oci.image.layer.v1.tar "$(digest plain-one)" "$(digest plain-two)")"
source_identity="$(printf '%s' "$source" | bash "$helper" "$source_config")"
rewritten_identity="$(printf '%s' "$rewritten" | bash "$helper" "$same_config")"
[[ "$source_identity" == "$rewritten_identity" ]]
reordered_config="$(jq -c '{config: .config, rootfs: .rootfs}' "$source_config")"
printf '%s' "$reordered_config" > "$tmp/reordered-config.json"
reordered_identity="$(printf '%s' "$rewritten" | bash "$helper" "$tmp/reordered-config.json")"
[[ "$source_identity" == "$reordered_identity" ]]

for altered in \
  "$(config "$(digest changed)")" \
  "$(jq -c '.config.Env = ["MODE=test"]' "$source_config")" \
  "$(jq -c '.config.Cmd = ["other"]' "$source_config")" \
  "$(jq -c '.config.User = "other"' "$source_config")" \
  "$(jq -c '.config.Entrypoint = ["/other-entrypoint"]' "$source_config")" \
  "$(jq -c '.config.WorkingDir = "/other"' "$source_config")"; do
  printf '%s' "$altered" > "$tmp/altered-config.json"
  identity="$(printf '%s' "$rewritten" | bash "$helper" "$tmp/altered-config.json")"
  [[ "$identity" != "$source_identity" ]]
done

for invalid in \
  "$(jq -c '.schemaVersion = 1' <<<"$source")" \
  "$(jq -c '.layers[0].size = -1' <<<"$source")" \
  "$(jq -c '.layers[0].mediaType = "application/unknown"' <<<"$source")" \
  "$(jq -c '.layers |= .[0:1]' <<<"$source")"; do
  if printf '%s' "$invalid" | bash "$helper" "$source_config" >/dev/null 2>&1; then
    printf 'image-content-identity: accepted malformed/unknown manifest\n' >&2
    exit 1
  fi
done

printf 'image content identity checks passed\n'
