#!/usr/bin/env bash
set -euo pipefail

ui_only=0
if [ "${1:-}" = --ui ]; then ui_only=1; fi
root="${ANVIL_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
target_dir="${CARGO_TARGET_DIR:-$root/target}"
export TMPDIR="${ANVIL_E2E_TMPDIR:-/tmp}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/anvil-local-e2e.XXXXXX")"
runtime="$tmp/runtime"
profile="$tmp/profile"
fixture="$tmp/fixture"
model_pid="" profile_pid="" api_pid="" git_http_pid=""
start_time=$SECONDS

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    printf '\n--- session diagnostics ---\n' >&2
    local ids id
    ids="$(curl -fsS http://127.0.0.1:8080/v1/sessions 2>/dev/null | jq -r '.[].id' 2>/dev/null || true)"
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      printf '\nstatus for %s:\n' "$id" >&2
      curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/status" >&2 || true
      printf '\nmessages for %s:\n' "$id" >&2
      curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages" >&2 || true
      printf '\nworker log for %s:\n' "$id" >&2
      cat "$runtime/$id/worker.log" >&2 2>/dev/null || true
    done <<<"$ids"
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
  for pid in "$api_pid" "$profile_pid" "$model_pid" "$git_http_pid"; do
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

# Refuse to share fixture/controller endpoints with an unrelated service/run.
for port in 4097 4098 8080 8443; do
  if ss -H -ltn "sport = :$port" | grep -q .; then
    printf 'local E2E port %s is already in use; refusing to touch existing processes or sessions\n' "$port" >&2
    exit 1
  fi
done

if [ -n "${ANVIL_PREBUILT_BIN_DIR:-}" ]; then
  anvild_bin="$ANVIL_PREBUILT_BIN_DIR/anvild"
  model_bin="$ANVIL_PREBUILT_BIN_DIR/anvil-test-model"
  test -x "$anvild_bin" && test -x "$model_bin"
else
  cargo build -p anvild -p anvil-test-model
  anvild_bin="$target_dir/debug/anvild"
  model_bin="$target_dir/debug/anvil-test-model"
fi
mkdir -p "$tmp" "$runtime" "$profile/config" "$fixture"
cp "$root/dev/opencode-e2e.jsonc" "$profile/config/opencode.jsonc"
export ANVIL_TEST_MODEL_PORT=4098 ANVIL_TEST_MODEL_GATE=1
"$model_bin" >"$tmp/model.log" 2>&1 & model_pid=$!
export OPENCODE_CONFIG="$profile/config/opencode.jsonc" OPENCODE_CONFIG_DIR="$profile/config"
export HOME="$profile/home" XDG_CONFIG_HOME="$profile/home/.config" XDG_CACHE_HOME="$profile/home/.cache"
export XDG_DATA_HOME="$profile/home/.local/share" XDG_STATE_HOME="$profile/home/.local/state"
export OPENAI_API_KEY=local-anvil-test-only
export ANVIL_OPENCODE_SERVER_PASSWORD=local-anvil-opencode-password-for-e2e-only
export OPENCODE_SERVER_PASSWORD="$ANVIL_OPENCODE_SERVER_PASSWORD"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"
opencode serve --hostname 127.0.0.1 --port 4097 >"$tmp/profile.log" 2>&1 & profile_pid=$!
export ANVIL_SANDBOX_BACKEND=local ANVIL_BIND_PORT=8080 ANVIL_LOCAL_RUNTIME_ROOT="$runtime"
export GIT_SSL_NO_VERIFY=true
export ANVIL_LOCAL_PROFILE_DIR="$profile" ANVIL_OPENCODE_BIN="$(command -v opencode)"
export ANVIL_PREVIEW_DOMAIN=localhost ANVIL_ANNOTATION_PREFIX=anvil.local
export ANVIL_PROFILE_OPENCODE_URL=http://127.0.0.1:4097 ANVIL_CREDENTIAL_URL=http://127.0.0.1:8080
export ANVIL_SESSION_SIGNING_SECRET=anvil-local-development-only-signing-secret
export ANVIL_HISTORY_PATH="$tmp/history.jsonl"
export ANVIL_WEB_DIR="${ANVIL_WEB_DIR:-$root/web/dist}"
unset ANVIL_STORE_PATH
RUST_LOG="${RUST_LOG:-info}" "$anvild_bin" >"$tmp/anvild.log" 2>&1 & api_pid=$!

poll() {
  local url="$1" deadline=$((SECONDS + 90))
  until curl --max-time 2 -fsS --user "opencode:$ANVIL_OPENCODE_SERVER_PASSWORD" "$url" >/dev/null 2>&1; do
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
    if [ "$expected" = running ] && jq -e '.execution_state == "running" and (.current_run.state == "running" or .current_run.state == "submitted")' <<<"$state" >/dev/null 2>&1; then
      return 0
    fi
    if [ "$expected" = completed_run ] && jq -e '.execution_state == "idle" and .last_run.state == "completed" and .current_run == null' <<<"$state" >/dev/null 2>&1; then
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

create_reconciler_task() {
  curl --max-time 10 -fsS -H 'content-type: application/json' -H 'idempotency-key: local-e2e-reconciler-task' \
    -d "$(jq -n --arg repository "$task_repository" '{outcome:"ANVIL-E2E:do-not-submit-this-turn",execution_target:{kind:"git_repository",project:"fixture",repository:$repository,base_ref:"main",delivery:"pull_request"},completion_policy:{kind:"evidence",required_kinds:["delivery_complete"]}}')" \
    http://127.0.0.1:8080/v1/tasks
}

wait_for_reconciler_runtime() {
  local task_id="$1" deadline=$((SECONDS + 120)) snapshot="" session_id="" opencode_id=""
  while (( SECONDS < deadline )); do
    snapshot="$(curl --max-time 3 -fsS "http://127.0.0.1:8080/v1/tasks/$task_id/snapshot")" || true
    session_id="$(jq -r '.attempts[0].session_id // empty' <<<"$snapshot" 2>/dev/null || true)"
    opencode_id="$(jq -r '(.observations | map(select(.key == "runtime.execution")) | first | .value.opencode_session_id) // empty' <<<"$snapshot" 2>/dev/null || true)"
    if [ -n "$session_id" ] && [ -n "$opencode_id" ]; then
      local session service port status messages
      session="$(curl --max-time 3 -fsS "http://127.0.0.1:8080/v1/sessions/$session_id")" || { printf 'bound Sandbox %s was not readable\n' "$session_id" >&2; return 1; }
      service="$(jq -r .service <<<"$session")"
      port="$(jq -r .opencode_port <<<"$session")"
      status="$(curl --max-time 3 -fsS "http://$service:$port/api/session/$opencode_id" --user "opencode:$ANVIL_OPENCODE_SERVER_PASSWORD")" || { printf 'native V2 session read failed for %s\n' "$opencode_id" >&2; return 1; }
      messages="$(curl --max-time 3 -fsS "http://$service:$port/api/session/$opencode_id/message" --user "opencode:$ANVIL_OPENCODE_SERVER_PASSWORD")" || { printf 'native V2 message observation failed for %s\n' "$opencode_id" >&2; return 1; }
      jq -e --arg id "$opencode_id" '.data.id == $id' <<<"$status" >/dev/null || { printf 'native V2 response was not bound to %s: %s\n' "$opencode_id" "$status" >&2; return 1; }
      jq -e '(.data // []) | length == 0' <<<"$messages" >/dev/null || { printf 'CreateAttempt unexpectedly has OpenCode messages: %s\n' "$messages" >&2; return 1; }
      jq -e 'any(.observations[]?; .key == "runtime.execution" and .value.runtime_health == "healthy" and .value.turn_state == "not_submitted")' <<<"$snapshot" >/dev/null
      return 0
    fi
    sleep 0.5
  done
  printf 'timed out waiting for Reconciler-owned Attempt runtime; last snapshot: %s\n' "$snapshot" >&2
  return 1
}

wait_for_reconciler_decision() {
  local task_id="$1" deadline=$((SECONDS + 20)) decisions=""
  while (( SECONDS < deadline )); do
    decisions="$(curl --max-time 3 -fsS "http://127.0.0.1:8080/v1/tasks/$task_id/decisions")" || true
    if jq -e 'any(.decisions[]?; .rule_id == "active_turn" or .rule_id == "attempt_starting")' <<<"$decisions" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  printf 'next reconciler decision did not consume runtime observation: %s\n' "$decisions" >&2
  return 1
}

worker_health() {
  local session="$1"
  poll "http://$(jq -r .service <<<"$session"):$(jq -r .opencode_port <<<"$session")/api/info"
}

model_request_count() {
  node - "$tmp/model.log" "$1" <<'NODE'
const fs = require("node:fs");
const marker = process.argv[3];
let count = 0;
for (const line of fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/)) {
  const prefix = "deterministic responses request: ";
  const start = line.indexOf(prefix);
  if (start < 0) continue;
  try {
    const request = JSON.parse(line.slice(start + prefix.length));
    const encoded = JSON.stringify(request);
    if (encoded.includes("You are a title generator.")) continue;
    if (!encoded.includes(marker)) continue;
    if (!Array.isArray(request.tools) || request.tools.length === 0) continue;
    count += 1;
  } catch {}
}
process.stdout.write(String(count));
NODE
}

poll http://127.0.0.1:4098/healthz
poll http://127.0.0.1:4097/api/info
poll http://127.0.0.1:8080/readyz
[[ -f "$tmp/controller.sqlite3" ]] || { printf 'controller store was not created beside history\n' >&2; exit 1; }

git -C "$fixture" init -b main >/dev/null
git -C "$fixture" config user.name Fixture
git -C "$fixture" config user.email fixture@example.invalid
printf 'before\n' >"$fixture/target.txt"
git -C "$fixture" add target.txt && git -C "$fixture" commit -m fixture >/dev/null
repository="file://$fixture"
git_http_root="$tmp/git-http"
mkdir -p "$git_http_root"
git clone --bare "$fixture" "$git_http_root/repo.git" >/dev/null 2>&1
# Enable receive-pack only for this disposable E2E repository. The global Git
# HTTP receive-pack setting must remain untouched.
git --git-dir="$git_http_root/repo.git" config http.receivepack true
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/git-http.key" -out "$tmp/git-http.crt" -days 1 -subj /CN=127.0.0.1 >/dev/null 2>&1
task_repository="https://127.0.0.1:8443/repo.git"
node "$root/tests/git-http-fixture.mjs" "$git_http_root" "$tmp/git-http.crt" "$tmp/git-http.key" 8443 >"$tmp/git-http.log" 2>&1 & git_http_pid=$!
deadline=$((SECONDS + 10))
until curl --max-time 1 -kfsS 'https://127.0.0.1:8443/repo.git/info/refs?service=git-upload-pack' >/dev/null 2>&1; do
  if (( SECONDS >= deadline )); then printf 'timed out waiting for local HTTPS Git fixture\n' >&2; exit 1; fi
  sleep 0.1
done

scenario_start=$SECONDS
task="$(create_reconciler_task)"
task_id="$(jq -r .task_id <<<"$task")"
test -n "$task_id" && test "$task_id" != null
curl --max-time 10 -fsS -H 'content-type: application/json' \
  -d "$(jq -n --argjson version "$(jq -r .version <<<"$task")" '{expected_version:$version,operator_hold:false,controller_mode:"reconciler"}')" \
  "http://127.0.0.1:8080/v1/tasks/$task_id/controller-mode" >/dev/null
wait_for_reconciler_runtime "$task_id"
wait_for_reconciler_decision "$task_id"
attempt_count="$(curl -fsS "http://127.0.0.1:8080/v1/tasks/$task_id/attempts" | jq '.attempts | length')"
test "$attempt_count" = 1
printf 'Reconciler CreateAttempt admission, native V2 binding and no SendTurn: %ds\n' "$((SECONDS - scenario_start))"

assert_http_smoke() {
  local index asset_paths asset_path=
  index="$(curl -fsS http://127.0.0.1:8080/)"
  grep -q '<html' <<<"$index"
  asset_paths="$(grep -oE '/assets/[^"[:space:]]+' <<<"$index" || true)"
  while IFS= read -r asset_path; do
    break
  done <<<"$asset_paths"
  test -n "$asset_path"
  curl -fsS "http://127.0.0.1:8080$asset_path" >/dev/null
  curl -fsS http://127.0.0.1:8080/healthz | jq -e '.status == "ok"' >/dev/null
}
assert_http_smoke
if [ "$ui_only" = 1 ]; then
  printf 'frontend/API smoke: %ds\ntotal: %ds\n' "$((SECONDS - start_time))" "$((SECONDS - start_time))"
  exit 0
fi

scenario_start=$SECONDS
created="$(create_session fixture 'ANVIL-E2E:durable-context=amber-731 ANVIL-E2E:edit-file ANVIL-E2E:wait-for-release inspect the fixture and change target.txt from before to after.')"
jq -e '.id | strings' <<<"$created" >/dev/null
id="$(jq -r .id <<<"$created")"
runtime_dir="$runtime/$id"
worker_health "$created"
jq -e '(.plugin // []) | length == 0' "$profile/config/opencode.jsonc" >/dev/null
test ! -e "$profile/plugins/anvil-report.ts"
test ! -e "$runtime_dir/home/.config/opencode/plugins/anvil-report.ts"
wait_for_state "$id" running
curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/activity" | jq -e '.execution_state == "running" and .telemetry.execution == "busy" and any(.telemetry.requests[]; (.prompt | contains("ANVIL-E2E:edit-file")) and .state == "running")' >/dev/null
curl -fsS -X POST http://127.0.0.1:4098/__test/release >/dev/null
wait_for_state "$id" completed_run
state="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/status")"
jq -e '.last_run.state == "completed" and (.last_run.finished_at | strings) and .current_run == null' <<<"$state" >/dev/null
diff="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/diff")"
jq -e '.. | strings | select(contains("+after"))' <<<"$diff" >/dev/null
printf 'create/edit/working/idle/diff: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
workspace="$runtime_dir/home/workspace/fixture"
before_session="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)"
before_transcript="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages")"
before_run="$(jq -r .last_run.id <<<"$state")"
curl -fsS -X POST http://127.0.0.1:4098/__test/hold >/dev/null
curl -fsS -H 'content-type: application/json' \
  -d '{"prompt":"ANVIL-E2E:followup ANVIL-E2E:wait-for-release confirm this remains the same conversation."}' \
  "http://127.0.0.1:8080/v1/sessions/$id/messages" >/dev/null
wait_for_state "$id" running
follow_up_state="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/status")"
test "$(jq -r .current_run.id <<<"$follow_up_state")" != "$before_run"
curl -fsS -X POST http://127.0.0.1:4098/__test/release >/dev/null
wait_for_state "$id" completed_run
after_session="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)"
test "$before_session" = "$after_session"
curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages" | jq -e '.. | strings | select(contains("Confirmed: this is the same OpenCode conversation."))' >/dev/null
printf 'follow-up same conversation/working/idle: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
workspace="$runtime_dir/home/workspace/fixture"
test -f "$workspace/target.txt"
opencode_data="$runtime_dir/home/.local/share/opencode"
test -s "$opencode_data/opencode.db"
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
wait_for_state "$id" completed_run
after_transcript="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages")"
jq -e --argjson before "$before_transcript" 'length >= ($before | length)' <<<"$after_transcript" >/dev/null
jq -e '.. | strings | select(contains("ANVIL-E2E:edit-file"))' <<<"$after_transcript" >/dev/null
test "$(<"$workspace/target.txt")" = after
test "$(git -C "$workspace" status --porcelain)" = " M target.txt"
curl -fsS -H 'content-type: application/json' -d '{"prompt":"ANVIL-E2E:restart-one-followup use the durable context from the first turn."}' \
  "http://127.0.0.1:8080/v1/sessions/$id/messages" >/dev/null
wait_for_state "$id" completed_run
curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages" | jq -e '.. | strings | select(contains("Confirmed restart one: prior conversation context is present."))' >/dev/null

# A second full OpenCode process recreation proves that reconciliation is
# reading its native session store repeatedly, rather than relying on a warm
# in-memory session or a one-off recovery path.
worker_pid="$resumed_pid"
curl -fsS -X POST "http://127.0.0.1:8080/v1/sessions/$id/suspend" >/dev/null
test ! -e "$runtime_dir/worker.pid"
! kill -0 "$worker_pid" 2>/dev/null
curl -fsS -X POST "http://127.0.0.1:8080/v1/sessions/$id/resume" >/dev/null
second_resumed_pid="$(<"$runtime_dir/worker.pid")"
test "$worker_pid" != "$second_resumed_pid"
worker_health "$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id")"
test "$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id" | jq -r .opencode_session_id)" = "$before_session"
wait_for_state "$id" completed_run
second_transcript="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages")"
jq -e --argjson before "$before_transcript" 'length >= ($before | length)' <<<"$second_transcript" >/dev/null
test "$(<"$workspace/target.txt")" = after
test "$(git -C "$workspace" status --porcelain)" = " M target.txt"
curl -fsS -H 'content-type: application/json' -d '{"prompt":"ANVIL-E2E:restart-two-followup continue using the first-turn context."}' \
  "http://127.0.0.1:8080/v1/sessions/$id/messages" >/dev/null
wait_for_state "$id" completed_run
curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/messages" | jq -e '.. | strings | select(contains("Confirmed restart two: prior conversation context is present."))' >/dev/null
printf 'suspend/resume workspace, OpenCode binding, watcher reconciliation: %ds\n' "$((SECONDS - scenario_start))"

scenario_start=$SECONDS
kill "$api_pid"
wait "$api_pid" 2>/dev/null || true
RUST_LOG="${RUST_LOG:-info}" "$anvild_bin" >"$tmp/anvild-restarted.log" 2>&1 & api_pid=$!
poll http://127.0.0.1:8080/readyz
wait_for_state "$id" completed_run
curl -fsS "http://127.0.0.1:8080/v1/sessions/$id/activity" | jq -e '.telemetry.schema_version == 1 and any(.telemetry.requests[]; .prompt | contains("ANVIL-E2E:edit-file"))' >/dev/null
printf 'anvild restart/materialized telemetry recovery: %ds\n' "$((SECONDS - scenario_start))"

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
wait_for_state "$first_id" running
wait_for_state "$second_id" running
curl -fsS -X POST http://127.0.0.1:4098/__test/release >/dev/null
wait_for_state "$first_id" completed_run
wait_for_state "$second_id" completed_run
test "$(<"$first_dir/home/workspace/concurrent-one/target.txt")" = after
test "$(<"$second_dir/home/workspace/concurrent-two/target.txt")" = after
first_diff="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$first_id/diff")"
second_diff="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$second_id/diff")"
jq -e '.. | strings | select(contains("+after"))' <<<"$first_diff" >/dev/null
jq -e '.. | strings | select(contains("+after"))' <<<"$second_diff" >/dev/null
for session_id in "$first_id" "$second_id"; do curl -fsS -X DELETE "http://127.0.0.1:8080/v1/sessions/$session_id" >/dev/null; done
test ! -e "$first_dir" && test ! -e "$second_dir"
printf 'concurrent workers, isolated endpoints/state/lifecycle: %ds\n' "$((SECONDS - scenario_start))"

# Exercise Campaign/Commission with the disposable Git fixture and deterministic
# local model. Confirm its branch effects before an anvild restart to expose
# recovery duplicates without treating an interrupted prompt as completed.
scenario_start=$SECONDS
curl -fsS -X POST http://127.0.0.1:4098/__test/hold >/dev/null
campaign_request="$(jq -n --arg repository "$task_repository" '{campaign:{purpose:"local E2E campaign",shared_contracts:[]},commissions:[{local_key:"e2e-edit",objective:"ANVIL-E2E:edit-file ANVIL-E2E:campaign-publish-local-fixture ANVIL-E2E:wait-for-release edit target.txt, commit, push, and publish locally.",obligations:[{id:"target-after",version:1,requirement:"target.txt contains after",acceptance_expectations:["target.txt is after"]}],execution_target:{kind:"git_repository",project:"campaign-e2e",repository:$repository,base_ref:"main",delivery:"local_branch"},budget:{max_attempts:1,max_continuations_per_reason:1,max_verifier_cycles:0,max_ci_retries:0,max_execution_seconds:180,max_model_cost:"0"}}]}')"
campaign="$(curl --max-time 10 -fsS -H 'content-type: application/json' -H 'idempotency-key: local-e2e-campaign' -d "$campaign_request" http://127.0.0.1:8080/v1/campaigns)"
campaign_again="$(curl --max-time 10 -fsS -H 'content-type: application/json' -H 'idempotency-key: local-e2e-campaign' -d "$campaign_request" http://127.0.0.1:8080/v1/campaigns)"
campaign_id="$(jq -r .campaign_id <<<"$campaign")"
commission_id="$(jq -r '.commissions[0].commission_id' <<<"$campaign")"
test -n "$campaign_id" && test "$campaign_id" != null
test -n "$commission_id" && test "$commission_id" != null
jq -e --arg campaign "$campaign_id" --arg commission "$commission_id" '.campaign_id == $campaign and .commissions[0].commission_id == $commission' <<<"$campaign_again" >/dev/null
aggregate="$(curl -fsS "http://127.0.0.1:8080/v1/campaigns/$campaign_id?limit=1")"
jq -e --arg commission "$commission_id" 'any(.commissions[]; .commission_id == $commission)' <<<"$aggregate" >/dev/null
commission="$(curl -fsS "http://127.0.0.1:8080/v1/commissions/$commission_id")"
jq -e '.state == "queued"' <<<"$commission" >/dev/null
start_request="$(jq -n --argjson version "$(jq -r .version <<<"$commission")" '{expected_version:$version}')"
curl -fsS -X POST -H 'content-type: application/json' -H 'idempotency-key: local-e2e-commission-start' -d "$start_request" "http://127.0.0.1:8080/v1/commissions/$commission_id/start" >/dev/null
# Commission/task IDs share their stable identifier; start returns a receipt
# and the current Commission projection, not a terminal lifecycle claim.
task_id="$commission_id"
deadline=$((SECONDS + 90))
session_id=""
while (( SECONDS < deadline )); do
  commission="$(curl --max-time 3 -fsS "http://127.0.0.1:8080/v1/commissions/$commission_id")"
  session_id="$(jq -r '.attempts[0].session_id // empty' <<<"$commission")"
  [ -n "$session_id" ] && break
  sleep 0.2
done
test -n "$session_id"
commission_session="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$session_id")"
opencode_id="$(jq -r .opencode_session_id <<<"$commission_session")"
test -n "$opencode_id" && test "$opencode_id" != null
commission_attempts="$(jq '.attempts | length' <<<"$commission")"
test "$commission_attempts" = 1
# The test model's hold gate is before it receives the prompt, so keeping it
# held through the restart would interrupt the request before any edit occurs.
# Release it only after the stable Session binding has been recorded, then
# wait for observable branch effects before exercising recovery.
curl -fsS -X POST http://127.0.0.1:4098/__test/release >/dev/null
campaign_workspace="$runtime/$session_id/home/workspace/campaign-e2e"
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  if [ -f "$campaign_workspace/target.txt" ] && [ "$(cat "$campaign_workspace/target.txt")" = after ] \
    && [ "$(git -C "$campaign_workspace" branch --show-current 2>/dev/null || true)" != main ] \
    && [ -z "$(git -C "$campaign_workspace" status --porcelain 2>/dev/null || true)" ] \
    && [ "$(curl -ksS https://127.0.0.1:8443/__fixture/pr 2>/dev/null | jq '.pull_requests | length')" = 1 ]; then
    break
  fi
  sleep 0.3
done
test "$(<"$campaign_workspace/target.txt")" = after
test -z "$(git -C "$campaign_workspace" status --porcelain)"
jq -e '.. | strings | select(contains("+after"))' <<<"$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$session_id/diff")" >/dev/null
campaign_branch="$(git -C "$campaign_workspace" branch --show-current)"
campaign_sha="$(git -C "$campaign_workspace" rev-parse HEAD)"
test "$campaign_branch" != main
test "$(git --git-dir="$git_http_root/repo.git" rev-parse "refs/heads/$campaign_branch")" = "$campaign_sha"
fixture_pr="$(curl -ksS https://127.0.0.1:8443/__fixture/pr)"
jq -e --arg branch "$campaign_branch" --arg sha "$campaign_sha" '.pull_requests | length == 1 and .[0].id == "local-pr-1" and .[0].provider == "local-fixture-not-github" and .[0].repository == "campaign-e2e" and .[0].base_ref == "main" and .[0].branch == $branch and .[0].commit_sha == $sha' <<<"$fixture_pr" >/dev/null
kill "$api_pid"
wait "$api_pid" 2>/dev/null || true
RUST_LOG="${RUST_LOG:-info}" "$anvild_bin" >"$tmp/anvild-campaign-restarted.log" 2>&1 & api_pid=$!
poll http://127.0.0.1:8080/readyz
commission_after_restart="$(curl -fsS "http://127.0.0.1:8080/v1/commissions/$commission_id")"
jq -e --arg commission "$commission_id" 'any(.commissions[]; .commission_id == $commission)' \
  <<<"$(curl -fsS "http://127.0.0.1:8080/v1/campaigns/$campaign_id?limit=1")" >/dev/null
test "$(jq -r '.attempts | length' <<<"$commission_after_restart")" = "$commission_attempts"
test "$(jq -r '.attempts[0].session_id' <<<"$commission_after_restart")" = "$session_id"
test "$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$session_id" | jq -r .opencode_session_id)" = "$opencode_id"
test "$(jq '.attempts | length' <<<"$commission_after_restart")" = 1
test "$(jq -r '.attempts[0].session_id' <<<"$commission_after_restart")" = "$session_id"
test "$(<"$campaign_workspace/target.txt")" = after
test -z "$(git -C "$campaign_workspace" status --porcelain)"
jq -e '.. | strings | select(contains("+after"))' <<<"$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$session_id/diff")" >/dev/null
test "$(git -C "$campaign_workspace" branch --show-current)" = "$campaign_branch"
test "$(git -C "$campaign_workspace" rev-parse HEAD)" = "$campaign_sha"
test "$(git --git-dir="$git_http_root/repo.git" rev-parse "refs/heads/$campaign_branch")" = "$campaign_sha"
fixture_pr_after="$(curl -ksS https://127.0.0.1:8443/__fixture/pr)"
jq -e --arg branch "$campaign_branch" --arg sha "$campaign_sha" '.pull_requests | length == 1 and .[0].id == "local-pr-1" and .[0].provider == "local-fixture-not-github" and .[0].repository == "campaign-e2e" and .[0].base_ref == "main" and .[0].branch == $branch and .[0].commit_sha == $sha' <<<"$fixture_pr_after" >/dev/null
messages_before_start_replay="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$session_id/messages")"
replay_status="$(curl -sS -o "$tmp/start-replay.json" -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'idempotency-key: local-e2e-commission-start' -d "$start_request" "http://127.0.0.1:8080/v1/commissions/$commission_id/start")"
test "$replay_status" = 200
jq -e --arg commission "$commission_id" '.receipt.commission_id == $commission and .receipt.disposition == "authorized" and .commission.commission_id == $commission and .commission.start_authorized == true' "$tmp/start-replay.json" >/dev/null
conflict_request="$(jq -n --argjson version "$(($(jq -r .version <<<"$commission_after_restart") + 1))" '{expected_version:$version}')"
conflict_status="$(curl -sS -o "$tmp/start-conflict.json" -w '%{http_code}' -X POST -H 'content-type: application/json' -H 'idempotency-key: local-e2e-commission-start' -d "$conflict_request" "http://127.0.0.1:8080/v1/commissions/$commission_id/start")"
test "$conflict_status" = 409
test "$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$session_id/messages")" = "$messages_before_start_replay"
commission_after_replay="$(curl -fsS "http://127.0.0.1:8080/v1/commissions/$commission_id")"
test "$(jq '.attempts | length' <<<"$commission_after_replay")" = "$commission_attempts"
fixture_pr_final="$(curl -ksS https://127.0.0.1:8443/__fixture/pr)"
jq -e --arg branch "$campaign_branch" --arg sha "$campaign_sha" '.pull_requests | length == 1 and .[0].id == "local-pr-1" and .[0].provider == "local-fixture-not-github" and .[0].repository == "campaign-e2e" and .[0].base_ref == "main" and .[0].branch == $branch and .[0].commit_sha == $sha' <<<"$fixture_pr_final" >/dev/null
printf 'Campaign idempotent submit/start, worker Git push and local fixture PR (campaign=%s commission=%s task=%s session=%s opencode=%s branch=%s sha=%s pr=local-pr-1 provider=local-fixture-not-github): %ds\n' "$campaign_id" "$commission_id" "$task_id" "$session_id" "$opencode_id" "$campaign_branch" "$campaign_sha" "$((SECONDS - scenario_start))"

# Bound the crash window to a separate, non-publishing Commission and the local
# deterministic model. Keep the model request held across the controller
# restart: a durable Submitted run is not evidence that the interrupted model
# outcome is known, and must not be blindly replayed.
scenario_start=$SECONDS
crash_objective='ANVIL-E2E:crash-window ANVIL-E2E:edit-file ANVIL-E2E:wait-for-release inspect target.txt and change before to after; do not commit or publish.'
crash_request="$(jq -n --arg repository "$task_repository" --arg objective "$crash_objective" '{campaign:{purpose:"local E2E bounded crash window",shared_contracts:[]},commissions:[{local_key:"e2e-crash-window",objective:$objective,obligations:[{id:"target-after",version:1,requirement:"target.txt contains after",acceptance_expectations:["target.txt is after"]}],execution_target:{kind:"git_repository",project:"crash-window-e2e",repository:$repository,base_ref:"main",delivery:"local_branch"},budget:{max_attempts:1,max_continuations_per_reason:1,max_verifier_cycles:0,max_ci_retries:0,max_execution_seconds:60,max_model_cost:"0"}}]}')"
crash_campaign="$(curl --max-time 10 -fsS -H 'content-type: application/json' -H 'idempotency-key: local-e2e-crash-window-campaign' -d "$crash_request" http://127.0.0.1:8080/v1/campaigns)"
crash_campaign_id="$(jq -r .campaign_id <<<"$crash_campaign")"
crash_commission_id="$(jq -r '.commissions[0].commission_id' <<<"$crash_campaign")"
test -n "$crash_campaign_id" && test "$crash_campaign_id" != null
test -n "$crash_commission_id" && test "$crash_commission_id" != null
curl -fsS -X POST http://127.0.0.1:4098/__test/hold >/dev/null
crash_commission="$(curl -fsS "http://127.0.0.1:8080/v1/commissions/$crash_commission_id")"
crash_start_request="$(jq -n --argjson version "$(jq -r .version <<<"$crash_commission")" '{expected_version:$version}')"
curl --max-time 10 -fsS -X POST -H 'content-type: application/json' -H 'idempotency-key: local-e2e-crash-window-start' -d "$crash_start_request" "http://127.0.0.1:8080/v1/commissions/$crash_commission_id/start" >/dev/null
deadline=$((SECONDS + 30))
crash_session_id=""
while (( SECONDS < deadline )); do
  crash_commission="$(curl --max-time 3 -fsS "http://127.0.0.1:8080/v1/commissions/$crash_commission_id")"
  crash_session_id="$(jq -r '.attempts[0].session_id // empty' <<<"$crash_commission")"
  if [ -n "$crash_session_id" ]; then
    crash_status="$(curl --max-time 3 -fsS "http://127.0.0.1:8080/v1/sessions/$crash_session_id/status")"
    if jq -e '.current_run.state == "submitted"' <<<"$crash_status" >/dev/null 2>&1; then break; fi
  fi
  sleep 0.2
done
test -n "$crash_session_id"
jq -e '.current_run.state == "submitted"' <<<"$crash_status" >/dev/null
crash_session="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$crash_session_id")"
crash_opencode_id="$(jq -r .opencode_session_id <<<"$crash_session")"
test -n "$crash_opencode_id" && test "$crash_opencode_id" != null
crash_attempt_count="$(jq '.attempts | length' <<<"$crash_commission")"
test "$crash_attempt_count" = 1
crash_run_id="$(jq -r .current_run.id <<<"$crash_status")"
crash_user_message_id="$(jq -r .current_run.user_message_id <<<"$crash_status")"
test -n "$crash_run_id" && test "$crash_run_id" != null
test -n "$crash_user_message_id" && test "$crash_user_message_id" != null
# Submitted is durable before OpenCode necessarily sends the request. Wait for
# the unique objective to reach the gated model with tools, not an earlier
# scenario's generic edit-file prompt or title-generation request.
deadline=$((SECONDS + 30))
crash_model_requests=0
while (( SECONDS < deadline )); do
  crash_model_requests="$(model_request_count ANVIL-E2E:crash-window)"
  if [ "$crash_model_requests" -gt 0 ]; then break; fi
  sleep 0.2
done
if [ "$crash_model_requests" -eq 0 ]; then
  printf 'timed out waiting for a tool-bearing model request containing ANVIL-E2E:crash-window\n' >&2
  grep -F 'deterministic responses request:' "$tmp/model.log" | tail -n 20 >&2 || true
  exit 1
fi
kill "$api_pid"
wait "$api_pid" 2>/dev/null || true
RUST_LOG="${RUST_LOG:-info}" "$anvild_bin" >"$tmp/anvild-crash-window-restarted.log" 2>&1 & api_pid=$!
poll http://127.0.0.1:8080/readyz
crash_commission_after_restart="$(curl -fsS "http://127.0.0.1:8080/v1/commissions/$crash_commission_id")"
test "$(jq '.attempts | length' <<<"$crash_commission_after_restart")" = "$crash_attempt_count"
test "$(jq -r '.attempts[0].session_id' <<<"$crash_commission_after_restart")" = "$crash_session_id"
test "$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$crash_session_id" | jq -r .opencode_session_id)" = "$crash_opencode_id"
jq -e --arg run "$crash_run_id" --arg message "$crash_user_message_id" '(.current_run // .last_run).id == $run and (.current_run // .last_run).user_message_id == $message' \
  <<<"$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$crash_session_id/status")" >/dev/null
# Leave two full scheduler intervals for recovery to act; no extra model request
# or prompt may be submitted while the original run's result remains unknown.
sleep 3
crash_commission_after_ticks="$(curl -fsS "http://127.0.0.1:8080/v1/commissions/$crash_commission_id")"
crash_status_after_ticks="$(curl -fsS "http://127.0.0.1:8080/v1/sessions/$crash_session_id/status")"
test "$(jq '.attempts | length' <<<"$crash_commission_after_ticks")" = "$crash_attempt_count"
test "$(jq -r '.attempts[0].session_id' <<<"$crash_commission_after_ticks")" = "$crash_session_id"
jq -e --arg run "$crash_run_id" --arg message "$crash_user_message_id" '(.current_run // .last_run).id == $run and (.current_run // .last_run).user_message_id == $message' <<<"$crash_status_after_ticks" >/dev/null
crash_model_requests_after="$(model_request_count ANVIL-E2E:crash-window)"
test "$crash_model_requests_after" = "$crash_model_requests"
# Release only to avoid leaving the local fixture handler blocked. Its outcome
# after the client/controller interruption is intentionally not asserted.
curl -fsS -X POST http://127.0.0.1:4098/__test/release >/dev/null
printf 'bounded Submitted crash window (campaign=%s commission=%s session=%s opencode=%s attempts=%s model_requests=%s->%s; outcome unknown, not replayed): %ds\n' "$crash_campaign_id" "$crash_commission_id" "$crash_session_id" "$crash_opencode_id" "$crash_attempt_count" "$crash_model_requests" "$crash_model_requests_after" "$((SECONDS - scenario_start))"

printf 'frontend/API smoke: passed\ntotal: %ds\n' "$((SECONDS - start_time))"
