#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
helper="$repo_root/runtime/anvil-credential"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

mock_curl="$tmp_dir/curl"
curl_log="$tmp_dir/curl.log"
cat >"$mock_curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

config=''
data=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) config="$2"; shift 2 ;;
    --data) data="$2"; shift 2 ;;
    *) shift ;;
  esac
done

printf '%s\n' "$(cat "$config")" >"$CREDENTIAL_CURL_LOG"
printf 'request-body=%s\n' "$data" >>"$CREDENTIAL_CURL_LOG"
if [ "${CREDENTIAL_CURL_EXIT:-0}" -ne 0 ]; then
  printf '%s\n' 'broker unavailable' >&2
  exit "$CREDENTIAL_CURL_EXIT"
fi
if [ "${CREDENTIAL_CURL_RESPONSE+x}" = x ]; then
  response="$CREDENTIAL_CURL_RESPONSE"
else
  response='{"token":"ghs_test-token"}'
fi
printf '%s\n%s' "$response" "${CREDENTIAL_CURL_STATUS:-200}"
EOF
chmod +x "$mock_curl"

run_helper() {
  printf '%s' "$1" | env \
    ANVIL_SESSION_ID=session-123 \
    ANVIL_CREDENTIAL_URL=http://anvild:8080 \
    ANVIL_SESSION_CREDENTIAL=session-secret \
    CURL="$mock_curl" \
    CREDENTIAL_CURL_LOG="$curl_log" \
    "$helper"
}

output="$(run_helper $'protocol=https\nhost=github.com\n')"
test "$output" = $'protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_test-token'
test -s "$curl_log"
grep -Fq 'Authorization: Bearer session-secret' "$curl_log"
grep -Fq 'request-body={"purpose":"git"}' "$curl_log"
! grep -Fq 'session-secret' <<<"$output"

if printf '%s' $'protocol=http\nhost=github.com\n' | env \
  ANVIL_SESSION_ID=session-123 \
  ANVIL_CREDENTIAL_URL=http://anvild:8080 \
  ANVIL_SESSION_CREDENTIAL=session-secret \
  CURL="$mock_curl" \
  CREDENTIAL_CURL_LOG="$curl_log" \
  "$helper" >/dev/null 2>"$tmp_dir/rejection.log"; then
  echo 'credential helper accepted a non-HTTPS request' >&2
  exit 1
fi
grep -Fq 'only HTTPS github.com credentials are supported' "$tmp_dir/rejection.log"

if printf '%s' $'protocol=https\nhost=github.example\n' | env \
  ANVIL_SESSION_ID=session-123 \
  ANVIL_CREDENTIAL_URL=http://anvild:8080 \
  ANVIL_SESSION_CREDENTIAL=session-secret \
  CURL="$mock_curl" \
  CREDENTIAL_CURL_LOG="$curl_log" \
  "$helper" >/dev/null 2>"$tmp_dir/rejection.log"; then
  echo 'credential helper accepted a non-GitHub host' >&2
  exit 1
fi
grep -Fq 'only HTTPS github.com credentials are supported' "$tmp_dir/rejection.log"

if printf '%s' $'protocol=https\nhost=github.com\n' | env \
  ANVIL_SESSION_ID=session-123 \
  ANVIL_CREDENTIAL_URL=http://anvild:8080 \
  ANVIL_SESSION_CREDENTIAL=session-secret \
  CURL="$mock_curl" \
  CREDENTIAL_CURL_LOG="$curl_log" \
  CREDENTIAL_CURL_EXIT=1 \
  "$helper" >/dev/null 2>"$tmp_dir/broker-error.log"; then
  echo 'credential helper accepted a failed broker request' >&2
  exit 1
fi
grep -Fq 'broker request failed (no HTTP response)' "$tmp_dir/broker-error.log"

if printf '%s' $'protocol=https\nhost=github.com\n' | env \
  ANVIL_SESSION_ID=session-123 \
  ANVIL_CREDENTIAL_URL=http://anvild:8080 \
  ANVIL_SESSION_CREDENTIAL=session-secret \
  CURL="$mock_curl" \
  CREDENTIAL_CURL_LOG="$curl_log" \
  CREDENTIAL_CURL_RESPONSE='{"error":{"code":"github_token_scope_rejected","message":"GitHub rejected the requested permissions","upstream_status":422,"github_request_id":"safe-request-id"}}' \
  CREDENTIAL_CURL_STATUS=502 \
  "$helper" >/dev/null 2>"$tmp_dir/empty-response.log"; then
  echo 'credential helper accepted a structured broker failure' >&2
  exit 1
fi
grep -Fq 'github_token_scope_rejected' "$tmp_dir/empty-response.log"
grep -Fq 'GitHub rejected the requested permissions' "$tmp_dir/empty-response.log"
grep -Fq 'GitHub HTTP 422' "$tmp_dir/empty-response.log"
grep -Fq 'request safe-request-id' "$tmp_dir/empty-response.log"
! grep -Fq 'ghs_test-token' "$tmp_dir/empty-response.log"

if printf '%s' $'protocol=https\nhost=github.com\n' | env \
  ANVIL_SESSION_ID=session-123 \
  ANVIL_CREDENTIAL_URL=http://anvild:8080 \
  ANVIL_SESSION_CREDENTIAL=session-secret \
  CURL="$mock_curl" \
  CREDENTIAL_CURL_LOG="$curl_log" \
  CREDENTIAL_CURL_RESPONSE='{}' \
  CREDENTIAL_CURL_STATUS=200 \
  "$helper" >/dev/null 2>"$tmp_dir/empty-token.log"; then
  echo 'credential helper accepted a broker response without a token' >&2
  exit 1
fi
grep -Fq 'broker returned no GitHub token' "$tmp_dir/empty-token.log"

printf 'credential helper checks passed\n'
