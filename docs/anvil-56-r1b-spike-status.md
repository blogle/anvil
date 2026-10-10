# ANVIL-56 R1b proof status

## OpenCode v1.18.30 SendTurn ambiguity

Command: `nix develop -c node crates/anvil-reconcile/tests/opencode_v11830_ambiguity.mjs`

Observed exact runtime: `1.18.30+3104c14`, from the pinned dev-shell package. The test used an isolated temporary HOME/XDG profile, a loopback OpenCode server, and `anvil-test-model`; it did not connect to a live Anvil session or external model.

The script starts a loopback OpenAI-compatible response fixture with explicit hold/release controls and a disposable OpenCode HOME/XDG profile. No external model or Anvil-owned session is involved.

Observed result:

| Experiment | Observation |
|---|---|
| Same caller `messageID` resubmitted while first turn was busy | First and duplicate `prompt_async` both returned HTTP 204; only one model request and one assistant turn were observed for the message ID. |
| Same `messageID` resubmitted after idle | HTTP 204; zero additional model requests and no additional assistant turn were observed. |
| Client socket closed 250 ms after dispatch while model response was gated | The user message persisted. OpenCode had also persisted an assistant placeholder (`time.created` only, no parts, no completion time) before the model response. |
| OpenCode server killed and restarted with the same temporary profile | The user and incomplete assistant placeholder remained queryable. Releasing the old gated model response did not complete the assistant turn. |
| Tool side effects | The fixture returned text only; zero tools were requested. Duplicate tool-side-effect behavior remains untested. |

Across the probe the loopback model received three distinct-message requests; neither busy nor idle same-ID duplicate caused another model request. This is **bounded experimental evidence for this specific OpenCode/model timing**, not a general exactly-once/idempotency contract. Production recovery therefore remains observation-first: correlate user/assistant by `messageID`/`parentID`; an empty/incomplete assistant placeholder is not proof of completion or safe resubmission; never blindly resend `UnknownOutcome`.

Still unproven: duplicate behavior where a tool side effect is in progress; the exact crash window after `createUserMessage` persistence but before `ensureRunning`; and whether that boundary can leave no assistant placeholder at all. The pinned binary exposes no test-only crash hook at that internal instruction boundary, so the script explicitly reports it unproven rather than manufacturing it through a different API. A user plus incomplete assistant placeholder remains ambiguous and must stay `unknown_outcome`/attention absent stronger evidence.

## Legacy/Shadow/Reconciler cutover

Status: **unproven**. No service authority switch or live Attempt adoption was tested. Production dispatch/cutover remains gated until ANVIL-55 Task ownership/store integration is merged and a separate restart/fencing test can exercise an already-live Attempt.

## Scope boundary

R1c service wiring, authority cutover, terminal persistence and production observer scheduling are deferred until ANVIL-55's canonical Task store/API lands. This spike document and isolated reducer do not create a competing Task store.
