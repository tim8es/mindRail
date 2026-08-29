# ADR-0005: Control-plane protocol v0.1 semantics

- **Status:** Accepted
- **Date:** 2026-08-29
- **Depends on:** ADR-0001, ADR-0003, ADR-0004

## Context

MindRail needs a transport-neutral protocol that can drive the first durable control-plane loop without making HTTP, MCP, GitHub, Cloudflare, TypeScript, or a model runtime part of core semantics.

ADR-0003 defines canonical domain records. ADR-0004 defines deterministic Goal/Task/Session/Lease lifecycle, fencing, recovery, and concurrency. This ADR defines the commands, queries, replay behavior, errors, and transport mappings that expose those semantics.

It does not select a server framework, persistence engine, authentication provider, policy language, cloud platform, or model provider.

## Decision

### 1. One semantic protocol, multiple transports

Protocol compatibility family is `0.1` and binds to domain schema major `v1`.

HTTP, MCP, CLI, and provider adapters map onto the same command/query semantics. They must not invent provider-specific lifecycle rules.

Clients submit intent, never authoritative snapshots. Runtime assigns ids, revisions, timestamps, Lease expiry, fencing tokens, permission sequence numbers, and authority attribution.

### 2. Command envelope

Every mutation carries:

```text
protocolVersion: "0.1"
command: explicit command discriminator
commandId: EntityId
workspaceId: EntityId
actor: ActorRef
```

Conditionally required:

```text
sessionId: EntityId
expectedRevision: integer >= 1
```

Optional tracing:

```text
correlationId?: EntityId
causationId?: EntityId
```

There is no generic `action`, arbitrary `payload`, `metadata`, or extension bag in the core protocol.

`ActorRef` is attribution, not authentication. A transport adapter binds the request to an authenticated principal and verifies that the claimed actor/session is authorized.

### 3. Idempotency

`commandId` is the protocol idempotency key. The unique logical key is exactly:

```text
(workspaceId, commandId)
```

The same `commandId` cannot be reused for a different command type or semantic intent inside one Workspace.

At the authoritative mutation boundary, the runtime atomically persists:

- command discriminator;
- canonical semantic request fingerprint;
- mutation outcome;
- immutable bounded protocol result or terminal error snapshot.

The semantic fingerprint includes every field that affects command meaning or authority, including command type, actor/session references, expected revisions, fencing values, and command-specific input.

`correlationId` and `causationId` are tracing-only and are **not** part of the semantic fingerprint. A network retry may change tracing context without changing logical command identity.

Exact replay returns the original bounded result/error snapshot with `replayed = true` and never re-executes the mutation.

Reusing `(workspaceId, commandId)` with a different semantic fingerprint returns `IDEMPOTENCY_CONFLICT`.

Structural/authentication rejection before command admission need not reserve the idempotency key.

### 4. Success and error envelopes

Command success:

```text
protocolVersion: "0.1"
commandId
correlationId
replayed: boolean
result: typed command result
```

Query success:

```text
protocolVersion: "0.1"
correlationId
result: typed query result
```

Error:

```text
protocolVersion: "0.1"
commandId?
correlationId
error:
  code: stable error code
  message: bounded human-readable text
  retryable: boolean
  details?: code-specific typed details
```

Clients branch on `error.code`, not message text or HTTP status.

### 5. MVP commands

Protocol v0.1 exposes explicit commands only.

| Command                    | Purpose                                            |
| -------------------------- | -------------------------------------------------- |
| `RegisterAgent`            | create logical Agent/capabilities                  |
| `StartSession`             | start one Agent execution lifetime                 |
| `HeartbeatSession`         | refresh Session liveness                           |
| `EndSession`               | end Session and revoke its effective Leases        |
| `CreateGoal`               | create active Goal                                 |
| `CreateTask`               | add Task under active Goal                         |
| `ClaimTask`                | obtain/recover Task execution Lease                |
| `RenewLease`               | extend current Lease                               |
| `ReleaseLease`             | voluntarily surrender Lease                        |
| `RecordCheckpoint`         | append progress/handoff evidence                   |
| `CompleteTask`             | append result and succeed Task                     |
| `FailTask`                 | append result and fail Task                        |
| `BlockTask`                | append blocked checkpoint and pause Task           |
| `ResumeTask`               | explicitly resume blocked Task                     |
| `RetryTask`                | explicitly reopen failed Task to `ready`           |
| `CancelTask`               | stop one nonterminal Task                          |
| `CancelGoal`               | stop Goal, cancel nonterminal Tasks, revoke Leases |
| `RequestPermission`        | create request and deterministic initial decision  |
| `RecordPermissionDecision` | append authenticated human follow-up decision      |

`FailGoal` is not public in protocol v0.1. ADR-0004 defines its runtime semantics so it can be added later without changing the domain model.

### 6. Lifecycle command semantics

#### RegisterAgent

Creates active Agent at revision 1 with exact namespaced capabilities. No wildcard/fuzzy capability matching.

#### StartSession

Creates an active Session for an active Agent. A new Session never inherits an old Session's Lease or permission authority.

#### HeartbeatSession

Requires current Session revision. Runtime writes authoritative `lastSeenAt` and increments revision. Heartbeat never renews a Lease.

#### EndSession

Requires current Session revision. Atomically marks Session ended and removes authority of all effective Leases owned by it. Tasks remain durable/recoverable.

#### CreateGoal

Creates active Goal at revision 1.

#### CreateTask

Requires Goal active at ADR-0004 Goal linearization boundary.

Validates same-Workspace/same-Goal dependencies and acyclic graph. Initial status is `ready` when all dependencies succeeded, otherwise `pending`.

CreateTask participates in Goal-level ordering so it cannot race with automatic Goal success or Goal cancellation into an inconsistent terminal Goal.

#### ClaimTask

Requires active Session/Agent, capability match, current observed Task revision when required, and Task state `ready`, or `running` without an effective Lease.

If another Session owns the effective Lease, reject.

If the **same Session already owns the current effective Lease**, return the existing Task/Lease unchanged. No new Lease, revision increment, or fencing token is created. This is a semantic duplicate independent of transport retry identity.

Otherwise claim creates a new Lease with a strictly higher per-Task fencing token. First claim changes `ready -> running`; recovery of a Lease-less running Task leaves Task state unchanged.

#### RenewLease

Requires current Lease revision, owner Session, current fencing token, and unexpired authority. Runtime selects the new expiry and increments Lease revision.

#### ReleaseLease

Requires current Lease revision and current fencing authority. Marks Lease released. Task remains `running` and recoverable.

#### RecordCheckpoint

Direct creation allows `progress` and `handoff` checkpoints. Requires current Lease/fence. Checkpoints are append-only.

#### CompleteTask

Requires current Task revision and current Lease/fence. Atomically:

1. append result checkpoint;
2. `running -> succeeded`;
3. increment Task revision;
4. release Lease;
5. reconcile dependent Tasks;
6. evaluate Goal automatic success using ADR-0004 Goal-level ordering.

#### FailTask

Requires current Task revision, current Lease/fence, and bounded Reason. Atomically append result checkpoint, set `failed`, increment Task revision, and release Lease.

#### BlockTask

Requires current Task revision, current Lease/fence, and bounded Reason. Atomically append blocked checkpoint, set `blocked`, increment Task revision, and release Lease.

#### ResumeTask

Requires authorized human/system actor, current Task revision, blocked Task, and no effective Lease. Returns to `ready` when dependencies are satisfied, otherwise `pending`.

#### RetryTask

Requires authorized actor, current Task revision, Task exactly `failed`, active Goal, and no effective Lease. ADR-0004 guarantees dependencies are already satisfied, so v0.1 transitions only `failed -> ready`. No automatic retry/backoff is introduced.

#### CancelTask

Requires authorized human/system/controller actor and current Task revision. Legal from `pending`, `ready`, `running`, or `blocked`.

Atomically sets `cancelled`, increments Task revision, records bounded reason, and revokes current effective Lease if one exists.

`failed`, `succeeded`, and `cancelled` Tasks are not recancelled/reopened.

#### CancelGoal

Requires authorized human/system/controller actor and current Goal revision.

At the ADR-0004 Goal linearization boundary, atomically/logically:

1. set Goal `cancelled` and increment revision;
2. cancel every nonterminal Task under it;
3. revoke every effective Lease under it;
4. prevent any concurrent/new `CreateTask` or `RetryTask` from being accepted under that Goal.

Persistence may choose the exact transactional implementation but may not expose a state that violates these semantics.

### 7. Permission commands

#### RequestPermission

Requires current Task/Session/Lease/fence authority.

From protocol perspective success is atomic:

1. append PermissionRequest;
2. evaluate deterministic MindRail policy;
3. append initial PermissionDecision with `basis = policy`, system actor, exact policy reference, sequence 1;
4. return both records.

Outcome is `ALLOW`, `DENY`, or `HUMAN_REQUIRED`. `HUMAN_REQUIRED` grants nothing.

An ALLOW is scoped to the exact request and execution authority. It never creates external credentials and cannot bypass host/IAM/sandbox restrictions.

#### RecordPermissionDecision

Public v0.1 use is authenticated human follow-up to latest `HUMAN_REQUIRED` decision.

Input contains request id, `ALLOW|DENY`, expected previous decision id, reason code, and optional bounded reason. Runtime derives actor, basis, sequence, and supersession link.

A late human decision may close audit history after Lease loss but does not revive old execution authority or transfer permission to a replacement Lease.

### 8. Queries

Queries are side-effect-free in protocol semantics and do not use `commandId`.

Minimum v0.1 reads:

- `GetWorkspace`;
- `GetGoal` / `ListGoals`;
- `GetTask` / `ListGoalTasks`;
- `ListClaimableTasks`;
- `GetTaskExecutionView`;
- `ListTaskCheckpoints`;
- `GetAgent`;
- `GetSession`;
- `GetLease`;
- `GetPermissionRequest`;
- `ListPendingHumanPermissions`;
- `ListPermissionDecisions`.

Lists use bounded `limit` and opaque cursor. No arbitrary filter language is part of v0.1.

`ListClaimableTasks` is advisory. `ClaimTask` revalidates every precondition atomically.

### 9. Stable error taxonomy

At minimum:

| Code                       | Meaning                                            |
| -------------------------- | -------------------------------------------------- |
| `INVALID_INPUT`            | structural/domain validation failed                |
| `NOT_FOUND`                | requested record unavailable in Workspace          |
| `CONFLICT`                 | current authoritative state conflicts with request |
| `REVISION_MISMATCH`        | expected revision is stale                         |
| `LEASE_NOT_ACTIVE`         | referenced Lease is not current/effective          |
| `LEASE_EXPIRED`            | Lease authority expired                            |
| `STALE_FENCING_TOKEN`      | presented fence is not current authority           |
| `INVALID_STATE_TRANSITION` | command illegal from current state                 |
| `IDEMPOTENCY_CONFLICT`     | commandId reused for different intent              |
| `SESSION_NOT_ACTIVE`       | Session ended/expired/stale                        |
| `CAPABILITY_MISMATCH`      | Agent lacks Task requirements                      |
| `DEPENDENCY_UNSATISFIED`   | Task cannot become executable yet                  |
| `ACTOR_NOT_AUTHORIZED`     | authenticated principal lacks authority            |
| `PERMISSION_DENIED`        | authoritative outcome is DENY                      |
| `HUMAN_DECISION_REQUIRED`  | no grant exists until human resolves               |
| `POLICY_UNAVAILABLE`       | deterministic policy evaluation unavailable        |

Errors include typed details where useful but never arbitrary JSON bags.

### 10. Recovery

When Lease/Session authority is lost:

1. old execution mutations stop being accepted;
2. caller starts/reuses an active Session;
3. claimable reads expose matching `running` Tasks without effective Lease;
4. `ClaimTask` grants a new Lease with higher fencing token;
5. caller reads checkpoints/handoff state;
6. execution continues under the new Lease;
7. old Lease-scoped permission grants do not transfer.

### 11. HTTP mapping

HTTP is a transport adapter, not semantic authority.

Recommended shape:

```text
POST /v0.1/commands/{command}
POST /v0.1/queries/{query}
```

Transport authentication binds principal identity before protocol admission. HTTP status is secondary; protocol error code remains canonical for client behavior.

### 12. MCP mapping

Explicit commands map to explicit MCP tools; reads may map to tools/resources according to client ergonomics.

MCP tool names must preserve semantic command boundaries rather than exposing generic `update_entity` or arbitrary action tools.

Host tool approval and sandbox policy remain additional enforcement boundaries. MindRail cannot bypass them.

### 13. Versioning

Within protocol family `0.1`:

- additive optional response/query fields may evolve compatibly;
- command meaning, authority semantics, required fields, idempotency scope, or error-code meaning do not change silently;
- breaking changes require a new protocol compatibility family.

Domain and protocol versions remain independent.

## Alternatives considered

### Generic CRUD / PATCH API

Rejected. It would allow clients to bypass deterministic lifecycle semantics and make authorization/concurrency ambiguous.

### Transport-specific semantics

Rejected. HTTP/MCP are adapters; core correctness must survive transport replacement.

### No durable idempotency receipts

Rejected. Lost responses after committed mutations would otherwise create duplicate Tasks/Leases or force unsafe guessing.

### Include tracing fields in idempotency fingerprint

Rejected. Correlation/causation are observability metadata, not command meaning; retries may legitimately change them.

## Consequences

- Runtime and persistence must store bounded immutable replay outcomes for admitted commands.
- Protocol handlers remain thin over deterministic runtime services.
- Agents can recover safely after session/lease loss without owning the source of truth.
- Human stop controls exist in v0.1 through `CancelTask` and `CancelGoal`.
- Provider adapters cannot introduce alternate task/permission authority.
