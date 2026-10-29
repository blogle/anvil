# OpenCode V2 local adapter contract

This local adapter follows the V2 API shape exercised in the incumbent at
`origin/main` SHA `b55f9b0ecbf89309832c6dcdc9a615cbc4e15f8b`, where
`flake.nix` pins OpenCode source commit
`9b4ec5714d481559990db0a816d5dec19541a814`. Relevant incumbent references:
`crates/anvild/src/lib.rs` (`OpenCode::health`, `create_session`,
`session_exists`, `session_messages`, and `prompt_async`) and
`docs/reconciler-integration-research.md` (SendTurn ambiguity analysis).

The protocol-compatible tests use a local Bun HTTP server; they do not connect
to a live OpenCode instance. Supported requests in `src/providers/opencode.ts`:

| Purpose | Request | Fixture response |
|---|---|---|
| Health/version | `GET /api/info` | `{ "version": "2.0.26+fixture" }` |
| Create session | `POST /api/session` with `{}` | `{ "data": { "id": "..." } }` |
| Active session observations | `GET /api/session/active` | `{ "data": { "session-id": { "type": "running" } }` |
| Read recent messages | `GET /api/session/{id}/message?limit=50&order=desc` | `{ "data": [...] }` with message times, assistant token usage, and tool states |
| Read model context limits | `GET /api/model` | `{ "data": [{ "providerID", "modelID", "limit": { "context" } }] }` |
| Interrupt safe active execution | `POST /api/session/{id}/interrupt?resume=false` | `{ "data": { "interrupted": true } }` |
| Subscribe to execution wakeups | `GET /api/event` | `text/event-stream` `data: {event JSON}` frames; client filters event type and `sessionID` before waking reconciliation |
| Select model | `POST /api/session/{id}/model` with providerID/modelID | Empty successful response |
| Submit instruction | `POST /api/session/{id}/prompt` with deterministic `{id,text}` | `{ "data": { "id": "..." } }` |

At the pinned `2.0.26` source commit, `packages/server/src/handlers/session.ts`
returns the active-session map with status `running`; `packages/server/src/event-feed.ts`
frames events as `data: ${JSON.stringify(event)}\n\n`; and
`packages/server/src/handlers/event.ts` exposes the unfiltered event feed.
`packages/schema/src/session-event.ts` and `session-message.ts` define the
`sessionID`, message progress timestamps, token usage, and tool-state fields used
by this watchdog. These source contracts informed the local fixture shapes; the
deployed OpenCode binary and its full behavior remain unverified.

The deterministic provider message ID is a short SHA-256-derived identity from
the durable Operation ID. It allows postcondition lookup; it is **not** claimed
as an exactly-once key. The incumbent's pinned-source research states that
`messageID` does not prevent duplicate model execution. Consequently this
adapter sends one prompt per dispatch, treats transport failure/5xx/conflict as
ambiguous, inspects durable V2 user/assistant messages, and never converts
absence, duplicate replies, or a lost acknowledgement into safe-retry evidence.
The watchdog keeps each Session snapshot for at most five seconds, then refreshes
the active-session map and recent provider messages. That bound limits observation
traffic independently of the daemon reconcile loop. Context pressure is measured
at 85% of the latest assistant input-token count against the selected OpenCode
model's reported context limit. Repeated tool failures are taken from
the latest assistant message only. A safe boundary requires that the latest
assistant message completed and no tool is streaming or running. A stuck turn is
derived from the provider's last message/tool progress timestamp and the local
policy threshold. Watchdog interruption is journaled as an Anvil Operation; the
controller re-reads active status and message/tool state immediately before the
interrupt POST and rejects the Operation if the boundary is no longer safe.
Ambiguous interrupt acknowledgements are inspected, never replayed. After an
interrupted or already-idle Session is observed, the controller selects a bounded
repair, strategy change, or context refresh. The hierarchical context packet is
reconstructed from durable Campaign/Commission, Assignment/Attempt, budget,
evidence, and repair Operation records; it does not include a transcript.
The SSE subscription is volatile by provider contract: locally filtered event
activity wakes the owning Commission, disconnects use bounded exponential backoff,
and each reconnect forces a fresh provider observation. The daemon's bounded periodic
reconciliation remains the fallback when `/api/event` is unavailable or events
are lost.

The adapter is exercised through local HTTP fixtures, SSE disconnect/reconnect,
and the configured daemon process test. The fixtures pin the response shapes
used by this slice but do not prove compatibility with the deployed OpenCode
build at the incumbent's pinned source revision. There is no live provider
acceptance. Randomized event ordering/loss, tool output/error classification
beyond the structured latest-message tool state, and production credential
management remain unverified.
