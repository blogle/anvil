# Agent Sandbox V1beta1 local adapter contract

`src/providers/agent-sandbox.ts` uses the Agent Sandbox `Sandbox` custom resource
API `agents.x-k8s.io/v1beta1`, matching the incumbent's read-only manifest at
`origin/main` SHA `b55f9b0ecbf89309832c6dcdc9a615cbc4e15f8b` and the pinned
upstream release asset `k8s/vendor/agent-sandbox/v1.0.2/sandbox.yaml` in that
source revision. The local adapter submits a `Sandbox` CR only; it does not
create or reconcile Pods itself. The upstream agent-sandbox controller owns
those resources.

The `Sandbox` template declares one persistent `ReadWriteOnce` Workspace claim,
the existing OpenCode profile claim, the existing shared Nix claim with read-only
store and daemon-socket mounts, and an OpenCode service port. Image identities
must be immutable `sha256` digests. Sensitive environment values are rejected;
the CR may contain Secret key references but never the referenced values. Pod
service-account token mounting is disabled. Resource annotations bind the
Commission identity and hash the complete desired runtime specification.

Create uses a stable name and first reobserves the existing resource. On a
create timeout, HTTP error, or conflict, it rereads the CR and accepts only the
same Commission identity and desired-spec digest; if no postcondition is
observable it returns `ambiguous` and does not retry. Suspend/resume use JSON
Patch with a `resourceVersion` test precondition. Delete supplies UID and
resourceVersion preconditions. Ready/Failed conditions map to provisioning
observations without treating an absent or stale provider read as success.

`test/providers/agent-sandbox.test.ts` exercises the CR shape and create,
lost-ack recovery, conflict, suspend/resume/delete, Secret references, and
resource identity against a local Bun HTTP fixture. It has not accessed a live
Kubernetes API. Runtime trust, RBAC scope, agent-sandbox controller behavior,
Workspace storage, and real upgrade continuity remain externally unverified;
this adapter is not wired to the current daemon executable.
