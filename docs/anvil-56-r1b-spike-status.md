# ANVIL-56 R1b proof status

## OpenCode v1.18.30 SendTurn ambiguity

Command: `nix develop -c node crates/anvil-reconcile/tests/opencode_v11830_ambiguity.mjs`

Observed exact runtime: `1.18.30+3104c14`, from the pinned dev-shell package. The test used an isolated temporary HOME/XDG profile, a loopback OpenCode server, and `anvil-test-model`; it did not connect to a live Anvil session or external model.

Observed result:

| Experiment | Observation |
|---|---|
| Same caller `messageID` resubmitted while first turn was busy | First and duplicate `prompt_async` both returned HTTP 204; one assistant parent observed; the gated model was released and completed. |
| Same `messageID` resubmitted after idle | HTTP 204; still one assistant parent for that user-message ID. |
| Client socket closed 250 ms after dispatch | User message was observed persisted and its assistant parent later appeared. |
| OpenCode server restarted with same temporary profile | Both tested user messages and assistant correlation remained queryable. |
| Tool side effects | None requested by these prompts; the probe did not establish tool-call idempotence. |

Across the probe the local model logged two requests for the two distinct message IDs, with no additional request observed for either duplicate. This is **bounded experimental evidence for the tested cases**, not a general exactly-once/idempotency contract. Production recovery therefore remains observation-first: correlate user/assistant by `messageID`/`parentID`; never blindly resend `UnknownOutcome`.

Still unproven: duplicate behavior where a tool side effect is in progress; the exact crash window after user-message persistence but before `ensureRunning`; and a restart with user present but no assistant. The pinned binary exposes no test-only crash hook at that internal boundary, so the script explicitly reports that scenario unproven rather than manufacturing it through a different API. A user-only result remains ambiguous and must stay `unknown_outcome`/attention absent stronger evidence.

## Legacy/Shadow/Reconciler cutover

Status: **unproven**. No service authority switch or live Attempt adoption was tested. Production dispatch/cutover remains gated until ANVIL-55 Task ownership/store integration is merged and a separate restart/fencing test can exercise an already-live Attempt.

## Scope boundary

R1c service wiring, authority cutover, terminal persistence and production observer scheduling are deferred until ANVIL-55's canonical Task store/API lands. This spike document and isolated reducer do not create a competing Task store.
