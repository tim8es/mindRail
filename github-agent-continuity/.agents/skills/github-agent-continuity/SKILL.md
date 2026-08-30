---
name: github-agent-continuity
description: Use when an autonomous agent works on a GitHub repository across independent or scheduled sessions and must recover prior work, coordinate with parallel sessions, or continue without conversation history.
---

# GitHub Agent Continuity

## Invariant

Treat every session as disposable. GitHub and committed repository content are durable truth; conversation history is not.

Before editing, a zero-context successor must be able to determine the project goal, executable task, current ownership generation, durable progress, blockers, and next action.

Read `docs/PROTOCOL.md` for exact claim/lease mechanics and `docs/STATE_MODEL.md` when sources disagree.

## Start every session

1. Read repository-specific agent/security instructions first.
2. Read `.agent/config.yml`, `.agent/PROJECT.md`, `.agent/GOALS.md`, and only relevant durable decisions.
3. Inspect active, blocked, human-required, and ready Issues.
4. Inspect native Issue dependencies.
5. Inspect matching `agent/issue-N-gK` refs and relevant PR/CI/commit state.
6. Reconcile checkpoint prose against actual GitHub state.

Do not edit before this recovery pass.

## Stop conditions

Do not modify a task when its Issue is closed/cancelled/blocked/human-required, a higher generation exists, your lease expired/yielded, or repository policy denies the action.

Repository policy and current GitHub evidence outrank checkpoints.

## Claim work

Own exactly one primary Issue.

Never use labels as a mutex. Claim only through the generation protocol in `docs/PROTOCOL.md`: create the structured empty claim commit, then atomically create the exact next generation ref.

If exact claim/ref creation is unavailable, do not approximate it with comments or labels; stop that claim and report the missing capability.

On takeover, create the new generation from the previous generation's durable HEAD. Never continue writing an older generation after a higher one exists.

## Work loop

While authority remains valid:

1. execute the next acceptance criterion;
2. make the smallest coherent change;
3. run available relevant validation;
4. commit and push recoverable progress;
5. re-check generation/Issue state before consequential writes;
6. checkpoint meaningful durable progress;
7. renew before the configured threshold or yield before the session ends.

Never claim unpushed work is durable.

## Checkpoint

Use `GAC CHECKPOINT v1` from `docs/PROTOCOL.md`. Keep it concise: completed, verified, remaining, one next action, blockers, and human decision if any. Do not include raw chain-of-thought or command diaries.

A graceful session should yield after pushing/checkpointing so the next scheduled session can take over immediately.

## Finalize

Before terminal state, re-read requirements/dependencies, confirm highest generation and lease margin, validate, push, then re-check authority.

Open a PR only when integration-ready. A coding task is `agent:done` only after intended work exists in the authoritative base branch and the Issue is closed. If merge needs human approval, use `agent:human-required`; do not guess or mark done.

## Hard rules

- Native Issue dependencies are authoritative.
- Older generation branches are stale, never current work.
- Do not force-push generation branches.
- Do not weaken tests to obtain green CI.
- Do not expose secrets or bypass repository protections.
- Do not edit `.agent/**`, `.agents/**`, or GAC protocol files unless the Issue explicitly authorizes control-plane changes.
