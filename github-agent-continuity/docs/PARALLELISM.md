# GAC Parallelism and Recovery v0.1

GAC permits parallel autonomous sessions on different Issues and serializes ownership of the same Issue through immutable generation claim refs plus generation-specific work branches.

The model is cooperative: compliant agents obey GitHub state and stop when fenced. It is not protection from a malicious repository writer.

## 1. Per-Issue invariants

1. At most one exact claim ref `gac-claim/issue-N-gK` can be created for generation K.
2. Highest valid **claim** generation is the only generation eligible for execution.
3. A valid lease is required in addition to highest-generation status.
4. Claim refs are immutable control metadata; they never receive implementation commits.
5. Work refs are generation-specific: `agent/issue-N-gK`.
6. Once claim `g(K+1)` exists, every `<= gK` claim/work generation is stale forever.
7. Takeover source is previous valid work HEAD, or prior claim source when no work branch existed.
8. Recovery never force-pushes/rebases claim or work refs.
9. Claim commits do not enter product work ancestry/base history.

Across different Issues, ownership is independent unless declared scopes overlap.

## 2. Initial claim race

Two sessions see eligible Issue `#42` with no claim generations:

```text
A: candidate claim commit A
B: candidate claim commit B

A: create gac-claim/issue-42-g1 -> A
B: create gac-claim/issue-42-g1 -> B
```

Only one exact claim-ref creation succeeds. Losing candidate commit is non-authoritative.

Winner then creates/validates work branch:

```text
agent/issue-42-g1 -> GAC-Source-Head
```

Loser re-reads winning claim and selects other work; it does not create `g2` merely because it lost.

## 3. Lost responses

### Claim-ref response lost

Read exact claim ref back:

- valid claim owner equals this session -> recover own successful claim if lease valid;
- owner differs -> another session won;
- malformed -> fail closed.

### Work-ref response lost

Read expected work branch back. If current claim is yours and branch equals/descends from expected source according to protocol, continue; incompatible branch is corruption.

Do not manufacture a new generation to handle ambiguous API responses.

## 4. Crash windows

### Before claim-ref creation

Candidate claim commit grants no ownership and can be garbage-collected.

### After claim-ref creation, before work-ref creation

Ownership/lease remains recoverable because immutable claim stores owner, source, expected work branch, and server timestamp. No product branch exists yet. After expiry a successor uses prior claim source as takeover source.

### After work-ref creation, before work commit/checkpoint

Work branch exists at source; no progress is lost. Claim still controls lease.

### After pushed work, before checkpoint

Work branch is stronger evidence than checkpoint prose. Recovery continues from pushed HEAD.

### After checkpoint, before push

Protocol says checkpoint must not claim unpushed implementation as durable. If violated, work branch wins over prose.

## 5. Takeover race

Suppose claim `g3` expired/yielded.

Both recovery sessions:

1. read valid `agent/issue-42-g3` HEAD if it exists, else g3 claim source;
2. create candidate g4 claim commits from their observed source;
3. attempt exact `gac-claim/issue-42-g4` creation.

Only one wins. Its immutable claim commit identifies authoritative takeover source. Winner then creates `agent/issue-42-g4` at that source.

If stale g3 pushes after source snapshot, that commit stays only on g3 and is not auto-imported.

## 6. Stale owner isolation

A stale session waking after newer claim exists must stop before consequential write.

Branch isolation:

```text
stale work   -> agent/issue-42-g3
current work -> agent/issue-42-g4
current claim-> gac-claim/issue-42-g4
```

A non-compliant stale writer may still push to old work branch if permissions allow, but cannot move current generation branch by branch-name accident. Current owner never auto-merges stale branches.

## 7. Why claims are not in work history

If claim commits were ancestors of work branches, repeated handoffs could add many empty control commits to a PR/base when using merge/rebase integration.

Separating refs yields:

```text
source ---- product commits ---- work gK ---- PR
   \
    \-- empty claim commit ---- gac-claim gK
```

Claim metadata remains stable/readable while product history stays clean. Squash merge is no longer required merely to hide GAC control commits.

## 8. Lease expiry vs finalization race

A session near expiry must not finalize without margin:

1. confirm highest claim;
2. confirm Issue executable;
3. renew if remaining lease < `finalization_margin_minutes`;
4. validate/push work;
5. re-read highest claim + Issue state after push;
6. only then create/merge PR or terminally transition.

If higher claim appears before step 5, old owner loses authority and must not complete/close task.

This is cooperative compare-before-finalize, not a single database transaction. Branch protection/review policy remains safety boundary for base writes.

## 9. Yield handoff

For scheduled execution, graceful yield is preferred:

1. push coherent progress to current work branch;
2. post unedited `Disposition: yielded` checkpoint;
3. stop writing.

Next session may claim next generation immediately and source from yielded work HEAD. A terminated generation never resumes itself.

## 10. Parallel different Issues

Two sessions can safely own:

```text
gac-claim/issue-41-g1 + agent/issue-41-g1
gac-claim/issue-42-g1 + agent/issue-42-g1
```

provided work is reasonably independent.

Each Issue declares:

- **Primary scope** — expected task-owned paths.
- **Shared scope** — likely overlap requiring integration care.

Scope is advisory, not a filesystem lock.

## 11. Shared-file conflicts

Typical shared paths: manifests/lockfiles, central exports, migrations, generated indexes, repo config, architecture docs.

When material overlap appears:

1. inspect other active Issue/claim/work state;
2. minimize broad shared edits;
3. checkpoint integration risk;
4. prefer additive isolated changes;
5. create integration/follow-up Issue when combination is non-trivial.

Never solve conflict risk by sharing one work branch across tasks/sessions.

## 12. GAC control-plane scope

Shared by default:

```text
.agent/**
.agents/**
.github/ISSUE_TEMPLATE/**
.github/pull_request_template.md
docs/DESIGN.md
docs/PROTOCOL.md
docs/STATE_MODEL.md
docs/PARALLELISM.md
```

Ordinary product Issues do not modify these. Protocol/template changes require explicit control-plane Issues and preferably serialized integration.

## 13. Pull Requests across generations

v0.1 avoids permanent shared PR/work branch.

Preferred rule: create PR only when current generation work is integration-ready.

If review later requests implementation changes:

1. terminate/yield current generation as appropriate;
2. create next claim from latest intended work HEAD;
3. create next work branch at same source;
4. make review changes there;
5. supersede/close stale PR when appropriate;
6. integrate from current work generation.

This may create occasional PR supersession but preserves stale-writer isolation and keeps claim control commits outside product history.

## 14. Dependency parallelism

If:

```text
#10 -> blocks #20
#11 -> blocks #20
```

then #10/#11 may run concurrently, while #20 remains ineligible until both are successfully completed per GAC semantics. Cancelled prerequisite is not success.

## 15. Recovery priority

Prefer strategically valid recoverable interrupted work before unrelated new work unless blocked/human-required/cancelled, dependencies changed, repository policy reprioritized it, or project goals supersede it.

This reduces abandoned generations and preserves continuity.

## 16. Ref growth

Each takeover creates one immutable claim ref and normally one work branch. Long unstable tasks accumulate refs.

v0.1 keeps old generations for recovery/audit and defers garbage collection. A future maintenance protocol may delete old work/claim refs only after successful integration plus retention policy.

Do not delete active/recovery evidence merely to reduce clutter.

## 17. Security boundary

With shared GitHub write permissions, GAC cannot stop an authorized malicious/non-cooperative actor from updating refs where allowed, deleting/editing comments, closing/relabeling Issues incorrectly, or merging content when branch policy allows.

Use GitHub permissions, branch protection/rulesets, CODEOWNERS/reviews, and least privilege for actual security. GAC coordinates compliant workers; it does not replace those controls.
