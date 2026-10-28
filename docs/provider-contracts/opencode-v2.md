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
| Active session observations | `GET /api/session/active` | `{ "data": [{ "id": "..." }] }` |
| Read recent messages | `GET /api/session/{id}/message?limit=100` | `{ "data": [...] }` |
| Select model | `POST /api/session/{id}/model` with providerID/modelID | Empty successful response |
| Submit instruction | `POST /api/session/{id}/prompt` with deterministic `{id,text}` | `{ "data": { "id": "..." } }` |

The deterministic provider message ID is a short SHA-256-derived identity from
the durable Operation ID. It allows postcondition lookup; it is **not** claimed
as an exactly-once key. The incumbent's pinned-source research states that
`messageID` does not prevent duplicate model execution. Consequently this
adapter sends one prompt per dispatch, treats transport failure/5xx/conflict as
ambiguous, inspects durable V2 user/assistant messages, and never converts
absence, duplicate replies, or a lost acknowledgement into safe-retry evidence.
`activeSessions()` returns raw active IDs; absence from that collection is not
by itself promoted to a definitive idle/failure result.

The adapter is tested in isolation and is not wired to `src/main.ts`'s current
unavailable provider. It does not yet implement OpenCode event-stream watchdog,
tool/context-pressure normalization, model catalog resolution, or production
credential management. Local fixture success is not live provider acceptance.
