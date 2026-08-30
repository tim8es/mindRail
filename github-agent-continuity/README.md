# GitHub Agent Continuity

GitHub Agent Continuity (GAC) is a repository template and agent skill for continuing autonomous coding work across disposable AI sessions using GitHub as the only durable coordination substrate.

A scheduled session can start with no conversation history, reconstruct goals/task state, recover interrupted work, claim one eligible Issue, push durable progress, checkpoint the next action, and yield/expire so a later session can continue.

## What it uses

- repository files for long-term project memory and generic agent rules;
- GitHub Issues for task definitions/lifecycle;
- GitHub native Issue dependencies for ordering;
- immutable generation claim branches for atomic ownership serialization;
- separate generation-specific work branches for implementation and stale-writer isolation;
- GitHub server timestamps for lease timing;
- Issue comments for checkpoint/renewal projection;
- Pull Requests and base branch for integration truth.

No database, daemon, package install, project language, local CLI, or external orchestration service is required by GAC itself. The executing agent still needs authenticated GitHub read/write capabilities and an external trigger such as a scheduled ChatGPT task.

## Guarantee boundary

GAC is **crash-tolerant cooperative coordination**, not an IAM/security boundary or Byzantine distributed lock. A collaborator with sufficient GitHub write permission can intentionally violate the protocol. GAC is designed to prevent accidental concurrency conflicts between well-behaved sessions and make recovery deterministic enough for coarse scheduled work.

## Core ownership model

Issue `#42`, generation 3 uses two refs:

```text
ownership: gac-claim/issue-42-g3  -> immutable empty claim commit
work:      agent/issue-42-g3      -> source + implementation commits
```

The highest valid **claim** generation is current. Ref creation for the exact next claim serializes competing sessions. Only the winning owner creates/uses the matching work branch.

A takeover creates `g(K+1)` from the previous valid work HEAD (or prior claim source when no work branch existed). Older work branches become stale. Claim commits stay outside product work history, so normal PR integration does not import GAC control commits into the base branch.

See [`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Install into a repository

1. Copy repository contents into target repository root.
2. Fill `.agent/PROJECT.md`, `.agent/GOALS.md`, and relevant durable decisions.
3. Review `.agent/config.yml`; defaults target roughly hourly scheduled sessions.
4. Follow [`docs/INSTALLATION.md`](docs/INSTALLATION.md) to create `agent:*` labels and verify GitHub capabilities/permissions.
5. Create work with Agent Task Issue template and configure native Issue dependencies.
6. Configure external scheduler with [`docs/SCHEDULED_PROMPT.md`](docs/SCHEDULED_PROMPT.md).

Repository-specific `AGENTS.md`, security policy, branch protection, review rules, and human approval requirements always outrank generic GAC skill.

## Repository layout

```text
.agents/skills/github-agent-continuity/SKILL.md
.agent/config.yml
.agent/PROJECT.md
.agent/GOALS.md
.agent/DECISIONS.md
.github/ISSUE_TEMPLATE/agent-task.yml
.github/pull_request_template.md
docs/
tests/SCENARIOS.md
```

## Runtime flow

```text
scheduled zero-context session
        ↓
read repository policy + .agent memory
        ↓
reconcile Issues/dependencies/claim refs/work refs/checkpoints
        ↓
recover yielded/expired work OR select ready work
        ↓
atomically win immutable next claim ref
        ↓
create/use matching generation work branch
        ↓
work only while highest-claim lease remains valid
        ↓
push coherent progress + checkpoint/renew/yield
        ↓
PR from work branch when integration-ready
        ↓
base contains result → Issue done
```

## Status

v0.1 is a protocol/template. `tests/SCENARIOS.md` specifies expected race/recovery invariants. Documentation does not itself prove runtime concurrency behavior; executed GitHub/API scenarios are required for runtime PASS claims.
