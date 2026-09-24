#!/usr/bin/env bash
set -euo pipefail

: "${ANVIL_SANDBOX_POD:?set ANVIL_SANDBOX_POD to the generated Sandbox pod}"
namespace="${ANVIL_NAMESPACE:-anvil}"

exec_in_sandbox() {
  kubectl exec -n "$namespace" "$ANVIL_SANDBOX_POD" -- bash -lc \
    'cd "$HOME/workspace/$ANVIL_PROJECT" && exec setpriv --reuid=1000 --regid=1000 --init-groups -- bash -lc '"$(printf '%q' "$1")"
}

ANVIL_RUNTIME_EXEC=exec_in_sandbox
source "$(dirname "$0")/sandbox-runtime-assertions.sh"

exec_in_sandbox 'test "$(id -u)" = 1000 && test "$(id -g)" = 1000'
exec_in_sandbox 'test "$HOME" = /home/anvil && test -w "$HOME" && test -w /tmp'
exec_in_sandbox 'test "$XDG_CONFIG_HOME" = /home/anvil/.config && test -w "$XDG_CONFIG_HOME"'
exec_in_sandbox 'test "$XDG_CACHE_HOME" = /home/anvil/.cache && test -w "$XDG_CACHE_HOME"'
exec_in_sandbox 'test "$XDG_DATA_HOME" = /home/anvil/.local/share && test -w "$XDG_DATA_HOME"'
exec_in_sandbox 'test "$XDG_STATE_HOME" = /home/anvil/.local/state && test -w "$XDG_STATE_HOME"'
exec_in_sandbox 'test -d "/home/anvil/workspace/$ANVIL_PROJECT" && test "$(pwd)" = "/home/anvil/workspace/$ANVIL_PROJECT"'
exec_in_sandbox 'printf "#!/usr/bin/env bash\nprintf env-ok\n" >/tmp/anvil-env-test && chmod +x /tmp/anvil-env-test && test "$('/tmp/anvil-env-test')" = env-ok'
exec_in_sandbox 'test "$DISPLAY" = :99 && test -n "$(pgrep -f "Xvfb :99")"'
exec_in_sandbox 'chromium --headless --disable-gpu --dump-dom about:blank >/dev/null'
exec_in_sandbox 'test "$(stat -c "%u" /nix/store)" = 0 && test ! -w /nix/store && test "$(stat -c "%u:%g" /nix/var)" = 0:0 && test ! -w /nix/var && pgrep -x nix-daemon >/dev/null && nix store info >/dev/null'
exec_in_sandbox 'nix develop --command just check'
exec_in_sandbox 'test "$(git config --global user.name)" = Anvil'

if [ "${ANVIL_ACCEPTANCE_GITHUB:-}" = 1 ]; then
  : "${ANVIL_GITHUB_REPOSITORY:?set ANVIL_GITHUB_REPOSITORY for the GitHub acceptance path}"
  exec_in_sandbox "gh api repos/${ANVIL_GITHUB_REPOSITORY} >/dev/null"
  exec_in_sandbox "git ls-remote https://github.com/${ANVIL_GITHUB_REPOSITORY}.git HEAD >/dev/null"
fi

if [ "${ANVIL_ACCEPTANCE_GITHUB_PUSH:-}" = 1 ]; then
  : "${ANVIL_GITHUB_REPOSITORY:?set ANVIL_GITHUB_REPOSITORY for the GitHub push acceptance path}"
  exec_in_sandbox "ANVIL_GITHUB_REPOSITORY='${ANVIL_GITHUB_REPOSITORY}' bash -euo pipefail -c '
    repo=\"\$HOME/workspace/\$ANVIL_PROJECT\"
    cd \"\$repo\"
    expected=\"https://github.com/\$ANVIL_GITHUB_REPOSITORY.git\"
    actual=\"\$(git remote get-url origin)\"
    test \"\${actual%.git}.git\" = \"\${expected%.git}.git\"
    branch=\"anvil-credential-acceptance-\$(date -u +%Y%m%d%H%M%S)-\$RANDOM\"
    ordinary=\".anvil-acceptance/\$branch.txt\"
    workflow=\".github/workflows/\$branch.yml\"
    cleanup() {
      git push origin --delete \"\$branch\" >/dev/null 2>&1 || true
      git switch - >/dev/null 2>&1 || true
      git branch -D \"\$branch\" >/dev/null 2>&1 || true
      rm -f \"\$ordinary\" \"\$workflow\"
    }
    trap cleanup EXIT
    git switch -c \"\$branch\"
    mkdir -p .anvil-acceptance
    printf "Anvil Git credential acceptance.\\n" >\"\$ordinary\"
    git add \"\$ordinary\"
    git commit -m \"test: verify Anvil Git push credential\"
    git push -u origin \"\$branch\"
    mkdir -p .github/workflows
    printf "name: Anvil credential acceptance\\non:\\n  workflow_dispatch:\\njobs:\\n  acceptance:\\n    runs-on: ubuntu-latest\\n    steps:\\n      - run: echo accepted\\n" >\"\$workflow\"
    git add \"\$workflow\"
    git commit -m \"test: verify Anvil workflow push credential\"
    git push origin \"\$branch\"
    gh api \"repos/\$ANVIL_GITHUB_REPOSITORY/contents/\$workflow?ref=\$branch\" >/dev/null
  '"
fi

printf 'sandbox acceptance checks passed for %s\n' "$ANVIL_SANDBOX_POD"
