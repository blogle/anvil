#!/usr/bin/env bash
set -euo pipefail

: "${ANVIL_SANDBOX_POD:?set ANVIL_SANDBOX_POD to the generated Sandbox pod}"
namespace="${ANVIL_NAMESPACE:-anvil}"
kubeconfig="${ANVIL_KUBECONFIG:-${KUBECONFIG:-}}"
: "${kubeconfig:?set ANVIL_KUBECONFIG or KUBECONFIG explicitly}"

exec_in_sandbox() {
  local command="$1" quoted
  quoted="$(printf '%q' "$command")"
  kubectl --kubeconfig "$kubeconfig" exec -n "$namespace" "$ANVIL_SANDBOX_POD" -- \
    bash -lc "cd \"\$HOME/workspace/\$ANVIL_PROJECT\" && exec setpriv --reuid=1000 --regid=1000 --init-groups -- bash -lc $quoted"
}

ANVIL_RUNTIME_EXEC=exec_in_sandbox
source "$(dirname "$0")/sandbox-runtime-assertions.sh"
exec_in_sandbox 'test -d "/home/anvil/workspace/$ANVIL_PROJECT" && test "$(pwd)" = "/home/anvil/workspace/$ANVIL_PROJECT"'

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
    printf \"Anvil Git credential acceptance.\\n\" >\"\$ordinary\"
    git add \"\$ordinary\"
    git commit -m \"test: verify Anvil Git push credential\"
    git push -u origin \"\$branch\"
    mkdir -p .github/workflows
    printf \"name: Anvil credential acceptance\\non:\\n  workflow_dispatch:\\njobs:\\n  acceptance:\\n    runs-on: ubuntu-latest\\n    steps:\\n      - run: echo accepted\\n\" >\"\$workflow\"
    git add \"\$workflow\"
    git commit -m \"test: verify Anvil workflow push credential\"
    git push origin \"\$branch\"
    gh api \"repos/\$ANVIL_GITHUB_REPOSITORY/contents/\$workflow?ref=\$branch\" >/dev/null
  '"
fi

printf 'sandbox acceptance checks passed for %s\n' "$ANVIL_SANDBOX_POD"
