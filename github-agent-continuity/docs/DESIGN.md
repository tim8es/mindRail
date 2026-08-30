# GitHub Agent Continuity — Design v0.1

**Status:** Approved for implementation
**Date:** 2026-08-30

## 1. Purpose

GitHub Agent Continuity (GAC) is a standalone, GitHub-only coordination layer for autonomous AI coding agents that work across short-lived, independent sessions.

A zero-context session must be able to recover project intent, current work, durable progress, blockers, and the next safe action using only repository and GitHub state. Conversation history is never authoritative.

GAC is independent of MindRail. The current repository is only a temporary host; the `github-agent-continuity/` directory is designed to become the root of a separate repository without importing MindRail code, schemas, runtime concepts, APIs, or ADRs.

## 2. Guarantee boundary

GAC provides **crash-tolerant cooperative coordination**, not a security boundary or Byzantine distributed lock.

It assumes agents follow the protocol and repository collaborators are trusted. Any actor with sufficient GitHub write permission can intentionally violate the protocol, update refs where repository policy permits, edit/delete Issue comments, or otherwise corrupt coordination state.

Within that trust model, GAC must prevent well-behaved concurrent sessions from accidentally owning the same generation, isolate stale-generation writes, recover abandoned work, and preserve durable evidence for a later session.

## 3. Goals

GAC v0.1 supports:

- durable long-term project context in repository files;
- GitHub Issues as the work queue;
- GitHub-native Issue dependencies as the dependency graph;
- recovery after session termination without conversation history;
- parallel work on independent Issues;
- atomic serialization of initial claims and takeovers through exact Git ref creation;
- immutable per-generation claim refs separated from implementation history;
- generation-specific work branches so stale writers cannot modify the current work branch by accident;
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

`.agent/` stores durable project knowledge/configuration. It is not a session log.

## 6. Configuration

`.agent/config.yml`:

```yaml
version: 1
base_branch: default
lease_ttl_minutes: 50
renewal_threshold_minutes: 15
finalization_margin_minutes: 10
claim_branch_prefix: gac-claim/issue-
work_branch_prefix: agent/issue-
```

`base_branch: default` resolves the repository's current default branch at runtime. The 50-minute lease default targets roughly hourly scheduling so a dead short session is normally recoverable by the next scheduled run.

## 7. Durable state ownership

| State | Authority |
|---|---|
| Project mission and boundaries | `.agent/PROJECT.md` |
| Strategic goals | `.agent/GOALS.md` |
| Durable project decisions | `.agent/DECISIONS.md` |
| Generic GAC behavior | `.agents/skills/github-agent-continuity/SKILL.md` |
| Task definition/acceptance criteria | GitHub Issue title/body |
| Dependency graph | GitHub native Issue dependencies |
| Task lifecycle | Issue open/closed state + `agent:*` labels |
| Current ownership generation | highest valid `gac-claim/issue-N-gK` ref |
| Owner, source, initial lease event | immutable claim commit referenced by that claim ref |
| Current durable implementation | matching `agent/issue-N-gK` work branch |
| Lease renewal/yield projection | valid structured Issue comments + GitHub `created_at` |
| Integration into project truth | Pull Request / authoritative base branch |
| Recovery summary | structured Issue checkpoint comments |
| Historical evidence | Git commits, claim refs, work refs, PRs, Issue history |

There is no monolithic `STATE.md`.

## 8. Why claim and work refs are separate

A claim commit must remain stable for owner/source/timestamp recovery, but implementation branches move as commits are pushed. If the claim commit lived in the implementation ancestry, repeated handoffs could also pollute base history with control-only claim commits when PRs are merge/rebase-integrated.

Therefore each generation uses two refs:

```text
claim: gac-claim/issue-42-g3  -> immutable empty claim commit
work:  agent/issue-42-g3      -> source + implementation commits
```

The exact claim ref creation is the ownership serialization point. The generation-specific work ref isolates stale writers. Claim commits never need to be ancestors of product work or enter the base branch.

## 9. State precedence and stop conditions

Repository-specific security/agent instructions outrank the generic skill.

A well-behaved agent stops implementation when any becomes true:

1. the Issue is closed, cancelled, blocked, or `agent:human-required`;
2. a higher valid claim generation exists;
3. the current generation lease expired or was yielded/terminated;
4. repository policy removes authority for the intended action.

A lease never overrides a human/repository stop. Actual GitHub evidence outranks checkpoint prose.

## 10. Task lifecycle

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
- `agent:active`: a current generation has a valid lease or is finalizing.
- `agent:blocked`: an objective prerequisite prevents progress.
- `agent:human-required`: one precise human decision/permission is required; the agent must not guess.
- `agent:done`: intended result is integrated into authoritative base (or an explicit non-code completion artifact exists) and the Issue is closed successfully.
- `agent:cancelled`: intentionally abandoned/cancelled; dependents must not treat it as successful delivery.

A coding task is not done merely because code is pushed, tests pass, or a PR is open.

## 11. Dependency model

GitHub native Issue dependencies are authoritative. Free-form dependency text may be shown for humans but is not machine authority.

A task is eligible only when every blocking dependency is semantically satisfied. For GAC-managed blockers this normally means closed with `agent:done` and not `agent:cancelled`.

A blocker closed with ambiguous outcome does not silently unblock dependent work.

## 12. Generational claim protocol

For Issue `#42` claim generations are:

```text
gac-claim/issue-42-g1
gac-claim/issue-42-g2
gac-claim/issue-42-g3
```

Matching work branches are:

```text
agent/issue-42-g1
agent/issue-42-g2
agent/issue-42-g3
```

The highest valid **claim** generation is current, even if its work branch has not yet been created.

### 12.1 Determine candidate generation

Use GitHub matching refs for the exact claim prefix and parse generation integers.

- no claim generation -> candidate `g1`;
- highest `gK` with active lease -> owned, do not claim;
- highest `gK` expired/yielded/terminated and Issue executable -> takeover candidate `g(K+1)`.

A malformed highest matching claim ref is corruption/namespace collision: fail closed rather than skipping it.

### 12.2 Determine takeover source

- initial claim: current authoritative base-branch HEAD;
- takeover: current previous-generation work HEAD if a valid work branch exists;
- if the prior work branch never existed, use the prior claim's `GAC-Source-Head`.

A previous work branch is valid only when it descends from the source recorded in its matching claim and has not been rewritten outside protocol.

### 12.3 Create candidate claim commit

Create an empty commit using the source tree and source commit as parent through GitHub Git Database API. Omit custom author/committer timestamps so GitHub supplies current authenticated identity/date.

Required trailers:

```text
GAC-Claim: v1
GAC-Issue: 42
GAC-Generation: 3
GAC-Owner: <globally-unique-session-id>
GAC-Base-Branch: <resolved-base-branch>
GAC-Source-Head: <source-sha>
GAC-Work-Branch: agent/issue-42-g3
```

Creating the candidate commit alone grants no authority.

### 12.4 Atomically create immutable claim ref

Create exactly:

```text
refs/heads/gac-claim/issue-42-g3 -> <candidate-claim-sha>
```

- `201`: candidate won, subject to read-back validation;
- conflict/already exists: re-read exact claim ref.

Lost-response recovery uses the claim owner: matching owner/session may recover its own successful claim; different owner means another session won. Do not jump to `g(K+1)` without reconciliation.

After creation the claim ref is immutable by protocol: never advance, rebase, or force-update it.

### 12.5 Create work ref after claim win

Only the winning claim owner may create:

```text
refs/heads/agent/issue-42-g3 -> <GAC-Source-Head>
```

The work ref begins directly at source, not at the claim commit. Product commits then advance the work branch normally.

If the owner crashes before work-ref creation, claim/lease remains recoverable. After expiry a successor can create the next claim from the prior claim source because no work was produced.

A conflicting pre-existing work ref that does not match protocol expectations is corruption and must fail closed.

## 13. Lease model

Ownership is highest valid claim generation + valid lease.

### Initial lease

The initial event is the GitHub-provided committer timestamp of the winning claim commit:

```text
lease_expires_at = claim_commit_server_time + lease_ttl
```

Local/session clocks and body timestamps are not authority.

### Renewal

A current owner renews with a structured `GAC CHECKPOINT v1` comment naming current Issue, generation, owner, claim ref, work branch, and pushed HEAD.

For authority use GitHub comment `created_at`. A checkpoint renews only when generation/owner match current claim, Issue remains executable, and comment is unedited (`created_at == updated_at`).

Edited/deleted comments may be human hints but are not trusted renewal events. This remains cooperative rather than tamper-proof coordination.

### Yield/termination

A valid current-generation disposition `yielded`, `blocked`, or `human-required` permanently ends that generation authority. A later comment cannot revive it. Continuation requires a new generation.

## 14. Checkpoint format

```text
GAC CHECKPOINT v1

Task: #42
Owner: <session-id>
Generation: 3
Disposition: active | yielded | blocked | human-required | finalizing
Claim ref: gac-claim/issue-42-g3
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

Checkpoint comments are recovery projections, not immutable authority records. Claimed durable progress must already exist on GitHub. Readers must handle pagination.

## 15. Recovery and stale-owner isolation

When `gK` expires/yields and a successor wins claim `g(K+1)`:

1. new source is previous work HEAD if valid, otherwise prior claim source;
2. new generation work branch starts from that source;
3. successor re-reads Issue, dependencies, old work, PRs, CI, and checkpoints;
4. older claim/work generations are permanently stale once a higher claim exists;
5. accidental stale pushes stay on old generation work branches and are ignored unless explicitly salvaged after review.

Never force-push/rebase generation work branches as normal GAC recovery behavior.

## 16. Parallel work and scope

Different Issues may execute concurrently. Task Issues declare advisory `Primary scope` and `Shared scope` paths. Material overlap is surfaced and minimized; scope is not a filesystem lock.

`.agent/**`, `.agents/**`, and GAC protocol/configuration files are shared control scope and require explicit Issue authorization to modify.

## 17. Session bootstrap

Every session:

1. reads repository-specific agent/security instructions;
2. reads config/project/goals/relevant decisions;
3. inspects active/blocked/human-required/ready Issues;
4. inspects native dependencies;
5. inspects matching claim refs and associated work refs;
6. recovers executable yielded/expired work when appropriate;
7. otherwise ranks eligible ready Issues;
8. claims exactly one primary Issue;
9. reconciles checkpoint prose with actual work/PR/CI state;
10. works/pushes in small coherent units;
11. renews or yields before losing authority.

Default ranking: dependency-unblocking value, current strategic goal, explicit priority, milestone priority, oldest eligible Issue.

## 18. Finalization

Before terminal transition:

1. confirm Issue remains executable;
2. confirm your claim generation is still highest;
3. ensure at least `finalization_margin_minutes` remains, renewing first if needed;
4. re-read Issue requirements and native dependencies;
5. re-read claim/work refs and current work HEAD;
6. evaluate every acceptance criterion;
7. run available validation and inspect final diff;
8. push intended work;
9. re-check highest claim and Issue state after push;
10. create a PR only when integration-ready;
11. merge only when repository policy permits autonomous merge.

Because claim commits are on separate immutable refs, the PR head is the work branch and control-only claim commits do not enter base history.

If merge requires human authorization, transition to `agent:human-required` with one precise request; do not mark done.

For coding tasks, `agent:done` is set only after intended work exists in authoritative base and the Issue is closed successfully.

If review requests new code after a PR exists, create a new generation from the latest intended work and supersede/close the stale PR when appropriate rather than sharing a permanent work branch.

## 19. Installation contract

Files travel in Git; labels/permissions are repository metadata and require one-time bootstrap.

Minimum capabilities for full protocol:

- repository contents/read;
- Git commit/ref creation and ref reads;
- Issues read/write and comment metadata;
- native Issue dependency read (write if allowed to manage graph);
- Pull Request read/write;
- CI/status reads required by repository policy.

Branch protection and repository policy remain authoritative.

## 20. Required conformance themes

Conformance scenarios in `tests/SCENARIOS.md` cover cold start, claim/takeover races, lost responses, both crash windows, stale writers, server-timed leases, edited comments, yield, recovery, dependency success/cancellation, requirement drift, finalization races, PR-not-done semantics, human gates, shared-scope conflicts, unpushed checkpoint mismatch, pagination, malformed namespaces, control-file scope, extraction, missing claim primitives, blocked-resume generations, and claim metadata exclusion from base history.

Documentation review may show the protocol addresses a scenario; runtime PASS requires an executed GitHub/API exercise.

## 21. Deferred beyond v0.1

Automated old-generation garbage collection, GitHub Actions conformance, multi-primary-task sessions, cryptographic owner identities, filesystem-level locking, cross-repository goals, non-GitHub adapters, and adversarial writer protection are deferred.
