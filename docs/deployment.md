# Deployment guardrails

This document defines boundaries, not an executable deployment request.

The inherited `just deploy` and `k8s/overlays/dev` target the existing `anvil`
namespace. Do not use those commands for this effort. An isolated overlay and
its deployment procedure must be reviewed and separately authorized first.

- Use a temporary Kubernetes namespace distinct from the production `anvil`
  namespace. Keep the production deployment, data, credentials, and service
  availability untouched.
- Deployment and namespace resources remain under the authorized dotfiles
  workflow. This implementation branch does not grant permission to edit
  dotfiles, access cluster credentials, or apply Kubernetes resources.
- Use isolated service accounts, credentials, storage, and network policies.
  Do not reuse production secrets or persistent volumes. Use immutable image
  digests so observations correspond to a precise source revision.
- Define namespace expiry and cleanup before deployment. Capture resource/image
  identities and redacted observations; never record secret values.
- Stop if namespace scope, credentials, production non-interference, or cleanup
  ownership is ambiguous.
- A successful rehearsal is characterization evidence, not production acceptance
  or permission to cut over. Promotion requires explicit approval and review of
  the observed evidence.

The operator and user must separately authorize a rehearsal before any cluster
or dotfiles action is taken.
