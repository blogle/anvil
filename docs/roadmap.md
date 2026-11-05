# Incremental roadmap

This is the single short roadmap for adapting mainline. Sequence work around
observable results; do not require every future-state feature before the first
isolated deployment.

## Phase 0 — agree on the target

Discuss the user's vision, write and approve the one-page [controller spec](spec.md),
and identify the deployment/evidence boundary. Until then, this branch is
documentation-only.

## Phase 1 — inventory mainline

Use current `main` as the behavioral baseline. Record the working capabilities,
runtime/deployment dependencies, tests, and operator workflows that the target
must preserve or intentionally replace. Agree on the smallest first slice; do
not duplicate existing functionality merely to fit a new design.

## Phase 2 — implement one slice

Make a reviewable, backward-conscious change with a direct test and enough
logging/state inspection to explain its behavior. Build the affected images and
pin their identities. Keep unfinished future phases out of the slice.

## Phase 3 — characterize in isolation

After separate deployment authorization, run the slice in a temporary namespace.
Observe normal behavior, failures, recovery, resource usage, and operator
workflow. Compare those results with the agreed spec. Feed concrete findings
back into the next code change and redeploy the new image digest.

## Phase 4 — prove before promotion

Repeat phased implementation and isolated characterization until the agreed
acceptance evidence exists. Production remains unchanged throughout. Promotion,
cutover, or release requires a separate explicit decision after review of the
observed evidence; it is not an automatic final phase.
