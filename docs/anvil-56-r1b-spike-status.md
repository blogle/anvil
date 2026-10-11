# ANVIL-56 R1b proof status

## OpenCode v1.18.30 SendTurn ambiguity

Command: `nix develop -c node crates/anvil-reconcile/tests/opencode_v11830_ambiguity.mjs`

Observed exact runtime: `1.18.30+3104c14`, from the pinned dev-shell package. The script starts a loopback OpenAI-compatible response fixture with explicit hold/release controls and a disposable HOME/XDG profile/workspace. It did not connect to a live Anvil session or external model.

Observed result:

| Experiment | Observation |
|---|---|
| Same caller `messageID` resubmitted while first turn was busy | First and duplicate `prompt_async` both returned HTTP 204. Depending on timing, one or two provider requests were active while gated. A completed run observed four total model requests, three assistant turns, two or three function calls, two tool outputs and two writes to the disposable workspace file for this message ID. |
| Same `messageID` resubmitted after idle | HTTP 204; zero additional model requests, assistant turns, or file mutations were observed in this run. |
| Client socket closed 250 ms after dispatch while model response was gated | The user message persisted. OpenCode had also persisted an assistant placeholder (`time.created` only, no parts, no completion time) before the model response. |
| OpenCode server killed and restarted with the same temporary profile | The user and incomplete assistant placeholder remained queryable. Releasing the old gated model response did not complete the assistant turn. |
| Tool side effects | The local model returned `read`/`edit` tool calls against a temporary workspace file only. Busy replay produced two observed file mutations; idle replay produced none. |

Across completed runs the loopback model received five requests total: four during the busy same-ID scenario and one for the separate timeout probe. Counts of calls gated before release and function-call requests varied with scheduling, while the busy replay consistently produced three assistant turns and two file mutations in the disposable workspace. The idle duplicate did not call the model or mutate the file in this probe. Equal-message-ID behavior therefore varied with timing even though both duplicate HTTP requests returned 204; the busy replay is direct evidence of repeated tool side effects. Production recovery remains observation-first: correlate user/assistant by `messageID`/`parentID`; an empty/incomplete assistant placeholder is not proof of completion or safe resubmission; never blindly resend `UnknownOutcome`.

Still unproven: the exact crash window after `createUserMessage` persistence but before `ensureRunning`; and whether that boundary can leave no assistant placeholder at all. The pinned binary exposes no test-only crash hook at that internal instruction boundary, so the script reports it unproven rather than manufacturing it through a different API. A user plus incomplete assistant placeholder remains ambiguous and must stay `unknown_outcome`/attention absent stronger evidence.

## Legacy/Shadow/Reconciler cutover

Status: **unproven**. No service authority switch or live Attempt adoption was tested. Production dispatch/cutover remains gated until ANVIL-55 Task ownership/store integration is merged and a separate restart/fencing test can exercise an already-live Attempt.

## Scope boundary

R1c service wiring, authority cutover, terminal persistence and production observer scheduling are deferred until ANVIL-55's canonical Task store/API lands. This spike document and isolated reducer do not create a competing Task store.
