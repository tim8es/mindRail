# GAC State Model v0.1

This document defines where state lives and how a zero-context session resolves contradictions.

## 1. Principles

1. GitHub/repository evidence is durable; conversation history is not.
2. Long-lived project memory and operational task state are separate.
3. One source should own each fact whenever possible.
4. Human/repository stop state overrides execution lease.
5. Highest valid **claim generation** determines current ownership lineage.
6. Claim refs and work refs have different responsibilities.
7. Checkpoint prose summarizes reality; it does not redefine repository reality.

## 2. Authority map

| Fact | Authoritative source |
|---|---|
| Repository security/execution policy | repository-specific instruction/security files |
| GAC timing/naming defaults | `.agent/config.yml` |
| Project mission/boundaries | `.agent/PROJECT.md` |
| Strategic direction | `.agent/GOALS.md` |
| Durable cross-session decisions | `.agent/DECISIONS.md` or stronger linked authority |
| Task title/outcome/acceptance criteria | GitHub Issue title/body |
| Blocking graph | GitHub native Issue dependencies |
| Human/task terminal stop state | Issue open/closed + `agent:*` labels |
| Current ownership generation | highest valid `gac-claim/issue-N-gK` ref |
| Generation owner/source/work-name | immutable claim commit referenced by that claim ref |
| Initial lease time | GitHub claim-commit committer timestamp |
| Renewal/yield event time | GitHub Issue-comment `created_at` for valid unedited event |
| Current implementation | matching `agent/issue-N-gK` work branch HEAD/tree |
| Verification evidence | actual project/CI results, not checkpoint claims alone |
| Integration completion | authoritative base branch / merged PR |
| Recovery summary | latest relevant structured checkpoint reconciled against stronger evidence |

## 3. Control state vs operational state

`.agent/**` should change rarely. Do not store current Issue, owner, lease, generation, checkpoint, temporary blocker, or current HEAD there.

Operational state is distributed across GitHub objects:

```text
Issue            -> desired task/lifecycle
Dependencies     -> ordering
Immutable claim  -> generation + owner + source + initial lease
Generation work  -> durable implementation
Issue comments   -> renewal/yield + recovery projection
PR/base          -> integration result
```

This avoids a hot shared `STATE.md` that parallel sessions would race to edit.

## 4. Claim-ref validity

A ref matching configured claim naming is a valid claim generation only when its referenced commit validates all of:

- `GAC-Claim: v1`;
- `GAC-Issue` equals ref Issue number;
- `GAC-Generation` equals ref generation;
- `GAC-Work-Branch` equals configured work branch for same Issue/generation;
- owner/base/source are non-empty;
- source SHA equals claim parent;
- claim tree equals source tree (empty metadata commit).

A valid claim ref is immutable by protocol after creation.

A malformed highest matching claim is corruption/namespace collision. Fail closed; do not silently use an older generation.

## 5. Work-ref validity

A work branch is operational implementation state, not ownership authority.

For generation K it must:

- have exact configured work name for Issue/generation;
- correspond to an existing valid matching claim generation;
- equal or descend from that claim's `GAC-Source-Head`;
- preserve that source ancestry under normal operation (no rebase/force rewrite).

The work branch starts at source itself, not at claim commit. Therefore claim metadata does not need to enter PR/base history.

If claim exists but work ref does not, ownership can still be active; the winner may create work ref. If it crashes, a successor can recover after lease expiry using the prior claim source.

A work branch without a valid matching claim grants no GAC authority.

## 6. Lease state machine per claim generation

A claim generation starts `ACTIVE` at claim commit server time.

```text
ACTIVE
  | active/finalizing checkpoint -> ACTIVE (lease renewed)
  | TTL expires                  -> EXPIRED
  | yielded checkpoint           -> YIELDED
  | blocked checkpoint           -> BLOCKED
  | human-required checkpoint    -> HUMAN_REQUIRED
  | higher claim appears         -> STALE

EXPIRED/YIELDED/BLOCKED/HUMAN_REQUIRED
  | higher claim appears         -> STALE

STALE -> terminal forever
```

A generation that expired or published a terminating disposition cannot reactivate itself. Continuation requires a new claim/work generation.

## 7. Issue projection repair

Labels are UI projections, not mutexes.

Examples:

- `agent:ready` + valid active highest claim -> repair toward `agent:active` if permitted.
- `agent:active` + expired highest claim -> task is recoverable; projection may be repaired.
- closed Issue + active lease -> Issue stop state wins; execution stops.
- `agent:human-required` + active lease -> human-required wins; execution stops.

Do not rewrite human terminal state merely to agree with stale checkpoints.

## 8. Checkpoint reconciliation

A checkpoint may claim `HEAD: abc`, `Verified: tests pass`, and `Next action: ...`.

A successor verifies:

1. referenced claim is current/relevant;
2. referenced work branch belongs to that claim;
3. referenced HEAD exists on expected work lineage;
4. claimed durable changes are actually pushed;
5. verification/CI evidence is current enough;
6. requirements/dependencies did not materially change.

Repository evidence wins over prose. A corrected checkpoint is written only after successor has authority.

## 9. Comment trust model

Issue comments are editable/deletable and are not immutable audit storage.

For lease semantics:

- only structurally valid current-claim comments count;
- GitHub `created_at` is event time;
- body timestamps are ignored;
- edited comments (`updated_at != created_at`) are excluded from authority;
- deletion can remove renewal evidence, so the model remains cooperative rather than tamper-proof.

Edited comments may still be non-authoritative recovery hints.

## 10. Dependency semantics

Native GitHub dependencies own graph edges. GAC adds success semantics:

- blocker closed + `agent:done` -> satisfied;
- blocker `agent:cancelled` -> not successful;
- blocker open/blocked/human-required/active/ready -> unsatisfied;
- blocker closed with ambiguous GAC outcome -> human resolution required.

Cancellation/closure cannot silently masquerade as delivered functionality.

## 11. Base branch and done

For coding work, authoritative base is final integration truth.

`agent:done` requires:

- intended result present in base;
- required validation/review policy satisfied;
- Issue closed successfully;
- not cancelled.

A work branch or open PR is insufficient. Claim refs are control metadata and never count as implementation completion.

For non-code tasks, the Issue must define a durable completion artifact/outcome explicitly.

## 12. Concurrent control-file edits

`.agent/**`, `.agents/**`, GAC `.github/**` templates, and GAC protocol docs are shared control scope. Ordinary parallel product tasks should not modify them unless specifically authorized.

Concurrent control-plane changes should declare overlap and be serialized through review/integration rather than assuming conflict-free merge.

## 13. Recovery precedence checklist

When state appears inconsistent:

1. What repository policy/security instructions apply?
2. Is Issue open/executable, or is there human/terminal stop?
3. What is highest valid **claim** generation?
4. Who owns its immutable claim, from what source, and what work branch is declared?
5. Is claim active/expired/yielded/terminated by server-timed events?
6. Does matching work branch exist and validate against source?
7. What is actually pushed on work branch?
8. What do PR/base/CI results prove?
9. What useful context remains only in checkpoint prose?

Never reverse this order because checkpoint text is easier to read.
