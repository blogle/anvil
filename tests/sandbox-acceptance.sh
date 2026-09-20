#!/usr/bin/env bash
set -euo pipefail

: "${ANVIL_SANDBOX_POD:?set ANVIL_SANDBOX_POD to the generated Sandbox pod}"
namespace="${ANVIL_NAMESPACE:-anvil}"

exec_in_sandbox() {
  kubectl exec -n "$namespace" "$ANVIL_SANDBOX_POD" -- bash -lc \
    'cd "$(readlink /proc/1/cwd)" && '"$1"
}

exec_in_sandbox 'test "$(id -u)" = 1000 && test "$(id -g)" = 1000'
exec_in_sandbox 'test "$HOME" = /home/anvil && test -w "$HOME" && test -w /tmp'
exec_in_sandbox 'test "$XDG_CONFIG_HOME" = /home/anvil/.config && test -w "$XDG_CONFIG_HOME"'
exec_in_sandbox 'test "$XDG_CACHE_HOME" = /home/anvil/.cache && test -w "$XDG_CACHE_HOME"'
exec_in_sandbox 'test "$XDG_DATA_HOME" = /home/anvil/.local/share && test -w "$XDG_DATA_HOME"'
exec_in_sandbox 'test "$XDG_STATE_HOME" = /home/anvil/.local/state && test -w "$XDG_STATE_HOME"'
exec_in_sandbox 'test -d "/home/anvil/workspace/$ANVIL_PROJECT" && test "$(readlink /proc/1/cwd)" = "/home/anvil/workspace/$ANVIL_PROJECT"'
exec_in_sandbox 'printf "#!/usr/bin/env bash\nprintf env-ok\n" >/tmp/anvil-env-test && chmod +x /tmp/anvil-env-test && test "$('/tmp/anvil-env-test')" = env-ok'
exec_in_sandbox 'test "$DISPLAY" = :99 && test -n "$(pgrep -f "Xvfb :99")"'
exec_in_sandbox 'chromium --headless --disable-gpu --dump-dom about:blank >/dev/null'
exec_in_sandbox 'nix develop --command just check'
exec_in_sandbox 'test "$(git config --global user.name)" = Anvil && test "${GIT_COMMITTER_NAME}" = Anvil'

if [ "${ANVIL_ACCEPTANCE_GITHUB:-}" = 1 ]; then
  : "${ANVIL_GITHUB_REPOSITORY:?set ANVIL_GITHUB_REPOSITORY for the GitHub acceptance path}"
  exec_in_sandbox "gh api repos/${ANVIL_GITHUB_REPOSITORY} >/dev/null"
  exec_in_sandbox "git ls-remote https://github.com/${ANVIL_GITHUB_REPOSITORY}.git HEAD >/dev/null"
fi

printf 'sandbox acceptance checks passed for %s\n' "$ANVIL_SANDBOX_POD"
