# ADR-0004: Runtime state machine and concurrency semantics

- **Status:** Proposed
- **Date:** 2026-08-29
- **Depends on:** ADR-0001, ADR-0003

## Context

MindRail needs deterministic execution semantics before a persistence adapter, HTTP/MCP transport, Cloudflare runtime, or orchestration engine is implemented. The runtime must remain correct when multiple agents compete for work, sessions disappear, leases expire, commands are retried or delayed, and stale agents resume after another session has taken over.

ADR-0001 separates durable runtime state from agent sessions and transport adapters. ADR-0003 defines Goal, Task, Agent, Session, Lease, Checkpoint, PermissionRequest, PermissionDecision, and AuditEvent contracts; separates Task progress from Lease ownership; requires optimistic revisions for mutable resources; and requires monotonically increasing fencing tokens for successive task leases.

This ADR defines the runtime semantics that those contracts intentionally deferred. It does not choose persistence, transport, cloud infrastructure, scheduler implementation, or retry policy.

## Decision

### 1. Runtime authority and serialization model

MindRail evaluates execution authority against current authoritative runtime state, not client-local state or message send time.

Commands that inspect or mutate a Task's execution state or lease authority must have a single deterministic linearization order per Task. A future persistence implementation may provide that order with a transaction, compare-and-set loop, lock, actor, Durable Object, or another mechanism. This ADR requires the semantics, not a technology.

The runtime uses authoritative server time for expiry and staleness checks:

```text
lease is time-valid    iff now < Lease.expiresAt
lease is expired       iff now >= Lease.expiresAt
session is time-valid  iff now < Session.lastSeenAt + configuredSessionTimeout
session is stale       iff now >= Session.lastSeenAt + configuredSessionTimeout
```

Equality is expired/stale. A command sent before a deadline but admitted after it has no preserved authority.

For protocol commands that carry an idempotency key, exact replay lookup occurs before normal mutation checks. The key format, scope, storage, and retention are protocol/persistence decisions; the semantic requirement is that a confirmed replay does not execute the command twice.

### 2. Durable Task state is separate from transient execution ownership

MindRail retains all seven existing Task states because each represents a durable distinction not encoded by a Lease.

| Task status | Durable meaning                                                       | Claimable                                       | Effective active lease allowed |
| ----------- | --------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------ |
| `pending`   | Waiting for dependency success                                        | No                                              | No                             |
| `ready`     | Dependencies satisfied and eligible for first execution               | Yes                                             | No before claim                |
| `running`   | Execution has begun and the Task is incomplete                        | Yes, only when no effective active lease exists | Yes                            |
| `blocked`   | Explicitly paused pending external resolution or control-plane action | No                                              | No                             |
| `succeeded` | Successfully completed                                                | No                                              | No                             |
| `failed`    | Execution ended unsuccessfully; explicit retry is required to reopen  | No                                              | No                             |
| `cancelled` | Explicitly abandoned/stopped                                          | No                                              | No                             |

`running` is persisted Task state. It is **not** derived from the presence of an active Lease.

An effective active Lease implies `Task.status = running`, but `Task.status = running` does not imply an active Lease. A running Task may temporarily have no active Lease after release, expiry, revocation, session death, crash, or handoff. That state is recoverable by a later claim without rewinding the Task to `ready`.

Lease renewal, release, expiry, revocation, or reassignment do not by themselves change Task status.

### 3. Task readiness and dependency semantics

A dependency is satisfied only when the referenced Task is `succeeded`.

For Task `T`:

```text
T.dependenciesSatisfied =
  every dependencyTaskId resolves to a Task with status == succeeded
```

Binding dependency rules from ADR-0003 remain in force:

- every dependency belongs to the same Workspace and Goal;
- self-dependencies are forbidden;
- the dependency graph is acyclic.

Initial runtime status is authoritative, not client-selected:

- a newly created Task whose dependencies are all satisfied starts `ready`;
- otherwise it starts `pending`.

When a dependency succeeds, the runtime reevaluates direct pending dependents and promotes each Task whose full dependency set is now satisfied from `pending` to `ready`.

A dependency in `pending`, `ready`, `running`, `blocked`, `failed`, or `cancelled` does not satisfy the dependent Task. A failed dependency may later be explicitly retried and eventually succeed, so dependent Tasks are not automatically failed or cancelled. A cancelled dependency can therefore leave dependents permanently pending until the Goal is explicitly failed/cancelled or a future task-definition feature changes the graph. This is intentional in v0.1; automatic failure/cancellation cascades are not introduced.

Dependency graph editing after creation is outside this ADR. If added later, it must preserve workspace/goal isolation, acyclicity, and deterministic readiness reconciliation.

### 4. Task transition table

Task state changes require authoritative runtime commands; agents do not submit arbitrary Task snapshots.

| From      | To          | Trigger                      | Required conditions                                                | Lease side effect                                          |
| --------- | ----------- | ---------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `pending` | `ready`     | dependency reconciliation    | Goal active; every dependency succeeded                            | none                                                       |
| `pending` | `blocked`   | explicit block               | Goal active; authorized controller action                          | none                                                       |
| `pending` | `cancelled` | task/Goal cancellation       | authorized controller action                                       | none                                                       |
| `ready`   | `running`   | first successful `ClaimTask` | Goal active; eligible Session/Agent; no effective active Lease     | create Lease                                               |
| `ready`   | `blocked`   | explicit block               | Goal active; authorized controller action                          | none                                                       |
| `ready`   | `cancelled` | task/Goal cancellation       | authorized controller action                                       | none                                                       |
| `running` | `blocked`   | accepted block command       | current valid execution authority, or authorized controller action | release if owner-initiated; revoke if controller-initiated |
| `running` | `succeeded` | accepted completion          | current valid execution authority                                  | release current Lease                                      |
| `running` | `failed`    | accepted failure             | current valid execution authority                                  | release current Lease                                      |
| `running` | `cancelled` | task/Goal cancellation       | authorized controller action                                       | revoke current Lease if present                            |
| `blocked` | `ready`     | explicit unblock             | Goal active; dependencies satisfied                                | none                                                       |
| `blocked` | `pending`   | explicit unblock             | Goal active; dependencies not satisfied                            | none                                                       |
| `blocked` | `cancelled` | task/Goal cancellation       | authorized controller action                                       | none                                                       |
| `failed`  | `ready`     | explicit `RetryTask`         | Goal active; dependencies satisfied; no effective active Lease     | none                                                       |
| `failed`  | `pending`   | explicit `RetryTask`         | Goal active; dependencies not satisfied; no effective active Lease | none                                                       |

All other Task status transitions are illegal in v0.1.

`succeeded`, `failed`, and `cancelled` are terminal for ordinary execution. `failed` may be reopened only by explicit `RetryTask`. `succeeded` and `cancelled` never reopen in place; a new Task is required.

There is no automatic retry, retry count, retry backoff, retry policy, or persisted Attempt entity in v0.1. Each accepted retry is an explicit audited Task mutation. A later need for independently addressable attempts requires a new domain/ADR decision.

Runtime commands that set `blocked`, `failed`, or `cancelled` must supply a bounded `Reason`; the runtime writes it as `statusReason`. Returning to `pending`, `ready`, or `running`, or succeeding, clears the previous status reason.

A Checkpoint whose `kind` is `blocked` does not itself transition the Task to `blocked`, and a Checkpoint whose `kind` is `result` does not itself complete the Task. Task transitions require their explicit runtime commands.

### 5. Lease authority model

A Lease is the temporary execution authority for exactly one Session to execute exactly one Task.

#### 5.1 Effective active Lease

A Lease is effective and authoritative only when all of the following hold at command admission:

1. `Lease.status = active`;
2. authoritative `now < Lease.expiresAt`;
3. its Session is effectively active;
4. the Session's Agent is active;
5. the Lease, Session, Task, and Agent resolve within the same Workspace;
6. the Task is `running`;
7. the Lease is the unique current effective Lease for that Task.

A Lease row whose status still says `active` after its deadline is not authoritative. Expiry may be materialized lazily as `expired`; authority ends at the timestamp regardless of cleanup timing.

A Lease owned by an ended/expired/stale Session is also non-authoritative even if its own `expiresAt` is later. When encountered, the runtime may materialize that Lease as `revoked`.

#### 5.2 Claim algorithm

`ClaimTask` executes at the Task serialization point.

1. Resolve Task, Goal, Session, and Agent and verify same-Workspace references.
2. Require Goal `active`.
3. Require Session effectively active and Agent `active`.
4. Require exact capability satisfaction:

   ```text
   Task.requiredCapabilities ⊆ Agent.capabilities
   ```

5. Inspect the Task's current effective Lease.
   - If another Session owns an effective Lease, reject the claim.
   - If the same Session already owns the effective Lease, return that Lease unchanged. This semantic duplicate must not mint a new Lease or fencing token.
6. If an old persisted `active` Lease is no longer effective, close it before granting:
   - TTL elapsed → `expired`;
   - owner Session no longer effective or controller invalidation → `revoked`.
7. Require Task `ready`, or Task `running` with no effective active Lease.
8. If the command carries `expectedTaskRevision`, require an exact match before mutation.
9. Allocate a new fencing token strictly greater than every token previously granted for this Task.
10. Create a new Lease with a new Lease id, the new fencing token, `status = active`, and a server-selected expiry.
11. If the Task was `ready`, transition it to `running` and increment its Task revision. If it was already `running`, Task status and revision do not change solely because ownership changed.
12. Record the accepted grant in AuditEvent.

The fencing sequence is per Task. A simple implementation may use `lastToken + 1`, but gaps are allowed. Tokens are never reused. Renewal does not increment the fencing token.

#### 5.3 Renewal

A Lease renewal is accepted only when:

- the caller presents the current Lease id, owning Session id, and exact fencing token;
- the Lease is effective at admission time;
- `expectedLeaseRevision` matches the current Lease revision;
- the owning Session and Agent remain effectively active;
- the Task remains `running`.

An accepted renewal strictly extends `expiresAt`, increments Lease `revision`, and leaves Task status/revision and fencing token unchanged.

Two renewals carrying the same expected Lease revision cannot both mutate the Lease. One linearizes first; the other observes a revision mismatch. If they are exact replays of one idempotent protocol command, the duplicate returns the recorded result instead of executing again.

#### 5.4 Release

The current Lease owner may release an effective Lease by presenting the current Lease id, Session id, fencing token, and expected Lease revision. Accepted release changes Lease status to `released` and increments Lease revision.

Release does not change a running Task back to `ready`. The Task remains `running` and may be reclaimed with a strictly higher fencing token.

#### 5.5 Revocation

The control plane may revoke an active Lease without owner consent. Revocation immediately removes execution authority and increments Lease revision when materialized.

Revocation alone leaves the Task `running`; cancellation or controller-driven blocking may combine Task transition and Lease revocation in the same authoritative operation.

#### 5.6 Expiry

Lease authority ends automatically when `now >= expiresAt`. A background expiration worker is not required for correctness.

Any command that encounters an elapsed `active` Lease may materialize it as `expired`. A new claim must close any stale persisted active Lease before creating the replacement.

### 6. Fencing and executor mutation admission

Every Task-scoped executor mutation must present:

- Task id;
- Session id;
- Lease id;
- the Lease fencing token.

The runtime accepts the mutation only if those values identify the current effective Lease for that Task at the linearization point.

A matching Task revision without a matching current Lease/fence is never sufficient authority.

A stale agent that resumes after release, expiry, revocation, Session death, or reassignment therefore cannot checkpoint, complete, fail, block, or create a new task-scoped PermissionRequest against authoritative state.

#### 6.1 Checkpoint admission

Checkpoint is append-only and does not mutate Task or Lease revisions.

A Checkpoint is accepted only if:

- Task, Session, Lease, and Checkpoint belong to the same Workspace;
- the Task is `running`;
- the Session/Lease pair is the current effective Lease owner;
- the Checkpoint Lease id and fencing token exactly match that current Lease.

Once admitted, the Checkpoint remains valid historical evidence even if the Lease expires or the Task is reassigned immediately afterward.

#### 6.2 Completion, failure, and block admission

Agent-issued completion, failure, or block requires all Checkpoint authority checks plus exact `expectedTaskRevision` matching.

Accepted completion:

- transitions Task `running -> succeeded`;
- increments Task revision;
- clears `statusReason`;
- releases the current Lease.

Accepted failure:

- transitions Task `running -> failed`;
- increments Task revision;
- writes the supplied `statusReason`;
- releases the current Lease.

Accepted block:

- transitions Task `running -> blocked`;
- increments Task revision;
- writes the supplied `statusReason`;
- releases the current Lease.

Task mutation and removal of that Lease's authority are one logical authoritative operation. A persistence implementation must not expose a state in which a terminal/blocked Task still authorizes executor writes.

### 7. Session model

`Agent` and `Session` remain distinct authorities:

- Agent = logical execution identity and declared capabilities;
- Session = one concrete execution/connectivity lifetime for that Agent.

A Session starts `active` with server-authored `lastSeenAt`.

Legal Session transitions are:

| From     | To        | Trigger                                              |
| -------- | --------- | ---------------------------------------------------- |
| `active` | `active`  | accepted heartbeat updates `lastSeenAt` and revision |
| `active` | `ended`   | explicit end                                         |
| `active` | `expired` | staleness timeout observed/materialized              |

`ended` and `expired` never return to `active`. Reconnection after Session death creates a new Session id.

A heartbeat uses authoritative server time and is accepted only while the Session is still effectively active. A heartbeat admitted at or after the staleness boundary cannot resurrect the Session; it is rejected and the Session may be materialized as `expired`.

Session heartbeat does not renew Task Leases. Lease renewal and Session liveness are separate operations.

Once a Session becomes ended, expired, or stale, all of its Leases cease to be effective immediately even if their Lease rows have not yet been materialized as revoked. Task status does not change because of Session loss.

### 8. Recovery after Lease or Session loss

Recovery requires no special Task reset.

For a Task currently `running`:

1. evaluate whether an effective active Lease exists;
2. if the persisted active Lease has elapsed, materialize it `expired`;
3. if its owner Session is no longer effective, materialize it `revoked`;
4. leave Task status `running`;
5. allow an eligible active Session to claim the Task;
6. grant a new Lease id with a fencing token strictly greater than all earlier grants;
7. reject every later mutation from older Lease ids/tokens.

Checkpoint/evidence history remains attached to the Task and is available to the recovery client through future context/protocol operations.

A `blocked` Task is not automatically recovered by claiming. It must first be explicitly unblocked, after which it returns to `ready` or `pending` according to dependency satisfaction.

### 9. Goal lifecycle and aggregation

The v0.1 Goal lifecycle remains intentionally small:

```text
active -> succeeded
active -> failed
active -> cancelled
```

Goal terminal states never reopen in place.

Rules:

1. a Goal starts `active`;
2. Tasks may be created or retried only while their Goal is `active`;
3. a non-empty active Goal automatically becomes `succeeded` when every Task under that Goal is `succeeded`;
4. Task failure does **not** automatically fail the Goal because failed Tasks may be explicitly retried;
5. Goal `failed` is an explicit control-plane/human/system decision that means the objective will not continue in that Goal;
6. Goal `cancelled` is an explicit abandonment/stop decision;
7. failing or cancelling a Goal cancels every nonterminal Task under it and revokes any effective active Leases; already succeeded/failed/cancelled Tasks retain their terminal history;
8. no new Task may be added after a Goal is terminal.

The last Task completion and concurrent Task creation must linearize against the Goal so only one outcome is possible: either creation happens first and is included in aggregation, or Goal success happens first and later creation is rejected.

Goal success criteria beyond "all Tasks succeeded" are not evaluated by a model or workflow engine in v0.1. Rich project-management aggregation is deferred.

### 10. Parent/child semantics

The v1 domain has no `parentTaskId` or other Task hierarchy field. It models Tasks under a Goal plus dependency edges.

Therefore v0.1 has no parent/child completion propagation. Decomposition creates peer Tasks under the same Goal and expresses ordering through `dependencyTaskIds` only. A future persistent Task hierarchy requires a separate domain/ADR decision.

### 11. Cancellation semantics

Task cancellation is an authorized control-plane mutation, not an executor success/failure result.

Cancellation is legal from `pending`, `ready`, `running`, or `blocked`.

If cancellation linearizes while an effective Lease exists, the Task becomes `cancelled` and that Lease loses authority in the same logical operation, normally by revocation. Later executor mutations are rejected even if they carry the old Task revision or fencing token.

A terminal Task is not rewritten to `cancelled` merely because its Goal is later cancelled. Historical succeeded/failed/cancelled outcomes remain unchanged.

### 12. Optimistic revisions

`revision` and `fencingToken` solve different concurrency problems:

- `revision` prevents lost updates to a mutable resource;
- `fencingToken` prevents an obsolete execution owner from exercising authority.

A command that carries an expected revision must match the resource's current revision at its linearization point. Mismatch rejects the mutation with no partial state change.

Executor commands still require a current Lease/fence even when the Task revision matches.

Examples:

- two controllers editing/cancelling the same Task with revision 12: at most one mutation from expected revision 12 succeeds;
- two Lease renewals from Lease revision 7: at most one state change from expected revision 7 succeeds;
- an old Session with Task revision 20 but stale fencing token 4 is rejected after token 5 has been granted.

Exact protocol error codes and response envelopes are deferred.

### 13. Permission boundary

Agents may create `PermissionRequest` records only while they hold current effective execution authority for the Task, and the request must contain the current Task/Session/Lease/fencing context.

Agents may never author or select a `PermissionDecision` outcome. Runtime admission must enforce ADR-0003 decision authorship:

- policy decisions are system-authored;
- human decisions are human-authored;
- `HUMAN_REQUIRED` is policy-only and grants no authority;
- an agent-supplied `ALLOW`, `DENY`, basis, policy attribution, or human attribution is never treated as authoritative.

The lifetime/consumption semantics of an `ALLOW` decision after Lease release, blocking, or reassignment are intentionally deferred to the permission-policy/protocol slice. This ADR only guarantees that stale agents cannot mint new PermissionRequests and cannot forge PermissionDecision authority.

### 14. Deterministic race outcomes

| Scenario                                                                         | Deterministic result                                                                                                                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two different Sessions claim the same `ready` Task                               | One claim linearizes first, transitions the Task to `running`, and receives the only effective Lease. The loser cannot mutate and receives current-state conflict/rejection.  |
| Duplicate `ClaimTask` with the same protocol idempotency key                     | Replay the original result; do not create another Lease or fencing token.                                                                                                     |
| Same Session semantically claims a Task it already effectively leases            | Return the existing Lease unchanged; do not increment Lease/Task revision or fencing token.                                                                                   |
| Two renewals race with the same `expectedLeaseRevision`                          | One succeeds; the other observes revision mismatch. Same-key replay returns the first result.                                                                                 |
| Completion races with Lease expiry                                               | The Task serialization point and authoritative clock decide. If completion linearizes while `now < expiresAt`, it may succeed. At/after expiry it is rejected.                |
| Checkpoint races with reassignment                                               | If admitted before old authority ends, the Checkpoint is accepted historical evidence. If reassignment/new fence linearizes first, the old Checkpoint is rejected.            |
| `expectedRevision` mismatch                                                      | Reject without Task/Lease/Session mutation. Idempotent exact replay remains a replay, not a new mutation.                                                                     |
| Delayed `RetryTask` arrives after the Task has succeeded                         | Reject because retry is legal only from `failed`. `succeeded` never reopens in place.                                                                                         |
| Duplicate complete/fail command with same idempotency key                        | Replay the first command result exactly; no second mutation.                                                                                                                  |
| Duplicate complete/fail command with a different key after one already succeeded | Reject because the Task is terminal and/or the Lease is no longer effective.                                                                                                  |
| Cancellation races with completion                                               | One terminal transition wins the Task serialization order. If completion wins, later cancel rejects. If cancel wins, Lease authority is removed and later completion rejects. |
| Session heartbeat races with staleness boundary                                  | Heartbeat admitted before the boundary may update `lastSeenAt`; heartbeat at/after the boundary cannot resurrect the Session.                                                 |
| Old Session resumes after a replacement Lease is granted                         | Every Task-scoped executor mutation from the old Lease/fence is rejected regardless of local progress or matching old revisions.                                              |

### 15. Formal invariants

| ID   | Invariant                                                                                                                                      | Enforcement point                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| I-01 | Every non-Workspace record and every cross-record reference stays within one Workspace.                                                        | all command admission / persistence constraints                  |
| I-02 | Task dependencies reference Tasks in the same Workspace and Goal, never self-reference, and remain acyclic.                                    | Task creation/domain validation                                  |
| I-03 | At most one effective active Lease exists per Task.                                                                                            | Lease grant serialization                                        |
| I-04 | Every effective active Lease belongs to exactly one effectively active Session; that Session belongs to one Agent.                             | Lease admission and Session liveness checks                      |
| I-05 | An effective active Lease implies `Task.status = running`.                                                                                     | grant and Task transition admission                              |
| I-06 | `Task.status = running` may have zero effective active Leases during crash/release/expiry/recovery windows.                                    | state-machine definition                                         |
| I-07 | Each successful new Lease grant uses a fencing token strictly greater than every earlier grant for that Task. Tokens are never reused.         | Lease grant serialization / token allocator                      |
| I-08 | Lease renewal never changes the fencing token; release/revocation/expiry never mint a token.                                                   | Lease transition logic                                           |
| I-09 | Task-scoped executor mutations require exact current Task/Session/Lease/fence authority. A stale Lease cannot mutate authoritative Task state. | checkpoint/completion/failure/block/permission-request admission |
| I-10 | `Task.requiredCapabilities` is a subset of the selected Agent's capabilities at Lease grant, and the Agent must be active.                     | ClaimTask admission                                              |
| I-11 | Mutable resource revisions increase monotonically on accepted mutation; supplied expected revisions must match exactly.                        | all mutable-resource commands                                    |
| I-12 | `succeeded` and `cancelled` Tasks never return to execution states. `failed` returns only through explicit audited retry.                      | Task transition reducer                                          |
| I-13 | No effective Lease exists for `pending`, `ready`, `blocked`, `succeeded`, `failed`, or `cancelled` Tasks.                                      | grant/transition side effects                                    |
| I-14 | Checkpoints are append-only and are admitted only for the correct Workspace, Task, Session, Lease id, and current fencing token.               | Checkpoint admission                                             |
| I-15 | PermissionRequest is append-only and task-scoped to current Lease/fence authority at creation.                                                 | PermissionRequest admission                                      |
| I-16 | PermissionDecision outcome/authorship cannot be forged by an Agent; ADR-0003 policy/human attribution rules remain binding.                    | permission decision admission                                    |
| I-17 | Lease and Session expiry use authoritative runtime time; client timestamps/send time cannot extend authority.                                  | clock/command admission                                          |
| I-18 | Once a Session is ended/expired/stale, it cannot become active again; recovery creates a new Session.                                          | Session reducer                                                  |
| I-19 | Goal terminal states never reopen; no Task is created/retried under a terminal Goal.                                                           | Goal/Task admission                                              |
| I-20 | Goal failure/cancellation removes authority from all nonterminal work under that Goal while preserving already-terminal Task history.          | Goal transition logic                                            |

### 16. Executable test plan

No formal verification framework is introduced for v0.1. The runtime implementation should expose pure transition/admission functions over an in-memory state model with an injectable authoritative clock. Vitest is sufficient.

#### 16.1 Transition-table tests

Create table-driven tests that enumerate every legal Task, Session, Lease, and Goal transition and assert:

- accepted next state;
- exact revision increments;
- required Lease side effects;
- statusReason set/clear behavior;
- AuditEvent emission expectations.

For every state, enumerate all non-listed target transitions and assert rejection with byte-for-byte unchanged authoritative resources, except an allowed bounded rejection audit record.

Suggested files:

```text
test/runtime/task-transitions.test.ts
test/runtime/session-transitions.test.ts
test/runtime/lease-transitions.test.ts
test/runtime/goal-aggregation.test.ts
```

#### 16.2 Concurrency/interleaving tests

Use a test adapter with an explicit atomic/serialization primitive and barriers to force race orders.

Required cases:

- two Sessions claim one ready Task;
- same Session duplicate claim;
- two renewals with the same expected Lease revision;
- completion vs expiry boundary;
- completion vs cancellation;
- checkpoint vs Lease reassignment;
- Session end/expiry vs Lease renewal;
- Goal success aggregation vs concurrent Task creation.

For each race, run both possible linearization orders where meaningful and assert that all final states satisfy the invariant table.

#### 16.3 Stale-Lease recovery tests

With a fake clock:

1. grant Lease token `n` to Session A;
2. advance to `expiresAt` or expire/end Session A;
3. claim from Session B and assert new token `> n`;
4. submit Checkpoint, CompleteTask, FailTask, BlockTask, and PermissionRequest from Session A;
5. assert every stale mutation is rejected and no authoritative Task mutation occurs;
6. assert Session B remains the only effective owner.

Repeat for release, revocation, Session staleness, and controller cancellation.

#### 16.4 Duplicate/idempotency tests

Against a minimal command-deduplication interface supplied by the protocol/runtime boundary:

- replay the same successful ClaimTask key and verify identical Lease/result with no new token;
- replay the same successful CompleteTask/FailTask key and verify no second Task revision change;
- replay the same rejected command key and verify a stable recorded rejection when the protocol chooses to persist definitive rejections;
- send a semantically identical command under a new key after state has advanced and verify normal current-state validation rather than replay.

The key syntax, dedupe scope, and retention window remain outside this ADR.

#### 16.5 Revision tests

For every mutable command that accepts an expected revision:

- current revision succeeds;
- current revision + 1 rejects;
- previous revision rejects;
- mismatch causes no partial Task/Lease/Session/Goal mutation;
- stale fencing token rejects even when expected Task revision is correct.

#### 16.6 Invariant/property tests without a new framework

Use deterministic seeded command-sequence generation in Vitest rather than adding a model-checking/property-testing dependency.

Generate bounded sequences over a small fixture state (for example one Goal, two Tasks, two Agents, three Sessions) containing:

- claim;
- renew;
- release;
- clock advance;
- heartbeat/end Session;
- checkpoint;
- block/unblock;
- complete/fail/retry;
- cancel Task/Goal.

After every accepted or rejected command, run one invariant assertion function implementing I-01 through I-20. Persist failing seeds as regression tests.

Additionally, exhaustively enumerate short interleavings for the highest-risk one-Task/two-Session sequences. This provides useful small-state model coverage without adopting a formal verification framework.

#### 16.7 Cross-record security tests

Explicitly test rejection of:

- cross-Workspace Goal/Task/Session/Lease/Checkpoint references;
- cross-Goal dependencies;
- dependency cycles/self-reference;
- Agent missing one required capability;
- disabled Agent claim;
- stale/ended Session claim or renewal;
- Checkpoint with wrong Session, Lease id, or fence;
- Agent-authored PermissionDecision or forged human/system attribution.

### 17. Decisions intentionally deferred

This ADR deliberately does **not** decide:

- database/storage technology, schema, indexes, locks, compare-and-set primitives, or transaction boundaries;
- Cloudflare Workers, Durable Objects, D1, queues, or any provider infrastructure;
- HTTP, MCP, CLI, or vendor-specific operation names and payloads;
- protocol error-code taxonomy and response envelopes;
- idempotency-key syntax, namespace, persistence, retention, or garbage collection;
- concrete Lease TTL, Session timeout, heartbeat cadence, renewal cadence, or bounded extension policy;
- scheduler fairness, priorities, affinity, work stealing, or task-discovery ranking;
- automatic retry counts, exponential backoff, retry budgets, or failure classification;
- a persistent Attempt entity or Task parent/child hierarchy;
- mutation semantics for Task dependency graphs after creation;
- permission `ALLOW` lifetime/consumption across blocking, release, or Lease reassignment;
- authentication, human identity mapping, or transport credentials;
- audit retention/indexing/storage implementation;
- evidence/artifact storage;
- LLM planning, automatic decomposition, or success-criteria reasoning;
- GitHub integration or declarative workflow configuration.

These choices must preserve the state, fencing, revision, isolation, and permission invariants defined here.

## Alternatives considered

### Derive `running` entirely from active Lease presence

Rejected. Lease loss is an ownership event, not proof that durable execution progress never began. Deriving `running` from Lease presence would silently rewind a crashed/released Task to a pre-execution state and blur the difference between initial scheduling and recovery.

### Return a Task to `ready` whenever its Lease ends

Rejected for the same reason. Recovery of an already-started Task should remain distinguishable from first execution. A running Task with no Lease is a valid recovery state.

### Add a persistent Attempt entity now

Rejected for v0.1. Explicit retry plus immutable Checkpoint/Audit history is sufficient to preserve deterministic authority without adding a new durable lifecycle. If attempts later need independent identity, query, policy, or artifacts, that requires a new domain decision.

### Event sourcing for concurrency and recovery

Rejected. ADR-0003 explicitly keeps current-state records plus append-only audit rather than reconstructing authority from an event log. Event sourcing adds replay/versioning/projection complexity that is unnecessary for these invariants.

### Automatic failure/cancellation propagation through dependencies

Rejected. It would introduce project-management policy and make explicit retry harder. v0.1 requires only that a dependency be `succeeded` before a dependent becomes ready.

### Distributed consensus / workflow-engine semantics

Rejected. The required guarantee is deterministic serialization of conflicting commands against authoritative state. Persistence adapters can provide that guarantee without introducing a consensus system, workflow DSL, or Temporal-like runtime into the protocol architecture.

## Consequences

- Task progress survives process crashes and Lease turnover without conflating ownership with lifecycle.
- Fencing tokens make stale-agent resurrection safe even when old messages arrive after reassignment.
- Optimistic revisions remain useful for normal mutable-resource concurrency and are not overloaded as execution authority.
- Session death is recoverable without rewriting Task history.
- Failure recovery is explicit and auditable rather than driven by hidden retry policy.
- Some Tasks may remain pending behind permanently unsatisfied dependencies until a user/control-plane decision resolves the Goal; this is preferable to implicit cascades in v0.1.
- Persistence implementations must provide a per-Task serialization/atomicity boundary strong enough to enforce Lease uniqueness, fencing, and Task/Lease transition side effects.
- Goal aggregation needs a deterministic consistency boundary with Task creation/completion, but this does not mandate a particular database or distributed coordination system.

## Compatibility and migration

No runtime implementation or persisted runtime data exists yet, so no data migration is required.

This ADR does not change the JSON shapes defined by ADR-0003. It gives concrete lifecycle meaning to existing Task, Session, Lease, Goal, Checkpoint, PermissionRequest, PermissionDecision, revision, and fencing-token fields.

If these lifecycle semantics become externally consumed protocol behavior, materially incompatible changes require a new ADR and may require a new major contract/protocol version under ADR-0003 compatibility rules.
