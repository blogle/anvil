# First-slice acceptance evidence

This ledger records evidence in the current local checkout. A local deterministic
check is not evidence of deployed or live-provider acceptance. Status values:

- **LOCAL_EVIDENCE** — the listed local behavior has executable evidence; this
  does not substitute for any external acceptance gate.
- **NOT_STARTED** — implementation or acceptance evidence is outstanding.
- **BLOCKED_EXTERNAL** — cannot be completed without separately authorized
  external access or an unresolved provider/deployment contract.
- **NEEDS_CRITERIA** — the FS identifier is not accompanied by its authoritative
  acceptance text in the repository or the available task context; do not infer
  completion from adjacent implementation.

The full normative FS-01–FS-15 criteria were not present in the checkout at the
time this ledger was created. The repository-craft steering specifically
requires conventional TypeScript roots; this ledger records that evidence under
FS-01 and FS-02, without asserting that it exhausts their acceptance criteria.

| ID | Status | Local evidence / remaining gap |
|---|---|---|
| FS-01 | LOCAL_EVIDENCE / NEEDS_CRITERIA | Conventional source root is `src/`; package export, Prettier scripts, and TypeScript include use `src/**/*.ts`. `package.json`, `tsconfig.json`; verified by `nix develop -c just check`. Full criterion text is needed to assess the rest of FS-01. |
| FS-02 | LOCAL_EVIDENCE / NEEDS_CRITERIA | Conventional test root is `test/`; imports use `../src` and `./support`; Bun test discovery and Prettier include the new root. Verified by `nix develop -c just check` (19 tests, 433 assertions). Full criterion text is needed to assess the rest of FS-02. |
| FS-03 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-04 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-05 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-06 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-07 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-08 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-09 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-10 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-11 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-12 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-13 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-14 | NEEDS_CRITERIA | Normative criterion unavailable; no acceptance claim. |
| FS-15 | BLOCKED_EXTERNAL | Live deployment/namespace acceptance requires separate authorization. No cluster/dotfiles access was used; do not attempt until authorized. |

## G01–G06 adversarial findings

| Finding | Evidence | Status |
|---|---|---|
| G01 — successor controller must resolve predecessor Operations without replay | `test/store.test.ts` successor-Lease recovery test; `test/lifecycle.test.ts` stale-owner rejection. | Local deterministic coverage. |
| G02 — authorized retry must survive restart and preserve logical Operation identity | `test/store.test.ts` retry-authorized reopen test; `test/lifecycle.test.ts` provider-proof bounded retry test. | Local deterministic coverage. |
| G03 — conclusion is bound to registered PR, repository, target, revision, and passing checks | `src/domain.ts` authoritative conclusion validation; `test/lifecycle.test.ts` mismatched-merge test; `test/domain-core.test.ts` repository/target/PR identity mismatch assertions. | Local deterministic coverage; newest identity assertions require rerun. |
| G04 — maxAttempts=1 permits its initial Attempt but blocks another | `test/domain-core.test.ts` maxAttempts boundary test. | Local deterministic coverage. |
| G05 — concluded Commission specifications are immutable | `test/lifecycle.test.ts` amendment-after-conclusion test. | Local deterministic coverage. |
| G06 — idempotent Wait/Hold/Escalate decisions do not advance durable version | `test/domain-core.test.ts` and `test/lifecycle.test.ts` repeated no-op tests. | Local deterministic coverage. |

## Verification record

- `nix develop -c just check` — passed after the path move and fixes: formatting,
  strict TypeScript checks, 19 deterministic Bun tests / 433 assertions.
- `nix develop -c just ci-check` — passed on the same final code; Nix included
  the renamed `src/` and `test/` trees.
- `nix develop -c just ci-verify` — passed on the same final code.
- `nix run .#sdlc -- install --check` — passed on the same final code.
- No post-steering commit was created or pushed. PR #123 remains unmerged.

## Known outstanding first-slice work

Real OpenCode, agent-sandbox, GitHub/CI/Mergify adapters, daemon HTTP/MCP,
React UI, multi-process/HTTP daemon integration harness, packaging/deployment
contract, authoritative FS criterion text, and the separately authorized live
acceptance gate remain outstanding or externally gated. The incumbent `main`
is still the parity baseline; this evidence does not authorize cutover.
