#!/usr/bin/env bash
set -euo pipefail

ui_only=0
if [ "${1:-}" = --ui ]; then ui_only=1; fi
root="$(git rev-parse --show-toplevel)"
export TMPDIR="${ANVIL_E2E_TMPDIR:-/tmp}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/anvil-local-e2e.XXXXXX")"
runtime="$tmp/runtime"
profile="$tmp/profile"
fixture="$tmp/fixture"
model_pid="" profile_pid="" api_pid=""
start_time=$SECONDS

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then for log in "$tmp"/*.log; do [ -f "$log" ] && { printf '\n--- %s ---\n' "$log" >&2; cat "$log" >&2; }; done; fi
  local sessions=""
  sessions="$(curl -fsS http://127.0.0.1:8080/v1/sessions 2>/dev/null | jq -r '.[].id' 2>/dev/null || true)"
  while IFS= read -r id; do
    [ -n "$id" ] && curl -fsS -X DELETE "http://127.0.0.1:8080/v1/sessions/$id" >/dev/null 2>&1 || true
  done <<<"$sessions"
  for pid in "$api_pid" "$profile_pid" "$model_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cargo build -p anvild -p anvil-test-model
mkdir -p "$tmp" "$runtime" "$profile/config" "$profile/plugins" "$fixture"
cp "$root/runtime/anvil-report.ts" "$profile/plugins/anvil-report.ts"
jq --arg plugin "$profile/plugins/anvil-report.ts" '.plugin = [$plugin]' "$root/dev/opencode-e2e.jsonc" >"$profile/config/opencode.jsonc"
export ANVIL_TEST_MODEL_PORT=4098
"$root/target/debug/anvil-test-model" >"$tmp/model.log" 2>&1 & model_pid=$!
export OPENCODE_CONFIG="$profile/config/opencode.jsonc" OPENCODE_CONFIG_DIR="$profile/config"
export HOME="$profile/home" XDG_CONFIG_HOME="$profile/home/.config" XDG_CACHE_HOME="$profile/home/.cache"
export XDG_DATA_HOME="$profile/home/.local/share" XDG_STATE_HOME="$profile/home/.local/state"
export OPENAI_API_KEY=local-anvil-test-only
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
opencode serve --hostname 127.0.0.1 --port 4097 >"$tmp/profile.log" 2>&1 & profile_pid=$!
export ANVIL_SANDBOX_BACKEND=local ANVIL_BIND_PORT=8080 ANVIL_LOCAL_RUNTIME_ROOT="$runtime"
export ANVIL_LOCAL_PROFILE_DIR="$profile" ANVIL_OPENCODE_BIN="$(command -v opencode)"
export ANVIL_PREVIEW_DOMAIN=localhost ANVIL_ANNOTATION_PREFIX=anvil.local
export ANVIL_PROFILE_OPENCODE_URL=http://127.0.0.1:4097 ANVIL_CREDENTIAL_URL=http://127.0.0.1:8080
export ANVIL_SESSION_SIGNING_SECRET=anvil-local-development-only-signing-secret
export ANVIL_HISTORY_PATH="$tmp/history.jsonl"
"$root/target/debug/anvild" >"$tmp/anvild.log" 2>&1 & api_pid=$!

poll() {
  local url="$1" deadline=$((SECONDS + 90))
  until curl --max-time 2 -fsS "$url" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then printf 'timed out waiting for %s\n' "$url" >&2; for log in "$tmp"/*.log; do printf '\n--- %s ---\n' "$log" >&2; cat "$log" >&2; done; return 1; fi
    sleep 0.2
  done
}
poll http://127.0.0.1:4098/healthz
poll http://127.0.0.1:4097/global/health
poll http://127.0.0.1:8080/readyz

git -C "$fixture" init -b main >/dev/null
git -C "$fixture" config user.name Fixture
git -C "$fixture" config user.email fixture@example.invalid
printf 'before\n' >"$fixture/target.txt"
git -C "$fixture" add target.txt && git -C "$fixture" commit -m fixture >/dev/null
repository="file://$fixture"

assert_http_smoke() {
  curl -fsS http://127.0.0.1:8080/ | grep -q '<html'
  curl -fsS http://127.0.0.1:8080/assets/app.js | grep -q 'fetch'
  curl -fsS http://127.0.0.1:8080/healthz | jq -e '.status == "ok"' >/dev/null
}
assert_http_smoke
if [ "$ui_only" = 1 ]; then
  printf 'frontend/API smoke: %ds\ntotal: %ds\n' "$((SECONDS - start_time))" "$((SECONDS - start_time))"
  exit 0
fi

scenario_start=$SECONDS
created="$(curl -sS -H 'content-type: application/json' -d "$(jq -n --arg repository "$repository" '{project:"fixture",repository:$repository,ref:"main",prompt:"ANVIL-E2E:edit-file inspect the fixture and change target.txt from before to after.",model:null}')" http://127.0.0.1:8080/v1/sessions)"
if jq -e '.id | strings' <<<"$created" >/dev/null 2>&1; then :; else printf 'session create failed: %s\n' "$created" >&2; exit 1; fi
id="$(jq -r .id <<<"$created")"
test -n "$id"
runtime_dir="$runtime/$id"
for _ in $(seq 1 80); do
  state="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/status")"
  [ "$(jq -r .work_state <<<"$state")" = ready_for_review ] && break
  sleep 0.5
done
if [ "$(jq -r .work_state <<<"$state")" != ready_for_review ]; then
  printf 'worker did not complete; messages: ' >&2
  curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages" >&2 || true
  printf '\nworker log:\n' >&2
  cat "$runtime_dir/worker.log" >&2 || true
  exit 1
fi
diff="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/diff")"
jq -e '.. | strings | select(contains("+after"))' <<<"$diff" >/dev/null
printf 'create/edit/report: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
before_session="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)"
curl -fsS -H 'content-type: application/json' -d '{"prompt":"ANVIL-E2E:followup confirm this remains the same conversation."}' "http://127.0.0.1:8080/v1/sessions/$id/messages" >/dev/null
after_session="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)"
test "$before_session" = "$after_session"
printf 'follow-up continuity: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
workspace="$runtime_dir/home/workspace/fixture"
test -f "$workspace/target.txt"
worker_pid="$(<"$runtime_dir/worker.pid")"
curl -fsS -X POST "http://127.0.0.1:8080/v1/sessions/$id/suspend" >/dev/null
test ! -e "$runtime_dir/worker.pid"
! kill -0 "$worker_pid" 2>/dev/null
curl -fsS -X POST "http://127.0.0.1:8080/v1/sessions/$id/resume" >/dev/null
test -f "$workspace/target.txt"
test "$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)" = "$before_session"
printf 'suspend/resume: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
curl -fsS -X DELETE "http://127.0.0.1:8080/v1/sessions/$id" >/dev/null
test ! -e "$runtime_dir"
printf 'delete cleanup: %ds\n' "$((SECONDS - scenario_start))"
printf 'total: %ds\n' "$((SECONDS - start_time))"
