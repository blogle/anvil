# Operations Frontend Implementation Note

Anvil had no browser frontend or static asset pipeline. The existing operator
API is `anvild`; sessions are represented by Agent Sandbox resources and
metadata annotations, while OpenCode stores the conversation on each sandbox
workspace. The existing `/v1/sessions/:id/messages` and `/status` proxy routes
already reach the durable OpenCode message history and live execution status.

The frontend read model is `GET /v1/sessions/:id/activity`. Lightweight state
polls omit conversation parts. The selected session additionally requests
`?include_events=true`, which combines:

- Sandbox metadata, phase, creation time, and the durable ready timestamp.
- OpenCode user and assistant messages, preserving exact submitted prompts.
- OpenCode status and tool parts for active request state and trustworthy current
  operation text when available.
- User-visible assistant text, tool input/output summaries, errors, and lifecycle
  transitions, ordered by authoritative timestamps and stable OpenCode
  message/part identity.
- Existing preview URL generation for the OpenCode endpoint and the exact
  `anvilctl sessions attach <id>` command.

The initial sandbox creation prompt is not duplicated in Anvil storage. It is
retrieved from OpenCode's persisted message history just like later prompts.
Sandbox creation and readiness are durable Kubernetes state; intermediate
startup transitions are not retained by the current Agent Sandbox resource and
are therefore not fabricated in the timeline.

OpenCode event polling is bounded to the latest 100 messages; older pages are
loaded on demand with OpenCode's cursor. The merged browser window is capped at
500 events and the response's `event_window` carries the cursor and truncation
state. Tool payloads are credential-redacted on the server before serialization,
and reasoning parts are never included.

The dashboard is colocated with `anvild` as small static assets served from the
same origin. It uses modest polling for state refresh and calculates timers in
the browser from server timestamps. This keeps deployment to the existing
Anvil image and avoids introducing a separate service or database.
