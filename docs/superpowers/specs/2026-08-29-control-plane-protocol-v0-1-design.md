# MindRail Control-Plane Protocol v0.1 — Design Specification

- **Status:** Approved
- **Date:** 2026-08-29
- **Depends on:** ADR-0001, ADR-0003, ADR-0004, ADR-0005
- **Domain contract:** `schemas/domain/v1/`
- **Scope:** transport-neutral command/query semantics plus HTTP/MCP mapping. No server, database, Cloudflare runtime, policy language, planner, or provider integration.

## 1. Objective

Support the first durable control-plane loop:

```text
create Goal
  → create Tasks
  → discover/claim Task
  → Lease + fencing authority
  → heartbeat / renew
  → checkpoint
  → complete / fail / block
  → permission request / decision
  → recover after Session/Lease loss
  → cancel Task/Goal when human/system must stop work
```

The protocol is intentionally explicit. There is no generic CRUD mutation surface.

## 2. Authority model

- Domain v1 JSON Schema remains canonical for records.
- ADR-0004 owns lifecycle/concurrency semantics.
- Runtime state is authoritative.
- `Agent != Session != Task != Lease`.
- Actor references are attribution; transports authenticate/bind principals.
- Lease id + Session id + fencing token are required for executor authority.
- `expectedRevision` protects mutable-record optimistic concurrency.
- LLM output never grants permission authority.
- External credentials/IAM/host sandbox remain separate enforcement boundaries.

## 3. Common command envelope

```text
protocolVersion: "0.1"
command: explicit discriminator
commandId: EntityId
workspaceId: EntityId
actor: ActorRef
sessionId?: EntityId
expectedRevision?: integer >= 1
correlationId?: EntityId
causationId?: EntityId
```

Unknown command fields are rejected. There is no arbitrary `payload`, `metadata`, or extension bag.

## 4. Idempotency

Canonical key:

```text
(workspaceId, commandId)
```

One key identifies one admitted logical mutation across all command types.

Persistence stores atomically with the mutation:

```text
command
semanticFingerprint
terminalResultOrErrorSnapshot
createdAt
optionalExpiry
```

The fingerprint includes semantic/authority fields but excludes `correlationId` and `causationId`, because tracing is not intent.

Examples:

```text
CreateTask commandId=cmd-42 commits task-9
response lost
retry same semantic command cmd-42
→ return task-9 snapshot, replayed=true
→ no duplicate Task
```

```text
cmd-42 previously admitted as CreateTask
later reused for CancelGoal
→ IDEMPOTENCY_CONFLICT
```

Replay remains subject to caller authorization to read the stored result, but never re-executes the mutation.

## 5. Responses

Command success:

```text
protocolVersion
commandId
correlationId
replayed: boolean
result: typed result
```

Query success:

```text
protocolVersion
correlationId
result: typed result
```

Error:

```text
protocolVersion
commandId?
correlationId
error:
  code
  message
  retryable
  details?: typed-by-code details
```

## 6. Command table

| Command | Required intent | Primary result |
| --- | --- | --- |
| `RegisterAgent` | display name, capabilities | Agent |
| `StartSession` | agentId | Session |
| `HeartbeatSession` | sessionId, expected Session revision | Session |
| `EndSession` | sessionId, expected Session revision | Session + revoked Leases |
| `CreateGoal` | title, objective, success criteria | Goal |
| `CreateTask` | goalId, title, objective, acceptance criteria, capabilities, dependencies | Task |
| `ClaimTask` | taskId, sessionId, observed Task revision | Task + Lease |
| `RenewLease` | leaseId, sessionId, expected Lease revision, fence | Lease |
| `ReleaseLease` | leaseId, sessionId, expected Lease revision, fence | Lease |
| `RecordCheckpoint` | task/session/lease/fence, progress or handoff evidence | Checkpoint |
| `CompleteTask` | execution refs, expected Task revision, result/evidence | Task + Checkpoint + released Lease |
| `FailTask` | execution refs, expected Task revision, reason/result | Task + Checkpoint + released Lease |
| `BlockTask` | execution refs, expected Task revision, reason/evidence | Task + Checkpoint + released Lease |
| `ResumeTask` | taskId, expected Task revision | Task |
| `RetryTask` | taskId, expected Task revision | Task |
| `CancelTask` | taskId, expected Task revision, reason | Task + revoked Lease? |
| `CancelGoal` | goalId, expected Goal revision, reason | Goal + affected Task/Lease summary |
| `RequestPermission` | execution refs, permission, justification, resource? | PermissionRequest + initial PermissionDecision |
| `RecordPermissionDecision` | requestId, expected predecessor, ALLOW/DENY, reasonCode | PermissionDecision |

No `UpdateEntity`, `PatchTask`, or arbitrary-action command exists.

## 7. Key command semantics

### CreateTask

Goal must still be active at ADR-0004 Goal linearization point. Dependencies are same Workspace/Goal and acyclic. Runtime chooses `ready` vs `pending`.

### ClaimTask

Valid for:

- `ready`; or
- `running` with no effective Lease.

If another Session has the effective Lease: reject.

If the same Session already has it: return the current Lease unchanged. This semantic duplicate does not mint a new fence even when the incoming commandId is different.

Otherwise create a new Lease with a strictly greater fencing token.

### CompleteTask

Atomically/logically append result Checkpoint, succeed Task, release Lease, reconcile dependencies, and evaluate Goal auto-success under Goal-level ordering.

### FailTask

Append result evidence, set `failed`, record reason, release Lease. Retry is never automatic.

### BlockTask / ResumeTask

Blocking requires current executor authority and releases Lease. Resume is human/system/controller authority and returns Task to `ready` or `pending` according to dependency satisfaction.

### RetryTask

Legal only from `failed`. ADR-0004 makes v0.1 retry:

```text
failed -> ready
```

No retry counter/Attempt entity is added.

### CancelTask

Human/system/controller stop control. Legal only for nonterminal executable/waiting states (`pending`, `ready`, `running`, `blocked`). Revokes effective Lease and prevents stale completion.

### CancelGoal

Goal-level stop control. The accepted operation terminalizes Goal, cancels all nonterminal Tasks, revokes effective Leases, and prevents concurrent `CreateTask`/`RetryTask` admission under that Goal.

This is the minimum reliable human stop primitive for autonomous execution.

### RequestPermission

Requires current Lease/fence. Success creates request plus deterministic initial decision as one logical operation. `HUMAN_REQUIRED` grants no authority.

### RecordPermissionDecision

Authenticated human follow-up only. Runtime derives decision basis/actor/sequence/supersession. A decision recorded after Lease loss is audit closure only; it does not revive authority.

## 8. Query table

| Query | Purpose |
| --- | --- |
| `GetWorkspace` | bootstrap scope |
| `GetGoal` / `ListGoals` | objective/current Goal state |
| `GetTask` / `ListGoalTasks` | Task state and decomposition |
| `ListClaimableTasks` | advisory work discovery |
| `GetTaskExecutionView` | Task + effective Lease + latest checkpoint projection |
| `ListTaskCheckpoints` | durable handoff/evidence history |
| `GetAgent` | Agent capabilities/status |
| `GetSession` | Session liveness/state |
| `GetLease` | Lease state |
| `GetPermissionRequest` | permission request state |
| `ListPendingHumanPermissions` | approval queue |
| `ListPermissionDecisions` | immutable decision chain |

Lists use `limit` 1..100 and opaque cursor. No arbitrary filter language.

## 9. Error codes

| Code | Client behavior |
| --- | --- |
| `INVALID_INPUT` | fix request |
| `NOT_FOUND` | refresh/stop |
| `CONFLICT` | refresh state |
| `REVISION_MISMATCH` | re-read and re-evaluate intent |
| `LEASE_NOT_ACTIVE` | reacquire/stop stale execution |
| `LEASE_EXPIRED` | claim new Lease |
| `STALE_FENCING_TOKEN` | stop old executor immediately |
| `INVALID_STATE_TRANSITION` | use legal command/current state |
| `IDEMPOTENCY_CONFLICT` | client bug/new commandId for new intent |
| `SESSION_NOT_ACTIVE` | start/recover Session |
| `CAPABILITY_MISMATCH` | use another Agent |
| `DEPENDENCY_UNSATISFIED` | wait/resolve dependencies |
| `ACTOR_NOT_AUTHORIZED` | do not retry unchanged |
| `PERMISSION_DENIED` | stop unauthorized action |
| `HUMAN_DECISION_REQUIRED` | wait/query human decision |
| `POLICY_UNAVAILABLE` | safe exact retry when infrastructure recovers |

HTTP status codes may map coarsely, but protocol error code is canonical.

## 10. Recovery sequence

```text
old Lease expires/revokes
→ old executor writes rejected
→ active/new Session lists claimable running Tasks
→ ClaimTask grants higher fencing token
→ client reads Task execution view/checkpoints
→ continue under new Lease
→ request fresh permission when required
```

Old Lease-scoped ALLOW decisions never transfer.

## 11. HTTP mapping

Recommended transport mapping:

```text
POST /v0.1/commands/{command}
POST /v0.1/queries/{query}
```

The HTTP adapter validates authentication, decodes the typed request, invokes the same semantic handler used by other adapters, then maps protocol envelope to HTTP response.

No REST resource PATCH endpoint may bypass lifecycle commands.

## 12. MCP mapping

Each mutating semantic command becomes an explicit MCP tool. Reads may be tools or resources depending on client ergonomics.

Examples:

```text
mindrail.create_goal
mindrail.create_task
mindrail.claim_task
mindrail.record_checkpoint
mindrail.complete_task
mindrail.retry_task
mindrail.cancel_task
mindrail.cancel_goal
mindrail.request_permission
```

No generic `mindrail.execute` / `update_entity` tool.

MCP host approval/sandbox remains independent authority.

## 13. Compatibility

Protocol family `0.1` may add optional response/query fields without changing existing meaning.

Breaking changes include:

- changing idempotency scope;
- changing authority/fencing requirements;
- changing required command fields;
- changing error-code meaning;
- changing lifecycle command semantics.

Such changes require a new protocol compatibility family/ADR.

## 14. Deferred

- public `FailGoal` command;
- generic workflow/decomposition DSL;
- first-class Plan/Review entities;
- arbitrary extensions/metadata;
- batch commands;
- streaming subscription protocol;
- provider-specific commands;
- authentication-provider selection;
- policy language/storage.

## 15. Implementation verification

Implementation must prove at minimum:

- same command replay returns immutable original result and does not execute twice;
- same commandId with different semantic fingerprint conflicts;
- changed tracing IDs do not cause idempotency conflict;
- same-Session duplicate claim returns existing Lease/fence;
- concurrent different-Session claims cannot both win;
- stale fences cannot checkpoint/complete;
- `RetryTask` only reopens failed Task to ready;
- CancelTask beats/rejects later stale completion according to serialization order;
- CancelGoal prevents concurrent accepted Task creation and revokes execution authority;
- HTTP and MCP adapters produce equivalent semantic outcomes.

No unexecuted transport/runtime test may be described as PASS.
