# Operations Frontend Implementation Note

Anvil had no browser frontend or static asset pipeline. The existing operator
API is `anvild`; sessions are represented by Agent Sandbox resources and
metadata annotations, while OpenCode stores the conversation on each sandbox
workspace. The existing `/v1/sessions/:id/messages` and `/status` proxy routes
already reach the durable OpenCode message history and live execution status.

The frontend read model is `GET /v1/sessions/:id/activity`. It combines:

- Sandbox metadata, phase, creation time, and the durable ready timestamp.
- OpenCode user and assistant messages, preserving exact submitted prompts.
- OpenCode status and tool parts for active request state and trustworthy current
  operation text when available.
- Existing preview URL generation for the OpenCode endpoint and the exact
  `anvilctl sessions attach <id>` command.

The initial sandbox creation prompt is not duplicated in Anvil storage. It is
retrieved from OpenCode's persisted message history just like later prompts.
Sandbox creation and readiness are durable Kubernetes state; intermediate
startup transitions are not retained by the current Agent Sandbox resource and
are therefore not fabricated in the timeline.

The dashboard is colocated with `anvild` as small static assets served from the
same origin. It uses modest polling for state refresh and calculates timers in
the browser from server timestamps. This keeps deployment to the existing
Anvil image and avoids introducing a separate service or database.
