# GitHub Agent Continuity — Design v0.1

**Status:** Implemented; runtime concurrency verification pending standalone smoke test  
**Date:** 2026-08-30

## 1. Purpose

GitHub Agent Continuity (GAC) is a standalone GitHub-only coordination layer for autonomous AI coding agents working across disposable, independent sessions.

A zero-context successor must reconstruct project intent, eligible work, current ownership, durable progress, blockers, and the next safe action using repository and GitHub evidence only. Conversation history is never authoritative.

The prototype currently lives under `github-agent-continuity/` in another repository, but that directory is designed to become the root of an independent repository without host-project code, schemas, runtime services, or architecture dependencies.

## 2. Guarantee boundary

GAC provides **crash-tolerant cooperative coordination**.

It is not an IAM system, adversarial distributed lock, Byzantine consensus protocol, secret manager, CI replacement, or protection from a malicious collaborator with sufficient GitHub write permission.

Within the cooperative model, GAC aims to:

- serialize competing claims for one Issue;
- isolate stale-session implementation writes;
- recover abandoned pushed work;
- preserve enough durable evidence for a later zero-context session;
- allow independent Issues to execute in parallel.

Repository permissions, rulesets, branch protection, CODEOWNERS, environments, and human approval remain the actual security boundary.

## 3. Standalone layout

```text
.agents/skills/github-agent-continuity/SKILL.md
.agent/config.yml
.agent/PROJECT.md
.agent/GOALS.md
.agent/DECISIONS.md
.agent/README.md
.github/ISSUE_TEMPLATE/agent-task.yml
.github/pull_request_template.md
docs/DESIGN.md
docs/PROTOCOL.md
docs/STATE_MODEL.md
docs/PARALLELISM.md
docs/INSTALLATION.md
docs/SCHEDULED_PROMPT.md
tests/SCENARIOS.md
README.md
```

`.agent/**` is durable project memory/configuration, not operational session state.

## 4. Configuration

Default `.agent/config.yml`:

```yaml
version: 1
base_branch: default
lease_ttl_minutes: 50
renewal_threshold_minutes: 15
finalization_margin_minutes: 10
clock_skew_grace_minutes: 5
claim_branch_prefix: gac-claim/issue-
work_branch_prefix: agent/issue-
```

`base_branch: default` resolves the repository default branch at runtime.

The defaults target roughly hourly scheduled sessions. `clock_skew_grace_minutes` is used only when the agent cannot obtain trustworthy current GitHub/server time: local time may declare a lease expired only after the normal expiry plus this grace. It never extends the current owner's execution authority.

## 5. State ownership

| Fact | Authority |
|---|---|
| Project mission/boundaries | `.agent/PROJECT.md` |
| Strategic goals | `.agent/GOALS.md` |
| Durable decisions | `.agent/DECISIONS.md` or stronger linked repository authority |
| Generic worker procedure | `.agents/skills/github-agent-continuity/SKILL.md` |
| Task outcome/acceptance criteria | GitHub Issue title/body |
| Dependency graph | GitHub native Issue dependencies |
| Human/task stop state | Issue open/closed state + `agent:*` labels |
| Current ownership generation | highest valid `gac-claim/issue-N-gK` ref |
| Generation owner/source/work-name | immutable claim commit referenced by claim ref |
| Initial lease event | GitHub claim-commit committer timestamp |
| Renewal/yield events | valid unedited structured Issue comments + GitHub `created_at` |
| Current implementation | matching `agent/issue-N-gK` work branch |
| Integration completion | authoritative base branch / merged PR |
| Recovery summary | structured checkpoint comments reconciled against stronger evidence |

There is intentionally no shared operational `STATE.md`.

## 6. Claim/work separation

Each generation has two refs:

```text
claim: gac-claim/issue-42-g3 -> immutable empty metadata commit
work:  agent/issue-42-g3     -> source + implementation commits
```

The exact next claim-ref creation is the ownership serialization point. The work branch begins directly at the recorded source SHA rather than at the claim commit.

This separation provides two properties:

1. a stale generation writes to a different work branch from the current generation;
2. GAC control-only claim commits do not enter normal PR/base history.

A work branch by itself never grants authority.

## 7. Claim protocol

For Issue `#42`, claim generations are `gac-claim/issue-42-g1`, `g2`, ... .

A contender:

1. discovers the highest exact claim generation across complete/matching ref results;
2. determines whether it is active, expired, yielded, or terminated;
3. chooses the next exact generation only when takeover is allowed;
4. chooses source: base HEAD for `g1`, otherwise previous valid work HEAD, falling back to prior claim source if no work branch was ever created;
5. creates an empty candidate claim commit with the source tree and source as parent;
6. records trailers including Issue, generation, unique owner ID, base branch, source SHA, and expected work branch;
7. atomically creates the exact immutable claim ref;
8. reads the ref/claim back before treating ownership as established;
9. creates/reads the matching work branch from the recorded source.

Candidate commits that never receive the exact claim ref are non-authoritative.

If exact claim creation conflicts or its response is lost, the contender re-reads the exact ref. It must not jump to another generation merely because the call did not return success locally.

Malformed highest claim state fails closed.

## 8. Lease protocol

Ownership requires both:

```text
highest valid claim generation
+
valid lease
```

Initial lease time is the GitHub-provided claim-commit timestamp.

Valid `active` or `finalizing` checkpoints renew from GitHub comment `created_at`. `yielded`, `blocked`, and `human-required` terminate that generation immediately. Edited checkpoint comments (`updated_at != created_at`) are not lease-authoritative.

```text
lease_expires_at = latest_effective_event_time + lease_ttl_minutes
```

To judge expiry, prefer trustworthy GitHub/server current time. If unavailable, local/session time may be used only for takeover with `clock_skew_grace_minutes` added. Body-provided timestamps never extend authority.

An expired or terminated generation cannot reactivate itself. Continuation always uses a new generation.

## 9. Checkpoint contract

```text
GAC CHECKPOINT v1

Task: #42
Owner: <session-id>
Generation: 3
Disposition: active | finalizing | yielded | blocked | human-required
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

Checkpoint prose is a recovery projection, not immutable truth. A checkpoint must never claim unpushed implementation as durable. Readers must handle comment pagination.

## 10. Task lifecycle and dependencies

Required labels:

```text
agent:ready
agent:active
agent:blocked
agent:human-required
agent:done
agent:cancelled
```

GitHub native Issue dependencies are authoritative for graph edges.

For a normal GAC-managed coding blocker, successful dependency completion means the blocker is closed successfully, carries `agent:done`, is not cancelled, and its intended result exists in authoritative base.

An open PR, green tests on a work branch, manual closure, or `agent:cancelled` does not automatically satisfy dependents.

## 11. Parallelism and stale writers

Different Issues may own different generations concurrently.

Same-Issue stale generations are fenced cooperatively by the highest claim generation. Generation-specific work names additionally isolate accidental stale pushes:

```text
stale:   agent/issue-42-g2
current: agent/issue-42-g3
```

An old session can still push to its stale branch if it ignores protocol and permissions allow it; GAC cannot prevent a malicious writer. Current owners never auto-import stale commits solely because they are newer in wall-clock time.

Issue `Primary scope` and `Shared scope` are advisory conflict signals, not filesystem locks.

## 12. Session bootstrap

Before implementation writes every session:

1. reads repository-specific agent/security instructions;
2. reads config, project, goals, and only relevant durable decisions;
3. inspects active/blocked/human-required/ready Issues;
4. inspects native dependencies;
5. inspects matching claim refs, work refs, PR/CI state, and relevant checkpoints;
6. reconciles projections against repository evidence;
7. recovers an eligible yielded/expired task when appropriate, otherwise ranks eligible ready work;
8. claims exactly one primary Issue.

Default ranking: dependency-unblocking value, strategic goal, explicit priority, milestone priority, then oldest eligible Issue.

## 13. Work, yield, recovery

While authority remains valid, the owner makes small coherent changes, validates, pushes to the generation work branch, re-checks authority before consequential writes, and checkpoints meaningful durable progress.

A graceful scheduled session should push and post `Disposition: yielded` before ending so the next session can take over immediately. TTL expiry is the crash path.

Takeover starts from the previous valid work HEAD. If the previous owner crashed before work-ref creation, takeover uses the prior claim source.

## 14. Finalization

Before terminal transition the owner:

1. confirms Issue remains executable;
2. confirms its claim generation is still highest;
3. ensures sufficient lease margin, renewing first when needed;
4. re-fetches Issue requirements and native dependencies;
5. evaluates every acceptance criterion;
6. runs available validation and inspects final diff;
7. pushes intended work;
8. re-checks highest claim and Issue stop state after the push;
9. creates a PR from the **work branch** only when integration-ready.

A coding task becomes `agent:done` only after the intended result exists in authoritative base and the Issue is closed successfully.

If merge/review requires a human, use `agent:human-required` with one precise request. A later session may perform idempotent metadata reconciliation after conclusive external action, but any new code requires a new generation.

## 15. Installation contract

The target agent/tool integration must be able to read repository/Issues/dependencies/comments/PR/CI state and must expose exact Git commit/ref creation plus read-back for full parallel claim semantics.

If exact claim primitives are unavailable, GAC must not approximate ownership with labels or comments. Concurrent autonomous claims are disabled until the capability exists.

Labels/settings/permissions are repository metadata and require one-time bootstrap outside this prototype branch.

## 16. Verification boundary

`tests/SCENARIOS.md` is a conformance specification. Documentation review can establish internal consistency, but runtime claims such as simultaneous-claim exclusivity, crash recovery, and takeover behavior require executed GitHub/API scenarios in a disposable/standalone repository.

The prototype intentionally does not create GAC labels or test claim refs in the temporary host repository because repository metadata and refs are not isolated by the prototype directory.

## 17. Deferred beyond v0.1

Deferred: automated old-generation garbage collection, automated conformance via GitHub Actions, multiple primary tasks per session, cryptographic owner identity, filesystem locks, cross-repository goals, non-GitHub adapters, and adversarial-writer protection.
