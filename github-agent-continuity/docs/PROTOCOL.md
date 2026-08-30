# GAC Protocol v0.1

This document defines the operational procedure agents follow. `DESIGN.md` defines architecture/guarantee boundary; `STATE_MODEL.md` defines authority when evidence conflicts.

## 1. Terms

- **base branch** — configured authoritative integration branch; `default` resolves repository default.
- **Issue N** — one executable task.
- **claim generation K** — immutable ownership ref `gac-claim/issue-N-gK`.
- **work generation K** — implementation branch `agent/issue-N-gK` associated with that claim.
- **claim commit** — empty commit referenced by claim ref; stores owner/source/work metadata and initial server-timed lease event.
- **owner** — globally unique session identifier stored in claim commit.
- **lease** — bounded execution authority for highest valid claim generation.
- **checkpoint** — structured Issue comment containing recovery state; valid active/finalizing checkpoints renew lease.
- **yield** — structured terminal checkpoint intentionally ending one generation early.

## 2. Session identity

Generate one unique opaque owner ID per independent execution session, e.g.:

```text
session-20260830T120000Z-7f31c7d4
```

Never reuse owner ID across scheduled sessions.

## 3. Bootstrap before editing

1. Read repository-specific agent/security instructions.
2. Read `.agent/config.yml`, `.agent/PROJECT.md`, `.agent/GOALS.md`, and only relevant decisions.
3. Inspect active/blocked/human-required/ready Issues.
4. Read native Issue dependencies.
5. Inspect matching claim refs and corresponding work refs.
6. Inspect related PRs, CI/status, recent commits, checkpoints.
7. Reconcile labels/comments against repository state.

No implementation write occurs before this pass.

Stopped tasks may be inspected for **administrative reconciliation** (Section 18), but inspection does not grant code authority.

## 4. Eligibility

An Issue is executable only when:

- open;
- not cancelled/blocked/human-required;
- native blockers semantically satisfied;
- repository policy allows intended work;
- no active highest claim lease exists.

For GAC-managed dependencies, success normally means blocker closed + `agent:done` and not `agent:cancelled`. Ambiguous closed blockers do not count as success.

## 5. Discover highest claim generation

Using `claim_branch_prefix`, query GitHub matching refs and parse only exact names such as:

```text
^gac-claim/issue-N-g([1-9][0-9]*)$
```

Use highest integer generation.

Do not infer ownership from work branches, labels, comments, or first page of repository-wide branches.

Malformed highest matching claim ref is corruption/namespace collision: fail closed rather than skipping it.

## 6. Validate claim and work metadata

Claim trailers:

```text
GAC-Claim: v1
GAC-Issue: N
GAC-Generation: K
GAC-Owner: <owner-id>
GAC-Base-Branch: <resolved-base>
GAC-Source-Head: <source-sha>
GAC-Work-Branch: agent/issue-N-gK
```

Claim validity requires Issue/generation/ref/work-name consistency, parent == source, same tree as source (empty metadata commit), and non-empty owner/base/source.

Claim ref is immutable by protocol after creation: never advance/rebase/force-update it.

A work branch grants no authority by itself. It is valid for the matching claim only when it equals or descends from claim source and has not been force-rewritten/rebased outside protocol. Work starts at source, not claim commit.

## 7. Lease state

Read all relevant Issue comments across pagination. A checkpoint counts for lease authority only when Task/Generation/Owner/Claim ref/Work branch match current claim, disposition is defined, and GitHub reports `created_at == updated_at`.

Start with claim-commit GitHub committer timestamp. Process valid checkpoint events by GitHub `created_at`:

- `active` / `finalizing` -> renew;
- `yielded` / `blocked` / `human-required` -> permanently terminate that generation.

A terminated/expired generation never revives itself; continuation requires a new claim generation.

```text
lease_expires_at = latest_active_event_time + lease_ttl_minutes
```

### Current-time source

Lease **event** times are GitHub-authoritative. To decide whether expiry has occurred:

1. prefer GitHub/server current time exposed by the API/tool (for example HTTP response `Date` or equivalent trusted server time);
2. if unavailable, use session/local time only with configured `clock_skew_grace_minutes` for takeover.

With local fallback, a contender may treat lease as expired only when:

```text
local_now >= lease_expires_at + clock_skew_grace_minutes
```

Grace is a takeover safety margin, not extra owner authority. Current owner should renew early/stop at lease expiry and never rely on grace to keep working.

Body-provided timestamps never extend authority.

## 8. Choose next generation and source

- no claim generation -> `K=1`, source = current base HEAD;
- expired/yielded/terminated highest gK -> next `g(K+1)`.

Takeover source:

1. valid previous work branch HEAD if it exists;
2. otherwise previous claim `GAC-Source-Head` (owner may have crashed before creating work branch).

If highest claim still active, do not claim.

## 9. Construct candidate claim commit

Using GitHub Git Database operations:

1. read source commit/tree;
2. create commit with same tree and source as parent;
3. include required claim trailers + expected work branch;
4. omit custom author/committer timestamps so GitHub supplies authenticated identity/current date.

Candidate commit alone grants no authority.

## 10. Atomically create exact claim ref

Create:

```text
refs/heads/gac-claim/issue-N-gK -> <candidate-claim-sha>
```

- success -> read ref/claim back and validate;
- conflict/lost response -> re-read exact ref.

Lost-response resolution:

- valid claim owner == this session and metadata matches -> recover own successful claim if lease valid;
- owner differs -> another session won;
- malformed -> fail closed.

Do not create next generation merely because exact ref creation conflicted.

Unreferenced candidate commits are non-authoritative.

## 11. Create/read work branch after claim win

Only winning owner may establish:

```text
refs/heads/agent/issue-N-gK -> <GAC-Source-Head>
```

Read back after creation:

- valid source/descendant + current claim is yours -> use it (supports lost-response retry);
- incompatible history -> fail closed;
- missing/uncreatable -> do not implement.

Never push implementation to claim ref.

Crash after claim before work ref remains recoverable from claim source after lease expiry.

## 12. Lifecycle projection after claim

After claim/work validation, reconcile Issue toward `agent:active` when permitted. Labels are projections, never mutexes.

Metadata mutation failure must be reported, not silently assumed fixed.

## 13. Work loop

While highest claim + lease remain valid:

1. select next acceptance criterion;
2. inspect implementation;
3. make smallest coherent change;
4. run relevant validation;
5. commit/push to current **work branch**;
6. re-read highest claim + Issue stop state before consequential writes;
7. checkpoint meaningful durable progress;
8. renew before `renewal_threshold_minutes` remains.

Never checkpoint unpushed implementation as durable. Never force-push/rebase generation work branches under normal GAC operation.

If higher claim appears, stop immediately.

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

No chain-of-thought, raw command transcripts, or session diary.

## 15. Graceful yield / blocked / human-required

Before normal session end: push coherent work, post `yielded` with concrete next action, then stop. Successor may claim next generation immediately; TTL is crash path.

When blocked: push safe coherent work, post `blocked` + exact unblock condition, project `agent:blocked`, stop.

When human decision required: post `human-required` with one precise request, project label, stop; never guess.

Resumption after any terminating disposition uses new claim/work generation.

## 16. Recovery

Takeover winner creates new work branch at source recorded by winning new claim, then:

1. inspect old checkpoints, previous work commits/diff, PRs, CI, requirements, dependencies;
2. distinguish pushed work from prose;
3. re-run/re-check validation as needed;
4. continue existing work rather than restart blindly.

Late stale pushes remain isolated on old work branches. Salvage only reviewed specific commits; never auto-merge stale branch due newer wall-clock time.

## 17. Finalization

1. confirm Issue executable;
2. confirm your claim generation still highest;
3. determine remaining lease using Section 7;
4. renew if below `finalization_margin_minutes`;
5. re-fetch requirements/dependencies;
6. evaluate every acceptance criterion;
7. validate and inspect final diff;
8. push intended work;
9. re-read highest claim + Issue stop state after push.

Create PR only from current **work branch** when integration-ready.

- autonomous merge allowed + required checks satisfied -> merge by repository policy, verify result in base, then `agent:done` + successful Issue close;
- human merge/review required -> human-required exact request; do not mark done;
- pending external check -> follow repository blocked/waiting policy; do not mark done.

Open PR is not completion. Claim commits are on separate immutable refs and must not enter base merely because of GAC ownership metadata.

If review requires new code after PR exists, use next generation from latest intended work and supersede stale PR when appropriate.

## 18. Administrative reconciliation after external action

A session may perform **idempotent metadata reconciliation without implementation authority** when no code edit is required and external GitHub evidence conclusively satisfies a stopped task condition.

Examples:

- human-required solely for merge, and linked PR is now merged into authoritative base;
- blocked solely on an external check, and check is now conclusively satisfied;
- human closed Issue after successful integration but forgot `agent:done` projection.

Allowed reconciliation:

- verify base/PR/Issue evidence;
- repair labels/close state to the already-proven outcome;
- if further implementation is needed, make Issue executable but claim a **new generation before code writes**.

Do not use this exception to change code, guess an ambiguous human decision, or convert `not planned`/cancelled closure into success without evidence.

Multiple sessions performing the same idempotent metadata repair is acceptable.

## 19. Cancellation

`agent:cancelled` is terminal abandonment, not success. Dependent tasks must not silently treat it as satisfied.

## 20. API/consistency failures

Fail closed when exact claim-ref creation unavailable; claim metadata unreadable; claim/work namespace malformed; highest claim incomplete; work branch incompatible with claim source; dependency state unresolved; or repository policy conflicts.

Do not substitute labels, comments, model confidence, shared work branch, or local-time guess without configured skew safety for missing authority primitives.
