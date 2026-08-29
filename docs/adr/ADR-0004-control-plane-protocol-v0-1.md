# ADR-0004: Control-plane protocol v0.1 semantics

- **Status:** Proposed
- **Date:** 2026-08-29
- **Depends on:** ADR-0001, ADR-0003

## Context

ADR-0001 defines MindRail as a vendor-neutral control plane whose HTTP, MCP, CLI, and vendor-specific integrations are adapters over common semantics. ADR-0003 defines the first domain vocabulary and makes JSON Schema Draft 2020-12 the canonical authority for domain records.

MindRail now needs a transport-neutral protocol that can drive the first durable control-plane loop without making HTTP, MCP, GitHub, Cloudflare, TypeScript, or a model runtime part of the core architecture. The protocol must distinguish durable work from ephemeral execution sessions, survive retries and session loss, and reject stale execution owners deterministically.

This ADR defines protocol semantics only. It does not select a server framework, persistence engine, policy engine implementation, deployment platform, authentication provider, or orchestration engine.

## Decision

### 1. Protocol v0.1 is transport-neutral and binds to domain v1

MindRail protocol v0.1 defines commands, queries, responses, errors, retry behavior, concurrency preconditions, and authority checks independently of transport.

HTTP and MCP are mappings over these semantics. Neither adapter may introduce a second task/lease/permission lifecycle.

Protocol v0.1 consumes the canonical `schemas/domain/v1/` records defined by ADR-0003. Protocol request shapes are intent-specific inputs, not replacement domain entities and not client-authored authoritative snapshots.

### 2. Mutations use explicit commands

The v0.1 command surface is intentionally explicit. Core commands include:

- `RegisterAgent`;
- `StartSession`;
- `HeartbeatSession`;
- `EndSession`;
- `CreateGoal`;
- `CreateTask`;
- `ClaimTask`;
- `RenewLease`;
- `ReleaseLease`;
- `RecordCheckpoint`;
- `CompleteTask`;
- `FailTask`;
- `BlockTask`;
- `ResumeTask`;
- `RequestPermission`;
- `RecordPermissionDecision`.

There is no v0.1 `UpdateEntity`, `PatchObject`, generic `ExecuteAction`, arbitrary command payload, or provider-specific core command.

### 3. Commands have a common protocol envelope but command-specific bodies

Every mutating command carries:

- `protocolVersion`;
- command discriminator;
- `commandId` as the idempotency key;
- `workspaceId`;
- `actor` as an `ActorRef`;
- `sessionId` when the operation is session-bound;
- `expectedRevision` when the command mutates or conditionally acts on an existing mutable primary resource;
- optional `correlationId` and `causationId` for tracing/audit.

The envelope does not contain an arbitrary metadata object. Each command defines its own fixed fields.

The asserted `actor` is not self-authenticating. A transport adapter must bind it to authenticated runtime identity and reject impersonation.

### 4. Runtime state remains authoritative

Clients submit intent fields only. The runtime authoritatively assigns resource ids, timestamps, revisions, lease expiry times, fencing tokens, permission-decision sequence numbers, and other state-derived values.

Read models may combine domain records for recovery or client convenience, but they are projections over canonical runtime state and are not new persisted domain authorities.

### 5. Every mutating command is idempotent

`commandId` is required for every mutating command and is unique within a workspace.

Once a command reaches the mutation boundary, the runtime atomically records the command fingerprint and terminal outcome with the state change. A retry with the same `commandId` and identical protocol command returns the original outcome without creating duplicate resources or append-only records.

Reusing a `commandId` for a different command produces `IDEMPOTENCY_CONFLICT`.

Validation or authentication failures that occur before command admission do not reserve the idempotency key.

### 6. Revision and lease fencing are separate mandatory concurrency controls

`expectedRevision` protects mutable resources from lost updates. A stale expected revision produces `REVISION_MISMATCH`.

Task execution mutations also require the current `leaseId` and `fencingToken`. A lease that is missing, expired, released/revoked, or superseded cannot authorize a checkpoint, terminal task transition, or task-scoped permission request.

Fencing tokens increase monotonically for successive leases on a task. A stale session remains rejected even if a delayed request is otherwise structurally valid.

### 7. Task durability survives session and lease loss

A task is never owned by a session. Session or lease loss does not delete or recreate the task.

When a running task has no active lease, it is recoverable work. A new active session with sufficient Agent capabilities may discover and claim it, receiving a newer fencing token. Existing checkpoints remain the durable handoff record.

The old session cannot regain authority merely by reconnecting or replaying requests with its old lease/token.

### 8. Permission decisions never mint external credentials

`RequestPermission` creates a task-scoped `PermissionRequest` tied to the current session, lease, and fencing token. The runtime records an initial deterministic policy decision with outcome `ALLOW`, `DENY`, or `HUMAN_REQUIRED`.

`HUMAN_REQUIRED` grants no authority. A later human decision may resolve only to `ALLOW` or `DENY` and is appended through the domain decision chain.

An LLM cannot grant authority by producing text or tool arguments. Protocol authorization also cannot bypass credentials, IAM, repository permissions, operating-system controls, network policy, or sandbox restrictions enforced by the external service/runtime.

A permission decision tied to an old lease does not transfer to a replacement session or lease.

### 9. Errors are stable and machine-readable

Protocol failures return stable error codes plus typed details where useful. v0.1 includes, at minimum:

- `INVALID_INPUT`;
- `NOT_FOUND`;
- `CONFLICT`;
- `REVISION_MISMATCH`;
- `LEASE_MISSING`;
- `LEASE_EXPIRED`;
- `STALE_FENCING_TOKEN`;
- `PERMISSION_DENIED`;
- `HUMAN_DECISION_REQUIRED`;
- `INVALID_STATE_TRANSITION`;
- `IDEMPOTENCY_CONFLICT`.

Transport status codes or MCP error flags are adapter representations; clients must key protocol behavior on the stable protocol code.

### 10. HTTP and MCP remain adapters

The HTTP adapter uses explicit resource/command routes rather than a universal RPC endpoint. HTTP headers may map idempotency, revision, and tracing fields, but header names are not protocol authority.

The MCP adapter exposes each mutation as a dedicated tool. Addressable reads are resources or resource templates; filtered/discovery reads may be read-only tools. MCP tools do not receive a generic action bag.

Provider-specific concepts remain outside protocol core in both mappings.

## Alternatives considered

### Generic CRUD over domain entities

Rejected. Allowing clients to POST or PATCH authoritative Task, Lease, Session, or PermissionDecision snapshots would blur runtime authority, make invalid state transitions easy to express, and weaken fencing/idempotency guarantees.

### One generic RPC endpoint with an action string and JSON payload

Rejected. It creates an unbounded protocol escape hatch, weakens compatibility review, and makes transport adapters responsible for inventing semantics that should be explicit in core.

### HTTP as the canonical protocol

Rejected. HTTP is an important adapter, but HTTP verbs/status codes should not define MindRail semantics or constrain MCP/local clients.

### MCP as the canonical protocol

Rejected for the same reason. MCP is an adapter for model-facing clients, not the authority for task/lease lifecycle semantics.

### Session-owned tasks

Rejected. Sessions are ephemeral. Binding task durability to session lifetime would violate ADR-0001 and make recovery after host interruption unreliable.

### Revision-only concurrency

Rejected. Revisions prevent lost updates but do not prevent a delayed former lease holder from acting after a new execution owner is granted authority.

### Fencing-only concurrency

Rejected. Fencing protects execution ownership but does not protect ordinary mutable-resource updates from stale writes.

### Transfer permission decisions across lease recovery

Rejected. Permission requests are scoped to a specific execution authority. Reusing an old allow decision after lease loss would bypass fencing and context changes.

### Event sourcing as protocol authority

Rejected. v0.1 commands mutate normal current state and may emit append-only audit records; clients do not reconstruct authoritative state by replaying an event stream.

## Consequences

- Clients get a small, explicit, testable control-plane surface.
- Retries can be safe across dropped responses and process restarts.
- Session/lease recovery is deterministic and does not depend on model memory.
- HTTP and MCP can evolve as adapters without changing core lifecycle semantics.
- Runtime implementations must persist idempotency outcomes and enforce cross-record invariants atomically where a command spans multiple records.
- Some command implementations require coordinated changes to Task, Lease, Checkpoint, Session, PermissionRequest, PermissionDecision, and AuditEvent records; the later runtime slice must make those transitions atomic at its consistency boundary.
- The protocol deliberately exposes fewer generic mutation capabilities, so new lifecycle operations require explicit protocol design rather than ad hoc patches.

## Compatibility and migration

Protocol v0.1 is the first protocol version; there is no deployed protocol state to migrate.

The detailed specification defines compatibility rules. In summary:

- new commands/queries may be added compatibly when existing semantics do not change;
- existing command meaning, required preconditions, stable error meaning, or authority boundaries cannot change incompatibly within v0.1;
- breaking protocol changes require a new protocol version;
- domain-schema versioning remains governed separately by ADR-0003;
- HTTP/MCP mapping changes that preserve protocol semantics are adapter changes, not protocol-version changes.

ADR-0004 remains **Proposed** while protocol semantics are under review. With ADR-0003 now Accepted, there is no known domain-contract blocker to accepting this ADR after review.
