# Agent Development Workflow

This workflow applies to coding agents working in the MindRail repository before MindRail can orchestrate its own development.

## 1. Bootstrap context

Read in this order:

1. `AGENTS.md`;
2. `docs/00_PROJECT_INDEX.md`;
3. `docs/CURRENT_STATE.md`;
4. accepted ADRs relevant to the task;
5. the current implementation and recent changes needed to understand the slice.

Do not load every document by default. Follow the index and task boundaries to minimize context cost.

## 2. Establish current repository truth

Inspect the active branch/commit and relevant files. Historical chat summaries are hints, not authority.

Before editing, identify:

- the concrete desired outcome;
- files/boundaries likely affected;
- verification that can actually run;
- any architectural/security decision that requires an ADR.

## 3. Isolate substantial work

Use a dedicated branch or worktree for substantial changes. Avoid concurrent agents writing the same branch or file set without explicit coordination.

Suggested branch prefixes:

- `feat/` — user-visible/product capability;
- `fix/` — defect correction;
- `docs/` — documentation-only work;
- `chore/` — repository/tooling maintenance;
- `adr/` — architecture decision work.

## 4. Design only as much as needed

For a bounded change, document the short design in the issue/PR or task context.

For a new subsystem, persistent concept, or changed boundary, write/review an ADR and an implementation plan before code. Do not use a planning document as evidence that implementation exists.

## 5. Implement with evidence

For behavioral work:

1. add a failing test;
2. execute and confirm the expected failure when the environment allows;
3. implement the minimum behavior;
4. execute focused and aggregate checks;
5. remove unnecessary complexity discovered during implementation.

For configuration/documentation changes, validate the actual consumer where practical (for example CI, schema parser, formatter, or GitHub rendering) rather than inventing unit tests for static text.

## 6. Check architecture and permission impact

Before completing:

- Did a new persistent concept appear?
- Did system-of-record ownership change?
- Did a credential, permission, or trust boundary widen?
- Did a provider-specific assumption leak into core semantics?
- Did a new dependency solve a current need or only a hypothetical one?

If the answer exposes an unreviewed architectural change, stop that part and create/propose the ADR instead of normalizing the drift.

## 7. Reconcile repository truth

Update `docs/CURRENT_STATE.md` whenever factual capability or verification state changes. Update architecture docs when accepted architecture changes. Update the roadmap only when planning changes.

## 8. Handoff

A useful handoff is concise and evidence-based:

```text
Scope:
- what changed

Verification:
- command -> observed result

Docs/ADR:
- what was updated

Limitations:
- what was not verified or remains blocked

Next:
- the smallest logical next slice
```

Do not end with a generic "what should I do next?" when an existing plan or task queue already defines the next action.
