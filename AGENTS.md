# AGENTS.md

MindRail is developed as an auditable, vendor-neutral control plane for autonomous AI agents.

## Start here

Before substantial work:

1. Read `docs/00_PROJECT_INDEX.md`.
2. Read `docs/CURRENT_STATE.md`.
3. Read accepted ADRs relevant to the task.
4. Inspect the current repository state; do not trust historical summaries over current evidence.

## Authority

When documents conflict, use this precedence:

1. this file;
2. accepted ADRs;
3. `docs/CURRENT_STATE.md`;
4. `docs/architecture/`;
5. `docs/roadmap/`;
6. `README.md`.

Correct contradictions when you encounter them.

## Execution rules

- Make the smallest coherent change that satisfies the task.
- Prefer simple, explicit boundaries over speculative abstractions.
- Do not add frameworks, services, storage systems, or dependencies without a concrete need.
- For behavioral changes, add or update tests and execute them before claiming success.
- Never call an unexecuted check PASS.
- Update authoritative documentation when implementation changes current reality.
- Stop and propose an ADR before introducing a new persistent architectural concept, changing a security or permission boundary, changing storage authority, breaking a protocol/contract, or contradicting an accepted ADR.
- Prefer an isolated branch/worktree for substantial changes.
- Keep credentials and broad permissions out of agent context; follow least privilege.

## Completion evidence

Report:

- scope changed;
- commands/checks actually executed and their results;
- documentation/ADR updates;
- known limitations;
- anything not runtime-verified.
