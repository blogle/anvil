#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: nix-daemon-smoke.sh IMAGE}"
container="anvil-nix-daemon-smoke-$$"
bootstrap_dir="$(mktemp -d)"
cleanup() {
  set +e
  docker rm -f "$container" >/dev/null 2>&1
  if [ -d "$bootstrap_dir" ]; then
    # Bootstrap runs as root in the image. Remove its files from a root-owned
    # bind mount in a root container, then restore the runner's ownership.
    docker run --rm --user 0:0 --entrypoint /bin/bash \
      --volume "$bootstrap_dir:/shared-nix" "$image" -c \
      'find /shared-nix -mindepth 1 -delete; chown "$1:$2" /shared-nix' \
      -- "$(id -u)" "$(id -g)" >/dev/null 2>&1
    rmdir "$bootstrap_dir" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

docker run --rm --entrypoint /bin/bash "$image" -c \
  'test -x /bin/anvil-nix-daemon && test -x /bin/anvil-nix-deployment-canary'

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
# The exact same fresh-build contract used by Kubernetes startupProbe must
# pass in the publish-loaded image, before tags are pushed.
docker exec "$container" /bin/anvil-nix-deployment-canary

# The CI runner owns mktemp; a provisioned Nix PVC is root-owned. Model that
# ownership in the disposable fixture, without relaxing fail-closed bootstrap.
docker run --rm --user 0:0 --entrypoint /bin/bash \
  --volume "$bootstrap_dir:/shared-nix" "$image" -c \
  'chown 0:0 /shared-nix && chmod 0755 /shared-nix'
docker run --rm --entrypoint /bin/anvil-nix-daemon \
  --volume "$bootstrap_dir:/shared-nix" "$image" --bootstrap
test -s "$bootstrap_dir/var/nix/db/db.sqlite"
test -f "$bootstrap_dir/var/nix/.anvil-bootstrap-complete"

printf 'daemon OCI smoke passed for %s\n' "$image"
