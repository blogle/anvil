---
name: walkthrough-author
description: Keep docs/walkthrough.md a verified, source-anchored tour of the implementation. Load when landing architectural changes, new modules, or major features touching the engine, strategy, harness, sandbox, github, store, http, or CLI surface — and when explicitly asked to reconcile or regenerate the walkthrough.
---

# Walkthrough Author

## Objective

`docs/walkthrough.md` is a guided tour of the implementation as it exists
in this tree: non-normative (spec.md §3 and architecture.md win), every
behavioral claim anchored to a `file:line` the reader can open. This skill
keeps it true as the code advances, instead of letting it drift.

## When it runs

Load this skill whenever work changes the shape the walkthrough documents:

- the module tree, dependency direction, or port variants (engine,
  strategy, harness, sandbox, github, store, http, secrets)
- the tick sequence, transition table, or state machine
- prompt composition, strategy knobs, or verdict evaluation
- the signal channel, CLI verbs, or HTTP routes
- test tiers and what exercises what

And on explicit request to reconcile or regenerate the walkthrough.

## The operation — reconcile (default)

A reconcile pass, not a rewrite:

1. Read the current walkthrough end to end.
2. Re-verify every `file:line` citation against the current source. A
   moved anchor is a bug in the doc: fix the line, and re-read enough of
   the surrounding code to confirm the claim itself still holds.
3. For each section, read the cited source and confirm the described
   behavior still matches. Patch stale claims; preserve approved prose
   wherever it is still true.
4. Rebuild §9 (drift notes) from the board: check open tickets on the
   ANVIL board (modules M1–M4) for code-vs-spec deviations; each gets one
   honest note — what the code does, what spec/architecture says, the
   direction, the ticket. Remove notes whose tickets closed.
5. Check the two diagrams only where structure changed:
   `walkthrough-architecture.svg` (crate/module layout, arrow topology —
   no two arrow lines may cross) and `walkthrough-states.svg` (every
   legal match arm of engine.rs `apply()` must be represented). Diagrams
   are hand-authored SVG: update geometry, do not regenerate them.
6. Add a section only when the code grew a genuinely new surface;
   otherwise the structure holds.

Blank-slate regeneration is a separate mode, only on explicit request:
re-derive the whole document from a fresh source read, then check the
result against the standing commentary so the framing survives.

## Standing commentary (operator direction, 2026-11-23 review)

Durable operator intent about *how* the walkthrough explains the system —
not observations to re-derive:

1. **State is derived from observables, never resident.** The engine
   reads the store *and* live GitHub state each tick. Never regress to
   "the database is the truth" as the sole observable.
2. **The engine validates only machine-readable facts** (work present,
   check conclusions, mergeability, head movement). It cannot evaluate
   whether evidence satisfies an obligation — obligations/evidence are
   grounding for the working agent and review material for humans or
   reviewer-agent strategies. Never imply the control loop judges a
   claim's substance.
3. **The signal channel is the agent's *primary* (not "only") control
   surface.** The intended extension — agents toggle obligations
   complete with evidence — is direction, ticketed on the board. Describe
   current behavior first, then the direction, marked
   not-yet-implemented.
4. **Prompting gets real code**: `TurnContext` assembly, `compose_turn`,
   and the initial-vs-reprompt lifecycle (where gaps and session
   continuity come from). Step-summary boxes are not a substitute.
5. **The strategy section explains the experimentation surface**: what a
   strategy is, the default's knobs, what is customizable today, and what
   multi-session/multi-agent shapes are expressible (spec N19, §4.5).
6. **CLI verbs are documented by purpose**, not just name.
7. **The sandbox port is described as code-truth**; deviations from
   architecture.md's `podman | agent-sandbox` shape are carried as drift
   notes plus board tickets, never rewritten as if the target existed.
8. **Testing shows at least one real test snippet** and says what each
   tier exercises.

## Conventions

- The non-normative header stays: spec.md §3 and architecture.md win;
  where they and the walkthrough disagree, the walkthrough is stale.
- Claims are anchored `file:line`, verified at write time. Abridged code
  excerpts are marked "abridged" and stay faithful to the real source.
- Diagrams: dark theme (`#14161a` bg, `#191c21` boxes, `#2a2e35`
  strokes), the existing state-color palette, dashed strokes for terminal
  or stub boxes.
- Drift notes are honest and specific.

## Verify

- Re-check every citation one final time after edits.
- If either SVG was touched:
  `nix shell nixpkgs#libxml2 -c xmllint --noout docs/walkthrough-*.svg`.
- Serve the docs on a scratch port
  (`nix run .#docs -- --root docs --project . --port 3999`) and curl the
  walkthrough page to confirm it renders; then stop the server.
- Never claim a check passed that was not run.
