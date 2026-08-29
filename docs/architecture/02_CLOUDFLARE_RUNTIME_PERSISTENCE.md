# Cloudflare reference runtime persistence mapping

- **Status:** Research proposal; not a binding protocol or domain decision
- **Date:** 2026-08-29
- **Research base:** `adr/domain-contracts` at `7e1abb44627df983b1674cf018cb9e1358e1ee7a`
- **Depends on:** ADR-0001, proposed ADR-0003, MindRail v1 Domain Contracts design
- **Scope:** Reference persistence/coordination mapping for Cloudflare D1 and Durable Objects. No production persistence implementation is introduced by this document.

## 1. Executive recommendation

For MindRail v0.1, use **one Durable Object coordinator per Workspace plus one shared D1 runtime database**.

The split is:

- **D1 is the canonical operational store** for all durable MindRail runtime records and adapter-internal relational state required to enforce persistence invariants.
- **One Durable Object per Workspace is the coordination address** for mutation paths that require sequencing, lease recovery scheduling, or workspace-local conflict reduction.
- **Durable Object memory is never authoritative.** An object may keep an in-memory promise queue or cache as a coordination optimization, but every correctness-relevant fact must be recoverable from D1 after restart.
- **Durable Object storage is not a second task database.** The coordinator may use its single alarm and minimal coordinator metadata, but must not mirror Tasks, Leases, revisions, fencing counters, or permission state there.
- **D1 constraints and atomic transactions remain the correctness boundary.** The Durable Object reduces conflicting work; it does not replace database preconditions.
- **Use one D1 database for v0.1.** Do not create one database per Workspace until measured storage or write-throughput pressure justifies sharding.
- **Do not introduce per-Task Durable Objects or a hybrid topology in v0.1.** Cross-task dependency, Goal, Session, and permission operations make that topology materially more complex without present evidence that a Workspace coordinator is insufficient.

This is approach **B: one Durable Object per Workspace + D1 persistence**.

Cloudflare remains replaceable. No D1 database identifier, Durable Object identifier, alarm concept, Worker binding, or Cloudflare consistency primitive belongs in canonical JSON Schema or the transport-neutral protocol.

## 2. Inherited architectural constraints

This proposal preserves the existing boundaries rather than changing domain semantics:

1. Runtime state is authoritative operational state; Git/GitHub are not the task database.
2. `Workspace` is the existing isolation boundary and is therefore the natural coordination granularity.
3. `Task`, `Session`, and `Lease` remain separate concepts.
4. A Lease is the execution claim; there is no additional persisted `claimed` Task status.
5. Fencing tokens increase monotonically per Task and stale tokens cannot authorize mutation.
6. Mutable domain resources use optimistic `revision` values.
7. `Checkpoint`, `PermissionRequest`, `PermissionDecision`, and `AuditEvent` remain append-only domain records.
8. Audit is not event sourcing.
9. Cloudflare types and identifiers do not leak into canonical contracts.
10. This mapping must not modify ADR-0003 semantics to fit Cloudflare.

If the runtime/state-machine or protocol slices later refine an operation's legal state transition, this persistence adapter must implement that rule; this document does not redefine it.

## 3. Verified Cloudflare platform facts

The following Cloudflare-specific facts were verified against official documentation on 2026-08-29 and should be rechecked before implementation because service limits and pricing can change.

### 3.1 D1

- D1 uses SQLite semantics and supports foreign keys, indexes, partial indexes, JSON functions, and versioned migrations.
- `D1Database.batch()` executes statements sequentially as one SQL transaction. If a statement fails, the sequence is aborted/rolled back.
- D1 runs in auto-commit outside such a batch, so a correctness-critical multi-table mutation must not be split across independent Worker-to-D1 calls.
- A D1 database is inherently single-threaded and processes queries one at a time. Excess concurrency is queued until overload limits are reached.
- A Workers Paid D1 database is limited to 10 GB; the current account limit is 50,000 databases and 1 TB total storage before requested limit increases.
- D1 read replication is asynchronous. When enabled, the Sessions API provides sequential consistency via bookmarks. A first unconstrained read may still begin from a stale replica; `first-primary` or a prior bookmark is required when freshness matters.
- Writes are sent to the primary database.
- D1 automatically retries some read-only queries, but write retries remain an application responsibility and must be idempotent or otherwise safe.
- D1 billing is based primarily on rows read, rows written, and stored bytes. Index design therefore affects both latency and cost.

### 3.2 Durable Objects

- Each Durable Object identity names one globally unique stateful instance at a time and is suitable for a tenant/workspace-sized coordination atom.
- Durable Object memory can be evicted or reset during normal operation and deployment. Persistent correctness cannot depend on memory surviving.
- Durable Object storage is private, transactional, and strongly consistent, but this proposal intentionally does not use it as the MindRail runtime database.
- Durable Objects are single-threaded, but JavaScript `async`/`await` can allow requests to interleave while waiting on non-storage I/O. A call from the coordinator to D1 is therefore not automatically a global critical section.
- `blockConcurrencyWhile()` can block interleaving, but Cloudflare recommends reserving it mainly for initialization; holding it across external I/O is an anti-pattern and reduces throughput.
- Each Durable Object has one alarm. Alarm delivery is at least once and handlers must be idempotent.
- New Durable Object namespaces should use the SQLite storage backend. Current Cloudflare configuration also supports declarative Durable Object class lifecycle through Wrangler `exports`.

### 3.3 Current limits/cost signals relevant to v0.1

These numbers are implementation-planning inputs, not protocol guarantees.

| Area | Current Cloudflare value relevant to MindRail | v0.1 implication |
| --- | --- | --- |
| D1 database size | 10 GB paid / 500 MB free | One shared DB is sufficient for early dogfooding; watch growth before sharding. |
| D1 DB concurrency | One query at a time per database | Keep transactions short and indexed; a single shared DB eventually becomes a write-throughput ceiling. |
| D1 max query duration | 30 seconds | Lease sweeps and migrations must be bounded. |
| D1 bound parameters | 100 per query | Avoid giant `IN` lists or bulk mutations in one statement. |
| D1 Paid included usage | 25B rows read/month; 50M rows written/month; 5 GB storage | Query/index discipline matters more than provisioned capacity. |
| D1 Paid overage | $0.001/million rows read; $1/million rows written; $0.75/GB-month | High-frequency heartbeat/audit write amplification is the main cost risk. |
| Durable Objects count | Unlimited objects; class/account limits apply | Per-Workspace identity is operationally feasible. |
| SQLite DO storage | 10 GB per object paid | Not relevant to domain storage because the coordinator stores only minimal metadata/alarm state. |
| Durable Object alarms | One alarm per object, at-least-once delivery | One Workspace coordinator can schedule the earliest Workspace lease expiry. |
| Durable Object Paid requests | 1M/month included, then $0.15/million | Route only coordination-sensitive operations through the DO; pure reads need not. |
| Durable Object Paid duration | 400k GB-s/month included, then $12.50/million GB-s | Avoid long-lived non-hibernating coordinator work and lock-like waits. |

## 4. Approaches considered

### A. D1 only with optimistic transactions

**Shape:** Workers call one D1 database directly. All claim, lease, revision, and expiry behavior is implemented with SQL transactions, conditional updates, unique indexes, and periodic/lazy expiry scans.

**Advantages**

- Fewest Cloudflare components.
- D1 constraints are sufficient to make claims and fencing correct when transactions are designed carefully.
- No Durable Object hop on write paths.
- Portability is straightforward.

**Disadvantages**

- Coordination logic is scattered across every mutation entry point unless the service layer is disciplined.
- Lease expiry wakeups require lazy recovery or a broader scheduled scan.
- High-contention Workspace commands repeatedly reach D1 just to discover conflicts.
- There is no natural per-Workspace serialization address for later WebSocket/session-control needs.

**Decision:** viable fallback and useful local mental model, but not the preferred Cloudflare reference. Correctness must remain D1-compatible enough that this topology could still be used by another deployment.

### B. One Durable Object per Workspace + D1 persistence

**Shape:** every Workspace maps to one coordinator object. Coordination-sensitive commands enter that object, which serializes its D1 critical sections in process and executes one atomic D1 transaction per accepted state mutation. D1 remains authoritative.

**Advantages**

- Workspace already exists as the domain isolation boundary; no new persistent concept is invented.
- One coordination address covers Task claims, lease renew/release/recovery, Session state, dependency transitions, and permission resolution without cross-object protocols.
- The object's single alarm can track the earliest lease expiry for that Workspace.
- In-memory sequencing reduces expected D1 conflicts while database constraints still protect restart/bypass/error cases.
- Future replacement can map the same coordination boundary to an actor, advisory lock, mutex service, or serializable DB transaction.

**Disadvantages**

- Adds a network hop and Durable Object request cost.
- A very hot single Workspace can become a coordinator hotspot.
- The coordinator must explicitly serialize D1-bound critical sections; `async` D1 calls can otherwise interleave.
- The D1 database itself is still a shared single-threaded write bottleneck across Workspaces.

**Decision:** **recommended for v0.1**. The costs are bounded and the coordination model is substantially easier to reason about than per-Task or hybrid ownership.

### C. Durable Object per Task + D1

**Shape:** each Task owns a coordinator object; D1 stores durable state.

**Advantages**

- Natural Task-local claim/lease serialization.
- Very high theoretical parallelism across Tasks.

**Disadvantages**

- Goal-level transitions and dependency resolution span multiple Task objects.
- Session lifecycle and permission queries become cross-object operations.
- Workspace-wide lease expiry or human-approval views need fan-out or another coordinator.
- Multiple object identities can end up writing related rows in the same D1 transaction domain.
- More routing, failure, testing, and migration surface before any measured need.

**Decision:** rejected for v0.1.

### D. Hybrid coordination

**Shape:** a Workspace scheduler object plus Task objects for lease/heartbeat/checkpoint operations, possibly with other specialized objects.

**Advantages**

- Can isolate hot Task traffic from Workspace scheduling.
- Could support very large Workspaces if measurements justify it.

**Disadvantages**

- Introduces cross-Durable-Object ownership rules and distributed failure cases.
- Risks two coordination authorities for the same Task lifecycle.
- Requires explicit ordering between Workspace and Task coordinators even though D1 still must enforce final correctness.
- Harder to port and test.

**Decision:** rejected until real traffic demonstrates that one Workspace coordinator is a bottleneck.

## 5. Durable Object identity and responsibilities

### 5.1 Identity

The coordinator identity is derived from the canonical `workspaceId` using adapter-internal naming, conceptually:

```text
WorkspaceCoordinator("workspace:" + workspaceId)
```

A Cloudflare implementation may use `idFromName(...)`, but the resulting Durable Object id is never persisted into the domain model or exposed by the protocol.

Do not use a `Project` id because `Project` is not a canonical v1 entity. Do not create one only to fit deployment topology.

### 5.2 Coordinator owns coordination, not truth

The Workspace coordinator may own:

- admission ordering for coordination-sensitive commands;
- a short-lived in-memory promise queue/mutex for D1 critical sections;
- scheduling the Workspace's next lease-expiry alarm;
- retry/backoff around transient D1 errors when an operation is safe to retry;
- post-restart reconciliation from D1.

It must not own authoritative copies of:

- Task status/revision;
- Session status/revision;
- active Lease identity or expiry;
- per-Task last fencing token;
- checkpoints;
- permission state;
- audit history.

Those values live in D1.

### 5.3 Why an explicit in-memory queue is still required

Durable Object single-threading alone is not enough when the handler awaits D1. Cloudflare documents that non-storage asynchronous I/O can allow another request to interleave. Therefore each Workspace coordinator should put coordination-sensitive operations into a local promise chain before the first `await` to D1.

That queue is an optimization, not a correctness dependency:

- if the object restarts, the queue disappears;
- the next request reconstructs truth from D1;
- D1 constraints, expected revisions, fencing checks, and atomic transactions still reject invalid concurrent writes.

Do not use `blockConcurrencyWhile()` as a request-path distributed lock around D1 calls.

## 6. D1 database topology

Use **one shared D1 database** for v0.1.

Every non-Workspace table includes `workspace_id`. Cross-record foreign keys use `(workspace_id, id)` pairs so same-Workspace references are enforced by the database where possible.

Reasons not to use one D1 database per Workspace yet:

- no measured database-size or write-throughput problem exists;
- dynamic database routing/binding adds deployment and operational complexity;
- schema migrations become N-database fleet operations;
- v0.1 success depends on correctness and debuggability, not horizontal database sharding.

A later adapter version may shard Workspaces across D1 databases without changing protocol/domain semantics. The routing map would be infrastructure configuration, not a field on Workspace.

## 7. SQL storage model

### 7.1 Mapping conventions

- Domain ids remain opaque `TEXT` values.
- Non-Workspace primary keys are `(workspace_id, id)` so ids need not be globally unique across Workspaces.
- Domain `UtcDateTime` values are stored internally as integer Unix epoch milliseconds. The persistence adapter converts them to/from the canonical UTC `...Z` representation. This avoids incorrect lexical ordering of timestamps with different fractional-second precision.
- Bounded arrays/objects that are not queried relationally are stored as validated JSON text.
- Relationships and sets needed for invariants/querying are normalized.
- D1 foreign keys and `CHECK`/unique constraints supplement canonical JSON Schema validation; they do not replace it.
- Hard deletes are not required for normal v0.1 lifecycle. Foreign keys should default to `RESTRICT` rather than broad cascades so historical evidence is not silently erased.

### 7.2 Proposed tables

The following DDL is a design proposal, not an applied migration.

```sql
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived'))
);

CREATE TABLE goals (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'succeeded', 'failed', 'cancelled')),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE tasks (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  acceptance_criteria_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'ready', 'running', 'blocked', 'succeeded', 'failed', 'cancelled')
  ),
  status_reason_json TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, goal_id) REFERENCES goals(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE task_dependencies (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_task_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id, dependency_task_id),
  CHECK (task_id <> dependency_task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, dependency_task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE task_required_capabilities (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id, capability),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE agents (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE agent_capabilities (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, capability),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE sessions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'expired')),
  last_seen_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE RESTRICT
);

-- Adapter-internal monotonic allocator. It is not a domain entity.
CREATE TABLE task_fencing_counters (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  last_fencing_token INTEGER NOT NULL DEFAULT 0 CHECK (last_fencing_token >= 0),
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE leases (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'revoked')),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE checkpoints (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  created_at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('progress', 'handoff', 'blocked', 'result')),
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  progress_percent INTEGER CHECK (progress_percent BETWEEN 0 AND 100),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE permission_requests (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  created_at_ms INTEGER NOT NULL,
  permission TEXT NOT NULL,
  justification TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  PRIMARY KEY (workspace_id, id),
  CHECK ((resource_type IS NULL) = (resource_id IS NULL)),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, lease_id) REFERENCES leases(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE permission_decisions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('ALLOW', 'DENY', 'HUMAN_REQUIRED')),
  basis TEXT NOT NULL CHECK (basis IN ('policy', 'human')),
  decided_by_type TEXT NOT NULL CHECK (decided_by_type IN ('system', 'human', 'agent')),
  decided_by_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  policy_id TEXT,
  policy_version TEXT,
  reason TEXT,
  supersedes_decision_id TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, request_id, sequence),
  FOREIGN KEY (workspace_id, request_id) REFERENCES permission_requests(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, supersedes_decision_id)
    REFERENCES permission_decisions(workspace_id, id) ON DELETE RESTRICT
);

-- Adapter-internal query projection for the append-only decision chain.
-- PermissionDecision records remain the durable history; this row is maintained
-- in the same transaction as every new decision.
CREATE TABLE permission_heads (
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  latest_decision_id TEXT NOT NULL,
  latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= 1),
  latest_outcome TEXT NOT NULL CHECK (latest_outcome IN ('ALLOW', 'DENY', 'HUMAN_REQUIRED')),
  awaiting_human INTEGER NOT NULL CHECK (awaiting_human IN (0, 1)),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, request_id),
  FOREIGN KEY (workspace_id, request_id) REFERENCES permission_requests(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, latest_decision_id)
    REFERENCES permission_decisions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE audit_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('system', 'human', 'agent')),
  actor_id TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  related_json TEXT,
  transition_from TEXT,
  transition_to TEXT,
  attributes_json TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);

-- Protocol/runtime metadata only. Add this table once the protocol's
-- idempotency-key semantics are final; do not add an idempotency field to
-- canonical domain schemas merely for D1.
CREATE TABLE command_receipts (
  workspace_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  result_ref_json TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  PRIMARY KEY (workspace_id, operation, idempotency_key),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);
```

`permission_heads` and `command_receipts` are adapter/runtime support tables, not new canonical domain entities. They must not appear in JSON Schema unless a later ADR deliberately promotes their semantics into the domain.

### 7.3 Required indexes

```sql
-- Ready-task discovery.
CREATE INDEX idx_tasks_ready
  ON tasks(workspace_id, created_at_ms, id)
  WHERE status = 'ready';

-- Tasks under a Goal.
CREATE INDEX idx_tasks_goal
  ON tasks(workspace_id, goal_id, created_at_ms, id);

-- Dependency traversal in both directions.
CREATE INDEX idx_task_dependencies_reverse
  ON task_dependencies(workspace_id, dependency_task_id, task_id);

-- Capability matching support.
CREATE INDEX idx_task_required_capability
  ON task_required_capabilities(workspace_id, capability, task_id);
CREATE INDEX idx_agent_capability
  ON agent_capabilities(workspace_id, capability, agent_id);

-- Session lookup / stale-session recovery.
CREATE INDEX idx_sessions_status_seen
  ON sessions(workspace_id, status, last_seen_at_ms, id);
CREATE INDEX idx_sessions_agent_status
  ON sessions(workspace_id, agent_id, status, last_seen_at_ms, id);

-- Lease correctness and expiry.
CREATE UNIQUE INDEX ux_leases_one_active_per_task
  ON leases(workspace_id, task_id)
  WHERE status = 'active';
CREATE UNIQUE INDEX ux_leases_task_fencing_token
  ON leases(workspace_id, task_id, fencing_token);
CREATE INDEX idx_leases_active_expiry
  ON leases(workspace_id, expires_at_ms, task_id)
  WHERE status = 'active';
CREATE INDEX idx_leases_session_status
  ON leases(workspace_id, session_id, status, expires_at_ms);

-- Append-only Task evidence.
CREATE INDEX idx_checkpoints_task_time
  ON checkpoints(workspace_id, task_id, created_at_ms, id);

-- Permission chain and human queue.
CREATE INDEX idx_permission_decisions_request
  ON permission_decisions(workspace_id, request_id, sequence DESC);
CREATE INDEX idx_permission_heads_awaiting_human
  ON permission_heads(workspace_id, updated_at_ms, request_id)
  WHERE awaiting_human = 1;

-- Audit pagination and common forensic lookups.
CREATE INDEX idx_audit_workspace_time
  ON audit_events(workspace_id, created_at_ms DESC, seq DESC);
CREATE INDEX idx_audit_correlation
  ON audit_events(workspace_id, correlation_id, seq);
CREATE INDEX idx_audit_subject
  ON audit_events(workspace_id, subject_type, subject_id, seq);
```

Do not add speculative indexes beyond observed query plans. D1 bills rows written and indexes add write/storage cost. For implementation, validate hot queries with `EXPLAIN QUERY PLAN`, inspect D1 `rows_read`/`rows_written`, and run `PRAGMA optimize` after schema/index changes as Cloudflare recommends.

## 8. Ownership and transaction matrix

| Operation | Coordination owner | Required D1 atomic boundary | Main database guards |
| --- | --- | --- | --- |
| Create Workspace/Goal/Task/Agent/Session | Workspace coordinator for non-Workspace writes; bootstrap service for Workspace creation | Resource rows + normalized child rows + required audit event | PK/FK constraints; initial revision = 1; Task creation also creates fence counter = 0 |
| Update mutable resource | Workspace coordinator | Conditional resource update + dependent set replacement if any + audit | `WHERE revision = expectedRevision`; accepted update increments by exactly 1 |
| Claim Task / grant Lease | Workspace coordinator | Expire any already-timed-out active lease for that Task; state-machine recovery transition if required; insert new Lease; advance per-Task fence counter; Task transition/revision if required; audit; command receipt when protocol idempotency exists | Partial unique active-lease index; expected Task revision/state; per-Task unique fencing token; capability/session checks |
| Renew Lease / heartbeat | Workspace coordinator | Valid Lease renewal and Session `lastSeenAt`/revision update when both are part of one accepted command | Lease id + session id + active status + current fencing token + expiry rule; optimistic Session revision where required |
| Release/revoke Lease | Workspace coordinator | Lease status/revision update + Task transition required by state machine + audit | Current active Lease + fencing token + expected revisions |
| Append Checkpoint | Workspace coordinator | Authority-conditional Checkpoint insert + optional audit | Insert must be selected from matching active, unexpired Lease/session/token; stale token produces zero inserts |
| Create PermissionRequest | Workspace coordinator | Authority-conditional request insert + initial policy decision/head update if evaluated in same command + audit | Matching active Lease/session/token; request id uniqueness |
| Append PermissionDecision | Workspace coordinator | New immutable decision + `permission_heads` CAS/update + audit | Unique `(request, sequence)`; immediately preceding decision/head must match; basis/outcome rules validated by runtime/schema |
| Expire Leases | Workspace coordinator alarm or lazy reconciliation | Bounded set of due Lease expirations + state-machine transitions + audit | `status = 'active' AND expires_at_ms <= now`; idempotent on repeat |
| Pure query | Stateless Worker may read D1 directly | None | Use primary/bookmark when freshness matters; do not base coordination decisions on an unconstrained replica |

A meaningful state transition and its `AuditEvent` should commit in the same D1 transaction. High-frequency heartbeat updates need not emit a separate AuditEvent unless the runtime audit policy explicitly requires it; auditing every heartbeat would create avoidable write amplification.

## 9. Exact concurrency patterns

### 9.1 Optimistic revision update

A mutable resource update is a compare-and-swap in SQL:

```sql
UPDATE tasks
SET
  status = :new_status,
  status_reason_json = :status_reason_json,
  revision = revision + 1,
  updated_at_ms = :now_ms
WHERE workspace_id = :workspace_id
  AND id = :task_id
  AND revision = :expected_revision;
```

Acceptance requires exactly one changed row. Zero rows means not found or stale revision and must not be silently treated as success.

If the transaction also inserts an audit row, make that insert conditional on the post-update revision/resource state so a stale update produces a transactionally harmless no-op rather than a false audit record.

### 9.2 Fencing-token allocation

Fencing tokens are allocated from `task_fencing_counters`, not from a global sequence and not from Durable Object memory.

The Task-creation transaction inserts:

```text
last_fencing_token = 0
```

A successful Lease-grant transaction computes the new token as:

```text
new token = last_fencing_token + 1
```

and in the same D1 batch:

1. inserts the Lease with that token;
2. advances `task_fencing_counters.last_fencing_token` to the same value;
3. performs any accepted Task transition/revision update;
4. inserts the AuditEvent;
5. records the protocol command receipt if idempotency semantics are available.

The Lease insertion must be conditional on the runtime's claim preconditions and the counter row. The counter update must be conditional on the newly inserted Lease id. If the active-Lease unique index rejects the insert, the transaction rolls back and the counter does not advance.

Gaps in fencing tokens would be harmless, but the proposed transaction avoids gaps for rejected claims and makes the monotonicity proof simple.

### 9.3 Active-Lease uniqueness

Database correctness does not rely on the Workspace coordinator seeing every caller. The partial unique index:

```sql
CREATE UNIQUE INDEX ux_leases_one_active_per_task
ON leases(workspace_id, task_id)
WHERE status = 'active';
```

is the final guard against two active Lease rows for one Task.

A Lease whose `expires_at_ms <= now` no longer grants authority even if its persisted status has not yet been rewritten from `active` to `expired`. Claim/admission paths must reconcile due expiry before relying on the partial unique index.

### 9.4 Stale execution admission

Checkpoint, completion, Task-scoped permission request, or other execution mutations should never perform a separate "read Lease, then later insert" sequence.

Use a conditional write shaped like:

```sql
INSERT INTO checkpoints (...)
SELECT ...
FROM leases l
WHERE l.workspace_id = :workspace_id
  AND l.id = :lease_id
  AND l.task_id = :task_id
  AND l.session_id = :session_id
  AND l.status = 'active'
  AND l.fencing_token = :fencing_token
  AND l.expires_at_ms > :now_ms;
```

Zero inserted rows means the submitted authority is stale/invalid. This removes the time-of-check/time-of-use gap.

## 10. Lease expiry discovery and recovery

Use **both** alarm-driven and lazy reconciliation, with D1 as truth.

### 10.1 Alarm path

After a Lease grant/renew/release/revoke, the Workspace coordinator queries the earliest remaining active Lease expiry and sets its one Durable Object alarm accordingly.

When the alarm fires:

1. read D1 for due active Leases in that Workspace using `idx_leases_active_expiry`;
2. apply the runtime state-machine's expiration/recovery transitions in bounded D1 transactions;
3. repeat if more due rows remain;
4. set the next alarm from the new earliest active expiry.

The handler must be idempotent because Durable Object alarms are at-least-once.

### 10.2 Lazy path

Correctness must not depend on the alarm firing on time.

Before a claim or any authorization decision that could be affected by expiry, reconcile relevant Leases using the same `expires_at_ms <= now` predicate. An expired Lease must not authorize a mutation even if cleanup has not yet updated its status.

This means:

- an alarm failure can delay the cosmetic/materialized `expired` status;
- it cannot extend execution authority;
- the next relevant request repairs the durable status before granting new authority.

### 10.3 Why no global queue or custom scheduler

A per-Workspace alarm plus lazy reconciliation is enough for v0.1. There is no evidence requiring a queue, custom consensus service, or multi-region scheduler.

If a future workload needs global expiry analytics or mass recovery, add a dedicated index/sweeper only after measurement.

## 11. AuditEvent persistence

Audit events are stored in D1, not Durable Object storage and not Git.

Use an internal integer `seq` solely for efficient stable pagination; the canonical `AuditEvent.id` remains the external domain identifier. `seq` must never leak into JSON Schema or protocol semantics.

Rules:

- Insert transition/security/permission audit rows in the same D1 transaction as the authoritative mutation they describe.
- Do not use the audit table to reconstruct normal current state.
- Flatten actor/subject/correlation fields that are common query predicates.
- Store bounded `related` and `attributes` values as JSON text after canonical validation.
- Prefer cursor pagination on `(created_at_ms, seq)` rather than large `OFFSET` scans.
- Avoid an AuditEvent per heartbeat by default; use aggregate/session/lease lifecycle events unless the audit policy later requires more detail.

## 12. Permission requests awaiting human decision

`PermissionDecision` remains append-only. To avoid repeatedly scanning every decision chain for a human queue, maintain `permission_heads` transactionally.

When a new decision is appended:

- verify the current head/sequence;
- insert the immutable decision;
- update the head to the new decision;
- set `awaiting_human = 1` only when the latest effective outcome is `HUMAN_REQUIRED`;
- set it to `0` after a valid human `ALLOW` or `DENY` supersedes that decision;
- insert the AuditEvent;
- commit all of the above atomically.

The head row is a query projection, not a new domain concept. It can be checked/rebuilt from `PermissionDecision` history during maintenance, but normal runtime state must keep it transactionally synchronized.

## 13. D1 consistency model and MindRail compensation

### 13.1 Coordination writes

Use one D1 `batch()` transaction for every multi-table authoritative mutation. Never rely on separate auto-committed statements plus compensating application code for Lease grants, fencing allocation, permission chains, or audited state transitions.

### 13.2 Reads

For v0.1, the simplest deployment is to leave D1 read replication disabled for coordination-critical data.

If read replication is enabled later:

- coordination decisions must use the primary (`first-primary`) or carry forward a D1 Session bookmark from the preceding mutation;
- pure dashboards/history reads may use replica-backed sessions when stale initial data is acceptable;
- D1 bookmarks are an adapter detail and must not become a protocol token.

Sequential consistency from a D1 Session is useful, but it does not remove the need for SQL CAS/revision checks against other writers.

### 13.3 No distributed transaction between D1 and Durable Object storage

Do not create a correctness requirement that atomically commits D1 state and Durable Object storage state together.

The alarm is a liveness hint. If D1 commits a Lease grant and `setAlarm()` fails afterward, the Lease remains valid and its expiry remains enforceable by D1 timestamps/lazy reconciliation. The coordinator should retry/reschedule the alarm, but it must not undo or hide the committed Lease.

## 14. Failure modes

| Failure | Required behavior |
| --- | --- |
| Durable Object evicted/restarted | Lose in-memory queue/cache only. Re-enter through the same Workspace identity, read D1, reconcile due expiry, continue. No Task/Lease truth is lost. |
| Durable Object restarts while a D1 transaction is in flight | If D1 did not commit, retry is safe after rollback. If D1 committed but the response was lost, retry must resolve through idempotency/CAS/unique constraints rather than performing a second grant. |
| Two claim requests arrive concurrently | Workspace queue normally sequences them. D1 partial unique active-Lease index and claim preconditions remain the final guard. Exactly one claim may commit. |
| Stale Session submits old fencing token | Conditional insert/update matches zero rows; reject without side effects. |
| Lease expires while Session is disconnected | Authority ends at `expires_at_ms`. Alarm or next relevant request materializes `expired` and performs state-machine recovery. |
| Alarm fires twice | Expiry transaction is idempotent because it only changes `status = 'active'` rows due by time. |
| Alarm cannot reach D1 temporarily | Catch/retry with backoff and schedule another alarm before retry budget is exhausted. Lazy reconciliation still prevents expired authority from being used. |
| D1 batch statement fails | Entire batch rolls back. Do not emit a success response or an audit row describing a mutation that did not commit. |
| D1 write commits but response delivery fails | Duplicate command must not create duplicate authority. Use protocol idempotency receipt when defined; otherwise expected revisions, stable ids, and unique Lease/token constraints convert retry into existing-result/conflict behavior. |
| D1 write commits but alarm scheduling fails | Keep committed D1 state. Treat alarm failure as liveness degradation, not transactional failure. Reconcile/reschedule later. |
| D1 state commits but Git/GitHub projection fails | D1 remains canonical. Retry the integration/projection independently; do not roll back operational truth to match GitHub. No distributed two-phase commit. |
| D1 read replica lags | Do not use unconstrained replica reads for coordination. Use primary/bookmark, or disable read replication on the critical path. |
| D1 overloads / hits query limit | Return retryable infrastructure error, use exponential backoff with jitter where operation is idempotent, keep transactions short/indexed, and bound sweeps. |
| `permission_heads` disagrees with decision chain | Treat as persistence-integrity failure; rebuild/repair the projection from immutable decisions and investigate the transaction path. Do not rewrite historical decisions. |
| One Workspace becomes a hot coordinator | Measure DO request latency/queue depth and D1 time. Only then consider finer-grained coordination via a new architecture decision. |
| Shared D1 database reaches throughput/storage limit | Shard Workspaces across multiple D1 databases behind the persistence adapter; protocol and domain ids remain unchanged. |

## 15. D1 write succeeds but another operation fails

MindRail must distinguish **authoritative transaction work** from **post-commit side effects**.

### Must be in the same D1 transaction

- domain current-state mutation;
- fencing-counter update associated with a Lease grant;
- append-only record whose acceptance is part of the command;
- required AuditEvent for that accepted transition;
- adapter query-head updates such as `permission_heads`;
- command receipt when protocol idempotency is implemented.

If any of those fail, the command must roll back.

### Must not be treated as part of the D1 atomic transaction

- Durable Object alarm scheduling;
- Git/GitHub projection updates;
- notifications;
- external evidence uploads already represented by an immutable `EvidenceRef`;
- other non-authoritative integrations.

There is no distributed two-phase commit in v0.1. A post-commit integration failure is retried/reconciled from D1 truth. Do not add an outbox/queue architecture until an integration proves that durable asynchronous delivery is required.

## 16. Migration strategy principles

### 16.1 Separate contract version from database migration version

`schemas/domain/v1/` is the canonical domain major version. D1 migration number is an implementation detail. Multiple SQL migrations may implement one domain version.

### 16.2 Use forward-only versioned D1 migrations

- Keep every applied SQL migration immutable.
- Prefer expand/backfill/contract changes when data exists.
- Add indexes deliberately and verify query plans.
- Use `PRAGMA defer_foreign_keys = on` only when a schema migration temporarily needs reordered changes; D1 normally enforces foreign keys.
- Run `PRAGMA foreign_key_check` and `PRAGMA optimize` after structural/index changes where appropriate.
- Exercise migrations against realistic data sizes before production.

Cloudflare D1 migrations are stored as ordered SQL files and applied through Wrangler; use that mechanism rather than application-startup schema mutation.

### 16.3 Durable Object class lifecycle is separate

The Workspace coordinator class should use the current recommended SQLite-backed Durable Object namespace, but its persistent storage should remain minimal. Durable Object class lifecycle/configuration changes are deployment migrations, not MindRail domain migrations.

Current Cloudflare guidance supports declarative Worker `exports` for class lifecycle. Recheck the current Wrangler mechanism when implementation begins.

### 16.4 Recovery

D1 Time Travel is useful operational protection, not an application transaction mechanism. Restore procedures must consider the whole runtime database and any integrations that need reprojection afterward.

## 17. Scaling and cost risks

### 17.1 D1 write bottleneck

A single D1 database processes queries serially. The v0.1 shared database is intentionally simple, but it has a finite write-throughput ceiling.

Mitigations before sharding:

- short transactions;
- correct partial/composite indexes;
- avoid heartbeat AuditEvents;
- avoid full-table expiry scans;
- use narrow projections for ready/human queues;
- inspect `rows_read`, `rows_written`, query duration, and overload errors.

If one database becomes the measured bottleneck, shard by Workspace behind the persistence adapter. Do not shard by Task first.

### 17.2 Workspace Durable Object hotspot

One Workspace object serializes coordination-critical calls. That is desired until one Workspace is actually hot.

Keep pure reads outside the object and keep the queued critical section to one short D1 transaction. Do not perform slow GitHub/model/network calls while holding the Workspace sequencing queue.

### 17.3 Write amplification

D1 and SQLite-backed Durable Objects bill writes, and indexes also have storage/write cost.

Highest-risk write sources are:

- aggressive heartbeat intervals;
- auditing every heartbeat;
- excessive indexes;
- repeated projection rewrites;
- broad recovery updates.

Measure before optimizing cadence. The domain contract does not require a particular heartbeat frequency.

### 17.4 Placement latency

A Durable Object lives in one location and D1 writes go to the D1 primary. The coordinator-to-D1 network hop may dominate latency if placement is poor. Measure real deployment latency before adding custom placement, replication, or sharding logic.

Do not introduce multi-region custom consensus.

## 18. Portability requirements

The Cloudflare adapter is replaceable if the core runtime depends only on capabilities equivalent to the following:

```text
RuntimeStore
- atomic transaction over one Workspace's related records
- conditional update by expected revision
- append-only insert with uniqueness constraints
- transactional query/update of permission decision head
- query ready Tasks by Workspace
- query Tasks by Goal
- query active Leases by expiry
- query Sessions by Workspace/status/lastSeen
- query human-required permissions
- query AuditEvents by Workspace/cursor/correlation/subject

LeaseAuthorityStore
- allocate a strictly increasing fencing token per Task atomically with Lease grant
- guarantee at most one active Lease per Task
- reject mutation with stale Lease/session/fencing token

WorkspaceCoordinator
- stable identity derived from Workspace id
- serialize/sequence coordination-sensitive commands as an optimization
- schedule a wake-up for earliest lease expiry, with at-least-once/idempotent handling
- recover entirely from RuntimeStore after restart
```

Equivalent replacements include:

- PostgreSQL transactions + unique partial indexes + advisory lock/actor per Workspace;
- a single-node SQLite runtime for local development with an in-process Workspace mutex;
- another managed SQL database with compare-and-swap/transaction semantics plus a replaceable actor/timer service.

A replacement does **not** need D1 bookmarks, Durable Object ids, Workers bindings, Cloudflare alarms, or Cloudflare migrations. Those are adapter details.

## 19. Recommended v0.1 operational rules

1. Route all coordination-sensitive mutations through the Workspace coordinator.
2. Keep pure read/query endpoints stateless and D1-backed unless they require coordination freshness.
3. Use one D1 batch transaction per authoritative multi-table mutation.
4. Enforce optimistic revisions in SQL, not only in TypeScript.
5. Allocate fencing tokens in D1 per Task and enforce one active Lease with a partial unique index.
6. Validate execution authority in the write statement itself; avoid read-then-write races.
7. Treat Durable Object alarm scheduling as liveness, not authority.
8. Reconcile expired Leases on both alarm and relevant request paths.
9. Put required audit records in the same D1 transaction as the state change they describe.
10. Keep heartbeat audit volume low unless later policy requires per-heartbeat evidence.
11. Do not enable replica-backed coordination reads without primary/bookmark rules.
12. Do not store a second Task/Lease copy in Durable Object storage.
13. Do not introduce per-Task Durable Objects, queues, or database sharding before measurements justify them.

## 20. Implementation-entry criteria

Before implementing this reference mapping, reconcile it against the accepted versions of:

- ADR-0003 / Domain Contracts;
- the deterministic runtime state-machine/concurrency design;
- the transport-neutral protocol, especially idempotency and error semantics.

If adopting the Cloudflare topology as a maintained reference implementation would make the deployment/storage boundary binding beyond ADR-0001's existing replaceability rule, create a separate Proposed ADR at implementation time. This research note itself does not alter accepted storage authority or canonical domain semantics.

## 21. Official Cloudflare sources checked

Verified 2026-08-29:

- D1 limits: <https://developers.cloudflare.com/d1/platform/limits/>
- D1 pricing: <https://developers.cloudflare.com/d1/platform/pricing/>
- D1 Worker API / transactional `batch()`: <https://developers.cloudflare.com/d1/worker-api/d1-database/>
- D1 read replication / Sessions consistency: <https://developers.cloudflare.com/d1/best-practices/read-replication/>
- D1 indexes and partial indexes: <https://developers.cloudflare.com/d1/best-practices/use-indexes/>
- D1 foreign keys: <https://developers.cloudflare.com/d1/sql-api/foreign-keys/>
- D1 migrations: <https://developers.cloudflare.com/d1/reference/migrations/>
- D1 retry guidance: <https://developers.cloudflare.com/d1/best-practices/retry-queries/>
- Durable Objects rules/design/concurrency: <https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/>
- Durable Object storage/restart behavior: <https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/>
- Durable Object alarms: <https://developers.cloudflare.com/durable-objects/api/alarms/>
- Durable Object limits: <https://developers.cloudflare.com/durable-objects/platform/limits/>
- Durable Object pricing: <https://developers.cloudflare.com/durable-objects/platform/pricing/>
- Durable Object class lifecycle: <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>
