---
name: software-craft
description: >
  Apply when implementing, refactoring, designing, or reviewing
  software. Produce code with obvious ownership, minimal concepts,
  coherent abstractions, explicit states, localized complexity,
  and readable control flow. Use for changes to production code,
  public APIs, data models, or module boundaries.
---

# Software Craft

## Objective

Produce software whose structure is predictable, whose concepts
are few and coherent, and whose implementation is straightforward
to understand.

The reader should discover the design, not reconstruct it.

Optimize for understanding and correctness, not line count,
abstraction count, or stylistic uniformity.

## The Rules

### 1. Give every concept one identity and one home

- Use existing domain vocabulary consistently.
- Put behavior alongside the concept that owns it.
- Do not introduce competing representations of the same concept.
- Do not create managers, services, or utilities without a
  distinct responsibility.

### 2. Make structure communicate architecture

- Organize modules by cohesive responsibilities.
- Keep public interfaces small and intentional.
- Keep implementation details private.
- Make dependency direction understandable and consistent.
- Avoid unnecessary navigation between files.

### 3. Minimize conceptual machinery

- Prefer an existing concept over inventing another.
- Do not introduce abstractions for hypothetical future needs.
- Prefer direct implementation when abstraction adds vocabulary
  without removing complexity.
- Accept longer code when it is easier to understand.

### 4. Make boundaries remove knowledge

- Each abstraction must hide a meaningful implementation detail
  or establish a meaningful invariant.
- Callers should depend on contracts, not internal mechanisms.
- Do not add forwarding layers without a distinct responsibility.
- Keep knowledge of external systems at their integration boundaries.

### 5. Prefer composition to coordination

- Build new behavior by combining existing primitives when natural.
- Favor small interfaces with useful, coherent operations.
- Avoid registries, factories, and orchestration mechanisms when
  ordinary composition suffices.
- Do not force composition when explicit coordination is clearer.

### 6. Encode truth in the program's structure

- Represent mutually exclusive states as alternatives.
- Make invalid states unrepresentable where practical.
- Handle known variants exhaustively.
- Make failures explicit rather than hiding them behind defaults.
- Put validation at boundaries where untrusted data enters.

### 7. Give complexity an address

- Localize unavoidable complexity behind cohesive interfaces.
- Keep exceptional behavior near the invariant that requires it.
- Do not distribute special-case logic across unrelated modules.
- Explain non-obvious algorithms and their correctness constraints.

### 8. Make execution easy to follow

- Prefer explicit data flow and recognizable effects.
- Make control flow reflect the actual decisions being made.
- Avoid unnecessary indirection and surprising implicit behavior.
- Keep unrelated operations separate.
- Optimize for the reader, not for cleverness.

### 9. Make correctness demonstrable

- Preserve existing behavior unless the change explicitly alters it.
- Test observable behavior and important invariants.
- Document why subtle or unsafe operations are correct.
- Use deterministic verification wherever available.
- Never claim a check passed unless it was executed successfully.

### 10. Remove what no longer earns its existence

- Delete obsolete paths, abstractions, and dependencies.
- Avoid preserving duplication through compatibility wrappers
  unless compatibility is actually required.
- Do not introduce configurability without a concrete requirement.
- Leave the affected code more coherent, not merely larger.

## Workflow

### Before implementing

For nontrivial changes:

1. Find the existing concept responsible for the requested behavior.
2. Read its implementation, public interface, and relevant tests.
3. Identify the smallest coherent change that satisfies the request.
4. Identify any new concepts or boundaries the change requires.
5. Prefer extending an existing primitive when that is simpler.

Do not produce a design document unless the complexity warrants it.

### During implementation

Apply the rules above while writing code.

If a design starts requiring unrelated modules to understand new
implementation details, reconsider the boundary.

If a new abstraction does not make its callers simpler, reconsider
the abstraction.

If the implementation requires repeated special cases, reconsider
the underlying representation.

Prefer resolving the structural problem over accumulating patches.

### After implementation

Inspect the actual diff and ask:

1. Did I introduce a concept that wasn't necessary?
2. Is each change located where a reader would expect it?
3. Can any new abstraction or layer be removed?
4. Are invalid states and failures handled explicitly?
5. Did complexity leak outside the component that owns it?
6. Is the execution path understandable without hidden context?
7. Are behavioral claims supported by tests or other evidence?
8. Is there dead code or obsolete machinery to remove?

Correct material issues before declaring the work complete.

Run applicable repository formatting, linting, type-checking,
architectural checks, and targeted tests.

## Review Protocol

When reviewing a change, report findings only when they identify a
concrete violation with a meaningful consequence.

Each finding must provide:

- Location: the relevant code.
- Principle: which rule is violated.
- Evidence: what makes the current design harder to understand,
  maintain, or verify.
- Remedy: the simplest concrete improvement.

Do not invent findings to satisfy a checklist.

Do not recommend speculative abstractions, unrelated refactors,
or cosmetic churn.

## Judgment

These rules are not mechanical optimization targets.

Do not split cohesive modules merely to make files smaller.
Do not replace clear branches with obscure abstractions.
Do not hide complexity behind additional layers.
Do not sacrifice correctness or performance for aesthetic purity.

When principles conflict, prefer the design that requires the
least total knowledge to understand and safely modify.

For a trivial change, apply these principles proportionately.
