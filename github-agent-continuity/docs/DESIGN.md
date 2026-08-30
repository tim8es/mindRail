# GitHub Agent Continuity — Design v0.1

**Status:** Approved for implementation
**Date:** 2026-08-30

## 1. Purpose

GitHub Agent Continuity (GAC) is a standalone, GitHub-only coordination layer for autonomous AI coding agents that work across short-lived, independent sessions.

A zero-context session must be able to recover project intent, current work, durable progress, blockers, and the next safe action using only repository and GitHub state. Conversation history is never authoritative.

GAC is independent of MindRail. The current repository is only a temporary host; the `github-agent-continuity/` directory is designed to become the root of a separate repository without importing MindRail code, schemas, runtime concepts, APIs, or ADRs.

## 2. Guarantee boundary

GAC provides **crash-tolerant cooperative coordination**, not a security boundary or Byzantine distributed lock.

It assumes agents follow the protocol and repository collaborators are trusted. Any actor with sufficient GitHub write permission can intentionally violate the protocol, rewrite permitted refs, edit/delete Issue comments, or otherwise corrupt coordination state.

Within that trust model, GAC must prevent well-behaved concurrent sessions from accidentally owning the same generation, isolate stale-generation writes, recover abandoned work, and preserve enough durable evidence for the next session to continue.

## 3. Goals

GAC v0.1 supports:

- durable long-term project context in repository files;
- GitHub Issues as the work queue;
- GitHub-native Issue dependencies as the dependency graph;
- recovery after session termination without conversation history;
- parallel work on independent Issues;
- atomic serialization of initial claims and takeovers through Git ref creation;
- generation-specific work branches so stale writers cannot modify the current generation branch by accident;
- expiring and renewable leases based on GitHub server timestamps;
- structured checkpoints as human-readable recovery projections;
- explicit blocked, human-required, done, and cancelled states;
- integration through Pull Requests;
- a small scheduled-session bootstrap prompt;
- no external database, runtime service, package, or project-language dependency.

## 4. Non-goals

GAC v0.1 is not a general distributed database, sub-minute scheduler, IAM system, secret manager, CI replacement, model-vendor integration, automatic merge-conflict solver, cross-repository orchestrator, or protection against malicious repository writers.

The target workload is autonomous sessions running for minutes and restarting on a coarse cadence such as hourly scheduled tasks.

## 5. Standalone repository layout

```text
.agents/
└── skills/
    └── github-agent-continuity/
        └── SKILL.md

.agent/
├── config.yml
├── PROJECT.md
├── GOALS.md
├── DECISIONS.md
└── README.md

.github/
├── ISSUE_TEMPLATE/
│   └── agent-task.yml
└── pull_request_template.md

docs/
├── DESIGN.md
├── PROTOCOL.md
├── STATE_MODEL.md
├── PARALLELISM.md
├── INSTALLATION.md
└── SCHEDULED_PROMPT.md

tests/
└── SCENARIOS.md

README.md
```

`.agent/` stores durable project knowledge and configuration. It is not a session log.

## 6. Configuration

`.agent/config.yml` provides repository-local defaults:

```yaml
version: 1
base_branch: default
lease_ttl_minutes: 50
renewal_threshold_minutes: 15
finalization_margin_minutes: 10
branch_prefix: agent/issue-
```

`base_branch: default` resolves the repository's current default branch at runtime. The 50-minute lease default is chosen for an hourly scheduler so an unexpectedly terminated short session becomes recoverable by the next scheduled run.

## 7. Durable state ownership

| State | Authority |
|---|---|
| Project mission and boundaries | `.agent/PROJECT.md` |
| Strategic goals | `.agent/GOALS.md` |
| Durable project decisions | `.agent/DECISIONS.md` |
| Generic GAC behavior | `.agents/skills/github-agent-continuity/SKILL.md` |
| Task definition and acceptance criteria | GitHub Issue title/body |
| Dependency graph | GitHub native Issue dependencies |
| Task lifecycle | Issue open/closed state + `agent:*` labels |
| Current ownership generation | Highest existing `agent/issue-N-gK` ref |
| Owner identity and initial lease event | Claim commit at the root of that generation |
| Lease renewal/yield projection | Valid structured Issue comments + GitHub `created_at` |
| Durable implementation work | Current generation branch commits |
| Integration into project truth | Pull Request / authoritative base branch |
| Recovery summary | Structured Issue checkpoint comments |
| Historical evidence | Git commits, refs, PRs, Issue history |

There is no monolithic `STATE.md`.

## 8. State precedence and stop conditions

Repository-specific security and agent instructions outrank this generic skill.

For a task, a well-behaved agent must stop modifying implementation when any of these becomes true:

1. the Issue is closed, cancelled, blocked, or marked `agent:human-required`;
2. a higher ownership generation exists;
3. the current generation lease expired or was explicitly yielded;
4. repository policy removes authority for the intended action.

A lease never authorizes an agent to ignore human/repository stop state. Actual GitHub repository evidence outranks checkpoint prose.

## 9. Task lifecycle

Required labels:

```text
agent:ready
agent:active
agent:blocked
agent:human-required
agent:done
agent:cancelled
```

Semantics:

- `agent:ready`: open and eligible after dependency checks.
- `agent:active`: a current generation has a valid lease or is in active finalization.
- `agent:blocked`: an objective prerequisite prevents progress.
- `agent:human-required`: one precise human decision/permission is required; the agent must not guess.
- `agent:done`: intended result is integrated into the authoritative base branch (or the Issue documents a completed non-code outcome) and the Issue is closed.
- `agent:cancelled`: work is intentionally abandoned/cancelled; dependents must not treat cancellation as successful delivery.

A coding task is not `done` merely because code is pushed, tests pass, or a PR is open.

## 10. Dependency model

GitHub native Issue dependencies are authoritative. Free-form `Depends on:` text may be displayed for humans but is not the machine authority.

A task is eligible only when every blocking dependency is semantically satisfied. For GAC-managed dependencies this normally means the blocking Issue is closed with `agent:done` and not `agent:cancelled`.

If a dependency closes without an unambiguous successful terminal state, a dependent task must not guess.

## 11. Generation branch and atomic claim

For Issue `#42`, generations are:

```text
agent/issue-42-g1
agent/issue-42-g2
agent/issue-42-g3
```

The highest generation ref is the current ownership generation. The generation branch is both ownership isolation boundary and durable work branch; there is no shared task work branch.

### Determine the candidate

Use GitHub matching refs for the exact Issue prefix and parse generation integers rather than relying on a repository-wide branch page.

- no generation -> candidate `g1`;
- highest `gK` with active lease -> do not claim;
- highest `gK` expired/yielded -> candidate `g(K+1)`.

### Choose the source

- initial claim: current authoritative base-branch HEAD;
- takeover: previous generation HEAD read immediately before constructing the claim.

### Create the claim commit

Construct an empty claim commit using the source tree and source commit as parent. Create it through GitHub's Git Database API with author/committer timestamps omitted so GitHub supplies the authenticated identity/current date.

Required trailers:

```text
GAC-Claim: v1
GAC-Issue: 42
GAC-Generation: 3
GAC-Owner: <globally-unique-session-id>
GAC-Base-Branch: <resolved-base-branch>
GAC-Source-Head: <source-sha>
```

### Atomically create the generation ref

Create exactly:

```text
refs/heads/agent/issue-42-g3 -> <claim-commit-sha>
```

Ref creation is the serialization point.

- `201`: session owns the generation;
- conflict/already exists: another session won; discard the dangling candidate commit, re-read state, and do not modify task work.

A crash before ref creation creates no ownership. A crash after ref creation still leaves owner and initial lease metadata in the referenced claim commit.

## 12. Lease model

Ownership is generation + lease.

### Initial lease

The initial lease event time is the GitHub-provided committer timestamp of the winning claim commit:

```text
lease_expires_at = claim_commit_server_time + lease_ttl
```

Local/session clocks are not authoritative.

### Renewal

A current owner renews by posting `GAC CHECKPOINT v1` naming the current Issue, generation, owner, branch, and HEAD.

For lease authority use the comment's GitHub `created_at`, not a timestamp written in the body. A checkpoint counts as renewal only when generation and owner match the current claim, the Issue remains executable, and the comment has not been edited (`created_at == updated_at`).

Edited/deleted comments may remain useful as human context but are not trusted renewal events. Repository writers can still delete events, so this remains cooperative coordination rather than tamper-proof storage.

### Yield

A current owner may terminate ownership early with a valid checkpoint disposition `yielded`, `blocked`, or `human-required`. The owner must stop writing immediately after publishing it. A successor may then create `g(K+1)` without waiting for TTL expiry once the task is executable.

## 13. Checkpoint format

```text
GAC CHECKPOINT v1

Task: #42
Owner: <session-id>
Generation: 3
Disposition: active | yielded | blocked | human-required | finalizing
Work branch: agent/issue-42-g3
HEAD: <durable-pushed-sha>
Completed:
- ...
Verified:
- ...
Remaining:
- ...
Next action: <one concrete executable action>
Blockers: none | <exact blocker>
Human decision required: none | <one precise decision>
```

Checkpoint comments are recovery projections, not immutable authority records. Progress claimed as durable must already be pushed. Readers must inspect all relevant paginated comments rather than assuming the first page contains the latest valid checkpoint.

## 14. Recovery and stale-owner fencing

When `gK` expires/yields and a successor wins `g(K+1)`:

1. `g(K+1)` starts from the previous generation HEAD observed at takeover;
2. the successor re-reads Issue, dependencies, PRs, CI, commits, and checkpoints;
3. it continues durable work instead of restarting it;
4. every older generation is permanently stale once a higher generation exists;
5. accidental stale pushes remain isolated on old branches and are ignored unless a later owner explicitly salvages them.

Never force-push a generation branch as normal recovery behavior.

## 15. Parallel work and scope

Parallel sessions may own different Issues. Task Issues declare advisory `Primary scope` and `Shared scope` paths. Scope is not a filesystem lock; material overlap is an integration risk that must be surfaced.

`.agent/**`, `.agents/**`, and GAC protocol/config files are control-plane/shared scope. Ordinary implementation tasks must not modify them unless their Issue explicitly authorizes it.

## 16. Session bootstrap

Every new session:

1. reads repository agent/security instructions;
2. reads `.agent/config.yml`, project/goals, and relevant decisions;
3. inspects active/blocked/human-required/ready Issues;
4. inspects native Issue dependencies;
5. inspects matching generation refs;
6. recovers executable yielded/expired work when appropriate;
7. otherwise ranks eligible ready Issues;
8. claims exactly one primary Issue through the generation protocol;
9. reconciles checkpoint prose with actual branch/PR/CI state;
10. executes and pushes small coherent progress;
11. renews or yields before losing authority.

Default ranking: dependency-unblocking value, current strategic goal, explicit priority, milestone priority, then oldest eligible Issue.

## 17. Finalization

Before a terminal transition the owner must:

1. confirm it still owns the highest generation;
2. ensure at least `finalization_margin_minutes` remains, renewing first if necessary;
3. re-read Issue title/body and native dependencies to detect requirement changes;
4. re-read generation ref/HEAD and relevant repository state;
5. evaluate every acceptance criterion;
6. run available validation and inspect the final diff;
7. push all intended durable work;
8. re-check generation and Issue executable state after the push;
9. create a Pull Request only when implementation is ready for integration;
10. merge only when repository policy permits autonomous merge.

If merge requires human authorization, transition to `agent:human-required` with one precise request; do not mark done.

For coding tasks, `agent:done` is set only after intended work is present in the authoritative base branch and the Issue is closed.

If review later requires new code after a PR exists, create a new generation from the latest intended work and supersede/close the stale PR when appropriate. v0.1 intentionally avoids a permanent shared PR branch because it would reintroduce stale-writer risk.

## 18. Blocked, human-required, cancelled

A blocked/human-required checkpoint ends the lease early and the owner stops editing. `agent:cancelled` is terminal failure/abandonment, not successful dependency completion.

The scheduler should re-check blocked/human-required tasks for changed external state before selecting new work, but must not repeatedly retry a deterministic blocker with no new evidence.

## 19. Installation contract

Files travel in Git; labels and permissions are repository metadata and therefore require one-time bootstrap after installing the template.

Minimum capabilities for the full protocol:

- repository contents read;
- repository contents/Git commit/ref write;
- Issues read/write for labels and checkpoint comments;
- Pull Request read/write for integration;
- Issue dependency read, and write when the agent is allowed to manage dependencies.

Branch protection and repository policy remain authoritative and may intentionally require human merge/deploy approval.

## 20. Scheduled bootstrap prompt

```text
Open the configured GitHub repository.
Read repository agent instructions and load the github-agent-continuity skill.
Recover project and task state entirely from GitHub and repository evidence.
Resume eligible interrupted work when appropriate; otherwise claim the next eligible ready task.
Continue autonomously while repository policy permits.
Persist recoverable progress incrementally.
Renew or yield ownership before losing authority.
Do not depend on this conversation surviving the session.
```

## 21. Required conformance scenarios

1. cold start chooses an eligible task;
2. simultaneous initial claim produces one `g1` winner;
3. simultaneous takeover produces one `g(K+1)` winner;
4. stale generation writes stay isolated;
5. crash before ref creation leaves no ownership;
6. crash after ref creation preserves owner/time metadata;
7. lease uses GitHub timestamps rather than body/local timestamps;
8. edited checkpoint is rejected as renewal;
9. graceful yield allows immediate takeover;
10. recovery starts from prior durable HEAD;
11. dependency requires successful terminal state;
12. cancelled dependency does not silently unblock work;
13. requirements are re-read before finalization;
14. takeover/finalization race cannot authorize both generations;
15. open PR alone is not done;
16. human gate is not guessed through;
17. overlapping shared scope is surfaced;
18. checkpoint never claims unpushed progress;
19. pagination cannot hide highest generation/newest checkpoint;
20. extracted project has no MindRail dependency.

## 22. Deferred beyond v0.1

Automated old-generation garbage collection, GitHub Actions conformance, multi-primary-task sessions, cryptographic owner identities, filesystem-level locking, cross-repository goals, non-GitHub adapters, and adversarial writer protection are deferred.
