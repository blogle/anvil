#!/usr/bin/env bash
set -euo pipefail

: "${ANVIL_RUNTIME_EXEC:?define ANVIL_RUNTIME_EXEC as a function accepting one shell command}"
ANVIL_RUNTIME_EXEC 'test "$(id -u)" = 1000 && test "$(id -g)" = 1000'
ANVIL_RUNTIME_EXEC 'test "$HOME" = /home/anvil && test -w "$HOME" && test -w /tmp && test "$(stat -c %a /tmp)" = 1777'
ANVIL_RUNTIME_EXEC 'test "$XDG_CONFIG_HOME" = /home/anvil/.config && test -w "$XDG_CONFIG_HOME"'
ANVIL_RUNTIME_EXEC 'test "$XDG_CACHE_HOME" = /home/anvil/.cache && test -w "$XDG_CACHE_HOME"'
ANVIL_RUNTIME_EXEC 'test "$XDG_DATA_HOME" = /home/anvil/.local/share && test -w "$XDG_DATA_HOME"'
ANVIL_RUNTIME_EXEC 'test "$XDG_STATE_HOME" = /home/anvil/.local/state && test -w "$XDG_STATE_HOME"'
ANVIL_RUNTIME_EXEC 'test "$XDG_RUNTIME_DIR" = /home/anvil/.local/state/runtime && test -d "$XDG_RUNTIME_DIR"'
ANVIL_RUNTIME_EXEC 'printf "#!/usr/bin/env bash\nprintf env-ok\n" >/tmp/anvil-env-test && chmod +x /tmp/anvil-env-test && test "$(/tmp/anvil-env-test)" = env-ok'
ANVIL_RUNTIME_EXEC 'test "$DISPLAY" = :99 && pgrep -f "Xvfb :99" >/dev/null && chromium --headless --disable-gpu --dump-dom about:blank >/dev/null'
ANVIL_RUNTIME_EXEC 'test "$(git config --global user.name)" = Anvil && test -n "$(git config --global user.email)"'
ANVIL_RUNTIME_EXEC 'test "$(stat -c %u /nix/store)" = 0 && test ! -w /nix/store && test "$(stat -c %u:%g /nix/var)" = 0:0 && test ! -w /nix/var'
ANVIL_RUNTIME_EXEC 'pgrep -x nix-daemon >/dev/null && nix store info >/dev/null && nix develop --command just check'
ANVIL_RUNTIME_EXEC 'command -v opencode >/dev/null && command -v nix >/dev/null && command -v just >/dev/null && command -v git >/dev/null'

if [ "${ANVIL_ACCEPTANCE_GITHUB:-}" = 1 ]; then
  : "${ANVIL_GITHUB_REPOSITORY:?set ANVIL_GITHUB_REPOSITORY for the GitHub acceptance path}"
  ANVIL_RUNTIME_EXEC "gh api repos/${ANVIL_GITHUB_REPOSITORY} >/dev/null"
  ANVIL_RUNTIME_EXEC "git ls-remote https://github.com/${ANVIL_GITHUB_REPOSITORY}.git HEAD >/dev/null"
fi
