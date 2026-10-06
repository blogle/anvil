#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: nix-daemon-smoke.sh IMAGE}"
container="anvil-nix-daemon-smoke-$$"
bootstrap_dir="$(mktemp -d)"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$bootstrap_dir"' EXIT

docker run --rm --entrypoint /bin/bash "$image" -c \
  'test -x /bin/anvil-nix-daemon'

docker run --detach --name "$container" "$image" >/dev/null
for _ in $(seq 1 60); do
  if docker exec "$container" /bin/bash -c \
    'NIX_REMOTE=daemon nix store info >/dev/null 2>&1'; then
    break
  fi
  sleep 1
done
docker exec "$container" /bin/bash -c \
  'NIX_REMOTE=daemon nix store info >/dev/null'

chmod 0755 "$bootstrap_dir"
docker run --rm --entrypoint /bin/anvil-nix-daemon \
  --volume "$bootstrap_dir:/shared-nix" "$image" --bootstrap
test -s "$bootstrap_dir/var/nix/db/db.sqlite"
test -f "$bootstrap_dir/var/nix/.anvil-bootstrap-complete"

printf 'daemon OCI smoke passed for %s\n' "$image"
