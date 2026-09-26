#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/anvil-kind-e2e.XXXXXX")"
cluster="anvil-e2e-${$}"
kubeconfig="$tmp/kubeconfig"
namespace=anvil
source_repo="${ANVIL_KIND_SOURCE_REPOSITORY:-https://github.com/blogle/anvil.git}"
source_ref="${ANVIL_KIND_SOURCE_REF:-${GITHUB_HEAD_REF:-${GITHUB_REF_NAME:-$(git -C "$root" branch --show-current)}}}"
created=0 api_forward_pid="" router_forward_pid="" pod_name=""

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    printf '\n--- isolated Kind diagnostics ---\n' >&2
    kubectl --kubeconfig "$kubeconfig" get pods,pvc,sandbox -A -o wide >&2 || true
    kubectl --kubeconfig "$kubeconfig" -n anvil logs deployment/anvild --all-containers=true >&2 || true
    kubectl --kubeconfig "$kubeconfig" -n anvil logs deployment/anvil-profile --all-containers=true >&2 || true
    if [ -n "$pod_name" ]; then kubectl --kubeconfig "$kubeconfig" -n anvil logs "$pod_name" --all-containers=true >&2 || true; fi
    for log in "$tmp"/*.log; do [ -f "$log" ] && { printf '\n--- %s ---\n' "$log" >&2; cat "$log" >&2; }; done
  fi
  for pid in "$api_forward_pid" "$router_forward_pid"; do
    if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
  done
  if [ "$created" = 1 ] && ! { [ "$status" -ne 0 ] && [ "${ANVIL_E2E_KEEP:-0}" = 1 ]; }; then
    kind delete cluster --name "$cluster" --kubeconfig "$kubeconfig" >/dev/null 2>&1 || true
  fi
  if [ "$status" -ne 0 ] && [ "${ANVIL_E2E_KEEP:-0}" = 1 ]; then
    printf 'Kind acceptance artifacts retained at %s\n' "$tmp" >&2
  else
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

poll() {
  local url="$1" deadline=$((SECONDS + 120))
  until curl --max-time 3 -fsS "$url" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      printf 'timed out waiting for %s\n' "$url" >&2
      return 1
    fi
    sleep 0.2
  done
}

kind create cluster --name "$cluster" --kubeconfig "$kubeconfig" --wait 120s
created=1

anvil_image="$(nix build --no-link --print-out-paths .#anvil-image)"
sandbox_image="$(nix build --no-link --print-out-paths .#anvil-sandbox-image)"
skopeo --tmpdir "$tmp" --insecure-policy copy "docker-archive:$anvil_image" docker-daemon:ghcr.io/blogle/anvil:kind-e2e >/dev/null
skopeo --tmpdir "$tmp" --insecure-policy copy "nix:$sandbox_image" docker-daemon:ghcr.io/blogle/anvil-sandbox:kind-e2e >/dev/null
kind load docker-image ghcr.io/blogle/anvil:kind-e2e ghcr.io/blogle/anvil-sandbox:kind-e2e --name "$cluster"

kubectl --kubeconfig "$kubeconfig" cluster-info
kubectl --kubeconfig "$kubeconfig" apply -f "$root/k8s/vendor/agent-sandbox/v1.0.2/sandbox.yaml"
kubectl --kubeconfig "$kubeconfig" -n agent-sandbox-system rollout status deployment/agent-sandbox-controller --timeout=180s
kubectl --kubeconfig "$kubeconfig" wait --for=condition=Established --timeout=120s crd/sandboxes.agents.x-k8s.io
kubectl --kubeconfig "$kubeconfig" explain sandbox.spec --api-version=agents.x-k8s.io/v1beta1

# Render the checked-in deployment with local image tags and Never/IfNotPresent
# behavior so this lane cannot fall back to GHCR images.
mkdir -p "$tmp/kind-base"
cp -a "$root/k8s/base/." "$tmp/kind-base/"
cat >"$tmp/kind-base/kustomization.yaml" <<'EOF'
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: anvil
resources:
  - namespace.yaml
  - service-account.yaml
  - rbac.yaml
  - runtime-config.yaml
  - github-app-secret.yaml
  - opencode-profile-pvc.yaml
  - anvil-history-pvc.yaml
  - deployments.yaml
  - anvil-profile-deployment.yaml
  - services.yaml
  - anvil-profile-service.yaml
images:
  - name: ghcr.io/blogle/anvil
    newTag: kind-e2e
  - name: ghcr.io/blogle/anvil-sandbox
    newTag: kind-e2e
patches:
  - target:
      version: v1
      kind: Deployment
      name: anvild
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/imagePullPolicy
        value: IfNotPresent
  - target:
      version: v1
      kind: Deployment
      name: anvil-mcp
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/imagePullPolicy
        value: IfNotPresent
  - target:
      version: v1
      kind: Deployment
      name: anvil-router
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/imagePullPolicy
        value: IfNotPresent
  - target:
      version: v1
      kind: Deployment
      name: anvil-profile
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/imagePullPolicy
        value: IfNotPresent
EOF
kustomize build "$tmp/kind-base" | kubectl --kubeconfig "$kubeconfig" apply -f -

session_secret="kind-only-session-signing-secret-0123456789abcdef"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" create secret generic github-app-credentials \
  --from-literal=ANVIL_GITHUB_APP_ID=1 \
  --from-literal=ANVIL_GITHUB_INSTALLATION_ID=1 \
  --from-literal=ANVIL_GITHUB_PRIVATE_KEY=unused-in-kind-acceptance \
  --from-literal=ANVIL_SESSION_SIGNING_SECRET="$session_secret" \
  --dry-run=client -o yaml | kubectl --kubeconfig "$kubeconfig" apply -f -
kubectl --kubeconfig "$kubeconfig" -n "$namespace" patch configmap anvil-runtime --type merge -p \
  '{"data":{"ANVIL_SANDBOX_IMAGE":"ghcr.io/blogle/anvil-sandbox:kind-e2e","ANVIL_PREVIEW_DOMAIN":"preview.kind.test","ANVIL_ANNOTATION_PREFIX":"anvil.example","AGENT_SANDBOX_ROUTER_URL":"http://anvild.anvil.svc.cluster.local:8080","BASE_DOMAIN":"preview.kind.test"}}'
kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout restart deployment/anvild
kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout restart deployment/anvil-router

kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status deployment/anvild --timeout=180s
kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status deployment/anvil-profile --timeout=180s
kubectl --kubeconfig "$kubeconfig" -n "$namespace" rollout status deployment/anvil-router --timeout=180s

# Verify the Anvil service account can manage only its namespaced Sandbox API.
test "$(kubectl --kubeconfig "$kubeconfig" auth can-i --as=system:serviceaccount:anvil:anvild create sandboxes.agents.x-k8s.io -n anvil)" = yes
test "$(kubectl --kubeconfig "$kubeconfig" auth can-i --as=system:serviceaccount:anvil:anvild patch sandboxes.agents.x-k8s.io -n anvil)" = yes
test "$(kubectl --kubeconfig "$kubeconfig" auth can-i --as=system:serviceaccount:anvil:anvild get pods -n anvil)" = no
test "$(kubectl --kubeconfig "$kubeconfig" auth can-i --as=system:serviceaccount:anvil:anvild get secrets -n anvil)" = no

run_id="run_kind_acceptance"
started_at="2026-01-01T00:00:00Z"
finished_at="2026-01-01T00:01:00Z"
work_state_record="$(jq -cn --arg run_id "$run_id" --arg started_at "$started_at" --arg finished_at "$finished_at" '{changed_at:$finished_at,state:{state:"ready_for_review",details:{run:{run_id:$run_id,assistant_message_id:"assistant_kind_acceptance",started_at:$started_at,finished_at:$finished_at},previous_run:null}}}')"
last_run="$(jq -cn --arg run_id "$run_id" --arg started_at "$started_at" --arg finished_at "$finished_at" '{id:$run_id,state:"completed",started_at:$started_at,finished_at:$finished_at}')"
jq -n \
  --arg repository "$source_repo" \
  --arg source_ref "$source_ref" \
  --arg run_id "$run_id" \
  --arg finished_at "$finished_at" \
  --arg work_state_record "$work_state_record" \
  --arg last_run "$last_run" \
  --arg image "ghcr.io/blogle/anvil-sandbox:kind-e2e" \
  '{
    apiVersion:"agents.x-k8s.io/v1beta1",
    kind:"Sandbox",
    metadata:{
      name:"anvil-fixture-12345678",
      namespace:"anvil",
      labels:{"app.kubernetes.io/managed-by":"anvil","app.kubernetes.io/name":"sandbox"},
      annotations:{
        "anvil.example/project":"anvil",
        "anvil.example/repository":$repository,
        "anvil.example/base-ref":$source_ref,
        "anvil.example/work-branch":"anvil/fixture-12345678",
        "anvil.example/runtime-layout":"v2",
        "anvil.example/created-at":"2026-01-01T00:00:00Z",
        "anvil.example/work-state":"ready_for_review",
        "anvil.example/work-state-changed-at":$finished_at,
        "anvil.example/work-state-run-id":$run_id,
        "anvil.example/work-state-record":$work_state_record,
        "anvil.example/run-last":$last_run,
        "anvil.example/binding-state":"pending",
        "anvil.example/binding-continuity":"exact",
        "anvil.example/binding-checked-at":"2026-01-01T00:00:00Z"
      }
    },
    spec:{
      service:true,
      podTemplate:{
        metadata:{labels:{"app.kubernetes.io/managed-by":"anvil","app.kubernetes.io/name":"sandbox"}},
        spec:{
          securityContext:{fsGroup:1000},
          initContainers:[{
            name:"prepare-workspace",
            image:$image,
            imagePullPolicy:"IfNotPresent",
            command:["/bin/bash","-lc"],
            args:["set -euo pipefail; mkdir -p /home/anvil/workspace/anvil; chown -R 1000:1000 /home/anvil"],
            securityContext:{runAsUser:0,runAsGroup:0},
            volumeMounts:[{name:"workspace",mountPath:"/home/anvil"}]
          }],
          containers:[{
            name:"sandbox",
            image:$image,
            imagePullPolicy:"IfNotPresent",
            ports:[{name:"opencode",containerPort:4096}],
            env:[
              {name:"ANVIL_PROJECT",value:"anvil"},
              {name:"ANVIL_REPOSITORY",value:$repository},
              {name:"ANVIL_REF",value:$source_ref},
              {name:"ANVIL_WORK_BRANCH",value:"anvil/fixture-12345678"},
              {name:"ANVIL_RUN_ID",value:$run_id},
              {name:"ANVIL_SESSION_ID",value:"fixture-12345678"},
              {name:"ANVIL_CREDENTIAL_URL",value:"http://anvild:8080"},
              {name:"OPENCODE_CONFIG",value:"/anvil/profile/config/opencode.jsonc"},
              {name:"OPENCODE_CONFIG_DIR",value:"/anvil/profile/config"},
              {name:"HOME",value:"/home/anvil"},
              {name:"XDG_CONFIG_HOME",value:"/home/anvil/.config"},
              {name:"XDG_CACHE_HOME",value:"/home/anvil/.cache"},
              {name:"XDG_DATA_HOME",value:"/home/anvil/.local/share"},
              {name:"XDG_STATE_HOME",value:"/home/anvil/.local/state"},
              {name:"XDG_RUNTIME_DIR",value:"/home/anvil/.local/state/runtime"},
              {name:"DISPLAY",value:":99"}
            ],
            readinessProbe:{httpGet:{path:"/global/health",port:"opencode"},periodSeconds:2,timeoutSeconds:1,failureThreshold:60},
            livenessProbe:{httpGet:{path:"/global/health",port:"opencode"},initialDelaySeconds:15,periodSeconds:10},
            volumeMounts:[
              {name:"workspace",mountPath:"/home/anvil"},
              {name:"shared-profile",mountPath:"/anvil/profile"}
            ]
          }],
          volumes:[{name:"shared-profile",persistentVolumeClaim:{claimName:"anvil-opencode-profile"}}]
        }
      },
      volumeClaimTemplates:[{
        metadata:{name:"workspace"},
        spec:{accessModes:["ReadWriteOnce"],resources:{requests:{storage:"1Gi"}}}
      }]
    }
  }' >"$tmp/kind-sandbox.json"
kubectl --kubeconfig "$kubeconfig" apply -f "$tmp/kind-sandbox.json"
sandbox_name=anvil-fixture-12345678
kubectl --kubeconfig "$kubeconfig" -n "$namespace" wait --for=condition=Ready "sandbox/$sandbox_name" --timeout=300s
sandbox_pvc="workspace-$sandbox_name"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" wait --for=jsonpath='{.status.phase}'=Bound "pvc/$sandbox_pvc" --timeout=120s
service_fqdn="$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get sandbox "$sandbox_name" -o json | jq -r '.status.serviceFQDN // empty')"
test -n "$service_fqdn"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get service "$sandbox_name" -o json | jq -e '.spec.ports[] | select(.port == 4096)' >/dev/null

deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  pod_name="$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get endpoints "$sandbox_name" -o json 2>/dev/null | jq -r '[.subsets[]?.addresses[]?.targetRef.name][0] // empty')"
  [ -n "$pod_name" ] && break
  sleep 0.2
done
test -n "$pod_name"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" exec "$pod_name" -- mount | grep -q '/home/anvil'
kubectl --kubeconfig "$kubeconfig" -n "$namespace" exec "$pod_name" -- curl -fsS "http://$service_fqdn:4096/global/health" >/dev/null
opencode_session="$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" exec "$pod_name" -- \
  curl -fsS -X POST http://127.0.0.1:4096/session -H 'content-type: application/json' -d '{}' | jq -r .id)"
test -n "$opencode_session"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" annotate sandbox "$sandbox_name" \
  "anvil.example/opencode-session-id=$opencode_session" \
  anvil.example/binding-state=available \
  anvil.example/binding-checked-at="$(date -u +%Y-%m-%dT%H:%M:%SZ)" --overwrite

kubectl --kubeconfig "$kubeconfig" -n "$namespace" port-forward service/anvild 18080:8080 >"$tmp/anvild-port-forward.log" 2>&1 & api_forward_pid=$!
kubectl --kubeconfig "$kubeconfig" -n "$namespace" port-forward service/anvil-router 18082:8082 >"$tmp/router-port-forward.log" 2>&1 & router_forward_pid=$!
poll http://127.0.0.1:18080/readyz
poll http://127.0.0.1:18082/readyz

session="$(curl -fsS http://127.0.0.1:18080/v1/sessions/fixture-12345678)"
test "$(jq -r .opencode_session_id <<<"$session")" = "$opencode_session"
test "$(jq -r .service <<<"$session")" = "$service_fqdn"
preview="$(curl -fsS http://127.0.0.1:18080/v1/sessions/fixture-12345678/previews/5173)"
preview_url="$(jq -r .url <<<"$preview")"
preview_host="$(jq -r '.url | sub("^https?://"; "")' <<<"$preview")"
test "$preview_url" = "https://fixture-12345678-p5173.preview.kind.test"
sessions_through_router="$(curl -fsS -H "Host: $preview_host" http://127.0.0.1:18082/v1/sessions)"
jq -e 'any(.[]; .id == "fixture-12345678")' <<<"$sessions_through_router" >/dev/null || {
  printf 'router did not proxy to the Anvil session API: %s\n' "$sessions_through_router" >&2
  exit 1
}
invalid_router_status="$(curl -sS -o /dev/null -w '%{http_code}' -H 'Host: invalid.preview.kind.test' http://127.0.0.1:18082/v1/sessions)"
test "$invalid_router_status" = 400 || {
  printf 'router rejected invalid preview host with HTTP %s, expected 400\n' "$invalid_router_status" >&2
  exit 1
}

curl -fsS -X POST http://127.0.0.1:18080/v1/sessions/fixture-12345678/suspend >/dev/null
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  mode="$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get sandbox "$sandbox_name" -o json | jq -r '.spec.operatingMode // "Running"')"
  [ "$mode" = Suspended ] && break
  sleep 0.2
done
test "$mode" = Suspended
curl -fsS -X POST http://127.0.0.1:18080/v1/sessions/fixture-12345678/resume >/dev/null
session_after_resume="$(curl -fsS http://127.0.0.1:18080/v1/sessions/fixture-12345678)"
test "$(jq -r .opencode_session_id <<<"$session_after_resume")" = "$opencode_session"
status="$(curl -fsS http://127.0.0.1:18080/v1/sessions/fixture-12345678/status)"
jq -e '.environment_state == "ready" and .execution_state == "idle" and .work_state == "ready_for_review" and .current_run == null' <<<"$status" >/dev/null
deadline=$((SECONDS + 120))
while (( SECONDS < deadline )); do
  pod_name="$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get endpoints "$sandbox_name" -o json | jq -r '[.subsets[]?.addresses[]?.targetRef.name][0] // empty')"
  [ -n "$pod_name" ] && break
  sleep 0.2
done
test -n "$pod_name"

ANVIL_KUBECONFIG="$kubeconfig" \
ANVIL_SANDBOX_POD="$pod_name" \
ANVIL_NAMESPACE="$namespace" \
  bash "$root/tests/sandbox-acceptance.sh"

printf 'Kind Agent Sandbox reconciliation, PVC, suspend/resume, RBAC, router/preview and shared runtime acceptance passed\n'
