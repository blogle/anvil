# Mergify merge-queue observation contract

`src/providers/mergify.ts` follows the official REST API contract at
<https://docs.mergify.com/api/merge-queue>:

- Base URL `https://api.mergify.com/v1`
- Read `GET /repos/{owner}/{repository}/merge-queue/pull/{pr_number}`
- Bearer credential supplied separately from GitHub App worker tokens
- Preserve the observed PR number, queue timestamp/position, `ci_state`, overall
  queue state, and individual queue-check names/states
- Interpret `404` with `error_code=PULL_REQUEST_NOT_QUEUED` as an explicit
  not-queued observation; keep credential failures and unavailable API distinct

`test/providers/mergify.test.ts` exercises the contract against a local Bun HTTP
fixture. The Mergify client is read-only; Anvil does not pause, dequeue, or merge
through this client. It has not been used against a live Mergify account.
