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
  if [ "$status" -ne 0 ]; then
    for log in "$tmp"/*.log; do
      [ -f "$log" ] && { printf '\n--- %s ---\n' "$log" >&2; cat "$log" >&2; }
    done
  fi
  if [ "$status" -eq 0 ] || [ "${ANVIL_E2E_KEEP:-0}" != 1 ]; then
    local sessions=""
    sessions="$(curl -fsS http://127.0.0.1:8080/v1/sessions 2>/dev/null | jq -r '.[].id' 2>/dev/null || true)"
    while IFS= read -r id; do
      [ -n "$id" ] && curl -fsS -X DELETE "http://127.0.0.1:8080/v1/sessions/$id" >/dev/null 2>&1 || true
    done <<<"$sessions"
  fi
  for pid in "$api_pid" "$profile_pid" "$model_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  if [ "$status" -ne 0 ] && [ "${ANVIL_E2E_KEEP:-0}" = 1 ]; then
    printf 'E2E artifacts retained at %s\n' "$tmp" >&2
  else
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cargo build -p anvild -p anvil-test-model
mkdir -p "$tmp" "$runtime" "$profile/config" "$fixture"
cp "$root/dev/opencode-e2e.jsonc" "$profile/config/opencode.jsonc"
export ANVIL_TEST_MODEL_PORT=4098 ANVIL_TEST_MODEL_GATE=1
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
    if (( SECONDS >= deadline )); then
      printf 'timed out waiting for %s\n' "$url" >&2
      for log in "$tmp"/*.log; do printf '\n--- %s ---\n' "$log" >&2; cat "$log" >&2; done
      return 1
    fi
    sleep 0.2
  done
}

wait_for_state() {
  local id="$1" expected="$2" deadline=$((SECONDS + 60)) state=""
  while (( SECONDS < deadline )); do
    state="$(curl --max-time 3 -fsS "http://127.0.0.1:8080/v1/sessions/$id/status")" || true
    if [ "$expected" = working ] && jq -e '.execution_state == "running" and .work_state == "in_progress"' <<<"$state" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$expected" = ready_for_review ] && jq -e '.execution_state == "idle" and .work_state == "ready_for_review" and .current_run == null' <<<"$state" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  printf 'timed out waiting for session %s state %s; last status: %s\n' "$id" "$expected" "$state" >&2
  curl --max-time 3 -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages" >&2 || true
  printf '\nworker log:\n' >&2
  cat "$runtime/$id/worker.log" >&2 || true
  return 1
}

create_session() {
  local project="$1" prompt="$2"
  curl --max-time 90 -fsS -H 'content-type: application/json' \
    -d "$(jq -n --arg project "$project" --arg repository "$repository" --arg prompt "$prompt" '{project:$project,repository:$repository,ref:"main",prompt:$prompt,model:null}')" \
    http://127.0.0.1:8080/v1/sessions
}

worker_health() {
  local session="$1"
  poll "http://$(jq -r .service <<<"$session"):$(jq -r .opencode_port <<<"$session")/global/health"
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
created="$(create_session fixture 'ANVIL-E2E:edit-file ANVIL-E2E:wait-for-release inspect the fixture and change target.txt from before to after.')"
jq -e '.id | strings' <<<"$created" >/dev/null
id="$(jq -r .id <<<"$created")"
runtime_dir="$runtime/$id"
worker_health "$created"
jq -e '(.plugin // []) | length == 0' "$profile/config/opencode.jsonc" >/dev/null
test ! -e "$profile/plugins/anvil-report.ts"
test ! -e "$runtime_dir/home/.config/opencode/plugins/anvil-report.ts"
wait_for_state "$id" working
curl -fsS -X POST http://127.0.0.1:4098/__test/release >/dev/null
wait_for_state "$id" ready_for_review
state="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/status")"
jq -e '.last_run.state == "completed" and (.last_run.finished_at | strings) and .current_run == null' <<<"$state" >/dev/null
diff="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/diff")"
jq -e '.. | strings | select(contains("+after"))' <<<"$diff" >/dev/null
printf 'create/edit/working/idle/diff: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
before_session="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)"
before_run="$(jq -r .work_state_run_id <<<"$state")"
curl -fsS -X POST http://127.0.0.1:4098/__test/hold >/dev/null
curl -fsS -H 'content-type: application/json' \
  -d '{"prompt":"ANVIL-E2E:followup ANVIL-E2E:wait-for-release confirm this remains the same conversation."}' \
  "http://127.0.0.1:8080/v1/sessions/$id/messages" >/dev/null
wait_for_state "$id" working
follow_up_state="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/status")"
test "$(jq -r .work_state_run_id <<<"$follow_up_state")" != "$before_run"
curl -fsS -X POST http://127.0.0.1:4098/__test/release >/dev/null
wait_for_state "$id" ready_for_review
after_session="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)"
test "$before_session" = "$after_session"
curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages" | jq -e '.. | strings | select(contains("Confirmed: this is the same OpenCode conversation."))' >/dev/null
printf 'follow-up same conversation/working/idle: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
workspace="$runtime_dir/home/workspace/fixture"
test -f "$workspace/target.txt"
test -f "$runtime_dir/home/.local/share/opencode/opencode.db"
worker_pid="$(<"$runtime_dir/worker.pid")"
curl -fsS -X POST "http://127.0.0.1:8080/v1/sessions/$id/suspend" >/dev/null
test ! -e "$runtime_dir/worker.pid"
! kill -0 "$worker_pid" 2>/dev/null
test "$(<"$workspace/target.txt")" = after
curl -fsS -X POST "http://127.0.0.1:8080/v1/sessions/$id/resume" >/dev/null
test -f "$workspace/target.txt"
resumed_pid="$(<"$runtime_dir/worker.pid")"
test "$worker_pid" != "$resumed_pid"
worker_health "$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id")"
test "$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)" = "$before_session"
wait_for_state "$id" ready_for_review
printf 'suspend/resume workspace, OpenCode binding, watcher reconciliation: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
worker_pid="$(<"$runtime_dir/worker.pid")"
curl -fsS -X DELETE "http://127.0.0.1:8080/v1/sessions/$id" >/dev/null
test ! -e "$runtime_dir"
! kill -0 "$worker_pid" 2>/dev/null
printf 'delete process/watcher/runtime cleanup: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
curl -fsS -X POST http://127.0.0.1:4098/__test/hold >/dev/null
jq -n --arg repository "$repository" '{project:"concurrent-one",repository:$repository,ref:"main",prompt:"ANVIL-E2E:edit-file ANVIL-E2E:wait-for-release independently edit this session fixture.",model:null}' >"$tmp/concurrent-one.json"
jq -n --arg repository "$repository" '{project:"concurrent-two",repository:$repository,ref:"main",prompt:"ANVIL-E2E:edit-file ANVIL-E2E:wait-for-release independently edit this session fixture.",model:null}' >"$tmp/concurrent-two.json"
curl --max-time 90 -fsS -H 'content-type: application/json' -d @"$tmp/concurrent-one.json" http://127.0.0.1:8080/v1/sessions >"$tmp/concurrent-one-created.json" & first_create=$!
curl --max-time 90 -fsS -H 'content-type: application/json' -d @"$tmp/concurrent-two.json" http://127.0.0.1:8080/v1/sessions >"$tmp/concurrent-two-created.json" & second_create=$!
wait "$first_create"
wait "$second_create"
first_session="$(<"$tmp/concurrent-one-created.json")"
second_session="$(<"$tmp/concurrent-two-created.json")"
first_id="$(jq -r .id <<<"$first_session")"
second_id="$(jq -r .id <<<"$second_session")"
first_dir="$runtime/$first_id"
second_dir="$runtime/$second_id"
test "$first_id" != "$second_id"
test "$(jq -r .opencode_port <<<"$first_session")" != "$(jq -r .opencode_port <<<"$second_session")"
test "$first_dir" != "$second_dir"
worker_health "$first_session"
worker_health "$second_session"
wait_for_state "$first_id" working
wait_for_state "$second_id" working
curl -fsS -X POST http://127.0.0.1:4098/__test/release >/dev/null
wait_for_state "$first_id" ready_for_review
wait_for_state "$second_id" ready_for_review
test "$(<"$first_dir/home/workspace/concurrent-one/target.txt")" = after
test "$(<"$second_dir/home/workspace/concurrent-two/target.txt")" = after
first_diff="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$first_id/diff")"
second_diff="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$second_id/diff")"
jq -e '.. | strings | select(contains("+after"))' <<<"$first_diff" >/dev/null
jq -e '.. | strings | select(contains("+after"))' <<<"$second_diff" >/dev/null
for session_id in "$first_id" "$second_id"; do curl -fsS -X DELETE "http://127.0.0.1:8080/v1/sessions/$session_id" >/dev/null; done
test ! -e "$first_dir" && test ! -e "$second_dir"
printf 'concurrent workers, isolated endpoints/state/lifecycle: %ds\n' "$((SECONDS - scenario_start))"

printf 'frontend/API smoke: passed\ntotal: %ds\n' "$((SECONDS - start_time))"
