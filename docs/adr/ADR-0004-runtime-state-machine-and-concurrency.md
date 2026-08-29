# ADR-0004: Runtime state machine and concurrency semantics

- **Status:** Accepted
- **Date:** 2026-08-29
- **Depends on:** ADR-0001, ADR-0003

## Context

MindRail must remain correct when several agents compete for work, sessions disappear, leases expire, requests are retried or delayed, and stale executors resume after reassignment.

ADR-0003 deliberately separates durable Task state from Session and Lease ownership, requires optimistic revisions for mutable resources, and requires monotonically increasing fencing tokens for successive Task leases. This ADR defines the deterministic runtime semantics that persistence and protocol adapters must preserve.

It does not select a database, transport, cloud provider, scheduler, retry policy, or workflow DSL.

## Decision

### 1. Authority and linearization

Runtime decisions use current authoritative state and authoritative server time, never client-local state or message send time.

Task-scoped execution operations have one deterministic linearization order per Task. Operations that change the membership or terminal state of a Goal have one deterministic linearization order for the affected Goal aggregate.

The Goal-level rule is required because `CreateTask`, Task completion with automatic Goal success, `CancelGoal`, and `FailGoal` can otherwise race. In particular:

- `CreateTask` is accepted only while the Goal is still `active` at the Goal linearization point;
- automatic Goal success observes the authoritative complete Task set at the same Goal linearization boundary;
- a Goal cannot become `succeeded` concurrently with an accepted new Task;
- Goal cancellation/failure and Task creation cannot both succeed in an order that leaves new work under a terminal Goal.

An implementation may realize these orders with transactions, compare-and-set loops, actors, locks, Durable Objects, or another mechanism. The semantics are binding; the technology is not.

Time boundaries are half-open:

```text
lease valid   iff now < lease.expiresAt
lease expired iff now >= lease.expiresAt
session valid iff now < session.lastSeenAt + sessionTimeout
session stale iff now >= session.lastSeenAt + sessionTimeout
```

A request sent before a deadline but admitted after it has no preserved authority.

### 2. Task state is durable; Lease ownership is transient

Task v1 keeps seven states:

| Status | Meaning | Claimable |
| --- | --- | --- |
| `pending` | waiting for dependencies | no |
| `ready` | dependencies satisfied, not yet executing | yes |
| `running` | execution has begun and work is incomplete | yes only when no effective Lease exists |
| `blocked` | explicitly paused | no |
| `succeeded` | completed successfully | no |
| `failed` | execution ended unsuccessfully | no until explicit retry |
| `cancelled` | explicitly abandoned/stopped | no |

`running` is persisted. It is not derived from Lease presence.

An effective active Lease implies `Task.status = running`, but a running Task may temporarily have no Lease after release, expiry, revocation, crash, session loss, or handoff. Such a Task is recoverable without rewinding it to `ready`.

Lease renewal, release, expiry, revocation, and reassignment do not by themselves change Task status.

### 3. Dependencies and readiness

A dependency is satisfied only when the referenced Task is `succeeded`.

All dependencies must:

- belong to the same Workspace and Goal;
- not reference the Task itself;
- form an acyclic graph.

Task creation chooses initial status deterministically:

```text
all dependencies succeeded -> ready
otherwise                  -> pending
```

When a Task succeeds, direct `pending` dependents are reevaluated and promoted to `ready` when all dependencies are now satisfied.

Failure or cancellation of a dependency does not automatically fail/cancel downstream Tasks in v0.1. A failed dependency may be retried. A cancelled dependency can leave dependents pending until the Goal is explicitly terminated or a future task-definition feature changes the graph.

### 4. Task transitions

| From | To | Trigger |
| --- | --- | --- |
| `pending` | `ready` | dependency reconciliation |
| `pending` | `blocked` | authorized block |
| `pending` | `cancelled` | task/Goal cancellation |
| `ready` | `running` | first accepted `ClaimTask` |
| `ready` | `blocked` | authorized block |
| `ready` | `cancelled` | task/Goal cancellation |
| `running` | `blocked` | accepted block |
| `running` | `succeeded` | accepted completion |
| `running` | `failed` | accepted failure |
| `running` | `cancelled` | authorized cancellation |
| `blocked` | `ready` | unblock when dependencies are satisfied |
| `blocked` | `pending` | unblock when dependencies are not satisfied |
| `blocked` | `cancelled` | cancellation |
| `failed` | `ready` | explicit `RetryTask` |

All other Task transitions are illegal in v0.1.

A Task can reach `failed` only after it was `running`, which means its dependencies were already satisfied. v0.1 dependencies are immutable and succeeded Tasks never reopen, so `failed -> pending` is intentionally not a legal transition.

`succeeded` and `cancelled` never reopen in place. `failed` reopens only through explicit `RetryTask`. There is no automatic retry, retry counter, retry backoff, or persistent Attempt entity in v0.1.

Blocking/failure/cancellation stores a bounded `Reason` in `statusReason`; returning to active work or succeeding clears the prior reason.

A `Checkpoint(kind = blocked)` does not itself block a Task, and `Checkpoint(kind = result)` does not itself complete one. State changes require explicit runtime commands.

### 5. Effective Lease

A Lease is effective only if all of these are true at admission:

1. Lease status is `active`;
2. `now < expiresAt`;
3. owning Session is effectively active;
4. Session Agent is active;
5. Lease, Session, Agent, and Task belong to the same Workspace;
6. Task is `running`;
7. this is the unique current effective Lease for the Task.

Persisted `active` rows past expiry are non-authoritative. Expiry may be materialized lazily. A Lease owned by a stale/ended Session is also immediately non-authoritative and may be materialized as `revoked`.

### 6. Claim and fencing

`ClaimTask` linearizes at the Task boundary and requires:

- active Goal;
- effective Session and active Agent;
- `Task.requiredCapabilities` to be a subset of `Agent.capabilities`;
- Task `ready`, or `running` with no effective Lease;
- current Task revision when required by the protocol.

If another Session owns the effective Lease, reject.

If the **same Session already owns the effective Lease**, return that existing Lease unchanged. This semantic duplicate does not create another Lease, does not increment revisions, and does not mint another fencing token.

Before a replacement grant, any stale persisted active Lease is closed as `expired` or `revoked` as appropriate.

Each new grant receives a fencing token strictly greater than every token previously granted for that Task. Tokens are never reused; gaps are allowed. Renewal does not change the fencing token.

On first claim, `ready -> running` and Task revision increments. Reclaiming a Lease-less `running` Task does not change Task status/revision solely because ownership changed.

### 7. Renewal, release, revocation, expiry

Lease renewal requires current Lease id, owning Session, exact fencing token, effective Lease, and expected Lease revision. It extends `expiresAt` using server policy and increments Lease revision.

Release by the current owner changes Lease status to `released` and increments Lease revision. The Task remains `running` and recoverable.

Control-plane revocation immediately removes authority and increments Lease revision when materialized. Revocation alone leaves the Task `running`.

Authority ends automatically at `expiresAt`; cleanup is not required for correctness.

### 8. Executor mutation admission

Every Task-scoped executor mutation presents:

```text
taskId
sessionId
leaseId
fencingToken
```

The runtime accepts it only when these identify the current effective Lease at the linearization point. A matching Task revision alone never grants execution authority.

Therefore a stale agent cannot checkpoint, complete, fail, block, or create a Task-scoped PermissionRequest after its Lease is released, expired, revoked, or replaced.

#### Checkpoints

Checkpoint creation is append-only and accepted only under current Lease authority. An accepted checkpoint remains historical evidence after later reassignment.

#### Complete / fail / block

Agent-issued completion, failure, or block additionally requires the exact expected Task revision.

The Task mutation and removal of the current Lease's authority are one logical atomic operation:

- complete: `running -> succeeded`, Task revision +1, clear reason, release Lease;
- fail: `running -> failed`, Task revision +1, set reason, release Lease;
- block: `running -> blocked`, Task revision +1, set reason, release Lease.

No persistence adapter may expose a terminal/blocked Task while still accepting executor writes through the old Lease.

### 9. Session lifecycle

`Agent != Session`.

Agent is logical execution identity/capabilities. Session is one concrete connectivity/execution lifetime.

Session transitions:

```text
active -> active   heartbeat
active -> ended    explicit end
active -> expired  staleness observed/materialized
```

Ended/expired Sessions never reactivate; reconnecting creates a new Session id.

Session heartbeat and Lease renewal are separate operations. Session loss immediately makes its Leases ineffective even if their rows have not yet been materialized as revoked.

### 10. Recovery

For a `running` Task without an effective Lease:

1. materialize expired/revoked old Lease when needed;
2. leave Task `running`;
3. allow an eligible active Session to claim it;
4. grant a new Lease id and strictly higher fencing token;
5. reject every later mutation from older Lease/token pairs.

Durable checkpoints/evidence remain attached to the Task for handoff.

A blocked Task must be explicitly resumed before it can be claimed.

### 11. Goal lifecycle

Goal lifecycle is deliberately small:

```text
active -> succeeded
active -> failed
active -> cancelled
```

Terminal Goals never reopen in place.

Rules:

- Tasks may be created or retried only under an `active` Goal;
- a non-empty active Goal automatically succeeds when, at the Goal linearization point, every authoritative Task under it is `succeeded`;
- Task failure does not automatically fail the Goal because failed Tasks may be retried;
- Goal failure is an explicit controller/human/system decision;
- Goal cancellation is an explicit stop decision;
- failing or cancelling a Goal cancels every nonterminal Task and revokes every effective Lease under the Goal as one logical Goal-level operation;
- Task creation and Goal terminalization are mutually ordered by the Goal linearization boundary.

### 12. Required race outcomes

| Race | Required result |
| --- | --- |
| two Sessions claim one Task | at most one new Lease commits |
| same Session claims its already leased Task | return existing Lease unchanged |
| two renewals use same Lease revision | one mutates; the other gets revision mismatch unless it is exact idempotent replay |
| completion vs Lease expiry | authoritative admission order/time decides; at/after expiry completion is rejected |
| checkpoint vs reassignment | checkpoint accepted only if old authority linearizes first |
| cancellation vs completion | one terminal operation wins; the loser is rejected |
| stale executor after reassignment | all old-fence mutations rejected |
| `CreateTask` vs automatic Goal success | exactly one Goal-level order; cannot accept Task beneath a Goal already terminalized by the competing operation |
| `CreateTask` vs `CancelGoal`/`FailGoal` | exactly one Goal-level order; no accepted new Task may survive under the terminal Goal |
| delayed `RetryTask` after a different terminal transition | reject unless current Task state is exactly `failed` |

### 13. Invariants

The implementation and tests must preserve:

1. at most one effective Lease per Task;
2. each effective Lease belongs to one effective Session;
3. fencing tokens strictly increase on every new grant for a Task;
4. stale Lease/fence pairs never authorize writes;
5. mutable accepted updates increment revision exactly once;
6. all Task dependencies stay within one Workspace and Goal and remain acyclic;
7. required capabilities are an exact subset of the selected Agent's capabilities;
8. checkpoints reference the Task/Session/Lease/fence that authorized them;
9. an Agent cannot forge PermissionDecision authority;
10. terminal Task states do not reopen except `failed -> ready` through explicit retry;
11. terminal Goals do not accept new/retried Tasks;
12. automatic Goal success and Task-set mutation are serialized consistently.

### 14. Verification requirements

Runtime implementation must include executable tests for:

- every legal and illegal Task transition;
- dependency readiness and DAG validation;
- concurrent claims;
- same-Session semantic duplicate claim;
- Lease renewal/release/expiry/revocation;
- monotonic fencing across recovery;
- stale checkpoint/completion rejection;
- Session staleness and recovery;
- exact revision conflicts;
- duplicate/idempotent commands once protocol support exists;
- cancellation/completion races;
- Goal auto-success vs concurrent `CreateTask`;
- Goal cancellation/failure vs concurrent `CreateTask`;
- permission authority invariants.

No unexecuted concurrency scenario may be described as runtime-verified.

## Alternatives considered

### Derive `running` solely from Lease presence

Rejected. Task progress must survive Lease/session loss and be reclaimable without pretending execution never began.

### Add a persistent Attempt entity now

Rejected. v0.1 can express explicit retry and Lease generations without another authority concept. Add Attempt only if independently addressable attempts become a demonstrated requirement.

### Event sourcing

Rejected. Current-state records plus append-only AuditEvents are sufficient and materially simpler.

### Per-provider concurrency semantics

Rejected. Correctness belongs to the transport/vendor-neutral runtime contract.

## Consequences

- Protocol and persistence implementations must enforce Task fencing and Goal aggregate ordering.
- A Task may legitimately be `running` without an active Lease.
- Recovery is explicit and safe rather than based on local executor assumptions.
- Runtime tests must exercise race behavior, not only happy-path transitions.
- Persistence implementations may optimize serialization, but database constraints/revisions/fencing remain final correctness guards.
