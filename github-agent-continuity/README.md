# GitHub Agent Continuity

GitHub Agent Continuity (GAC) is a repository template and agent skill for continuing autonomous coding work across disposable AI sessions using GitHub as the only durable coordination substrate.

A scheduled session can start with no conversation history, reconstruct project goals and task state from the repository, recover interrupted work, claim one eligible Issue, push durable progress, checkpoint the next action, and yield or expire so a later session can continue.

## What it uses

- repository files for long-term project memory and generic agent rules;
- GitHub Issues for task definitions and lifecycle;
- GitHub native Issue dependencies for ordering;
- generation-specific branches for cooperative claims, recovery, and stale-writer isolation;
- GitHub server timestamps for lease timing;
- Issue comments for human-readable checkpoints/lease renewals;
- Pull Requests and the base branch for integration truth.

No database, daemon, package install, project language, local CLI, or external orchestration service is required by GAC itself. The executing agent still needs authenticated GitHub read/write capabilities and an external trigger such as a scheduled ChatGPT task.

## Guarantee boundary

GAC is **crash-tolerant cooperative coordination**, not an IAM/security boundary or Byzantine distributed lock. A collaborator with sufficient GitHub write permission can intentionally violate the protocol. GAC is designed to prevent accidental concurrency conflicts between well-behaved agent sessions and to make recovery deterministic enough for coarse scheduled work.

## Core ownership model

Issue `#42` may have generations:

```text
agent/issue-42-g1
agent/issue-42-g2
agent/issue-42-g3
```

The highest generation is current. Each generation branch begins with a structured claim commit and then contains that generation's implementation work. A takeover creates `g(K+1)` from the previous generation's durable HEAD. Older branches become stale and cannot accidentally modify the current generation branch.

See [`docs/DESIGN.md`](docs/DESIGN.md) and [`docs/PROTOCOL.md`](docs/PROTOCOL.md) for the exact rules.

## Install into a repository

1. Copy the contents of this repository into the target repository root.
2. Fill in `.agent/PROJECT.md`, `.agent/GOALS.md`, and durable decisions relevant to the project.
3. Review `.agent/config.yml`; the defaults target roughly hourly scheduled sessions.
4. Follow [`docs/INSTALLATION.md`](docs/INSTALLATION.md) to create the `agent:*` labels and verify GitHub permissions.
5. Create work with the Agent Task Issue template and configure native Issue dependencies.
6. Configure the external scheduler with [`docs/SCHEDULED_PROMPT.md`](docs/SCHEDULED_PROMPT.md).

Repository-specific `AGENTS.md`, security policy, branch protection, review rules, and human approval requirements always outrank the generic GAC skill.

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
reconcile Issues/dependencies/generations/checkpoints
        ↓
recover yielded/expired work OR claim ready work
        ↓
work only while current generation lease is valid
        ↓
push coherent progress
        ↓
checkpoint + renew/yield
        ↓
PR when integration-ready
        ↓
base branch contains result → Issue done
```

## Status

v0.1 is a protocol/template. Its conformance suite in `tests/SCENARIOS.md` specifies expected behavior and race invariants. It does not claim adversarial locking or a separately deployed runtime service.
