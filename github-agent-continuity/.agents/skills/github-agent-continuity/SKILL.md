---
name: github-agent-continuity
description: Use when an autonomous agent works on a GitHub repository across independent or scheduled sessions and must recover prior work, coordinate with parallel sessions, or continue without conversation history.
---

# GitHub Agent Continuity

## Invariant

Treat every session as disposable. GitHub and committed repository content are durable truth; conversation history is not.

Before editing, recover project goal, executable task, current claim generation/lease, durable work, blockers, and next action.

Read `docs/PROTOCOL.md` for exact mechanics and `docs/STATE_MODEL.md` when evidence conflicts.

## Start every session

1. Read repository-specific agent/security instructions.
2. Read `.agent/config.yml`, project/goals, and only relevant durable decisions.
3. Inspect active/blocked/human-required/ready Issues and native dependencies.
4. Inspect matching `gac-claim/issue-N-gK` claim refs, corresponding `agent/issue-N-gK` work refs, PR/CI/commit state, and checkpoints.
5. Reconcile checkpoint prose against actual GitHub evidence.

Do not edit before recovery.

## Stop conditions

Stop task writes when Issue is closed/cancelled/blocked/human-required, a higher valid claim generation exists, your lease expired/yielded, or repository policy denies the action.

Repository policy/current GitHub evidence outrank checkpoints.

## Claim work

Own exactly one primary Issue.

Never use labels/comments as mutex. Follow `docs/PROTOCOL.md`:

1. create structured empty claim commit;
2. atomically create exact immutable next `gac-claim/...` ref;
3. read-back validate owner/source;
4. only winner creates/uses matching generation-specific `agent/...` work branch from claim source.

If exact claim operations are unavailable, fail closed. Do not approximate authority.

Claim refs never receive implementation commits. Work only on matching work branch. Older claim/work generations are stale after a higher claim exists.

## Work loop

While authority remains valid:

1. execute next acceptance criterion;
2. make smallest coherent change;
3. validate;
4. commit/push recoverable work to current work branch;
5. re-check claim generation/Issue state before consequential writes;
6. checkpoint meaningful durable progress;
7. renew before threshold or yield before session ends.

Never claim unpushed work is durable.

## Checkpoint and yield

Use `GAC CHECKPOINT v1`. Keep completed, verified, remaining, one next action, blockers, and human request concise. No chain-of-thought/command diary.

Graceful sessions push/checkpoint then `yielded` so next scheduled session may take over immediately.

## Finalize

Re-read requirements/dependencies, confirm highest claim + lease margin, validate/push, then re-check authority.

Open PR only when integration-ready from current **work branch**. Coding task is `agent:done` only after intended result exists in authoritative base and Issue is closed. Human merge/decision required -> `agent:human-required`, never guess.

## Hard rules

- Native Issue dependencies are authoritative.
- Claim refs are immutable control metadata; never push work to them.
- Never force-push/rebase generation work branches under normal GAC operation.
- Never weaken tests for green CI, expose secrets, or bypass repository protections.
- Do not edit `.agent/**`, `.agents/**`, or GAC protocol files unless Issue explicitly authorizes control-plane changes.
