# Anvil — Research digest

Prior art that bootstraps the design. Each entry: what it is, what we adopted,
what we avoided. Sources cited; claims marked as vendor-reported are directional.
This file informed [spec.md](spec.md) §7; it is reference material, not requirements.

## OpenAI — Symphony (Codex orchestration spec)

Source: <https://openai.com/index/open-source-codex-orchestration-symphony/>
(open spec; reference impls in Elixir/TS/Go/Rust/etc. at github.com/openai/symphony).

- Control plane invariant, one line: *for every open task, guarantee an agent is
  running in its own workspace.* The orchestrator is deliberately narrow: poll on
  cadence, dispatch with bounded concurrency, single authoritative state; the
  agent itself writes state transitions, comments, PR links.
- Durable: restarts crashed/stalled agents; work decoupled from sessions and PRs;
  last-mile CI shepherding (watch CI, rebase, retry flaky checks) until a
  handoff state — `Human Review`, not `Done`.
- Moved away from rigid state machines toward objectives ("give them tools and
  context and let them cook"); workflow policy versioned in-repo (`WORKFLOW.md`).
- Credential hygiene: expose a scoped tool function rather than raw tokens to
  subagents/containers.
- Vendor-reported: 500% increase in landed PRs on some teams in three weeks.

**Adopted:** the invariant (spec N3), dumb-scheduler posture, needs-review as
terminal-ish handoff, CI shepherding, secrets never at rest in sandboxes.
**Avoided:** Linear-as-control-plane coupling; multi-language spec validation.

## OpenAI — Harness engineering (repo-as-harness)

Source: <https://openai.com/index/harness-engineering/>

- ~1M LOC product with 0 hand-written lines; ~100-line `AGENTS.md` as a table of
  contents; knowledge lives in a structured `docs/` system of record with
  mechanical freshness enforcement.
- Convergence loop: self-review + additional agent reviews, iterate until all
  reviewers satisfied (the "Ralph Wiggum loop"); quality expressed as concrete
  machine-checkable thresholds; "corrections are cheap, waiting is expensive."
- Ephemeral per-worktree observability stacks; background entropy-GC agents.

**Adopted:** AGENTS.md-as-map + docs-as-record (this repo's layout), mechanically
checkable thresholds (PR checks as gate), the cheap-corrections philosophy
(default-off `verify_cmd`).
**Avoided for MVP:** per-worktree observability stacks, doc-gardening GC agents.

## Anthropic — Harness design for long-running app development

Source: <https://www.anthropic.com/research/harness-design-long-running-apps>

- Planner → Generator → Evaluator on the Agent SDK; per-criterion hard
  thresholds; any failure bounces back with detailed feedback.
- Key insight: **generator/evaluator separation** — self-evaluation is
  systematically inflated; a standalone skeptical evaluator is tunable far more
  tractably than a self-critical generator.
- Context durability via structured handoff artifacts, not session memory; they
  removed components (resets, sprints) as models improved: *"every harness
  component encodes an assumption about what the model can't do — stress test it."*
- Costs vendor-reported (e.g. $200/6hr full harness vs $9/20min solo).

**Adopted:** obligations + hard verification (N6), fresh-context state on disk
(N12 knob), the remove-one-component discipline (strategy snapshots, N19),
reviewer-agent as the first post-MVP experiment.

## StrongDM — Attractor

Source: <https://factory.strongdm.ai/products/attractor> (github.com/strongdm/attractor)

- Graph-structured generative SDLC: nodes are work phases with a core prompt;
  edges are natural-language conditions evaluated by the LLM; deterministic,
  observable, resumable from any checkpoint; ~20 community implementations.

**Adopted:** the framing that turn policy is a composable program (our Strategy
trait is the degenerate single-node case; Attractor-style graphs are a possible
strategy shape later).

## Geoffrey Huntley — the Ralph technique

Sources: <https://ralph-wiggum.ai/>, ghuntley.com/loop/, Pragmatic Engineer
retrospectives (mid-2025 onward).

- `while :; do cat PROMPT.md | claude-code ; done` — fresh agent process with a
  clean context each iteration; spec/plan file on disk; state lives in files +
  git history; the loop checks a completion signal and restarts.

**Adopted:** fresh-context-per-turn as a strategy knob; state outside the model's
context (DB + branch); completion signals must be explicit (`anvilctl done`).
**Context:** "dark factory" (Dan Shapiro's level-5 autonomy) and "loop
engineering" (the discipline of the unattended outer loop) are the umbrella
terms for what Anvil is.

## google-research/harness2

Source: <https://github.com/google-research/harness2> (research framework; not
officially supported Google product).

- Harness = prompts/tools/memory/skills/orchestration around a fixed model;
  harnessing = optimizing it. Propose–Probe–Compose loops accumulate
  evidence-supported lessons; supports opencode and Codex as executors;
  eight editable harness components.

**Adopted:** experimentation as a first-class product feature (strategy
snapshots per attempt, N19), a small fixed set of editable knobs.

## guregodevo/memdoor — team-solve

Source: <https://github.com/guregodevo/memdoor> (`examples/workflows/team-solve`)

- Deterministic Go workflow runner + coding agent; YAML step DAG; every agent
  step runs fresh-context and communicates only via on-disk ledger files with
  unique section markers.
- **Engine-run verification:** the test step never gates; a strict `verify`
  command run by the engine is the only gate. Reviewer must not modify the
  artifact (a documented failure: a wrong reviewer counterexample overwrote a
  correct solution).
- `team-backlog` cron: pick issue → branch → PR only when Check passes — the
  campaign/commission pattern. Reproduces GVS5H: SWE-bench Verified 80% with
  small models (claims carry caveats: small sample, possible contamination).

**Adopted:** engine-verified evidence, never agent self-report (N6/N20); the
team-solve shape as a strategy example; resume-at-failed-step economics.

## Intelligent-Internet/zenith

Source: <https://github.com/Intelligent-Internet/zenith>

- Continuous-improvement harness for day-scale tasks; dominant failure mode is
  premature completion. Two-tier state: durable human/agent-readable record vs
  runtime cursors; atomic writes; JSON handoff files polled by the coordinator;
  attention queue; numbered decision audit; missions sealed by a closeout.
- Ablation (vendor-reported): adaptive loop beats plain RALPH on rank at less
  than half the cost.

**Adopted:** events-for-observation + snapshots-for-truth split (N17); explicit
attention queue; audit-logged obligation mutations (N2).

## kubernetes-sigs/agent-sandbox

Source: <https://github.com/kubernetes-sigs/agent-sandbox> — docs:
<https://agent-sandbox.sigs.k8s.io/docs/>

- `Sandbox` CRD (`agents.x-k8s.io/v1beta1`): stateful pod with stable identity,
  persistent storage, TTL/deletion, pause/resume. `SandboxTemplate` /
  `SandboxWarmPool` / `SandboxClaim` for pre-warmed instant allocation; Go/Python
  SDKs with file/command APIs; isolation delegated to RuntimeClass (gVisor,
  Kata, …). v1.0.x releases; Gateway-API features need k8s ≥1.31, CEL ≥1.25.
  Ships an opencode-sandbox example.

**Adopted:** the production sandbox substrate (N15); labels as the router's
contract; warm pools flagged for later if spin-up latency demands.

## opencode v2 (inner harness facts)

Sources: <https://opencode.ai/docs/>, the OpenAPI document
(<https://opencode.ai/docs/openapi.json>, 173 operations).

- Drive surface: `session.create`, `session.prompt` ("durably admit one session
  input…"), `experimental.session.wait`, `event.subscribe` SSE with fine-grained
  types (`session.tool.*`, `session.usage.updated`, execution lifecycle),
  `session.diff`, `session.export`, `experimental.session.stats`.
- Runtime MCP add/remove exists (`experimental.mcp.add/remove`) — but
  **provider credentials and model config cannot be set via API**
  (`experimental.config.update` patches only `shell`); provider keys are env /
  config-file by design. Hence N12: materialize file+env once at sandbox start.
- Sessions persist in a workspace-local SQLite DB (`OPENCODE_DB`), surviving
  serve restarts. `opencode run --session <id> --format json --auto` is the
  exec-per-turn fallback.
- `opencode stats` / usage events feed per-attempt telemetry.

## Nix in sandboxes

Sources: <https://github.com/nlewo/nix2container>; nix-in-docker caching
patterns (kevincox.ca 2022); GitLab runner nix config (wiki.nixos.org);
Pact's nix agent sandbox (alexghr.me); firefly-forage k8s hostPath notes;
docs.attic.rs; cachix.org.

- nix2container: archive-less image builds, layered for caching,
  `copyToPodman`/`copyToDockerDaemon` loaders, `initializeNixDatabase` for
  CI-style images.
- Shared-store pattern (well-established): bind-mount host `/nix` (store ro +
  daemon socket) with `NIX_REMOTE=daemon`; builds delegate to the host daemon;
  artifacts recycle across containers/pods per node. k8s: hostPath on
  nix-labeled nodes. Cross-node sharing: attic (self-hosted) or cachix — out of
  scope (spec N14).

## blogle tooling

- **blogle/sdlc** (<https://github.com/blogle/sdlc>): pinned nix library + shared
  GitHub workflows; consumer owns checks, `ci.nix` (`check`/`verify`), the
  `publish` app (`sdlc.lib.mkConsumer` → `hydraJobs.ci-check/ci-verify`),
  `packages.nix-eval-jobs`, `apps.sdlc`, justfile recipes, `.changes/*.json`
  changelog stubs, caller workflows (`sdlc / check`, `sdlc / verify`), release
  via `just release-publish <version>` promoting the same artifact identity.
  Skill format: `skills/<name>/SKILL.md` with YAML frontmatter
  (`name`, `description`), installed under `.agents/skills/`.
- **blogle/fieldnotes** (<https://github.com/blogle/fieldnotes>): build-free
  markdown/HTML docs workbench with live reload, anchored review prompts, git
  diff view; serves `docs/` as root; `docs/fieldnotes.json` (title, entry,
  ordered navigation, optional styles/scripts); consumer wiring: pin as flake
  input, expose `apps.<system>.docs` → `bin/fieldnotes`. Both consumed here.
