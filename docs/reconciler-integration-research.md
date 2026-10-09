# R1 integration research and verification gates (2026-10-08)

This is evidence for [Durable Task Primitive](durable-task-primitive.md) and [Deterministic Task Reconciler](deterministic-task-reconciler.md), not permission to skip the executable R1 acceptance tests. The design is based on Anvil's pinned dependencies, not unpinned upstream HEAD.

## 1. Pinned OpenCode turn identity — source inspected, runtime spike still required

**Confirmed:** Anvil `flake.nix` pins `github:anomalyco/opencode/v1.18.30`. Its existing architecture persists a caller-assigned OpenCode user-message ID *before* submitting `prompt_async`, correlates the assistant by `parentID`, and serializes same-session dispatch. This is strong existing infrastructure to reuse.

Source:
- Anvil pin: https://github.com/blogle/anvil/blob/main/flake.nix
- Anvil's existing run binding: https://github.com/blogle/anvil/blob/main/docs/architecture.md
- Pinned OpenCode source: https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/prompt.ts

**Confirmed upstream:** In v1.18.30, `prompt(input)` calls `createUserMessage(input)` and persists the user-message before entering `loop()`, which calls `state.ensureRunning(...)`. A caller-supplied `messageID` is used as the message key; no duplicate-ID idempotency gate is evident in that prompt path. Anvil must **not** equate “same `messageID`” with “exactly-once model execution.” `prompt_async` returns HTTP 204 without the created assistant ID. The exact assistant message is identified by `parentID == user_message_id`.

The pinned `runLoop` exits on `lastAssistant.parentID === lastUser.id`, rather than depending solely on the lexical ordering of separate client/server-generated message IDs. This avoids one historical class of clock-skew bug; it does **not** guarantee resend idempotency.

Source: https://github.com/anomalyco/opencode/blob/v1.18.30/packages/opencode/src/session/prompt.ts

**Mandatory executable spike, against exactly v1.18.30 + Anvil's normal HTTP client and local test model:**
1. submit a unique caller-assigned `messageID`; verify user and assistant-parent correlation, across OpenCode server restart;
2. send identical `messageID` twice while idle, count distinct assistant turns/tools, and check message/part persistence;
3. send a duplicate while the first is busy and observe queued/racing semantics;
4. simulate HTTP timeout/connection close after request dispatch but before response, then restart Anvil and reconcile by querying user/assistant message identity;
5. test failure between message persistence and `ensureRunning` (user message exists but assistant absent) and distinguish it from a successfully accepted/executing turn.

**Gate:** if duplicate/idempotent behavior cannot be proven, never automatically resend `UnknownOutcome` SendTurn. Query and reconcile known message/run facts; park ambiguity for attention. Do not change OpenCode itself as a first-wave prerequisite unless the spike proves that no reliable observation-based recovery can be constructed.

## 2. GitHub required-check semantics — documented; production credentials still need contract test

GitHub requirements may be supplied by classic branch protection or repository/org rulesets. Fetch *effective rules for the target branch* and distinguish required contexts/app sources from optional CI.

- Required status contexts may come from both check runs and commit statuses; if they share a required name, both can be required.
- Required check results should be evaluated for the exact commit GitHub considers authoritative: PR head, synthetic PR test-merge commit, or **merge-group SHA**. These are distinct from one another. A merge-queue-only check failure must not automatically cause a worker-code repair turn.
- `success`, `neutral`, and `skipped` may satisfy required check policy; `pending`, absent, failing and inaccessible are not passing. A workflow skipped by a path filter can leave a required context permanently pending.
- Anvil currently has a scoped GitHub App broker; verify the exact metadata/checks/statuses/rules read permissions through adapter contract tests and a read-only live smoke test. If requiredness cannot be determined, surface unknown instead of declaring green.

Sources:
- https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks
- https://docs.github.com/en/rest/repos/rules#get-rules-for-a-branch
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group
- https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue

## 3. Legacy/Shadow ownership — architectural design, behavior not yet tested

Anvil already implements durable batch Task/Attempt queueing and transactional scheduler admission; do not replace that with pure per-Task capacity arithmetic.

Implement per-Task `ControllerMode = Legacy | Shadow | Reconciler`:
- Legacy owns existing side effects.
- Shadow observes/records proposed decisions, never dispatches Actions or allocates Attempts.
- Reconciler transfer uses Task CAS and adopts the live Attempt; legacy scheduler must stop claiming/completing it.

**Mandatory spike:** inject an active worker turn and a scheduled infrastructure retry into Legacy; run Shadow; verify no duplicate side effects; atomically transfer one Task; prove only new controller continues while retaining exact bound OpenCode Session. Verify mode switch across daemon restart.

## 4. Test failpoints — concrete implementation guidance

Use a compile-gated test-only failpoint facility; never enable process-kill hooks in production builds. Trigger one named failpoint per child test process via a test-scoped environment key and `abort`/hard process exit, then restart on the *same* SQLite store.

Required names:
- `reconcile.before_decision_commit`
- `reconcile.after_decision_commit`
- `outbox.before_claim`
- `outbox.after_claim_before_dispatch`
- `outbox.after_side_effect_before_result_commit`
- `observer.after_observation_commit_before_wake`
- `task.before_terminal_commit`
- `gc.after_schedule_before_cleanup`

The decision and newly selected Actions must be committed atomically. A crash before commit must leave neither committed, while after-commit replay must preserve Action identity.

## 5. Scope and evidence status

No live OpenCode double-submit/restart experiment or live GitHub required-check policy credential test was performed during this docs update. Those are R1b proof obligations, not silently completed research gates.

The local E2E architecture already has real OpenCode, local sandbox, the deterministic model and local Git fixtures. Extend it: no external model, GitHub, Lific, Kubernetes or Docker-in-Docker required for the authoritative R1 factory test.
