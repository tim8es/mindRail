# GitHub Agent Continuity — Design v0.1

**Status:** Draft for review
**Date:** 2026-08-30

## 1. Purpose

GitHub Agent Continuity (GAC) is a standalone, GitHub-only coordination layer for autonomous AI coding agents that work across short-lived, independent sessions.

A new session must be able to recover project intent, current work, prior progress, blockers, and the next safe action using only repository and GitHub state. Conversation history is never authoritative and may be unavailable.

GAC is intentionally independent of MindRail. It does not import MindRail code, schemas, runtime concepts, APIs, or ADRs. The current repository is only a temporary host for development of the standalone template.

## 2. Goals

GAC v0.1 must support:

- durable long-term project context in repository files;
- GitHub Issues as the work queue;
- recovery of interrupted work by a zero-context session;
- parallel work on independent tasks;
- deterministic task claiming using GitHub-native primitives;
- expiring task ownership so abandoned work can be recovered;
- atomic serialization of both initial claims and stale-lease takeovers;
- dependency-aware task selection;
- checkpointing progress without requiring an external database;
- isolated task branches and pull requests;
- explicit blocked and human-required states;
- a minimal scheduled-session bootstrap prompt;
- no runtime dependency beyond GitHub and an agent capable of reading/writing GitHub.

## 3. Non-goals

GAC v0.1 is not:

- a general distributed database;
- a fine-grained sub-minute scheduler;
- a replacement for CI;
- a permissions/IAM system;
- a secret manager;
- a model vendor integration;
- a high-frequency heartbeat service;
- a guarantee that arbitrary concurrent edits will merge automatically;
- a canonical orchestration protocol outside GitHub.

The design optimizes for sessions that run for minutes and restart on a cadence such as hourly scheduled tasks.

## 4. Repository layout

The standalone template uses this structure:

```text
.agents/
└── skills/
    └── github-agent-continuity/
        └── SKILL.md

.agent/
├── PROJECT.md
├── GOALS.md
├── DECISIONS.md
└── README.md

.github/
├── ISSUE_TEMPLATE/
│   └── agent-task.yml
└── pull_request_template.md

docs/
├── PROTOCOL.md
├── STATE_MODEL.md
├── PARALLELISM.md
└── SCHEDULED_PROMPT.md

README.md
```

`.agent/` contains durable project knowledge. It is not a session log.

## 5. State ownership

GAC separates durable declarative memory from operational GitHub state.

| State | Authority |
|---|---|
| Project mission and boundaries | `.agent/PROJECT.md` |
| Strategic goals | `.agent/GOALS.md` |
| Durable project decisions | `.agent/DECISIONS.md` |
| Work queue and task requirements | GitHub Issues |
| Task lifecycle state | Issue state + labels |
| Task ownership generation | highest existing `agent-lock/issue-N-gK` branch |
| Current lease projection | latest valid checkpoint for the winning generation |
| Implementation work | task branch + commits |
| Integration/review | Pull Request |
| Session recovery point | structured Issue checkpoint comment |
| Historical repository truth | Git commits / PR / Issue history |

No single `STATE.md` accumulates all history.

## 6. Task lifecycle

The minimal labels are:

```text
agent:ready
agent:active
agent:blocked
agent:human-required
agent:done
```

Lifecycle:

```text
ready -> active -> done
          |  \
          |   -> human-required -> ready
          -> blocked -> ready
```

A closed Issue may be used instead of `agent:done` if a repository chooses that convention. The template defaults to both closing the Issue and retaining `agent:done` for visible history.

## 7. Task definition

Each agent task Issue contains:

- outcome;
- acceptance criteria;
- dependencies;
- primary file scope;
- shared file scope;
- validation expectations;
- optional human constraints.

Dependencies use explicit Issue references such as `Depends on: #12, #13`.

The agent must not claim a task whose required dependencies are incomplete.

## 8. Generational claim protocol

Labels alone are not a concurrency lock because two sessions can observe `agent:ready` simultaneously.

For Issue `#42`, ownership is serialized by generation branches:

```text
agent-lock/issue-42-g1
agent-lock/issue-42-g2
agent-lock/issue-42-g3
```

Each lock branch is created from the current default-branch HEAD and contains no implementation work.

### Initial claim

If no lock generation exists, competing sessions both attempt to create:

```text
agent-lock/issue-42-g1
```

Exactly one creation may succeed. A session that receives an already-exists/conflict result does not own the task and must re-read GitHub state.

### Recovery claim

If the highest generation is `gK` and its lease is expired, competing recovery sessions both attempt to create exactly:

```text
agent-lock/issue-42-g(K+1)
```

Again, only one creation may succeed. The winner becomes the only session allowed to publish the ownership checkpoint for generation `K+1`.

This makes GitHub ref creation the compare-and-create serialization point for every ownership transfer, not only the first claim.

The working branch remains separate and stable across recovery:

```text
agent/42-short-task-name
```

A recovery owner continues the existing work branch rather than creating a fresh implementation branch unless the branch is missing or repository policy requires otherwise.

## 9. Lease protocol

A winning generation is bounded by a lease recorded in a structured checkpoint comment on the Issue.

Default lease duration for the template: **90 minutes**.

The ownership checkpoint contains:

```text
AGENT CHECKPOINT v1

Task: #42
Owner: <unique-session-id>
Generation: 3
Status: active
Lock: agent-lock/issue-42-g3
Work branch: agent/42-short-task-name
Lease started: <ISO-8601 UTC>
Lease until: <ISO-8601 UTC>
HEAD: <commit-sha-or-none>
Completed:
- ...
Verified:
- ...
Remaining:
- ...
Next action: <one executable action>
Blockers: none
Human decision required: none
```

A later checkpoint from the same owner and same generation may renew the lease by writing a new `Lease until` value.

Issue comments are immutable history. The current lease is the latest structurally valid checkpoint that names the highest existing lock generation.

A checkpoint for an older generation is stale even if its timestamp appears newer.

## 10. Stale lease recovery

A lock generation is never reused.

A different session may recover a task only when all are true:

1. it has identified the highest existing lock generation `gK`;
2. the latest valid checkpoint for `gK` has expired;
3. repository/Issue/PR evidence does not show a later valid renewal for `gK`;
4. the task is not complete;
5. the recovering session first inspects the work branch, commits, PR, CI, and acceptance criteria;
6. it atomically wins creation of `agent-lock/issue-N-g(K+1)`;
7. it records the new ownership checkpoint before modifying implementation.

If creation of `g(K+1)` fails, another recovery session won. The loser must re-read state and must not write to the task branch under the old generation.

Recovery continues existing durable progress rather than restarting the task.

Old lock generations remain as an audit trail in v0.1. Deleting old lock branches is optional maintenance and is not part of normal ownership transfer.

## 11. Session bootstrap

Every independent session performs this sequence before editing:

1. read repository agent instructions if present;
2. read `.agent/PROJECT.md` and `.agent/GOALS.md`;
3. read relevant durable decisions;
4. inspect active/blocked/human-required/ready Issues;
5. inspect lock generations, open agent PRs, and relevant recent commits;
6. recover interrupted work only through the generational claim protocol;
7. otherwise rank eligible ready tasks;
8. claim exactly one primary task;
9. reconcile its latest checkpoint with actual branch/PR/CI state;
10. continue execution.

Repository evidence overrides stale checkpoint prose.

## 12. Task selection

When there is no resumable task, rank eligible `agent:ready` Issues by:

1. dependency unblocking value;
2. current strategic goal;
3. explicit priority label;
4. milestone priority if used;
5. oldest eligible Issue.

The model may rank candidates, but it must not bypass explicit dependencies or an existing valid ownership claim.

## 13. Parallel work

Parallel sessions are supported when they own different Issues.

Each task Issue declares:

```text
Primary scope:
- src/persistence/**
- tests/persistence/**

Shared scope:
- package.json
- src/index.ts
```

Primary scope communicates expected isolation. Shared scope warns that integration conflicts are possible.

Scope is advisory in v0.1; it does not create filesystem locks. An agent that discovers material overlap with another active task must avoid broad conflicting edits where possible and checkpoint the risk.

## 14. Checkpoint discipline

Checkpoints are written after meaningful recoverable progress, not only at graceful session end.

A checkpoint must make these questions answerable by a zero-context successor:

- What task is this?
- Which lock generation owns it?
- Who currently owns that generation?
- Until when?
- Which branch contains durable work?
- What is already complete?
- What was actually verified?
- What remains?
- What exact action should happen next?
- Is anything blocked or waiting for a human?

Raw chain-of-thought, command transcripts, and verbose diaries are excluded.

Important implementation progress must be committed and pushed before a checkpoint claims it is durable.

## 15. Completion

Before completion, an agent must:

1. confirm it still owns the highest lock generation and has a valid lease;
2. evaluate every acceptance criterion;
3. run available relevant validation;
4. inspect the final diff;
5. push all durable implementation work;
6. create/update the task PR when the project uses PRs;
7. write a final checkpoint;
8. transition the Issue to done/closed;
9. leave lock generations for audit in v0.1.

Lock cleanup may be added later as maintenance but is not required for correctness.

## 16. Blocked and human-required work

`agent:blocked` means the task cannot currently progress because of an objective prerequisite or failure condition.

`agent:human-required` means progress requires a decision the agent must not guess, for example:

- destructive or irreversible action;
- ambiguous materially different product choices;
- unavailable credentials or permissions;
- merge/deploy approval required by repository policy.

The latest checkpoint must state the exact unblock condition or one precise human decision request.

A session may claim another independent ready Issue after it has checkpointed blocked/human-required state and stopped modifying the prior task branch.

## 17. Scheduled bootstrap prompt

The external scheduled task should remain small. The repository carries the protocol.

Reference prompt:

```text
Open the configured GitHub repository.
Read repository agent instructions and load the github-agent-continuity skill.
Recover project and task state entirely from GitHub and repository evidence.
Resume eligible interrupted work when appropriate; otherwise claim the next eligible ready task.
Continue autonomously while repository policy permits.
Persist recoverable progress to GitHub incrementally.
Do not depend on this conversation surviving the session.
```

## 18. Safety boundaries

The skill must not instruct autonomous agents to:

- expose secrets;
- weaken tests only to obtain passing CI;
- force-push shared branches;
- rewrite project history;
- bypass branch protections;
- merge/deploy when human authorization is required;
- infer permission from model confidence.

Repository-specific security/instruction files outrank the generic GAC skill.

## 19. Portability

The project must remain portable as a repository template:

- no external service configuration is required;
- no package installation is required;
- no project-language dependency is required;
- file paths are relative to repository root;
- GitHub-specific behavior is documented explicitly;
- users may copy the template files into an existing repository or create a repository from the standalone project later.

The temporary development path `github-agent-continuity/` is not part of the final standalone layout. When extracted, its contents become repository root.

## 20. Verification strategy

Because v0.1 is primarily a protocol/template, verification focuses on deterministic scenarios rather than unit-testing Markdown text.

Required scenario reviews:

1. **Cold start:** zero-context agent can identify the next eligible task.
2. **Interrupted session:** successor recovers branch progress from a checkpoint and repository evidence.
3. **Simultaneous initial claim:** only one concurrent creation of `agent-lock/issue-N-g1` succeeds.
4. **Simultaneous takeover:** after `gK` expires, only one concurrent creation of `g(K+1)` succeeds.
5. **Different tasks:** two sessions can own different Issues simultaneously.
6. **Expired lease:** a successor can recover abandoned work without discarding commits.
7. **Stale owner fencing:** an older generation must stop writing after a newer generation exists.
8. **Dependency:** blocked-by-dependency task is not selected early.
9. **Human gate:** a task requiring human decision is not guessed through.
10. **Conflict awareness:** overlapping shared scope is surfaced before broad edits.
11. **Durability:** checkpoint never claims unpushed progress as durable.
12. **Extraction:** copied project directory contains no dependency on MindRail paths, code, or concepts.

## 21. Planned v0.1 artifacts

Implementation will create:

- `README.md` — installation and operating overview;
- `.agents/skills/github-agent-continuity/SKILL.md` — executable agent procedure;
- `.agent/PROJECT.md` — project-memory template;
- `.agent/GOALS.md` — strategic-goal template;
- `.agent/DECISIONS.md` — durable-decision template;
- `.agent/README.md` — memory rules;
- `.github/ISSUE_TEMPLATE/agent-task.yml` — structured task template;
- `.github/pull_request_template.md` — handoff/integration template;
- `docs/PROTOCOL.md` — lifecycle and bootstrap protocol;
- `docs/STATE_MODEL.md` — authority and reconciliation rules;
- `docs/PARALLELISM.md` — claim/lease/recovery rules;
- `docs/SCHEDULED_PROMPT.md` — minimal scheduler prompt;
- `tests/SCENARIOS.md` — manual/conformance scenarios for v0.1.

## 22. Deferred questions

The following are explicitly deferred beyond v0.1:

- automated lock garbage collection;
- GitHub Actions conformance automation;
- multiple active tasks owned by one session;
- cryptographic owner identities;
- strict filesystem-level scope locking;
- cross-repository goals;
- non-GitHub adapters.
