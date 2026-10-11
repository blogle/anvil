# SDLC Onboarding

This PR is a preparation-only migration for `blogle/anvil`. It pins SDLC
source and reusable workflows to `v1.2.4`, keeps the existing Anvil workflows
in place, and adds the `sdlc / pr-fast`, `sdlc / candidate`, and stable
`sdlc / policy` contexts. Candidate stages build the three production images;
the upgrade-test image remains CI-only. No workflow in this PR publishes or
deploys on a feature branch.

## Expected First Run

`sdlc / policy` is intentionally red while the live repository has no
canonical `SDLC default branch` ruleset. The policy workflow only reads the
GitHub ruleset API with the Actions token and never applies changes or runs PR
code. Other applicable checks should be green; expensive candidate/Kind lanes
run through merge-group or main events, not ordinary source PR admission.

The shared v1.2.4 policy declaration uses `require_policy_check: false` for
the canonical first-onboarding bootstrap. The local stable gate adds the
required live-ruleset assertion, so this PR does not disguise missing
protection as success. After the user applies the ruleset, synchronize or
rerun the PR and the same check can pass. A follow-up reviewed change can set
`require_policy_check: true` after the baseline is established.

## User-Only Prerequisites

1. Review this open PR and confirm the only expected failure is `sdlc / policy`.
2. With admin credentials, run `nix develop -c sdlc policy plan --repo blogle/anvil`.
3. Apply the reviewed plan with `nix develop -c sdlc policy apply --repo blogle/anvil`.
4. Verify with `nix develop -c sdlc policy check --repo blogle/anvil`.
5. Rerun or synchronize the PR and confirm `sdlc / policy` is green.
6. Only then decide whether to authorize `integration:auto`; never add that label as part of this PR.
7. Provision the SDLC release GitHub App only when release activation is separately approved.

The policy renderer in v1.2.4 requires an active ruleset named `SDLC default
branch`, targeting `main`, with squash-only PRs, deletion and non-fast-forward
prevention, stale-review dismissal, and required checks `sdlc / pr-fast` and
`sdlc / policy`. Configure the provider app as the only intended release
bypass if the reviewed policy requires it; do not add legacy protection or
parent rulesets. The release App needs contents-write and pull-request-write
permissions, with credentials stored as `SDLC_RELEASE_APP_ID` and
`SDLC_RELEASE_APP_PRIVATE_KEY`, and `vars.SDLC_RELEASE_BOT_LOGIN` set to its
login. Publication also requires `vars.SDLC_RELEASE_ACTIVATE=true`; neither
is assumed or enabled here.

## Release Safety

The release caller is manual and has an explicit `activate` gate. The
consumer-owned `just release-publish <version>` hook requires the exact
merged/source identities and a JSON file containing immutable digests for all
three production GHCR images. It does not rebuild or push images. The SDLC
publisher verifies the merged SHA, tag, durable receipt, and policy before it
can call the hook. Mergify activation and release activation remain separate
user decisions.

## Validation Gap

Run `nix develop -c just check`, `nix flake check`, and actionlint locally when
the required tools and Nix caches are available. Hosted Kind acceptance and
full candidate image builds may be too expensive for the local sandbox; those
lanes must be reviewed from GitHub Actions before this migration is treated as
proven. The existing image and local-e2e workflows are intentionally retained
until that hosted evidence exists.
