# Durable Application Composition Design

**Status:** Proposed for implementation

**Date:** 2026-08-29

**Depends on:** ADR-0001, ADR-0003, ADR-0004, ADR-0005, `docs/architecture/02_CLOUDFLARE_RUNTIME_PERSISTENCE.md`

## Goal

Make the existing MindRail application/protocol surface durable without creating a second runtime authority. A command may be handled by a fresh process/runtime instance and still continue from the exact D1-backed Workspace state, preserve protocol idempotency, preserve fencing/revision authority, and produce the same lifecycle/permission behavior already verified by the in-memory reference runtime.

The first durable dogfood loop is:

```text
RegisterAgent
→ StartSession
→ CreateGoal
→ CreateTask
→ ClaimTask
→ RecordCheckpoint
→ RequestPermission
→ RecordPermissionDecision
→ CompleteTask
```

Restart must be supported at least after `ClaimTask` and after a `HUMAN_REQUIRED` permission decision.

## Non-goals

This slice does not:

- create a second `DurableControlPlane` with independently reimplemented lifecycle semantics;
- introduce event sourcing;
- make Durable Object memory authoritative;
- deploy Cloudflare Workers or claim production deployment readiness;
- add GitHub/Codex/ChatGPT integrations;
- add new domain entities or change canonical JSON Schema;
- add a policy DSL, IAM system, credential minting, or model-based policy authority;
- complete every ADR-0005 query/lifecycle command before the first restart-safe vertical slice is proven.

## Architecture decision

Use **rehydrate → execute existing semantics → persist atomically**.

For each admitted durable command:

1. Enter the existing Workspace serialization boundary.
2. Resolve an existing durable `(workspaceId, commandId)` receipt before execution.
3. Load the authoritative Workspace state from `DurableRuntimePersistence`.
4. Rehydrate an ephemeral execution model that uses the existing runtime lifecycle and permission semantics rather than defining a parallel state machine.
5. Execute the command against that ephemeral model.
6. Persist the authoritative delta plus audit/receipt in one D1 atomic boundary appropriate to that command.
7. Return the stored protocol result/error snapshot.
8. Discard all ephemeral state after the request.

D1 remains the only durable source of truth. The ephemeral runtime is a computation mechanism, not a state authority.

## Why this approach

### Rejected: second durable runtime implementation

A new `DurableControlPlane` that reimplements `ClaimTask`, permission handling, task completion, and Goal terminalization would create two semantic authorities. The local runtime and durable runtime would inevitably drift, forcing duplicate tests and making ADR-0004/ADR-0005 semantics dependent on adapter choice.

### Deferred: full pure reducer rewrite

A pure reducer/transition engine fed by arbitrary persisted snapshots would be the cleanest long-term form, but extracting every current lifecycle path into reducers before v0.1 would materially expand scope and regression risk. This design does not prevent that refactor later; the durable composition boundary should make it easier.

### Chosen: ephemeral rehydration over authoritative persistence

This preserves one semantic implementation while proving restart behavior now. Persistence still enforces its own relational, revision, fencing, receipt, and transaction invariants as the final durable correctness guard.

## Authority model

The following hierarchy is mandatory:

```text
Canonical JSON Schema
        ↓ record validity
ADR-0004 / ADR-0005 runtime semantics
        ↓ execution semantics
DurableRuntimePersistence / D1
        ↓ authoritative durable state and concurrency guards
Application dispatcher
        ↓ protocol command/query entry point
HTTP / MCP adapters
```

Neither HTTP/MCP nor application composition may grant authority independently.

Durable Object/Workspace coordinator memory may serialize requests but cannot hold correctness-relevant state that is absent from D1.

## Required code boundaries

### Durable application dispatcher

Add a durable application composition implementing the existing `ApplicationDispatcher` port. It must accept the same `ApplicationCommand` / `ApplicationQuery` surface as the in-memory dispatcher.

It owns orchestration only:

- receipt lookup/replay;
- Workspace serialization entry;
- snapshot loading;
- runtime rehydration;
- command execution;
- durable commit selection;
- persistence/application error translation;
- durable query reads.

It must not encode a second Task/Lease/permission state machine.

### Runtime rehydration seam

The existing runtime needs an explicit supported way to be initialized from a canonical `WorkspaceStateSnapshot`.

Rehydration must restore, at minimum:

- Workspace;
- Agents;
- Sessions;
- Goals;
- Tasks;
- Leases;
- effective Lease identity derived from authoritative records/time;
- Checkpoints;
- permission requests/decision chains;
- per-Task fencing counters.

Command receipts are not loaded into the ephemeral runtime as durable authority. Durable receipt resolution happens before runtime execution through persistence.

If a state relationship is inconsistent on load, fail closed as an integrity error; do not silently repair or invent state.

### Persistence command boundaries

Existing D1 atomic methods remain the durable commit primitives. For protocol parity, every mutation in the first durable loop must be able to store its command receipt in the same atomic boundary as its state change.

Therefore the persistence port must extend receipt-aware atomic writes for:

- `createAgent`;
- `createSession`;
- `appendCheckpoint`;
- `appendPermissionDecision`.

Existing receipt-aware methods for Goal, Task, Claim, permission-request + initial decision, and completion remain in use.

A receipt contains the immutable bounded protocol terminal result/error snapshot, not a reference to mutable rows.

## Idempotency

The key is exactly:

```text
(workspaceId, commandId)
```

Before mutation, durable composition checks for a stored receipt:

- same semantic fingerprint → return the stored terminal response with `replayed: true` and current retry correlation metadata where ADR-0005 permits;
- different semantic fingerprint/command → `IDEMPOTENCY_CONFLICT`;
- no receipt → continue admission/execution.

If the D1 mutation commits but response delivery is lost, the next process instance must return the stored immutable response without executing the domain mutation again.

No in-memory command receipt is authoritative in durable composition.

## Rehydration and time

Rehydration uses authoritative server time supplied by the composition/runtime clock.

Persisted `active` Session/Lease rows that are already ineffective by timestamp remain non-authoritative even before cleanup is materialized. Command execution must use the existing stale-session/stale-lease semantics and persistence guards.

The slice does not require a background cleanup worker to prove correctness. Lazy materialization plus timestamp-based authority is sufficient for the first restart-safe E2E.

## Durable first-loop command mapping

### RegisterAgent

- execute canonical runtime admission/record construction;
- atomically persist Agent + receipt;
- replay only from durable receipt.

### StartSession

- validate referenced active Agent through existing semantics;
- atomically persist Session + receipt.

### CreateGoal / CreateTask

- use existing receipt-aware persistence methods;
- preserve Goal-active and dependency invariants.

### ClaimTask

- runtime determines intended claim semantics;
- persistence remains final fence authority and allocates the durable fencing token;
- the result returned to the caller must reflect the persisted Task/Lease, not a speculative ephemeral token;
- same-Session semantic duplicate may return the current effective Lease without advancing the fence;
- competing process instances must result in at most one new Lease grant.

### RecordCheckpoint

- require current Session/Task/Lease/fence authority;
- atomically persist Checkpoint + receipt.

### RequestPermission

- deterministic policy evaluation remains in the current permission engine;
- atomically persist PermissionRequest + initial PermissionDecision + head + receipt;
- `HUMAN_REQUIRED` does not grant execution authority.

### RecordPermissionDecision

- human-only follow-up;
- expected predecessor must match the persisted permission head;
- atomically append immutable PermissionDecision, update head, and store receipt.

### CompleteTask

- use existing completion atomic boundary;
- persist result checkpoint + Task success + Lease release + optional Goal success + receipt together;
- stale/replaced authority after restart must fail closed.

## Queries in the first slice

The durable dispatcher must support the reads needed to verify the first loop without falling back to ephemeral state:

- `GetWorkspace`;
- `GetGoal`;
- `GetTask`;
- `GetLease`;
- `ListTaskCheckpoints`;
- `GetAgent`;
- `GetSession`;
- `GetPermissionRequest`;
- `ListPermissionDecisions`;
- `ListPendingHumanPermissions`.

`ListClaimableTasks` should be added in the same slice if the persistence read can be implemented without inventing semantics. It is advisory only; `ClaimTask` always revalidates under the serialized durable mutation path.

Any still-unsupported query must return the canonical bounded unsupported error; it must never read from a stale retained in-memory runtime.

## Error translation

The durable application dispatcher maps persistence failures into the existing protocol/application error taxonomy. It must not leak SQL, D1 bindings, internal stack traces, Durable Object identifiers, or credentials.

Expected mappings include:

- persistence `NOT_FOUND` → protocol/application `NOT_FOUND`;
- `REVISION_MISMATCH` → `REVISION_MISMATCH`;
- `STALE_AUTHORITY` → `STALE_AUTHORITY`;
- `IDEMPOTENCY_CONFLICT` → `IDEMPOTENCY_CONFLICT`;
- `INVALID_STATE_TRANSITION` → `INVALID_STATE_TRANSITION`;
- persistence integrity/invalid-record failures → fail closed as bounded `CONFLICT` or `INTERNAL_ERROR` according to whether the caller can safely act on the error.

Exact mapping must remain deterministic and tested.

## Audit

This slice must not manufacture audit history separately from the state mutation. Where the current D1 method supports `auditEvent`, the event is committed in the same atomic boundary as the mutation and receipt.

If the current runtime does not yet produce complete AuditEvents for a command, the durable composition must not claim complete audit coverage. Missing audit production can remain a later explicit slice; durable application integration must not introduce a second ad-hoc audit model.

## Restart-safe E2E acceptance tests

Use the existing SQLite-backed D1 harness to exercise real migrations and persistent database files.

### Restart after ClaimTask

1. Create durable dispatcher instance A over a database file.
2. Register Agent, start Session, create Goal/Task, claim Task.
3. Destroy A and close the database handle.
4. Open dispatcher instance B over the same database file.
5. Verify Task remains `running`, Lease remains authoritative with the same fence, and a checkpoint can be recorded.
6. Complete the Task from B using the original persisted execution authority.

### Restart after HUMAN_REQUIRED

1. Run through `RequestPermission(repository.write)` and receive `HUMAN_REQUIRED`.
2. Destroy the process/composition instance.
3. Reopen the same database.
4. List/read the pending request from D1.
5. Record human `ALLOW` using the persisted predecessor decision id.
6. Complete the original Task with still-current execution authority.

### Response-loss/idempotency restart

1. Execute a mutation and persist its receipt.
2. Simulate losing the returned response by discarding the first application instance.
3. Retry the exact same command id/semantic request through a new instance.
4. Receive `replayed: true` with the immutable original result.
5. Assert the state mutation occurred exactly once.

### Competing instances

1. Create two durable dispatcher instances over the same database/Workspace coordination test boundary.
2. Race two Sessions claiming one ready Task.
3. Assert only one new effective Lease/fence commits.
4. The loser receives a bounded conflict/stale result.
5. Reopening the database confirms a single authoritative active Lease and monotonic fencing counter.

## Verification gates

Before integration:

- focused RED tests must fail for the missing durable composition/restart behavior;
- focused GREEN tests must pass after implementation;
- existing in-memory runtime, protocol, permission, persistence, HTTP, and MCP tests must remain green;
- `pnpm check` must pass on the exact PR head;
- `pnpm test:coverage` must execute on the exact PR head;
- a post-merge permanent `Quality` run on `main` must pass before the slice is called complete.

No unexecuted test may be described as passing.

## Delivery sequence

1. Extend persistence atomic receipt parity for Agent, Session, Checkpoint, and human PermissionDecision.
2. Add supported runtime snapshot rehydration without changing canonical contracts.
3. Add durable application dispatcher and deterministic error translation.
4. Implement durable reads required by the restart E2E.
5. Add restart-after-claim, restart-after-permission, exact-replay-after-restart, and competing-instance tests.
6. Run full quality/coverage and reconcile `CURRENT_STATE`, v0.1 roadmap, and changelog.

## Exit condition

This slice is complete when the same application/protocol workflow can cross a real process/application restart using the same D1-backed Workspace and continue safely with preserved Session/Lease/fencing/permission/idempotency authority.

Completion of this slice does **not** mean MindRail v0.1 is production-ready. Cloudflare deployment verification, remaining lifecycle parity, agent acquisition/bootstrap, GitHub integration, and real Codex/ChatGPT dogfooding remain separate gates.