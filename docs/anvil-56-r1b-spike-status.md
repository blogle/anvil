# ANVIL-56 R1b proof status

## OpenCode v1.18.30 SendTurn ambiguity

Status: **unproven; executable spike not run**. Repository integration research and pinned source inspection state that caller-assigned `messageID` persists the user message before asynchronous dispatch, with no duplicate-ID idempotency gate evident in the `prompt` path. Therefore this implementation treats an uncertain SendTurn as observation-only and does not equate equal message IDs with idempotence.

Required runtime experiments remain outstanding: duplicate while idle; duplicate while busy; timeout after request acceptance; server restart; and persisted user message with no assistant reply. Until those tests run against exactly v1.18.30, none of those cases is claimed proven.

## Scope boundary

R1c service wiring, authority cutover, terminal persistence and production observer scheduling are deferred until ANVIL-55's canonical Task store/API lands. This spike document and isolated reducer do not create a competing Task store.
