# GAC v0.1 Conformance Scenarios

These scenarios define expected protocol behavior. They are written so an implementation/reviewer can exercise them manually or automate them later with GitHub API tests.

`PASS` means every expected invariant was observed. Do not mark a scenario PASS from design reasoning alone.

## S01 — Cold start selects eligible work

**Preconditions**

- zero conversation/session context;
- `.agent/` memory populated;
- one `agent:ready` Issue with all blockers done;
- another ready-looking Issue still blocked by an open native dependency.

**Actions**

1. Run the session bootstrap.
2. Read memory, Issues, dependencies, generation refs, PR/CI state.
3. Rank executable work.

**Expected invariants**

- blocked task is not claimable;
- eligible Issue can be selected without prior chat history;
- no implementation write occurs before reconciliation.

## S02 — Simultaneous initial claim

**Preconditions**

- Issue `#42` is eligible;
- no `agent/issue-42-gK` ref exists.

**Actions**

1. Sessions A and B each create candidate `g1` claim commits.
2. Both attempt exact ref creation for `agent/issue-42-g1`.

**Expected invariants**

- exactly one ref creation succeeds;
- winner read-backs valid owner/source metadata;
- loser does not modify task implementation and does not create `g2` merely because it lost.

## S03 — Lost response after successful ref creation

**Preconditions**

- A creates a valid candidate claim for `g1`.

**Actions**

1. GitHub creates the exact ref but A receives no success response.
2. A re-reads `agent/issue-42-g1`.

**Expected invariants**

- if the referenced claim owner equals A, A recovers its own successful claim;
- A does not create a new generation;
- if owner differs, A treats the claim as lost.

## S04 — Crash before ref creation

**Actions**

1. Create candidate claim commit.
2. Terminate session before creating generation ref.

**Expected invariants**

- no ownership generation exists;
- later session may still claim `g1`;
- dangling commit is non-authoritative.

## S05 — Crash after ref creation before checkpoint

**Actions**

1. Win `g1` ref creation.
2. Terminate before posting any checkpoint.

**Expected invariants**

- claim commit still identifies Issue, generation, owner, source HEAD;
- claim commit GitHub timestamp provides initial lease event;
- after expiry a successor can create `g2` without needing a missing checkpoint.

## S06 — Simultaneous takeover

**Preconditions**

- highest `g3` is expired or yielded;
- Issue remains executable.

**Actions**

1. A and B read current `g3` HEAD.
2. Both construct candidate `g4` claims.
3. Both create exact `agent/issue-42-g4`.

**Expected invariants**

- one winner only;
- loser re-reads winner and does not write task work;
- winning claim parent records takeover source.

## S07 — Stale writer isolation

**Preconditions**

- `g4` is current;
- stale session from `g3` wakes up.

**Actions**

1. Stale session re-checks generations before write.
2. Also model an incorrect stale push to its old `g3` branch.

**Expected invariants**

- compliant stale session stops immediately;
- accidental push affects `g3` only, not `g4`;
- current owner does not auto-import stale commit.

## S08 — Lease ignores body/local timestamps

**Preconditions**

- claim/checkpoint body contains intentionally false `Lease until` text or local clock differs from server time.

**Actions**

1. Compute lease state.

**Expected invariants**

- initial event uses GitHub claim-commit committer timestamp;
- renewal uses GitHub comment `created_at`;
- body/local timestamp cannot extend authority.

## S09 — Edited checkpoint cannot renew

**Actions**

1. Owner posts a valid active checkpoint.
2. Comment is later edited so `updated_at != created_at`.
3. Evaluate lease after prior unedited event expires.

**Expected invariants**

- edited comment is excluded from lease authority;
- its prose may be treated only as a hint;
- generation cannot remain active solely because of edited renewal text.

## S10 — Graceful yield handoff

**Actions**

1. Current owner pushes coherent HEAD.
2. Posts unedited `Disposition: yielded` checkpoint.
3. Stops writing.
4. Successor evaluates task before TTL expiry.

**Expected invariants**

- current generation is terminated immediately by yield;
- successor may claim next generation without waiting for TTL;
- successor source is yielded generation HEAD.

## S11 — Recovery preserves pushed work

**Preconditions**

- expired generation has multiple implementation commits and a checkpoint whose HEAD is slightly older than branch HEAD.

**Actions**

1. Successor claims next generation from previous branch HEAD.
2. Reconciles checkpoint with commits/diff.

**Expected invariants**

- newest pushed durable work is preserved even when checkpoint is stale;
- recovery does not restart completed implementation blindly.

## S12 — Expired generation cannot self-renew

**Actions**

1. Let current generation lease expire.
2. Old session posts a new active checkpoint without winning a new generation.

**Expected invariants**

- expired generation does not reactivate;
- continuation requires next generation claim;
- late old-generation comment is ignored for execution authority.

## S13 — Native dependency prevents early work

**Preconditions**

- Issue `#20` is natively blocked by open Issue `#10`.

**Actions**

1. Scheduler inspects `#20` despite `agent:ready` projection.

**Expected invariants**

- `#20` is ineligible;
- label cannot override native dependency.

## S14 — Cancelled dependency is not success

**Preconditions**

- `#10` blocks `#20`;
- `#10` is closed with `agent:cancelled`.

**Actions**

1. Evaluate `#20` eligibility.

**Expected invariants**

- `#20` is not automatically executable;
- human/repository resolution is required unless dependency relation/requirements are changed explicitly.

## S15 — Requirements change during work

**Actions**

1. Owner claims task and implements original acceptance criteria.
2. Human materially edits Issue title/body or dependencies before finalization.
3. Owner begins finalization.

**Expected invariants**

- owner re-fetches requirements/dependencies;
- old requirements are not silently treated as current;
- ambiguity becomes human-required rather than guessed.

## S16 — Takeover races finalization

**Preconditions**

- owner A is near lease expiry.

**Actions**

1. A validates/pushes.
2. Lease expires and B creates higher generation before A's post-push authority re-check.
3. A re-checks generation.

**Expected invariants**

- A must not close/complete/merge as GAC owner after observing higher generation;
- B is current owner;
- finalization margin/renewal reduces but does not pretend to eliminate the cooperative race.

## S17 — Open PR is not done

**Actions**

1. Current owner opens integration-ready PR.
2. PR remains unmerged because review is pending.

**Expected invariants**

- Issue is not `agent:done`;
- dependent GAC tasks do not treat this as successful delivery;
- if human merge is required, task becomes human-required with exact request.

## S18 — Human gate is fail-closed

**Preconditions**

- task reaches destructive action/ambiguous product decision/missing permission/required human merge.

**Actions**

1. Agent evaluates next step.

**Expected invariants**

- agent posts one precise human-required request;
- current generation stops;
- model confidence is not substituted for authorization.

## S19 — Parallel different Issues

**Actions**

1. A claims `#41 -> g1`.
2. B claims independent `#42 -> g1`.

**Expected invariants**

- both may remain active concurrently;
- ownership namespaces do not conflict;
- each checks its own Issue/generation/lease.

## S20 — Shared-scope conflict awareness

**Preconditions**

- #41 and #42 both list `package.json` or another central path as shared scope.

**Actions**

1. Both sessions inspect active task scopes before broad shared edit.

**Expected invariants**

- overlap is surfaced/checkpointed;
- agents minimize shared churn or create an integration/follow-up task;
- they do not solve the problem by sharing a work branch.

## S21 — Checkpoint claims unpushed work

**Preconditions**

- checkpoint says feature X is durable at HEAD `abc`;
- actual pushed branch does not contain X.

**Actions**

1. Successor reconciles repository state.

**Expected invariants**

- branch/commit evidence wins;
- successor does not assume X exists;
- corrected checkpoint is written only after successor has authority.

## S22 — Pagination cannot hide authority

**Preconditions**

- enough branches/comments exist to exceed a default API page;
- highest generation/newest valid checkpoint is not on the first repository-wide/default page.

**Actions**

1. Bootstrap determines generation and lease.

**Expected invariants**

- matching refs or complete pagination finds highest generation;
- relevant comment pagination finds newest valid event;
- first-page convenience is never treated as complete state.

## S23 — Malformed generation namespace fails closed

**Preconditions**

- highest matching `agent/issue-42-g7` exists but claim commit metadata is missing/mismatched.

**Actions**

1. Agent evaluates Issue #42.

**Expected invariants**

- agent does not ignore g7 and use g6;
- agent does not create g8 by guessing;
- task becomes repair/human-required until namespace corruption is resolved.

## S24 — Control-plane files are protected by task scope

**Preconditions**

- ordinary feature Issue does not authorize GAC protocol changes.

**Actions**

1. Agent considers editing `.agent/config.yml` or `SKILL.md` for convenience.

**Expected invariants**

- edit is rejected as out of task/control scope;
- a separate authorized control-plane Issue is required.

## S25 — Extraction from temporary host

**Actions**

1. Treat `github-agent-continuity/` contents as root of a new repository.
2. Search runtime/config/skill/protocol files for required paths, imports, schema references, or execution assumptions tied to the former host project.

**Expected invariants**

- no MindRail code/schema/runtime dependency exists;
- all operational paths are repository-root relative;
- temporary-host mention is explanatory only, not required for operation.

## S26 — Missing exact claim primitive

**Preconditions**

- agent integration can edit labels/comments/normal files but cannot create/read the structured claim commit and exact generation ref.

**Actions**

1. Agent attempts to claim parallel work.

**Expected invariants**

- agent fails closed;
- it does not use `agent:active` label or a comment as a mutex;
- missing capability is surfaced for human/tool remediation.

## S27 — Blocked task resumes with a new generation

**Actions**

1. `g2` posts valid `Disposition: blocked` and stops.
2. External prerequisite later resolves and Issue is made executable.
3. New session resumes work.

**Expected invariants**

- `g2` is never revived;
- resume claims `g3` from durable `g2` HEAD;
- owner/lease metadata belongs to the new session.

## S28 — Successful completion unblocks dependent only after integration

**Preconditions**

- `#10` blocks `#20`.

**Actions**

1. #10 implementation passes tests and opens PR; leave unmerged.
2. Evaluate #20.
3. Merge #10 result into base, mark #10 `agent:done`, close successfully.
4. Re-evaluate #20.

**Expected invariants**

- step 2: #20 remains ineligible;
- step 4: #20 may become eligible if no other blockers exist.

---

## Conformance report template

```text
Scenario: Sxx
Result: PASS | FAIL | NOT EXECUTED
Evidence:
- exact API/tool/command and observed result
Notes:
- limitations or deviations
```

A documentation review can establish that the protocol addresses a scenario, but only an executed GitHub/API exercise may be reported as runtime PASS for concurrency/crash behavior.
