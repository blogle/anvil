#!/usr/bin/env bash
set -euo pipefail

if [ -n "${ANVIL_ROOTFS:-}" ]; then
  rootfs="$ANVIL_ROOTFS"
  mapped_uid="$(id -u)"
  mapped_gid="$(id -g)"
  test -x "$rootfs/usr/bin/env"
  test -x "$rootfs/bin/sandbox-entrypoint"
  for binary in bash git nix just opencode chromium Xvfb nix-daemon; do
    test -x "$rootfs/bin/$binary" || test -x "$rootfs/usr/bin/$binary"
  done
  test "$(stat -c %u "$rootfs/nix/store")" = "$mapped_uid"
  test "$(stat -c %u:%g "$rootfs/nix/var")" = "$mapped_uid:$mapped_gid"
  store_mode="$(stat -c %a "$rootfs/nix/store")"
  (( (8#$store_mode & 022) == 0 ))
  test "$(stat -c %a "$rootfs/tmp")" = 1777
  test -d "$rootfs/home/anvil" && test -x "$rootfs/home/anvil"
  test ! -e "$rootfs/usr/share/anvil/anvil-report.ts"
fi

if [ -n "${ANVIL_RUNTIME_EXEC:-}" ]; then
  runtime_exec() {
    if declare -F ANVIL_RUNTIME_EXEC >/dev/null; then
      ANVIL_RUNTIME_EXEC "$1"
    else
      "$ANVIL_RUNTIME_EXEC" "$1"
    fi
  }
  runtime_exec 'test "$(id -u)" = 1000 && test "$(id -g)" = 1000'
  runtime_exec 'test "$HOME" = /home/anvil && test -w "$HOME" && test -w /tmp && test "$(stat -c %a /tmp)" = 1777'
  runtime_exec 'test "$XDG_CONFIG_HOME" = /home/anvil/.config && test -w "$XDG_CONFIG_HOME"'
  runtime_exec 'test "$XDG_CACHE_HOME" = /home/anvil/.cache && test -w "$XDG_CACHE_HOME"'
  runtime_exec 'test "$XDG_DATA_HOME" = /home/anvil/.local/share && test -w "$XDG_DATA_HOME"'
  runtime_exec 'test "$XDG_STATE_HOME" = /home/anvil/.local/state && test -w "$XDG_STATE_HOME"'
  runtime_exec 'test "$XDG_RUNTIME_DIR" = /home/anvil/.local/state/runtime && test -d "$XDG_RUNTIME_DIR"'
  runtime_exec 'printf "#!/usr/bin/env bash\nprintf env-ok\n" >/tmp/anvil-env-test && chmod +x /tmp/anvil-env-test && test "$(/tmp/anvil-env-test)" = env-ok'
  runtime_exec 'test "$DISPLAY" = :99 && pgrep -f "Xvfb :99" >/dev/null && chromium --headless --disable-gpu --dump-dom about:blank >/dev/null'
  runtime_exec 'test "$(git config --global user.name)" = Anvil && test -n "$(git config --global user.email)"'
  runtime_exec 'test "$(stat -c %u /nix/store)" = 0 && test ! -w /nix/store && test "$(stat -c %u:%g /nix/var)" = 0:0 && test ! -w /nix/var'
  runtime_exec 'pgrep -x nix-daemon >/dev/null && nix store info >/dev/null && nix develop --command just check'
  runtime_exec 'command -v opencode >/dev/null && command -v nix >/dev/null && command -v just >/dev/null && command -v git >/dev/null'
fi

if [ -z "${ANVIL_ROOTFS:-}" ] && [ -z "${ANVIL_RUNTIME_EXEC:-}" ]; then
  printf 'set ANVIL_ROOTFS for static OCI checks or ANVIL_RUNTIME_EXEC for runtime checks\n' >&2
  exit 2
fi

if [ "${ANVIL_ACCEPTANCE_GITHUB:-}" = 1 ]; then
  : "${ANVIL_GITHUB_REPOSITORY:?set ANVIL_GITHUB_REPOSITORY for the GitHub acceptance path}"
  ANVIL_RUNTIME_EXEC "gh api repos/${ANVIL_GITHUB_REPOSITORY} >/dev/null"
  ANVIL_RUNTIME_EXEC "git ls-remote https://github.com/${ANVIL_GITHUB_REPOSITORY}.git HEAD >/dev/null"
fi
