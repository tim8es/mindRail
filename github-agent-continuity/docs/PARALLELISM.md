# GAC Parallelism and Recovery v0.1

GAC permits parallel autonomous sessions when they work on different Issues and uses generation branches to serialize ownership of the same Issue.

The model is cooperative: compliant agents obey GitHub state and stop when fenced. It is not protection from a malicious repository writer.

## 1. Invariants

For one Issue:

1. At most one exact generation ref `gK` can be created.
2. The highest valid generation is the only generation eligible for execution.
3. A valid lease is required in addition to highest-generation status.
4. Once `g(K+1)` exists, every `<= gK` branch is stale forever.
5. Work branches are generation-specific, so stale writers do not share the current branch name.
6. Takeover begins from the previous generation HEAD captured at claim time.
7. No recovery step force-pushes an old/new generation branch.

Across different Issues, ownership is independent unless their declared scopes overlap.

## 2. Initial claim race

Two sessions see Issue `#42` with no generations.

```text
A: create candidate claim commit A
B: create candidate claim commit B

A: create refs/heads/agent/issue-42-g1 -> A
B: create refs/heads/agent/issue-42-g1 -> B
```

Only one exact ref creation succeeds. The losing candidate commit is non-authoritative.

The loser must re-read the winning ref/claim and select another task; it must not immediately attempt `g2` because a freshly created `g1` normally has an active lease.

## 3. Lost create-ref response

A network/tool response may disappear after GitHub created the ref.

The caller must read the exact ref back before deciding it lost:

- ref points to a valid claim whose `GAC-Owner` equals this session -> recover own successful claim;
- owner differs -> another session won;
- ref/claim malformed -> fail closed.

This makes the claim retry-safe without inventing another generation.

## 4. Crash windows

### Crash before ref creation

A candidate claim commit may exist without a branch. It grants no authority and can be ignored/garbage-collected.

### Crash after ref creation, before checkpoint

Authority is still recoverable because the winning claim commit already stores Issue, generation, owner, source HEAD, and a GitHub server timestamp. The next session can wait for expiry and take over even if no checkpoint was written.

### Crash after pushed work, before checkpoint

The branch is stronger evidence than checkpoint prose. Recovery inspects commits/diff and continues from pushed HEAD.

### Crash after checkpoint, before push

A checkpoint must never describe unpushed implementation as durable. If it does because an agent violated protocol, repository evidence wins and recovery disregards the prose claim.

## 5. Takeover race

Suppose `g3` is expired/yielded.

Two recovery sessions both:

1. read `g3` HEAD;
2. create candidate `g4` claim commits;
3. attempt exact `agent/issue-42-g4` ref creation.

Only one wins. The winner's claim parent identifies the durable takeover snapshot.

If `g3` receives a late stale push after that snapshot, the commit remains only on `g3`; it is not automatically imported into `g4`.

## 6. Stale owner behavior

A stale session may wake after a newer generation exists.

Before every consequential write it must re-read the highest generation. If stale, it stops.

Generation-specific branches also provide accidental-write isolation:

```text
stale owner -> agent/issue-42-g3
current     -> agent/issue-42-g4
```

A stale owner can still push to its old branch if it ignores protocol, but that cannot move `g4` or the base branch by branch-name accident. Current owners must not merge stale branches automatically.

## 7. Lease expiry vs finalization race

A session close to lease expiry must not begin finalization without margin.

Required sequence:

1. confirm highest generation;
2. confirm Issue executable;
3. if remaining lease < `finalization_margin_minutes`, renew;
4. validate/push;
5. re-read highest generation and Issue state after push;
6. only then create/merge PR or terminally transition Issue.

If another session creates a higher generation before step 5, the old owner loses authority and must not complete/close the task.

This is cooperative compare-before-finalize, not a single database transaction. Repository branch protection/review rules remain the final safety net for base-branch writes.

## 8. Yield handoff

For coarse scheduled execution, graceful yield is preferred over waiting for TTL.

Current owner:

1. pushes coherent progress;
2. posts unedited `Disposition: yielded` checkpoint;
3. stops writing.

Next session may create the next generation immediately. This avoids a one-scheduler-cycle idle gap.

A terminated generation never resumes itself, even if the same external agent identity starts the next session.

## 9. Parallel different Issues

Two sessions can safely own:

```text
agent/issue-41-g1
agent/issue-42-g1
```

provided their work is reasonably independent.

Each Issue should declare:

- **Primary scope** — paths expected to be owned mainly by this task.
- **Shared scope** — paths likely to overlap with other work.

The scope declaration is advisory, not a lock.

## 10. Shared-file conflicts

Typical shared paths include package manifests, dependency locks, central exports, migrations, generated indexes, repository config, and architecture docs.

When a task discovers material overlap with another active task:

1. inspect the other Issue/generation before broad edits;
2. minimize shared-file churn when possible;
3. checkpoint the integration risk;
4. prefer additive isolated changes;
5. use a dedicated integration/follow-up Issue when combining results is non-trivial.

Do not solve merge conflict risk by making multiple agents share one branch.

## 11. GAC control-plane files

Treat these as shared control scope by default:

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

Ordinary product Issues do not modify them. Protocol/template changes should be explicit control-plane Issues and preferably serialized.

## 12. Pull Requests across generations

v0.1 avoids a permanent shared PR/work branch.

Preferred rule: create the PR only when the current generation is integration-ready.

If human review requests implementation changes later:

1. current generation is terminated/yielded as appropriate;
2. create next generation from the latest intended durable work;
3. make review changes there;
4. supersede or close the stale PR when repository policy allows;
5. create/update integration using the current generation branch.

This produces more branches/occasional PR supersession but preserves stale-writer isolation.

## 13. Dependency parallelism

Parallelism is limited by native Issue dependencies.

If:

```text
#10 -> blocks #20
#11 -> blocks #20
```

then #10 and #11 may run in parallel, while #20 is ineligible until both are successfully completed according to GAC dependency semantics.

A cancelled prerequisite is not equivalent to successful completion.

## 14. Recovery priority

When selecting work, prefer recoverable interrupted work that is still strategically valid before opening unrelated new work, unless:

- it is blocked/human-required/cancelled;
- dependencies changed and made it ineligible;
- repository/human policy reprioritized it;
- current project goals explicitly supersede it.

This reduces abandoned branches and preserves continuity.

## 15. Branch growth

Every takeover creates a new generation branch. Long-running unstable tasks can accumulate many branches.

v0.1 keeps old generations as audit/recovery evidence and does not require garbage collection for correctness. A future maintenance protocol may delete old generations only after successful integration and a retention period.

Do not delete old generations during active recovery merely to reduce clutter.

## 16. What GAC cannot guarantee

With only shared GitHub repository permissions, GAC cannot prevent an authorized malicious/non-cooperative actor from:

- force-updating refs where repository policy permits;
- deleting/editing comments;
- closing/relabeling Issues incorrectly;
- merging unauthorized content if branch policy permits it.

Use GitHub permissions, branch protection/rulesets, CODEOWNERS/review requirements, and least privilege for security boundaries. GAC coordinates compliant workers; it does not replace those controls.
