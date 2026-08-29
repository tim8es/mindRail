# Contributing to MindRail

MindRail is in private early development. These rules are established now so future human and agent contributions share the same workflow.

## Before you change code

1. Read `AGENTS.md` and `docs/00_PROJECT_INDEX.md`.
2. Confirm current reality in `docs/CURRENT_STATE.md`.
3. Read relevant accepted ADRs.
4. For significant architecture/security/protocol/storage/licensing changes, create or discuss an ADR before implementation.

## Branches

Use a focused branch. Recommended prefixes:

- `feat/`
- `fix/`
- `docs/`
- `chore/`
- `adr/`

Avoid multiple unrelated changes in one branch.

## Commits

Use concise Conventional Commit-style messages, for example:

```text
feat: add task lease contract
fix: reject expired agent session
adr: define runtime state authority
docs: reconcile current state
```

Prefer several coherent commits over a single opaque dump, but do not split setup and behavior into commits that leave the repository knowingly broken without a deliberate TDD reason.

## Quality

Before requesting review, run the checks applicable to the change. Once the foundation toolchain is verified, the canonical aggregate command is:

```bash
pnpm check
```

Report commands you actually ran. If a required environment is unavailable, state that verification is missing rather than declaring success.

Behavioral changes should normally follow TDD and include tests that would fail if the production behavior regressed.

## Documentation

Update authoritative docs when reality changes:

- ADR for binding decisions;
- `CURRENT_STATE.md` for implemented/verified capability;
- architecture docs for accepted design;
- roadmap for future intent.

Do not use roadmap completion checkboxes as a substitute for runtime evidence.

## Pull requests

A reviewable PR explains:

- why the change exists;
- exact scope;
- architecture/ADR impact;
- checks executed and results;
- documentation changes;
- security/permission impact;
- known limitations and unverified claims.

## Licensing and contributions

MindRail is source-available under BUSL-1.1 during its BSL period. Contribution mechanics for external contributors (including CLA/DCO and the right to offer alternative commercial licenses) will be finalized before the repository is opened for external contributions.

Until then, unsolicited external code contributions should not be accepted without an explicit licensing review.
