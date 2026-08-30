# GAC v0.1 Conformance Scenarios

These scenarios define expected protocol behavior. They can be exercised manually or automated later with GitHub API tests.

`PASS` means the expected invariant was actually observed. Documentation reasoning alone is not runtime PASS evidence.

## S01 — Cold start selects eligible work

**Preconditions:** zero chat context; one executable `agent:ready` Issue; another ready-looking Issue blocked by native dependency.

**Actions:** run bootstrap and reconcile memory, Issues, dependencies, claim/work refs, PR/CI, checkpoints.

**Expected:** blocked task is not claimable; eligible task can be identified without prior chat; no implementation write precedes recovery.

## S02 — Simultaneous initial claim

**Preconditions:** Issue #42 eligible; no `gac-claim/issue-42-gK` exists.

**Actions:** A/B create candidate g1 claim commits; both create exact `gac-claim/issue-42-g1`.

**Expected:** exactly one claim-ref creation succeeds; winner read-backs valid owner/source/work metadata; loser does not implement or create g2 merely because it lost.

## S03 — Winner creates work branch separately

**Actions:** g1 winner creates `agent/issue-42-g1` at claim `GAC-Source-Head`.

**Expected:** work ref points to source, not claim commit; claim ref remains unchanged; implementation commits advance work ref only.

## S04 — Lost claim-ref response

**Actions:** GitHub creates exact claim ref but A receives no success response; A reads claim back.

**Expected:** matching `GAC-Owner` lets A recover its own successful claim if lease valid; different owner means loss; no unnecessary next generation.

## S05 — Lost work-ref response

**Actions:** owner creates work branch but loses response; reads work ref back.

**Expected:** valid work ref at source/descendant is reusable by same current claim owner; incompatible branch fails closed.

## S06 — Crash before claim ref

**Actions:** create candidate claim commit; terminate before claim-ref creation.

**Expected:** no ownership exists; later session may still claim g1; dangling commit non-authoritative.

## S07 — Crash after claim before work ref

**Actions:** win claim ref; terminate before work branch creation/checkpoint.

**Expected:** claim commit still provides Issue/generation/owner/source/work-name/server time; after expiry successor can take over using prior claim source.

## S08 — Crash after pushed work before checkpoint

**Preconditions:** valid work branch has new pushed commits; latest checkpoint older.

**Expected:** recovery sources next generation from actual previous work HEAD; branch evidence wins over stale checkpoint.

## S09 — Simultaneous takeover

**Preconditions:** g3 claim expired/yielded; prior work branch valid.

**Actions:** A/B read prior work HEAD, create candidate g4 claims, race exact `gac-claim/issue-42-g4`.

**Expected:** one winner; winning claim records takeover source; only winner creates/uses g4 work branch.

## S10 — Stale writer isolation

**Preconditions:** g4 current; stale g3 session wakes.

**Actions:** stale session re-checks claims; also model incorrect push to `agent/issue-42-g3`.

**Expected:** compliant stale session stops; accidental push touches g3 only, never g4; current owner does not auto-import stale commit.

## S11 — Lease ignores body/local timestamps

**Actions:** use false body timestamp/local clock skew; compute authority.

**Expected:** claim commit GitHub committer time starts lease; valid comment GitHub `created_at` renews; body/local values cannot extend authority.

## S12 — Edited checkpoint cannot renew

**Actions:** post valid active checkpoint, edit it (`updated_at != created_at`), allow prior unedited event to expire.

**Expected:** edited comment excluded from lease authority; prose may remain hint only.

## S13 — Expired generation cannot self-renew

**Actions:** let lease expire; old owner posts later active checkpoint without new claim.

**Expected:** generation stays expired; continuation requires next claim/work generation.

## S14 — Graceful yield handoff

**Actions:** owner pushes work, posts unedited `Disposition: yielded`, stops; successor evaluates before TTL.

**Expected:** generation terminated immediately; next claim may be created without waiting; takeover source is yielded work HEAD.

## S15 — Recovery when prior work branch never existed

**Preconditions:** prior claim exists/expired; owner crashed before work-ref creation.

**Expected:** successor uses prior claim `GAC-Source-Head` as next claim source; missing work branch is not mistaken for corruption when claim says no work was ever created.

## S16 — Native dependency prevents early work

**Preconditions:** #20 natively blocked by open #10, even if #20 has `agent:ready`.

**Expected:** #20 ineligible; label cannot override native dependency.

## S17 — Cancelled dependency is not success

**Preconditions:** #10 blocks #20; #10 closed with `agent:cancelled`.

**Expected:** #20 does not auto-run; dependency/requirements require explicit resolution.

## S18 — Requirements change during work

**Actions:** human materially changes Issue title/body/dependencies after claim; owner begins finalization.

**Expected:** owner re-fetches requirements/dependencies; old criteria are not silently treated current; ambiguity becomes human-required.

## S19 — Takeover races finalization

**Actions:** A pushes near expiry; lease expires and B wins higher claim before A post-push re-check.

**Expected:** A must not complete/close/merge as GAC owner after seeing higher claim; B is current owner. Finalization margin reduces but does not fake transactional atomicity.

## S20 — Open PR is not done

**Actions:** current owner opens integration-ready PR; leave unmerged.

**Expected:** Issue not `agent:done`; dependents not successfully unblocked; required human merge becomes precise human-required state.

## S21 — Claim metadata excluded from PR/base history

**Preconditions:** claim ref points to empty claim commit; work ref starts at claim source and has product commits.

**Actions:** compare PR from work branch to base; inspect ancestry.

**Expected:** claim commit is not a work-branch ancestor solely because of GAC ownership and does not need to enter base history during normal integration.

## S22 — Human gate is fail-closed

**Preconditions:** destructive action, materially ambiguous product choice, missing permission, or required human merge.

**Expected:** one precise human-required request; generation stops; model confidence never substitutes for authorization.

## S23 — Parallel different Issues

**Actions:** A owns `gac-claim/issue-41-g1` + `agent/issue-41-g1`; B independently owns Issue 42 pair.

**Expected:** both may remain active; namespaces independent; each checks its own claim/lease.

## S24 — Shared-scope conflict awareness

**Preconditions:** #41/#42 both declare central shared path.

**Expected:** overlap surfaced/checkpointed; agents minimize churn or create integration task; they do not share a work branch.

## S25 — Checkpoint claims unpushed work

**Preconditions:** checkpoint claims feature X durable; actual work branch lacks X.

**Expected:** Git evidence wins; successor does not assume X exists; corrected checkpoint only after authority.

## S26 — Pagination cannot hide authority

**Preconditions:** enough claim refs/comments to exceed default page; highest/newest not first page.

**Expected:** matching refs/complete pagination finds highest claim; relevant comment pagination finds newest valid event.

## S27 — Malformed claim namespace fails closed

**Preconditions:** highest `gac-claim/issue-42-g7` exists but claim metadata malformed/mismatched.

**Expected:** agent does not ignore g7/use g6 or guess-create g8; repair/human-required until resolved.

## S28 — Work branch conflicts with claim source

**Preconditions:** valid g3 claim declares source A, but `agent/issue-42-g3` exists on unrelated history B.

**Expected:** fail closed; do not treat branch as current work and do not overwrite/force-push it.

## S29 — Claim ref immutability

**Actions:** after claim creation, attempt ordinary implementation workflow.

**Expected:** no implementation commit advances `gac-claim/...`; all work goes to `agent/...`; changing claim ref is protocol violation/corruption.

## S30 — Control-plane files protected by task scope

**Preconditions:** ordinary feature Issue lacks GAC control-plane authorization.

**Expected:** agent does not edit `.agent/config.yml`, skill, or protocol docs for convenience; separate authorized control Issue required.

## S31 — Extraction from temporary host

**Actions:** treat `github-agent-continuity/` contents as new repository root; search operational files for host-project dependencies.

**Expected:** no MindRail code/schema/runtime dependency; root-relative operational paths; temporary-host mentions explanatory only.

## S32 — Missing exact claim primitive

**Preconditions:** tool can edit labels/comments/files but cannot create/read candidate claim commit + exact claim ref.

**Expected:** fail closed; no label/comment mutex; missing capability surfaced.

## S33 — Blocked task resumes with new generation

**Actions:** g2 posts valid blocked disposition/stops; prerequisite later resolves; new session resumes.

**Expected:** g2 never revived; g3 claim created from latest valid g2 work HEAD (or claim source if no work); new owner/lease metadata.

## S34 — Successful dependency unblocks only after integration

**Preconditions:** #10 blocks #20.

**Actions:** #10 tests pass/open PR but unmerged -> evaluate #20; then merge result, mark #10 done/close successfully -> re-evaluate.

**Expected:** #20 ineligible before integration; may become eligible after successful terminal state if no other blockers.

## S35 — Claim winner crashes after work ref creation

**Actions:** win claim, create work ref at source, crash before product commit/checkpoint.

**Expected:** work ref remains valid at source; after lease expiry successor may take over using that same HEAD; no control commit is in work ancestry.

## S36 — Previous work receives late stale push during takeover

**Actions:** successor reads g3 work HEAD A; stale g3 pushes B after read; successor wins g4 claim using A.

**Expected:** g4 source remains A; B stays stale on g3; B is not auto-salvaged because wall-clock is newer.

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

A documentation review can show that the protocol addresses a scenario, but only an executed GitHub/API exercise may be reported as runtime PASS for concurrency/crash behavior.
