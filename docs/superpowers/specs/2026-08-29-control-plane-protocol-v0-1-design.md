# MindRail Control-Plane Protocol v0.1 — Design Specification

- **Status:** Written review pending
- **Date:** 2026-08-29
- **Depends on:** ADR-0001, proposed ADR-0003, proposed ADR-0004
- **Domain contract:** `schemas/domain/v1/`
- **Scope:** Transport-neutral protocol semantics and HTTP/MCP mappings only. No HTTP/MCP server, persistence, Cloudflare runtime, orchestration engine, policy-engine implementation, or provider integration.

## 1. Objective

Define the smallest protocol that supports the first durable control-plane loop:

```text
Human/client
  → create Goal
  → create/decompose Tasks
  → discover/claim Task
  → establish Lease
  → heartbeat/renew
  → checkpoint
  → submit result / complete / fail / block
  → request permission
  → receive deterministic or human decision
  → recover after Session/Lease loss
  → query current state
```

The protocol preserves these constraints:

1. domain v1 schemas remain canonical;
2. protocol semantics are transport-neutral;
3. runtime state is authoritative;
4. `Agent != Session != Task != Lease`;
5. Tasks survive Session/Lease loss;
6. task execution mutations require lease fencing;
7. mutable-resource concurrency uses `revision` / `expectedRevision`;
8. every mutating command is idempotent;
9. permission authority comes only from deterministic policy or an authenticated human decision;
10. LLM output never grants authority;
11. errors are stable and machine-readable;
12. external credentials, IAM, host policy, and sandbox restrictions remain independent enforcement boundaries.

## 2. Non-goals

Protocol v0.1 does not define or implement:

- a server framework or deployment topology;
- database tables, transactions, migrations, or a storage engine;
- Cloudflare primitives;
- GitHub Issue/PR/Actions semantics;
- authentication provider, accounts, roles, billing, or credential exchange;
- a policy language or policy storage;
- model prompts, planning, or LLM orchestration;
- event sourcing;
- generic metadata/extension bags;
- arbitrary JSON command payloads;
- provider-specific commands;
- a second domain model.

## 3. Domain and protocol authority

Protocol v0.1 returns canonical domain v1 records where those records are the natural result: `Goal`, `Task`, `Agent`, `Session`, `Lease`, `Checkpoint`, `PermissionRequest`, and `PermissionDecision`.

Commands accept intent fields only. Clients do not authoritatively choose:

- ids;
- revisions;
- timestamps;
- lease expiry;
- fencing tokens;
- permission-decision sequence numbers;
- permission-decision actor/basis attribution.

Those values come from runtime authority.

Composite reads such as a Task plus its active Lease are read projections only. They are not persisted domain entities and cannot be written back as snapshots.

## 4. Version

Every logical request/response belongs to protocol compatibility family:

```text
0.1
```

Protocol v0.1 binds to domain schema major version `v1`. Protocol and domain versions remain independent.

## 5. Identity and authority references

Every request is scoped to exactly one `workspaceId`. Cross-workspace references are rejected.

Every request carries `actor: ActorRef`. The ActorRef is attribution, not authentication. A transport adapter must bind it to an authenticated caller/runtime principal; a caller cannot gain authority by supplying another Actor id in JSON or MCP arguments.

Session-bound commands also carry `sessionId`. Execution commands verify that the Session exists, is active, belongs to the acting Agent, and owns the referenced Lease.

`StartSession` creates a Session and therefore has no existing session id.

## 6. Command model

### 6.1 Common command envelope

Required:

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

There is no common `metadata`, `extensions`, `action`, or arbitrary `payload` field. Every command has a closed, command-specific input shape; unknown request fields produce `INVALID_INPUT`.

### 6.2 commandId

`commandId` is the transport-neutral idempotency key. `(workspaceId, commandId)` identifies one admitted logical mutation.

The client generates it before the first attempt and reuses it for every retry of that same command.

### 6.3 correlationId and causationId

`correlationId` groups related operations for audit/diagnostics. If absent on a command, the runtime uses `commandId` as the effective correlation id.

`causationId` may identify the immediately preceding request/command that caused this one. Both fields are tracing only: they grant no authority and impose no transaction/order semantics.

### 6.4 expectedRevision

`expectedRevision` means: apply this operation only if the primary mutable target still has this exact revision.

It is required when a command mutates or conditionally acts on an existing mutable primary target. Append-only creation does not invent revisions for new records.

## 7. Response envelope

Command success:

```text
protocolVersion: "0.1"
commandId: EntityId
correlationId: EntityId
replayed: boolean
result: command-specific typed result
```

Query success:

```text
protocolVersion: "0.1"
correlationId: EntityId
result: query-specific typed result
```

Error:

```text
protocolVersion: "0.1"
commandId?: EntityId
correlationId: EntityId
error:
  code: stable protocol error code
  message: bounded human-readable text
  retryable: boolean
  details?: code-specific typed details
```

`details` is a typed union by error code, not arbitrary JSON. Clients branch on `error.code`, not message text or HTTP status.

## 8. MVP command table

| Command | Fixed intent fields | Concurrency/authority | Result |
| --- | --- | --- | --- |
| `RegisterAgent` | `displayName`, `capabilities` | authorized control-plane actor | `Agent` |
| `StartSession` | `agentId` | authorized for active Agent | `Session` |
| `HeartbeatSession` | `sessionId`, `expectedRevision` | active Session | updated `Session` |
| `EndSession` | `sessionId`, `expectedRevision` | active Session; revokes active Leases | updated `Session`, affected `Lease[]` |
| `CreateGoal` | `title`, `objective`, `successCriteria` | none | `Goal` |
| `CreateTask` | `goalId`, `title`, `objective`, `acceptanceCriteria`, `requiredCapabilities`, `dependencyTaskIds` | Goal active; valid DAG | `Task` |
| `ClaimTask` | `taskId`, `sessionId`, `expectedRevision` | active Session, capability match, no active Lease | current `Task`, new `Lease` |
| `RenewLease` | `leaseId`, `sessionId`, `expectedRevision`, `fencingToken` | current active/unexpired Lease | updated `Lease` |
| `ReleaseLease` | `leaseId`, `sessionId`, `expectedRevision`, `fencingToken` | current active Lease | updated `Lease` |
| `RecordCheckpoint` | `taskId`, `sessionId`, `leaseId`, `fencingToken`, `kind`, `summary`, `evidence`, `progressPercent?` | current active Lease | `Checkpoint` |
| `CompleteTask` | execution refs, `expectedRevision`, `summary`, `evidence` | current Lease + Task revision | updated `Task`, result `Checkpoint`, released `Lease` |
| `FailTask` | execution refs, `expectedRevision`, `reason`, `summary`, `evidence` | current Lease + Task revision | updated `Task`, result `Checkpoint`, released `Lease` |
| `BlockTask` | execution refs, `expectedRevision`, `reason`, `summary`, `evidence` | current Lease + Task revision | updated `Task`, blocked `Checkpoint`, released `Lease` |
| `ResumeTask` | `taskId`, `expectedRevision` | authorized human/system; blocked Task; no active Lease | updated `Task` |
| `RequestPermission` | `taskId`, `sessionId`, `leaseId`, `fencingToken`, `permission`, `justification`, `resource?` | current active Lease | `PermissionRequest`, initial policy `PermissionDecision` |
| `RecordPermissionDecision` | `requestId`, `outcome`, `expectedPreviousDecisionId`, `reasonCode`, `reason?` | authenticated human; latest decision `HUMAN_REQUIRED` | new `PermissionDecision` |

`execution refs` means `taskId`, `sessionId`, `leaseId`, and `fencingToken`.

## 9. Command semantics

### 9.1 RegisterAgent

Creates an active `Agent` at revision 1 from `displayName` and exact namespaced `capabilities`. Wildcard/fuzzy capability matching is not part of v0.1.

Agent disable/re-enable is deferred.

### 9.2 StartSession

Requires an existing active Agent and caller authority for it. Creates an active Session at revision 1 with runtime-assigned `lastSeenAt`.

A new Session does not inherit an old Session's Lease or permission authority.

### 9.3 HeartbeatSession

Requires the current Session revision. On success, updates `lastSeenAt` from runtime time and increments Session revision.

Heartbeat does not renew a Lease. Session liveness and execution authority are deliberately separate.

### 9.4 EndSession

Requires the current Session revision. On success, atomically:

1. marks Session `ended`;
2. assigns `endedAt`/`lastSeenAt` from runtime time;
3. increments Session revision;
4. revokes every active Lease owned by that Session.

Revoking a Lease does not delete or fail the Task. A running Task without an active Lease is recoverable work.

Automatic Session expiry is runtime policy, not a client command.

### 9.5 CreateGoal

Creates an active Goal at revision 1.

Goal terminalization commands are deferred; v0.1 does not expose a generic Goal patch.

### 9.6 CreateTask

Validates:

- Goal exists in the same Workspace and is active;
- all dependencies exist in the same Workspace/Goal;
- no self-reference;
- dependency graph remains acyclic.

Initial status is deterministic:

```text
ready    when all dependencies are satisfied
pending  otherwise
```

A Task without dependencies is `ready`.

Because ids are runtime-assigned, decomposition creates predecessor Tasks before dependent Tasks that reference their ids.

### 9.7 ClaimTask

Requires the observed Task revision and an active Session whose Agent satisfies `Task.requiredCapabilities`.

Claimable state is:

- Task `ready`; or
- Task `running` with no active Lease (recovery case).

Dependencies must be satisfied and no active Lease may exist.

On success, atomically:

1. allocate the next monotonically increasing Task fencing token;
2. create active Lease for Task/Session;
3. transition `ready → running` and increment Task revision when needed;
4. leave an already-running recovery Task's revision unchanged;
5. return current Task and new Lease.

A claim is the Lease; there is no `claimed` Task state. Concurrent claimers cannot both succeed.

### 9.8 RenewLease

Requires current Lease revision, Session ownership, active status, runtime time before `expiresAt`, and exact current fencing token.

The runtime chooses the new expiry from deterministic lease policy. Clients cannot choose arbitrary TTLs.

An expired Lease cannot be renewed; the client must claim again and receive a higher fencing token.

### 9.9 ReleaseLease

Requires current Lease revision and fencing token. Marks Lease `released` and increments Lease revision.

Task state is not rewound. A running Task with no active Lease becomes recoverable/claimable. Clients should normally append a `handoff` checkpoint before voluntary release.

### 9.10 RecordCheckpoint

Direct v0.1 checkpoint creation allows only:

```text
progress | handoff
```

It requires a running Task and current active/unexpired Lease with matching fencing token.

Domain kinds `blocked` and `result` are created atomically by `BlockTask`, `CompleteTask`, or `FailTask`, so writing evidence alone cannot imply a terminal transition.

Checkpoint records are append-only.

### 9.11 CompleteTask

Requires current Task revision and current Lease/fencing authority.

On success, atomically:

1. append `Checkpoint(kind = result, progressPercent = 100)`;
2. set Task `succeeded`;
3. clear `statusReason` when present;
4. increment Task revision;
5. release Lease;
6. allow deterministic runtime rules to promote newly dependency-satisfied Tasks to `ready`.

There is no separate `SubmitTask` command because domain v1 has no submitted/review state. `CompleteTask` is final result submission plus successful terminal transition.

### 9.12 FailTask

Requires a domain `Reason`, current Task revision, and current Lease/fencing authority.

Atomically appends a `result` Checkpoint, sets Task `failed`, records `statusReason`, increments Task revision, and releases Lease.

Automatic retry/reopen of terminal failed Tasks is deferred.

### 9.13 BlockTask

Requires a domain `Reason`, current Task revision, and current Lease/fencing authority.

Atomically appends a `blocked` Checkpoint, sets Task `blocked`, records `statusReason`, increments Task revision, and releases Lease.

Blocked Tasks are not claimable until resumed.

### 9.14 ResumeTask

Requires an authorized human or deterministic system actor, Task state `blocked`, no active Lease, satisfied dependencies, and current Task revision.

Sets Task `ready`, clears `statusReason`, and increments revision.

An execution Agent cannot self-resume blocked work merely by model output.

### 9.15 RequestPermission

Requires a running Task and current Task/Session/Lease/fencing context.

From the protocol perspective, success is atomic:

1. append `PermissionRequest`;
2. evaluate deterministic MindRail policy;
3. append initial `PermissionDecision(sequence = 1, basis = policy, decidedBy.type = system, policyRef = exact policy version)`;
4. return both records.

Initial outcome is one of:

```text
ALLOW
DENY
HUMAN_REQUIRED
```

`HUMAN_REQUIRED` grants no authority.

An `ALLOW` applies only to the exact permission/resource and the request's Task/Session/Lease/fencing context. It does not create external credentials.

If deterministic policy cannot produce a decision, the command fails atomically with `POLICY_UNAVAILABLE`; v0.1 does not admit a dangling PermissionRequest without its initial policy decision.

### 9.16 RecordPermissionDecision

Public v0.1 use is the human follow-up to `HUMAN_REQUIRED`.

Input:

```text
requestId
outcome: ALLOW | DENY
expectedPreviousDecisionId
reasonCode
reason?
```

Requires an authenticated human and exact latest-decision match. Runtime derives:

```text
basis = human
decidedBy = authenticated human Actor
sequence = previous sequence + 1
supersedesDecisionId = expectedPreviousDecisionId
```

Clients cannot choose `basis`, `sequence`, or `decidedBy`.

A decision may still be recorded after the original Lease became stale for audit/closure, but it does not revive that Lease or transfer authority to a replacement Session. Replacement execution must create a new PermissionRequest.

## 10. Query model

Queries are side-effect-free from protocol semantics and do not require `commandId`.

Common query fields:

```text
protocolVersion: "0.1"
workspaceId
actor
sessionId?      # when session-scoped
correlationId?
```

List queries use `limit: 1..100` and an opaque `cursor?`. v0.1 has no arbitrary filter language or provider-specific sort/query syntax.

## 11. MVP query table

| Query | Input | Result | Use |
| --- | --- | --- | --- |
| `GetWorkspace` | workspace scope | `Workspace` | bootstrap/isolation |
| `GetGoal` | `goalId` | `Goal` | inspect objective |
| `ListGoals` | `status?`, cursor/limit | `Goal[]` + cursor | human/client state |
| `GetTask` | `taskId` | `Task` | optimistic-concurrency refresh |
| `ListGoalTasks` | `goalId`, cursor/limit | `Task[]` + cursor | decomposition/state |
| `ListClaimableTasks` | `sessionId`, cursor/limit | claimable `Task[]` + cursor | work discovery/recovery |
| `GetTaskExecutionView` | `taskId` | Task + active Lease/null + latest Checkpoint/null | recovery snapshot |
| `ListTaskCheckpoints` | `taskId`, cursor/limit | ordered `Checkpoint[]` + cursor | handoff/history |
| `GetAgent` | `agentId` | `Agent` | capability inspection |
| `GetSession` | `sessionId` | `Session` | liveness/recovery |
| `GetLease` | `leaseId` | `Lease` | renewal/conflict diagnosis |
| `GetPermissionRequestState` | `requestId` | request + ordered decisions + latest decision | permission wait/resume |
| `ListPendingPermissionRequests` | cursor/limit | requests whose latest decision is `HUMAN_REQUIRED` | human review queue |

### 11.1 ListClaimableTasks

Returns only Tasks that the active Session may attempt to claim:

- same Workspace;
- Agent capabilities satisfy Task requirements;
- dependencies satisfied;
- status `ready`, or `running` with no active Lease;
- no current active Lease.

The list is advisory; `ClaimTask` re-checks all preconditions atomically.

### 11.2 GetTaskExecutionView

Read projection:

```text
task: Task
activeLease: Lease | null
latestCheckpoint: Checkpoint | null
```

It has no independent id/revision and does not embed full checkpoint or permission history.

### 11.3 GetPermissionRequestState

Returns:

```text
request: PermissionRequest
decisions: PermissionDecision[] ordered by sequence
latestDecision: PermissionDecision
```

Ordering follows decision `sequence`, not timestamp sorting.

## 12. Error-code table

| Code | Meaning | Retry behavior |
| --- | --- | --- |
| `INVALID_INPUT` | closed request shape/value invalid | fix input; new attempt |
| `UNSUPPORTED_PROTOCOL_VERSION` | requested protocol version unsupported | negotiate/use supported version |
| `NOT_FOUND` | resource absent/not visible in Workspace | do not retry unchanged |
| `CONFLICT` | authoritative state conflicts; no narrower code applies | re-read before new intent |
| `REVISION_MISMATCH` | expected vs current mutable revision differ | re-read; do not blindly bump revision |
| `LEASE_MISSING` | execution operation has no current Lease | discover/claim |
| `LEASE_EXPIRED` | referenced Lease authority expired | claim a new Lease |
| `STALE_FENCING_TOKEN` | presented token is not current Task execution authority | stop stale execution; reacquire |
| `PERMISSION_DENIED` | latest authoritative permission outcome is `DENY` | stop unless context/policy changes |
| `HUMAN_DECISION_REQUIRED` | latest outcome is `HUMAN_REQUIRED`; no grant exists | wait/query for human decision |
| `INVALID_STATE_TRANSITION` | command illegal from current state | re-read/use valid command |
| `IDEMPOTENCY_CONFLICT` | commandId already admitted with different fingerprint | fix client bug/use new id for new intent |
| `SESSION_NOT_ACTIVE` | Session ended/expired | start/recover Session |
| `CAPABILITY_MISMATCH` | Session Agent lacks Task requirements | use suitable Agent |
| `DEPENDENCY_UNSATISFIED` | Task cannot claim/resume yet | resolve/wait dependencies |
| `ACTOR_NOT_AUTHORIZED` | authenticated actor lacks MindRail operation authority | do not retry unchanged |
| `POLICY_UNAVAILABLE` | deterministic policy authority unavailable | retry exact commandId when safe |
| `INTERNAL_ERROR` | no narrower stable code | retry exact commandId only when marked retryable/commit unknown |

Code-specific details are fixed typed shapes, for example resource id/type, expected/actual revision, lease expiry, presented/current fencing token, permission request id, or missing capabilities.

### 12.1 Deterministic error precedence

For session/lease execution commands, recommended validation order is:

1. structural input;
2. workspace/actor authorization;
3. idempotency replay/conflict;
4. reference existence/isolation;
5. Session active/ownership;
6. Lease existence/status/expiry;
7. fencing token;
8. expected revision;
9. Task state/dependency/capability preconditions;
10. permission preconditions;
11. mutation.

This ordering is protocol-visible because clients use errors for recovery.

A deployment may use `NOT_FOUND` instead of revealing a resource the authenticated actor is not allowed to know exists; that concealment policy must be deterministic.

## 13. Idempotency

### 13.1 Admission boundary

Before admission, structural validation/authentication failures do not reserve `commandId`.

At the atomic mutation boundary, the runtime stores:

- canonical command fingerprint;
- resulting state mutation;
- terminal protocol result/error.

Mutation and idempotency outcome commit atomically.

Replay lookup remains subject to current caller authentication/authorization to access the stored result, but never re-executes the mutation.

The fingerprint covers every protocol-semantic command field, including command type, workspace/actor/session refs, revisions, fencing values, correlation/causation ids when supplied, and all command-specific input. Transport-only headers/framing are excluded.

### 13.2 Lost-response example

```text
CreateTask(commandId = cmd-42) commits Task task-9
response is lost
client retries exact command cmd-42
→ same task-9
→ replayed = true
→ no duplicate Task
```

### 13.3 Conflicting reuse

```text
CreateTask(commandId = cmd-42, title = "Run tests")
CreateTask(commandId = cmd-42, title = "Deploy")
→ IDEMPOTENCY_CONFLICT
```

A new intent needs a new command id.

Idempotency outcomes must survive process restarts and normal retry horizons. v0.1 defines no command-result GC/retention API; implementations must not silently discard keys in a way that can recreate durable side effects while related state remains active.

## 14. Concurrency

### 14.1 Revision race

```text
A reads Task revision 17
B reads Task revision 17
A CompleteTask(expectedRevision = 17) → Task revision 18
B BlockTask(expectedRevision = 17) → REVISION_MISMATCH(actual = 18)
```

B must re-read and decide whether a new command is valid.

### 14.2 Fencing race

```text
Session A gets fencingToken 4
Lease 4 expires
Session B claims same running Task → fencingToken 5
A sends delayed checkpoint with token 4
→ STALE_FENCING_TOKEN
```

A new Task revision cannot make old fencing authority valid again.

### 14.3 Different problems

Revision prevents lost updates between mutations that are otherwise authorized.

Fencing prevents an old execution owner from acting after authority moved.

Both are required.

### 14.4 Permission-decision race

`RecordPermissionDecision` requires `expectedPreviousDecisionId`. Two humans cannot append competing sequence-2 decisions against the same `HUMAN_REQUIRED`; one wins and the other must re-read the permission state.

## 15. Retry guidance

| Situation | Required client behavior |
| --- | --- |
| timeout/connection loss; commit unknown | retry exact mutation with same `commandId` |
| retryable `INTERNAL_ERROR` | retry exact `commandId` |
| `REVISION_MISMATCH` | query current resource; issue new command only if intent remains valid |
| `LEASE_EXPIRED` / `STALE_FENCING_TOKEN` | stop old authority; recover/claim new Lease; use new command ids |
| `HUMAN_DECISION_REQUIRED` | wait/query; do not spin-retry protected action |
| `PERMISSION_DENIED` | stop unless policy/context legitimately changes |
| `IDEMPOTENCY_CONFLICT` | treat as client bug/key misuse |
| transport 5xx/tool failure with no protocol result | retry exact mutation with same `commandId` |

## 16. Recovery after Session/Lease loss

Recovery is not Session resurrection.

If connectivity was lost but Session and Lease are still current:

1. reconnect transport;
2. `GetSession`;
3. `GetLease` or `GetTaskExecutionView`;
4. continue only if authority is still active/current;
5. replay commit-unknown commands with original command ids.

If Lease expired/revoked:

1. stop old execution mutations;
2. start a new Session if necessary;
3. `ListClaimableTasks` exposes matching running Tasks with no active Lease;
4. `ClaimTask` creates a new Lease with higher fencing token;
5. read `GetTaskExecutionView` / `ListTaskCheckpoints` for durable handoff state;
6. continue under the new Lease;
7. create new permission requests because old Lease-scoped allows do not transfer.

A stale process that wakes later remains fenced even if its local Task snapshot or model memory says work may continue.

## 17. Lifecycle examples

### 17.1 Successful path

```text
RegisterAgent
StartSession
CreateGoal
CreateTask(A)
CreateTask(B depends on A)
ListClaimableTasks
ClaimTask(A) → Lease/fencing token
HeartbeatSession
RenewLease
RecordCheckpoint(progress)
RequestPermission → PermissionRequest + policy ALLOW
CompleteTask → result Checkpoint + Task succeeded + Lease released
GetTask / ListGoalTasks
```

### 17.2 Human escalation

```text
Agent RequestPermission
→ policy PermissionDecision sequence 1 = HUMAN_REQUIRED
Human ListPendingPermissionRequests
Human RecordPermissionDecision(expectedPreviousDecisionId = seq1, outcome = ALLOW)
Agent GetPermissionRequestState
→ latest decision sequence 2 = ALLOW
```

If the Agent Lease expired before use, the human ALLOW closes the old request but does not restore authority. Replacement execution re-requests permission under its new Lease.

### 17.3 Session/Lease recovery

```text
Session A ClaimTask → token 4
Session A RecordCheckpoint
Session A disappears
Lease expires
Session B ClaimTask same running Task → token 5
Session A delayed mutation token 4 → STALE_FENCING_TOKEN
Session B reads checkpoints and continues
```

## 18. HTTP mapping

HTTP is an adapter, not protocol authority.

Recommended protocol prefix:

```text
/v0.1
```

Recommended headers:

```text
Idempotency-Key: <commandId>
If-Match: "rev-<expectedRevision>"          # when applicable
MindRail-Correlation-Id: <correlationId>    # optional
MindRail-Causation-Id: <causationId>        # optional
```

Actor identity comes from authenticated request context and is validated against protocol attribution. Session id is not a bearer credential.

### 18.1 Command routes

| Command | HTTP mapping |
| --- | --- |
| `RegisterAgent` | `POST /v0.1/workspaces/{workspaceId}/agents` |
| `StartSession` | `POST /v0.1/workspaces/{workspaceId}/sessions` |
| `HeartbeatSession` | `POST /v0.1/workspaces/{workspaceId}/sessions/{sessionId}:heartbeat` |
| `EndSession` | `POST /v0.1/workspaces/{workspaceId}/sessions/{sessionId}:end` |
| `CreateGoal` | `POST /v0.1/workspaces/{workspaceId}/goals` |
| `CreateTask` | `POST /v0.1/workspaces/{workspaceId}/tasks` |
| `ClaimTask` | `POST /v0.1/workspaces/{workspaceId}/tasks/{taskId}:claim` |
| `RenewLease` | `POST /v0.1/workspaces/{workspaceId}/leases/{leaseId}:renew` |
| `ReleaseLease` | `POST /v0.1/workspaces/{workspaceId}/leases/{leaseId}:release` |
| `RecordCheckpoint` | `POST /v0.1/workspaces/{workspaceId}/tasks/{taskId}/checkpoints` |
| `CompleteTask` | `POST /v0.1/workspaces/{workspaceId}/tasks/{taskId}:complete` |
| `FailTask` | `POST /v0.1/workspaces/{workspaceId}/tasks/{taskId}:fail` |
| `BlockTask` | `POST /v0.1/workspaces/{workspaceId}/tasks/{taskId}:block` |
| `ResumeTask` | `POST /v0.1/workspaces/{workspaceId}/tasks/{taskId}:resume` |
| `RequestPermission` | `POST /v0.1/workspaces/{workspaceId}/permission-requests` |
| `RecordPermissionDecision` | `POST /v0.1/workspaces/{workspaceId}/permission-requests/{requestId}/decisions` |

Not part of v0.1:

```text
POST /commands
POST /rpc
PATCH /entities/{id}
```

### 18.2 Query routes

| Query | HTTP mapping |
| --- | --- |
| `GetWorkspace` | `GET /v0.1/workspaces/{workspaceId}` |
| `GetGoal` | `GET /v0.1/workspaces/{workspaceId}/goals/{goalId}` |
| `ListGoals` | `GET /v0.1/workspaces/{workspaceId}/goals` |
| `GetTask` | `GET /v0.1/workspaces/{workspaceId}/tasks/{taskId}` |
| `ListGoalTasks` | `GET /v0.1/workspaces/{workspaceId}/goals/{goalId}/tasks` |
| `ListClaimableTasks` | `GET /v0.1/workspaces/{workspaceId}/tasks?claimableForSession={sessionId}` |
| `GetTaskExecutionView` | `GET /v0.1/workspaces/{workspaceId}/tasks/{taskId}/execution-view` |
| `ListTaskCheckpoints` | `GET /v0.1/workspaces/{workspaceId}/tasks/{taskId}/checkpoints` |
| `GetAgent` | `GET /v0.1/workspaces/{workspaceId}/agents/{agentId}` |
| `GetSession` | `GET /v0.1/workspaces/{workspaceId}/sessions/{sessionId}` |
| `GetLease` | `GET /v0.1/workspaces/{workspaceId}/leases/{leaseId}` |
| `GetPermissionRequestState` | `GET /v0.1/workspaces/{workspaceId}/permission-requests/{requestId}` |
| `ListPendingPermissionRequests` | `GET /v0.1/workspaces/{workspaceId}/permission-requests?state=human-required` |

Query parameters above are fixed selectors, not an arbitrary filter language.

### 18.3 HTTP status mapping

| Protocol result/error | HTTP status |
| --- | --- |
| create success | `201 Created` |
| other success | `200 OK` |
| `INVALID_INPUT`, `UNSUPPORTED_PROTOCOL_VERSION` | `400 Bad Request` |
| adapter authentication failure | `401 Unauthorized` |
| `ACTOR_NOT_AUTHORIZED`, `PERMISSION_DENIED` | `403 Forbidden` |
| `NOT_FOUND` | `404 Not Found` |
| `REVISION_MISMATCH` via `If-Match` | `412 Precondition Failed` |
| `HUMAN_DECISION_REQUIRED` | `428 Precondition Required` |
| other state/lease/fencing/idempotency conflicts | `409 Conflict` |
| `POLICY_UNAVAILABLE` | `503 Service Unavailable` |
| `INTERNAL_ERROR` | `500 Internal Server Error` |

HTTP status is coarse classification; the response body retains the stable protocol code.

## 19. MCP mapping

MCP exposes the same semantics.

Mutation tools are dedicated:

```text
mindrail_register_agent
mindrail_start_session
mindrail_heartbeat_session
mindrail_end_session
mindrail_create_goal
mindrail_create_task
mindrail_claim_task
mindrail_renew_lease
mindrail_release_lease
mindrail_record_checkpoint
mindrail_complete_task
mindrail_fail_task
mindrail_block_task
mindrail_resume_task
mindrail_request_permission
mindrail_record_permission_decision
```

There is no `mindrail_execute_action(action, payload)` tool.

Addressable reads should be resources/resource templates where practical:

```text
mindrail://workspaces/{workspaceId}
mindrail://workspaces/{workspaceId}/goals/{goalId}
mindrail://workspaces/{workspaceId}/tasks/{taskId}
mindrail://workspaces/{workspaceId}/tasks/{taskId}/execution-view
mindrail://workspaces/{workspaceId}/sessions/{sessionId}
mindrail://workspaces/{workspaceId}/permission-requests/{requestId}
```

Parameterized discovery is clearer as read-only tools:

```text
mindrail_list_goals
mindrail_list_goal_tasks
mindrail_list_claimable_tasks
mindrail_list_task_checkpoints
mindrail_list_pending_permission_requests
```

MCP mutation arguments include command ids, revision/fencing preconditions, and explicit command fields. Actor identity may be injected/bound by the MCP server/runtime and must not be spoofable by model-generated arguments.

Tool failures should expose the same structured error (`code`, `message`, `retryable`, typed `details`) in structured content when supported. Text is supplemental.

## 20. Security/authority boundary

Protocol authorization is one layer in a chain:

```text
authenticated caller/runtime principal
        ↓
MindRail actor/workspace authorization
        ↓
Session + Lease + fencing authority
        ↓
MindRail deterministic permission decision (when required)
        ↓
external credentials / IAM / sandbox / host restrictions
```

Passing one layer never bypasses the next.

Examples:

- MindRail `ALLOW repository.write` cannot make a read-only GitHub token writable.
- MindRail `ALLOW filesystem.write` cannot escape a filesystem sandbox.
- A human decision cannot resurrect an expired Lease.
- Model text saying "approved" has no authority unless deterministic policy or an authenticated human records the domain decision.
- Provider credentials must not be embedded in domain records, audit attributes, PermissionRequests, or extension bags.

## 21. Backwards-compatible evolution

Compatible additions within v0.1, when existing behavior is unchanged:

- new explicit commands;
- new explicit queries;
- new HTTP/MCP mappings for existing semantics;
- optional response-envelope/read-projection fields that v0.1 clients are specified to ignore when unknown.

Existing v0.1 command input shapes remain strict. Adding even an optional field to an existing command request requires explicit compatibility review and normally a new protocol version because old strict servers may reject it.

Breaking changes requiring a new protocol compatibility version include:

- changing existing command meaning;
- weakening idempotency, revision, or fencing guarantees;
- broadening who may grant permission;
- transferring permission across Lease replacement;
- renaming/removing required command fields;
- changing stable error-code meaning;
- making clients reinterpret an existing field;
- replacing explicit commands with generic mutation semantics.

Before 1.0, a breaking change may advance to `0.2`; v0.1 clients do not treat `0.2` as automatically wire-compatible.

Domain breaking changes remain governed separately by ADR-0003.

## 22. Rejected alternatives

### Generic CRUD/entity patching

Rejected. Legal operations carry invariants beyond final fields. `CompleteTask` must check fencing/revision, append result evidence, transition Task, and release Lease atomically; `PATCH Task {status: succeeded}` cannot express this safely.

### Universal command/action bag

Rejected. It hides compatibility and authority semantics behind runtime strings/payloads and becomes an unreviewed extension mechanism.

### HTTP or MCP as canonical protocol

Rejected. Both are adapters; neither should define the core lifecycle.

### Client-selected Lease TTL

Rejected. Lease duration is control-plane policy, not worker preference.

### Implicit Lease renewal on arbitrary traffic

Rejected. A read/query must not accidentally keep execution authority alive.

### Permission boolean on Task/Session

Rejected. Permission is request-specific, attributable, auditable, and may require a human decision chain.

### Reusing old ALLOW after recovery

Rejected. The PermissionRequest contains old Session/Lease/fencing context; reuse would defeat fencing and policy re-evaluation.

### Provider-specific core commands

Rejected. `CreateGitHubIssue`, `RunCloudflareWorker`, or vendor-session commands belong to integration adapters, not protocol core.

### Event sourcing

Rejected. Current runtime state remains canonical; append-only audit evidence is not the sole reconstruction source.

## 23. Deferred protocol features

Deferred until concrete need exists:

- Workspace create/archive administration;
- Agent disable/re-enable/capability mutation;
- Goal complete/fail/cancel commands and terminalization policy;
- Task cancel, retry/reopen-failed, reprioritize, or definition-revision commands;
- bulk/batch commands and multi-command transactions;
- subscriptions, watch streams, webhooks, or long polling;
- standardized human-decision wait/notification semantics;
- priority/queue/fairness/affinity/capability implication rules;
- context-package schema beyond current domain/read state;
- artifact upload/download (v0.1 references evidence only);
- authentication/credential exchange and Workspace membership/roles;
- policy configuration/language protocol;
- audit-event query API beyond later operational need;
- command-result retention/compaction administration;
- cross-Workspace operations;
- offline merge;
- provider-specific integrations;
- event streams/event sourcing;
- generic metadata/extensions/plugin payloads.

## 24. Acceptance criteria

The written design is review-ready when:

1. every MVP mutation is an explicit fixed-shape command;
2. queries cover discovery, read-after-conflict, permission review, and Session/Lease recovery;
3. lost-response retries cannot duplicate durable side effects;
4. revisions and fencing solve separate stated concurrency problems;
5. stale sessions cannot mutate Tasks or reuse old permission grants;
6. policy and human decisions conform to domain PermissionDecision invariants;
7. HTTP and MCP map the same commands/errors instead of defining separate lifecycles;
8. no provider-specific concept enters protocol core;
9. no arbitrary JSON metadata/action escape hatch exists;
10. external credentials/sandbox restrictions remain independent;
11. no unresolved placeholder remains;
12. ADR-0004 remains Proposed until ADR-0003 is accepted and protocol review is complete.
