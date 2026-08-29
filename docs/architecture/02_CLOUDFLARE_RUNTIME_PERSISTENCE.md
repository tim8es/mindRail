# Cloudflare reference runtime persistence mapping

- **Status:** Approved reference design; implementation pending
- **Date:** 2026-08-29
- **Depends on:** ADR-0001, ADR-0003, ADR-0004, ADR-0005
- **Scope:** replaceable Cloudflare D1 + Durable Objects mapping. No Cloudflare type is part of canonical domain or protocol contracts.

## 1. Recommendation

MindRail v0.1 reference deployment uses:

```text
one Workspace Durable Object coordinator
        ↓ coordination / ordering
one shared D1 runtime database
        ↓ canonical durable state
Domain records + runtime support tables
```

D1 is the canonical operational store.

The Workspace Durable Object is a coordination address, not a second database. Its memory may queue requests/cache short-lived data, but every correctness-relevant fact must survive object eviction and be reconstructed from D1.

D1 constraints, conditional writes, and atomic transactions remain the final correctness boundary.

Use one shared D1 database for v0.1. Do not shard by Workspace or introduce per-Task Durable Objects until measured pressure justifies it.

## 2. Why Workspace coordination

ADR-0004 requires deterministic ordering not only per Task but also for Goal aggregate operations such as:

- `CreateTask`;
- Task completion that can auto-succeed a Goal;
- `CancelGoal`;
- future `FailGoal`;
- Task dependency reconciliation under the Goal.

A Workspace coordinator naturally covers those operations without cross-Durable-Object protocols and also serializes Task claim/lease/session/permission mutations inside the Workspace.

This is an optimization and routing boundary. Correctness must still hold if a coordinator restarts or if another deployment replaces it with serializable database transactions/advisory locks/actors.

## 3. Responsibility split

### Durable Object may own

- admission ordering for coordination-sensitive Workspace commands;
- a short-lived in-memory promise queue around D1 critical sections;
- scheduling the earliest Workspace Lease-expiry alarm;
- retry/backoff around transient D1 errors when the command is safe to retry;
- restart reconciliation from D1.

### Durable Object must not own authoritative copies of

- Task/Goal/Agent/Session state;
- Lease identity, expiry, or fencing counters;
- checkpoints;
- permission state;
- command idempotency receipts;
- audit history.

Those live in D1.

## 4. Database topology

Use one shared D1 database for v0.1.

Every non-Workspace record carries `workspace_id`. Cross-record relationships use `(workspace_id, id)` whenever possible so Workspace isolation is enforced by both service logic and relational constraints.

Opaque domain ids remain `TEXT`.

Canonical RFC3339 timestamps may be stored internally as integer epoch milliseconds and converted at the adapter boundary.

Validated bounded objects/arrays that are not queried relationally may use JSON text. Relationships required for constraints/querying are normalized.

No normal lifecycle operation hard-deletes audit/evidence records.

## 5. Core tables

The implementation should start with these logical tables; exact column names may vary but semantics may not.

### Canonical domain state

```text
workspaces
goals
tasks
agents
sessions
leases
checkpoints
permission_requests
permission_decisions
audit_events
```

### Normalized relationship/support state

```text
task_dependencies
task_required_capabilities
agent_capabilities
task_fencing_counters
permission_heads
command_receipts
```

`task_fencing_counters`, `permission_heads`, and `command_receipts` are persistence/runtime support tables, not canonical domain entities.

## 6. Required relational guards

At minimum:

- unique primary identity inside Workspace;
- same-Workspace foreign keys where D1/SQLite structure permits;
- Task → Goal same Workspace;
- dependency rows refer to Tasks in same Workspace;
- no direct self dependency;
- one immutable PermissionDecision sequence value per request;
- one current `permission_heads` row per request;
- monotonically increasing per-Task fencing counter;
- at most one persisted `active` Lease row per Task after stale rows are materialized before replacement grant;
- nonnegative/positive revision and fencing checks as appropriate.

Acyclic dependency validation and capability subset validation remain runtime checks; ordinary SQL foreign keys alone are not sufficient.

## 7. Idempotency receipts

ADR-0005 defines the unique command key as exactly:

```text
(workspaceId, commandId)
```

The persistence table therefore uses the equivalent key:

```sql
CREATE TABLE command_receipts (
  workspace_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('result', 'error')),
  response_snapshot_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  PRIMARY KEY (workspace_id, command_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT
);
```

`command` is data for diagnostics/conflict reporting; it is **not** part of the primary key.

`response_snapshot_json` is the bounded immutable protocol result/error snapshot returned on exact replay. It must not merely reference a mutable Task/Lease row, because that record may change between original response and retry.

The stored fingerprint excludes tracing-only correlation/causation ids per ADR-0005.

A receipt is written in the same D1 atomic boundary as the admitted mutation/outcome. If the mutation commits but response delivery fails, a retry returns the stored snapshot without mutating state again.

A semantic same-Session duplicate `ClaimTask` that returns an existing effective Lease may still create its own command receipt even when no domain record changes.

## 8. Task fencing

Use one per-Task durable counter:

```text
task_fencing_counters(workspace_id, task_id, last_fencing_token)
```

A new Lease grant transaction:

1. evaluates/materializes stale active Lease state;
2. verifies Task/Goal/Session/Agent/capability/revision preconditions;
3. obtains `nextToken > last_fencing_token`;
4. inserts the Lease using that token;
5. advances the fencing counter;
6. performs `ready -> running` Task mutation when required;
7. writes required AuditEvent;
8. writes command receipt when command protocol is in use.

All correctness-relevant steps commit or roll back together.

Tokens are never reused. Gaps are acceptable.

## 9. Claim semantics

Inside the Workspace coordination path:

1. load current Task/Goal/Session/Agent and effective Lease state from D1;
2. if another Session owns an effective Lease, reject;
3. if the same Session already owns it, return existing Task/Lease unchanged and persist replay receipt for this commandId if admitted;
4. if persisted active Lease is no longer effective, materialize it expired/revoked;
5. require Task `ready`, or `running` without effective Lease;
6. grant a new Lease/fence in one D1 transaction.

The Workspace DO normally prevents competing D1 claim attempts from interleaving, but database constraints and preconditions must still make it impossible for two grants to commit.

## 10. Goal-level operations

The following must be serialized through the same Workspace coordinator and use D1 transactions that preserve ADR-0004 Goal ordering:

### CreateTask

Atomically verify Goal still active, insert Task/relationships/fence counter, write audit/receipt.

### CompleteTask with automatic Goal success

The accepted operation updates Task/release/evidence/dependencies and then evaluates authoritative Goal Task membership under the same Goal-level serialization order.

The implementation must prevent the race:

```text
last Task completes → Goal succeeds
concurrently CreateTask is accepted
```

Only one logical order may win. If Goal terminalization wins first, CreateTask rejects. If CreateTask wins first, auto-success observes the added Task and may not terminalize prematurely.

### CancelGoal

One logical Goal-level operation:

- conditionally terminalize active Goal;
- cancel every nonterminal Task;
- revoke effective Leases;
- write audit events/summary;
- write command receipt;
- prevent concurrently admitted Task creation/retry under the Goal.

For v0.1, correctness is preferred over prematurely optimizing very large Goal fan-out. If transaction-size limits become a measured problem, a later ADR must define a staged cancellation state rather than silently weakening semantics.

## 11. Session and Lease expiry

Authority is evaluated using server time, not cleanup state.

An `active` Lease past `expires_at_ms` is already non-authoritative even before its row is updated.

Use both:

- lazy reconciliation on relevant commands/queries;
- one Workspace DO alarm scheduled for the earliest known Lease/session expiry requiring materialization.

Alarm delivery may repeat, so expiry handling is idempotent.

Failure to schedule an alarm after D1 state commits is a liveness degradation, not grounds to roll back already committed truth. Later requests/reconciliation must recover.

## 12. Permission decision head

PermissionDecision rows are immutable.

`permission_heads` stores the current latest decision id/sequence for efficient CAS-like admission of a human follow-up. Appending a decision and updating the head happen in one D1 transaction.

If head and immutable chain disagree, treat it as persistence integrity failure. Historical decisions are not rewritten to repair the projection.

## 13. Audit

AuditEvents remain append-only history, not event sourcing.

An accepted state mutation and its required AuditEvent commit in the same transaction where practical/required by semantics. Never write an audit event claiming a mutation that rolled back.

Indexes should support Workspace/time and subject lookup without scanning the entire event table.

## 14. Read paths

Pure reads need not pass through the Durable Object unless freshness/coordination semantics require it.

Coordination-sensitive reads such as `ListClaimableTasks` are advisory and may query D1 directly, but `ClaimTask` always revalidates under the coordinator/transaction.

Do not use a potentially stale replica as the authority for claim, revision, Lease, fencing, idempotency, or permission-decision admission. If D1 read replication is enabled, use the primary/appropriate consistency mechanism for critical paths.

## 15. Minimum indexes

Implementation should include measured/query-driven equivalents of:

```text
tasks(workspace_id, goal_id)
tasks(workspace_id, status)
leases(workspace_id, task_id, status)
leases(workspace_id, expires_at_ms, status)
sessions(workspace_id, status, last_seen_at_ms)
permission_requests(workspace_id, task_id)
permission_decisions(workspace_id, request_id, sequence)
audit_events(workspace_id, occurred_at_ms)
audit_events(workspace_id, subject_type, subject_id, occurred_at_ms)
```

Indexes are implementation choices and must be validated against actual D1 query plans before release.

## 16. Failure modes

| Failure | Required behavior |
| --- | --- |
| Workspace DO evicted/restarted | lose only memory queue/cache; reconstruct truth from D1 |
| two claims race | at most one new Lease commits |
| stale executor submits old fence | zero authoritative mutation; return stale-fence/lease error |
| Lease expires disconnected | authority ends at timestamp; alarm/lazy reconciliation materializes later |
| alarm fires more than once | expiry transaction remains idempotent |
| D1 transaction fails | roll back mutation/audit/receipt; never report success |
| D1 commit succeeds, response lost | exact retry resolves from command receipt immutable snapshot |
| same commandId reused for different command/intent | `IDEMPOTENCY_CONFLICT` |
| D1 commit succeeds, alarm scheduling fails | keep truth; retry/reconcile scheduling later |
| GitHub projection fails | D1 remains canonical; retry projection independently |
| permission head corrupt | fail closed and repair projection from immutable decisions |
| coordinator memory interleaves around await | local promise queue reduces conflicts; D1 constraints remain final guard |

## 17. Transaction ownership matrix

| Operation | Coordinator | D1 atomic boundary |
| --- | --- | --- |
| Create Goal/Task/Agent/Session | Workspace DO for Workspace-scoped creation | record + normalized children + audit + receipt |
| Heartbeat Session | Workspace DO | revision-conditional Session update + receipt |
| Claim Task | Workspace DO | stale Lease close + fence grant + Lease + Task transition + audit + receipt |
| Renew/Release Lease | Workspace DO | Lease authority/revision update + audit + receipt |
| Checkpoint | Workspace DO | authority-conditional append + audit/receipt as required |
| Complete/Fail/Block Task | Workspace DO | checkpoint + Task + Lease authority removal + dependency/Goal effects + audit + receipt |
| Retry/Resume/Cancel Task | Workspace DO | Task conditional update + Lease action if any + audit + receipt |
| Cancel Goal | Workspace DO | Goal + affected Tasks/Leases + audit + receipt as one logical Goal operation |
| Permission request | Workspace DO | request + initial decision + head + audit + receipt |
| Human decision | Workspace DO | immutable decision + head CAS + audit + receipt |

## 18. Migrations

Use versioned forward migrations committed with code.

Rules:

- schema migrations never redefine canonical domain semantics;
- destructive migrations require an explicit compatibility/data migration plan;
- D1 support-table changes remain adapter-internal unless promoted by a future ADR;
- migration execution and rollback/recovery are verified separately from application tests.

## 19. Portability

Cloudflare is replaceable.

Equivalent deployments may map:

- Workspace DO → actor/advisory lock/serialized service/transaction coordinator;
- D1 → PostgreSQL/SQLite/another transactional store;
- alarm → scheduler/TTL worker.

Portable semantic requirements are:

- authoritative durable state;
- Task and Goal ordering from ADR-0004;
- optimistic revisions;
- single effective Lease;
- monotonic fencing;
- durable command idempotency receipts;
- immutable permission/audit evidence;
- fail-closed authority validation.

No Cloudflare identifier or API appears in canonical JSON Schema or ADR-0005 protocol payloads.

## 20. Implementation gate

Before implementation, recheck current official Cloudflare documentation for D1 transaction semantics, Durable Object request interleaving/alarms, limits, and consistency behavior.

Implementation verification must include executable tests for:

- D1 schema/migrations;
- concurrent claim uniqueness;
- fence monotonicity;
- stale executor rejection;
- same-Session duplicate claim;
- lost-response command replay;
- commandId cross-command conflict;
- tracing-id changes preserving exact replay;
- Goal auto-success vs concurrent Task creation;
- Goal cancellation vs concurrent Task creation;
- coordinator restart recovery;
- duplicate alarm handling;
- D1 rollback preventing false audit/receipt state.
