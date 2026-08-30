# GAC State Model v0.1

This document defines where state lives and how a zero-context session resolves contradictions.

## 1. Principles

1. GitHub/repository evidence is durable; conversation history is not.
2. Long-lived project memory and operational task state are separate.
3. One source should own each fact whenever possible.
4. Human/repository stop state overrides execution lease.
5. Highest generation determines current ownership lineage.
6. Checkpoint prose summarizes reality; it does not redefine repository reality.

## 2. Authority map

| Fact | Authoritative source |
|---|---|
| Repository security/execution policy | repository-specific instruction/security files |
| GAC timing/naming defaults | `.agent/config.yml` |
| Project mission/boundaries | `.agent/PROJECT.md` |
| Strategic direction | `.agent/GOALS.md` |
| Durable cross-session decisions | `.agent/DECISIONS.md` or stronger repository authority linked from it |
| Task title/outcome/acceptance criteria | GitHub Issue title/body |
| Blocking graph | GitHub native Issue dependencies |
| Human/task terminal stop state | Issue open/closed + `agent:*` labels |
| Current ownership generation | highest valid matching generation ref |
| Generation owner/source | generation claim commit |
| Initial lease time | GitHub claim-commit committer timestamp |
| Renewal/yield event time | GitHub Issue-comment `created_at` for a valid unedited GAC event |
| Current implementation | current generation branch HEAD/tree |
| Verification evidence | actual project/CI results, not checkpoint claims alone |
| Integration completion | authoritative base branch / merged PR |
| Recovery summary | latest relevant structured checkpoint, reconciled against all above |

## 3. Control state vs work state

### Durable control memory

`.agent/**` should change rarely. It contains project-wide context that remains useful across many tasks.

Do not store operational fields such as:

- current Issue number;
- session owner;
- active lease;
- current generation;
- last checkpoint;
- temporary blocker;
- current branch HEAD.

Those facts already live in GitHub and duplicating them in a shared file creates conflict/staleness.

### Operational work state

Operational state is distributed across native GitHub objects:

```text
Issue          -> desired task/lifecycle
Dependencies   -> ordering
Generation ref -> current ownership lineage
Claim commit   -> owner + source + initial lease event
Generation git -> durable implementation
Issue comments -> renewal/yield + recovery summary
PR/base        -> integration result
```

## 4. Generation validity

A branch matching the configured GAC naming pattern is a valid generation only when its claim commit validates all of:

- `GAC-Claim: v1` exists;
- `GAC-Issue` equals branch Issue number;
- `GAC-Generation` equals branch generation;
- owner is non-empty;
- base branch is non-empty;
- source SHA equals claim parent;
- claim tree equals source tree (empty metadata commit).

A malformed highest matching generation is a corruption/collision condition. Fail closed; do not skip it and silently use an older generation.

## 5. Lease state machine per generation

A generation starts in `ACTIVE` at claim commit server time.

```text
ACTIVE
  | active/finalizing checkpoint -> ACTIVE (lease renewed)
  | TTL expires                  -> EXPIRED
  | yielded checkpoint           -> YIELDED
  | blocked checkpoint           -> BLOCKED
  | human-required checkpoint    -> HUMAN_REQUIRED
  | higher generation appears    -> STALE

EXPIRED/YIELDED/BLOCKED/HUMAN_REQUIRED
  | higher generation appears    -> STALE

STALE -> terminal forever
```

A generation that expired or published a terminating disposition cannot reactivate itself with a later comment. Continuation is a new generation.

## 6. Issue projection repair

Labels are useful UI but are not the mutex. When label state disagrees with stronger evidence, an authorized agent may repair the projection.

Examples:

- `agent:ready` + valid active highest lease -> repair to `agent:active`.
- `agent:active` + expired highest lease -> task is recoverable; label may stay active until takeover or be repaired according to repository convention.
- closed Issue + active lease -> closed Issue is a stop condition; the generation cannot keep executing.
- `agent:human-required` + active lease -> human-required stops execution; lease does not override it.

Do not repair a human terminal state merely to make it agree with a stale checkpoint.

## 7. Checkpoint reconciliation

A checkpoint may claim `HEAD: abc`, `Verified: tests pass`, and `Next action: ...`.

A successor must verify:

1. referenced branch/generation still exists and is current/relevant;
2. referenced HEAD exists on the expected generation lineage;
3. any claimed durable change is actually pushed;
4. test/CI status is current enough for the next action;
5. Issue requirements/dependencies have not changed materially.

If checkpoint prose conflicts with repository evidence, repository evidence wins and the successor writes a corrected checkpoint once it has authority.

## 8. Comment trust model

Issue comments are editable/deletable and therefore are not immutable audit records.

For lease semantics:

- only structurally valid current-generation comments are considered;
- `created_at` is the event time;
- body-provided timestamps are ignored;
- edited comments (`updated_at != created_at`) are excluded from lease authority;
- deletion can remove renewal evidence, which is one reason GAC is cooperative rather than tamper-proof.

For recovery prose, edited comments may still be useful as non-authoritative hints.

## 9. Dependency semantics

Native GitHub dependencies own graph edges. GAC adds success semantics:

- blocker closed + `agent:done` -> satisfied;
- blocker `agent:cancelled` -> not successful; dependent must not auto-run;
- blocker open/blocked/human-required/active/ready -> unsatisfied;
- blocker closed with ambiguous GAC outcome -> human resolution required for dependent execution.

This prevents a manually cancelled/abandoned prerequisite from being mistaken for delivered functionality.

## 10. Base branch and done

For coding work, the base branch is the final integration truth.

`agent:done` requires:

- intended result present in authoritative base branch;
- required repository validation/review policy satisfied;
- Issue closed as completed;
- not cancelled.

A generation branch or open PR alone is insufficient.

For non-code tasks where no merge is meaningful, the Issue must explicitly define the durable completion artifact/outcome before `agent:done` can be used.

## 11. Concurrent control-file edits

`.agent/**`, `.agents/**`, `.github/**` GAC templates, and `docs/*` GAC protocol files are shared control scope. Parallel ordinary task agents should not modify them unless specifically authorized.

If two control-plane tasks must run concurrently, their Issues should declare overlap explicitly and integration should be serialized through review rather than assuming conflict-free merge.

## 12. Recovery precedence checklist

When state appears inconsistent, answer in this order:

1. What repository policy/security instructions apply?
2. Is the Issue open and executable, or is there a human/terminal stop?
3. What is the highest valid generation ref?
4. Who owns its claim commit and from which source HEAD?
5. Is that generation active, expired, yielded, or terminated using server-timed events?
6. What is actually pushed on the generation branch?
7. What do PR/base/CI results say?
8. What do checkpoint summaries add that repository evidence does not already prove?

Never reverse this order merely because a checkpoint is easier to read.
