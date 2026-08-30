# GAC Protocol v0.1

This document defines the operational procedure agents follow. `DESIGN.md` defines the architecture and guarantee boundary; `STATE_MODEL.md` defines authority when evidence conflicts.

## 1. Terms

- **base branch** — configured authoritative integration branch; `default` resolves to the repository default branch.
- **Issue N** — one executable task.
- **generation K** — ownership/work branch `agent/issue-N-gK`.
- **claim commit** — first commit unique to a generation; records owner metadata and initial server-timed lease event.
- **owner** — globally unique session identifier stored in the claim commit.
- **lease** — bounded execution authority for the highest generation.
- **checkpoint** — structured Issue comment containing recovery state; valid active/finalizing checkpoints also renew the lease.
- **yield** — structured terminal checkpoint for a generation that intentionally ends its lease early.

## 2. Session identity

Generate a unique opaque owner ID per independent execution session, for example:

```text
session-20260830T120000Z-7f31c7d4
```

Do not reuse an owner ID across independent scheduled sessions.

## 3. Bootstrap before editing

1. Read repository-specific agent/security instructions.
2. Read `.agent/config.yml`, `.agent/PROJECT.md`, `.agent/GOALS.md`, and only relevant entries from `.agent/DECISIONS.md`.
3. Inspect open Issues carrying `agent:active`, `agent:blocked`, `agent:human-required`, or `agent:ready`.
4. Read native Issue dependencies for candidates.
5. Inspect matching generation refs for resumable/candidate tasks.
6. Inspect related PRs, CI/status, recent commits, and relevant checkpoints.
7. Reconcile labels/comments against actual repository state before selecting work.

No implementation write occurs before this pass.

## 4. Eligibility

An Issue is executable only when all are true:

- it is open;
- it is not `agent:cancelled`, `agent:blocked`, or `agent:human-required`;
- all native blocking dependencies are semantically satisfied;
- repository policy allows the intended work;
- it either has no generation, or its highest generation is expired/yielded and therefore recoverable, or it is `agent:ready` for initial claim.

For GAC-managed dependencies, a successful dependency normally means closed + `agent:done` and not `agent:cancelled`.

A closed dependency with ambiguous outcome must not be treated as successful automatically.

## 5. Discover the highest generation

For Issue `N`, query GitHub matching refs for the exact prefix represented by configured `branch_prefix` plus the Issue number. With the default naming, parse only branches matching:

```text
^agent/issue-N-g([1-9][0-9]*)$
```

Use the highest integer generation.

Do not infer the highest generation from Issue comments or labels. Do not rely on the first page of a repository-wide branch listing.

Every matching generation must begin with a structurally valid GAC claim commit. If the highest matching branch has no valid claim metadata, fail closed and request human repair rather than guessing around a namespace collision/corruption.

## 6. Read claim metadata

The generation's claim commit contains:

```text
GAC-Claim: v1
GAC-Issue: N
GAC-Generation: K
GAC-Owner: <owner-id>
GAC-Base-Branch: <resolved-base>
GAC-Source-Head: <source-sha>
```

The claim commit is the first commit after `GAC-Source-Head` on that generation and uses the same tree as the source commit.

The GitHub committer timestamp on this claim commit is the initial lease-event time.

Reject a claim as invalid when Issue number, generation number, branch name, source parent, or required trailers disagree.

## 7. Determine lease state

Read all relevant Issue comments across pagination and identify structurally valid `GAC CHECKPOINT v1` comments for the current highest generation and claim owner.

For authority purposes a checkpoint event is valid only when:

- `Task`, `Generation`, and `Owner` match the current claim;
- `Work branch` matches the current generation branch;
- GitHub reports `created_at == updated_at` (the comment was not edited);
- its disposition is one of the defined values.

Progress text from edited comments may still be a hint, but an edited comment never renews/terminates a lease.

### Effective event

Start with the claim commit server timestamp. Then consider valid checkpoint events in GitHub `created_at` order.

- `active` or `finalizing` — renews lease from that comment's `created_at`.
- `yielded`, `blocked`, or `human-required` — permanently terminates that generation's execution authority at that event.

Once a generation has a valid terminating disposition, a later comment must not revive it. Continuation requires a new generation.

Without a terminating event:

```text
lease_expires_at = latest_effective_event_created_at + lease_ttl_minutes
```

Compare against current trustworthy GitHub/server time when available. Do not use timestamps written inside comment bodies as authority.

An expired generation cannot renew itself. It must be superseded by a new generation.

## 8. Claim initial work or recover expired work

### 8.1 Choose generation and source

- no existing generation → `K = 1`, source = current base-branch HEAD;
- expired/yielded highest `gK` → next generation = `K + 1`, source = current HEAD of `gK` read immediately before claim construction.

If the current highest generation still has a valid active lease, do not claim the Issue.

### 8.2 Construct an empty claim commit

Using GitHub Git Database operations:

1. read the source commit and tree SHA;
2. create a commit with the same tree;
3. parent = exact source SHA;
4. include required GAC claim trailers;
5. omit custom author/committer timestamps so GitHub supplies current authenticated identity/date.

Creating this candidate commit does **not** grant ownership.

### 8.3 Atomically create the exact ref

Create:

```text
refs/heads/agent/issue-N-gK -> <candidate-claim-sha>
```

where `K` is exactly the candidate generation.

- success: read the ref and claim commit back; ownership is established only after read-back validation.
- conflict/already exists: re-read the exact ref and its claim commit.

If a create-ref response was lost, the read-back resolves ambiguity:

- ref claim owner equals this session owner and metadata matches → treat the claim as this session's successful claim if its lease is still valid;
- ref claim owner differs → another session won;
- malformed metadata → fail closed.

Do not create `g(K+2)` merely because `g(K+1)` creation conflicted. Reconcile first.

Candidate commits that never become referenced are non-authoritative and may be garbage-collected by GitHub.

## 9. Project lifecycle projection after claim

After winning a claim, reconcile Issue labels to `agent:active` when the repository permits label writes. Labels are projections, never the mutex.

If label mutation fails but claim authority is otherwise valid, checkpoint the metadata failure; whether work may continue depends on repository policy. Do not pretend label state is correct.

## 10. Work loop

While the generation and lease remain valid:

1. select the next acceptance criterion;
2. inspect existing implementation before editing;
3. make one coherent change;
4. run relevant validation available in the project;
5. commit and push the change to the current generation branch;
6. re-read highest generation and Issue stop state before consequential writes;
7. publish a concise checkpoint after meaningful recoverable progress;
8. renew before `renewal_threshold_minutes` remains.

Never checkpoint unpushed implementation as durable.

If a higher generation appears at any re-check, stop writing immediately. Local/unpushed work may be summarized for humans but is not current authority.

## 11. Checkpoint format

```text
GAC CHECKPOINT v1

Task: #42
Owner: session-...
Generation: 3
Disposition: active
Work branch: agent/issue-42-g3
HEAD: <pushed-sha>
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

Allowed dispositions:

- `active`
- `finalizing`
- `yielded`
- `blocked`
- `human-required`

Do not include chain-of-thought, raw command transcripts, or verbose diary text.

## 12. Graceful yield

Before a scheduled/host session ends naturally:

1. push coherent recoverable work;
2. post a checkpoint with `Disposition: yielded` and a concrete next action;
3. stop modifying the generation branch after the comment is created.

The next session may create the next generation immediately without waiting for TTL expiry.

If the session dies before yield, the next session waits until expiry and performs takeover.

## 13. Blocked and human-required

When an objective blocker appears:

1. push only coherent work safe to preserve;
2. post `Disposition: blocked` with exact unblock condition;
3. apply `agent:blocked` and remove active/ready projection when permitted;
4. stop writing.

When a human decision/permission is required:

1. post `Disposition: human-required` with exactly one actionable question/request;
2. apply `agent:human-required` when permitted;
3. stop writing and do not guess through the gate.

Resuming either state after it becomes executable uses a **new generation**. A terminated generation is never revived.

## 14. Recovery

A takeover winner starts from the previous generation HEAD captured at claim time. Then:

1. inspect old checkpoints, commits, PRs, CI/status, Issue requirements, and dependencies;
2. distinguish pushed durable work from prose claims;
3. re-run/re-check validation as needed;
4. continue from existing work rather than rebuilding it blindly.

Writes that an expired/stale session later pushes to an older branch remain isolated. A current owner may salvage a specific stale commit only after reviewing it; never merge stale branches automatically merely because they are newer in wall-clock time.

## 15. Requirement changes

Before finalization, always re-fetch Issue title/body and dependencies. Do not rely solely on what was read at claim time.

If acceptance criteria or dependency semantics materially changed, reconcile the implementation before proceeding. If the change creates ambiguity, use human-required.

## 16. Finalization

Before finalization:

1. confirm Issue remains executable;
2. confirm your generation is still highest;
3. compute remaining lease time from valid server-timed events;
4. if remaining time is below `finalization_margin_minutes`, renew first;
5. re-read requirements/dependencies;
6. evaluate every acceptance criterion;
7. run relevant validation and inspect final diff;
8. push all intended work;
9. re-read highest generation and Issue stop state after the push.

Then create a PR from the **current generation branch** only when implementation is integration-ready.

- autonomous merge allowed + required checks satisfied → merge according to repository policy, verify result exists in base, then set `agent:done` and close Issue.
- human merge/review required → post `human-required` with the exact PR decision needed; do not mark done.
- CI/external prerequisite pending → use blocked/waiting policy defined by the repository; do not call done.

An open PR is not successful task completion.

If review requests new implementation after a PR exists, continue via a new generation and supersede/close the stale PR when appropriate rather than reintroducing a permanent shared work branch.

## 17. Cancellation

`agent:cancelled` is terminal abandonment, not success. Stop all GAC work for the Issue. Dependent tasks must not silently interpret a cancelled blocker as satisfied.

## 18. API/consistency failure handling

Fail closed rather than weakening protocol when:

- exact Git ref creation is unavailable;
- claim commit metadata cannot be created/read;
- generation namespace is malformed/colliding;
- highest generation cannot be determined completely;
- Issue dependency state cannot be resolved for a dependency-sensitive task;
- repository policy/security instructions conflict with the intended action.

Do not substitute labels, comments, or model confidence for missing ownership primitives.
