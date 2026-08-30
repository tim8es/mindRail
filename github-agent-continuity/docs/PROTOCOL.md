# GAC Protocol v0.1

This document defines the operational procedure agents follow. `DESIGN.md` defines the architecture/guarantee boundary; `STATE_MODEL.md` defines authority when evidence conflicts.

## 1. Terms

- **base branch** — configured authoritative integration branch; `default` resolves repository default.
- **Issue N** — one executable task.
- **claim generation K** — immutable ownership ref `gac-claim/issue-N-gK`.
- **work generation K** — implementation branch `agent/issue-N-gK` associated with that claim.
- **claim commit** — empty commit referenced by the claim ref; stores owner/source metadata and initial server-timed lease event.
- **owner** — globally unique session identifier stored in claim commit.
- **lease** — bounded execution authority for highest valid claim generation.
- **checkpoint** — structured Issue comment containing recovery state; valid active/finalizing checkpoints renew lease.
- **yield** — structured terminal checkpoint that intentionally ends one generation early.

## 2. Session identity

Generate a unique opaque owner ID per independent execution session, for example:

```text
session-20260830T120000Z-7f31c7d4
```

Never reuse an owner ID across independent scheduled sessions.

## 3. Bootstrap before editing

1. Read repository-specific agent/security instructions.
2. Read `.agent/config.yml`, `.agent/PROJECT.md`, `.agent/GOALS.md`, and only relevant `.agent/DECISIONS.md` entries.
3. Inspect open `agent:active`, `agent:blocked`, `agent:human-required`, and `agent:ready` Issues.
4. Read native Issue dependencies.
5. Inspect matching claim refs and corresponding work refs.
6. Inspect related PRs, CI/status, recent commits, and relevant checkpoints.
7. Reconcile labels/comments against repository state.

No implementation write occurs before this pass.

## 4. Eligibility

An Issue is executable only when all are true:

- open;
- not `agent:cancelled`, `agent:blocked`, or `agent:human-required`;
- native blocking dependencies semantically satisfied;
- repository policy allows intended work;
- either no claim generation exists, or highest generation is expired/yielded/terminated and therefore recoverable.

For GAC-managed dependencies, success normally means blocker closed + `agent:done` and not cancelled. Ambiguous closed blockers do not count as success automatically.

## 5. Discover highest claim generation

Using configured `claim_branch_prefix`, query GitHub matching refs and parse only exact names such as:

```text
^gac-claim/issue-N-g([1-9][0-9]*)$
```

Use highest integer generation.

Do not infer current generation from work branches, labels, comments, or a first page of repository-wide branches.

Every matching claim ref must point to a structurally valid GAC claim commit. If the highest matching claim is malformed, fail closed and request repair rather than skipping it.

## 6. Validate claim metadata

Claim commit trailers:

```text
GAC-Claim: v1
GAC-Issue: N
GAC-Generation: K
GAC-Owner: <owner-id>
GAC-Base-Branch: <resolved-base>
GAC-Source-Head: <source-sha>
GAC-Work-Branch: agent/issue-N-gK
```

Validate:

- Issue/generation match claim-ref name;
- `GAC-Work-Branch` matches configured work branch for same Issue/generation;
- claim parent equals `GAC-Source-Head`;
- claim tree equals source tree (empty metadata commit);
- owner/base/source are non-empty and resolvable as required.

The GitHub committer timestamp on this immutable claim commit is initial lease-event time.

Claim refs never receive later work commits and must never be advanced/rebased/force-updated by GAC.

## 7. Determine lease state

Read all relevant Issue comments across pagination and identify structurally valid `GAC CHECKPOINT v1` comments for current highest claim/owner.

For lease authority, a checkpoint event is valid only when:

- `Task`, `Generation`, `Owner`, and `Claim ref` match current claim;
- `Work branch` matches claim metadata;
- GitHub reports `created_at == updated_at`;
- disposition is defined.

Edited comments can be prose hints but never renew/terminate a lease.

### Effective event

Start with claim-commit server timestamp, then process valid checkpoint events by GitHub `created_at`:

- `active` or `finalizing` — renews from `created_at`;
- `yielded`, `blocked`, `human-required` — permanently terminates that generation at the event.

A terminating disposition is monotonic. Later comments cannot revive the generation.

Without termination:

```text
lease_expires_at = latest_effective_event_created_at + lease_ttl_minutes
```

Use trustworthy GitHub/server time for comparison when available. Ignore body/local timestamps as authority.

An expired generation cannot renew itself; continuation requires a new claim generation.

## 8. Choose next claim generation and source

- no claim generation -> `K = 1`, source = current base HEAD;
- expired/yielded/terminated highest `gK` -> next = `g(K+1)`.

For takeover source:

1. if matching previous work branch exists and is valid, use its current HEAD;
2. if previous owner never created a valid work branch, use previous claim's `GAC-Source-Head`.

A work branch is valid only when it belongs to same Issue/generation namespace and its history descends from the source recorded by matching claim. Generation work branches must not be rebased/force-rewritten under normal GAC operation.

If highest claim still has active lease, do not claim.

## 9. Construct candidate claim commit

Using GitHub Git Database operations:

1. read source commit/tree;
2. create commit with same tree;
3. parent = exact source SHA;
4. include required claim trailers including expected work branch;
5. omit custom author/committer timestamps so GitHub supplies current authenticated identity/date.

Creating candidate commit alone grants no authority.

## 10. Atomically create exact claim ref

Create:

```text
refs/heads/gac-claim/issue-N-gK -> <candidate-claim-sha>
```

where K is exactly the candidate generation.

- success: read ref/claim back and validate before acting;
- conflict/already exists: re-read exact ref/claim.

### Lost response

If create-ref response was lost:

- referenced valid claim owner == this session owner and metadata matches -> recover this session's successful claim if lease still valid;
- owner differs -> another session won;
- malformed -> fail closed.

Do not create the next generation merely because exact ref creation conflicted. Reconcile first.

Unreferenced candidate commits are non-authoritative.

## 11. Create/read work branch after claim win

Only winning claim owner may establish matching work branch:

```text
refs/heads/agent/issue-N-gK -> <GAC-Source-Head>
```

The work branch starts at source, **not** at claim commit. Product commits therefore never need to include claim metadata in integration history.

After attempting work-ref creation, read it back:

- absent and creation failed unexpectedly -> do not start implementation;
- existing at source/valid descendants and current claim is yours -> treat as current work branch (supports lost-response retry);
- existing but incompatible with claim source/history -> corruption, fail closed.

A crash after winning claim but before work-ref creation is recoverable: claim still defines owner/source/lease. After expiry, successor can create next claim using prior source because no valid work was produced.

## 12. Lifecycle projection after claim

After claim + work-ref validation, reconcile Issue labels to `agent:active` when permitted. Labels are projections, never mutex.

If metadata repair fails, report it; do not pretend label state is correct. Whether implementation may continue depends on repository policy.

## 13. Work loop

While highest claim + lease remain valid:

1. select next acceptance criterion;
2. inspect implementation;
3. make one coherent change;
4. run relevant validation;
5. commit/push to current generation **work branch**;
6. re-read highest claim generation and Issue stop state before consequential writes;
7. checkpoint meaningful durable progress;
8. renew before `renewal_threshold_minutes` remains.

Never push implementation to claim ref. Never checkpoint unpushed implementation as durable.

If higher claim generation appears, stop immediately. Local/unpushed work is not current authority.

## 14. Checkpoint format

```text
GAC CHECKPOINT v1

Task: #42
Owner: session-...
Generation: 3
Disposition: active
Claim ref: gac-claim/issue-42-g3
Work branch: agent/issue-42-g3
HEAD: <pushed-work-sha>
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

Allowed dispositions: `active`, `finalizing`, `yielded`, `blocked`, `human-required`.

Do not include chain-of-thought, raw command transcripts, or verbose diary text.

## 15. Graceful yield

Before a scheduled/host session ends normally:

1. push coherent recoverable work;
2. post `Disposition: yielded` with concrete next action;
3. stop modifying work branch after comment creation.

Next session may create next claim generation immediately. TTL expiry is crash path, not preferred routine handoff.

## 16. Blocked and human-required

When objectively blocked:

1. push coherent safe work;
2. post `Disposition: blocked` + exact unblock condition;
3. apply `agent:blocked` when permitted;
4. stop writing.

When human decision/permission required:

1. post `Disposition: human-required` with exactly one actionable request;
2. apply `agent:human-required` when permitted;
3. stop writing and do not guess.

Resume after either state via **new claim/work generation**. Terminated generation is never revived.

## 17. Recovery

Takeover winner uses source chosen before claim creation, then creates new work branch at that source.

Recovery then:

1. inspects old checkpoints, previous work commits/diff, PRs, CI, requirements, dependencies;
2. distinguishes pushed durable work from prose claims;
3. re-runs/re-checks validation as needed;
4. continues existing work rather than restarting blindly.

Late stale pushes remain isolated on old work branches. Salvage specific stale commits only after explicit review; never auto-merge a stale branch because of newer wall-clock time.

## 18. Requirement changes

Before finalization, re-fetch Issue title/body and native dependencies. If requirements materially changed, reconcile implementation first. If ambiguous, use human-required.

## 19. Finalization

1. confirm Issue executable;
2. confirm your **claim generation** still highest;
3. compute remaining server-timed lease;
4. renew first if below `finalization_margin_minutes`;
5. re-read requirements/dependencies;
6. evaluate every acceptance criterion;
7. run relevant validation/inspect final diff;
8. push all intended work to current work branch;
9. re-read highest claim and Issue stop state after push.

Create PR from **current work branch** only when integration-ready.

- autonomous merge allowed + checks satisfied -> merge by repository policy, verify result in base, then `agent:done` + successful Issue close;
- human merge/review required -> post human-required exact request; do not mark done;
- CI/external prerequisite pending -> use repository waiting/blocked policy; do not mark done.

An open PR is not completion.

Claim commits live on separate claim refs, so normal PR integration of work branch does not import GAC claim commits into base history.

If review requires new implementation after PR exists, create next generation from latest intended work and supersede/close stale PR when appropriate rather than using a permanent shared work branch.

## 20. Cancellation

`agent:cancelled` is terminal abandonment, not success. Stop GAC work. Dependent tasks must not silently interpret it as satisfied.

## 21. API/consistency failures

Fail closed rather than weakening protocol when:

- exact claim-ref creation unavailable;
- claim commit cannot be created/read/validated;
- claim/work namespace malformed/colliding;
- highest claim generation cannot be determined completely;
- expected work branch conflicts with incompatible history;
- dependency state cannot be resolved for dependency-sensitive task;
- repository policy/security instructions conflict with action.

Do not substitute labels, comments, model confidence, or a shared work branch for missing ownership primitives.
