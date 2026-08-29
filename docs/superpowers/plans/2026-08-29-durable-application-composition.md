# Durable Application Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing MindRail application/protocol workflow restart-safe over the D1 persistence adapter without creating a second runtime semantic authority.

**Architecture:** Each durable command is serialized per Workspace, resolved against durable command receipts, rehydrates the existing runtime semantics from a canonical Workspace snapshot, executes the existing command path, then commits the resulting authoritative mutation through explicit D1 persistence operations. D1 is the only durable source of truth; all reconstructed runtime state is request-scoped and disposable.

**Tech Stack:** TypeScript, Node.js 24, pnpm, Vitest, node:sqlite D1 test harness, existing D1-like adapter, JSON Schema/Ajv test validators.

**Spec:** `docs/superpowers/specs/2026-08-29-durable-application-composition-design.md`

## Global Constraints

- ADR-0001 through ADR-0005 and canonical JSON Schema remain authoritative.
- Do not introduce a second lifecycle, permission, idempotency, or fencing authority.
- D1/persistence remains the only durable operational source of truth.
- Durable Object/coordinator memory is serialization only and must be reconstructible from D1.
- Structural protocol admission occurs before durable receipt reservation.
- `(workspaceId, commandId)` remains the exact idempotency key.
- Stored receipts contain immutable bounded terminal protocol result/error snapshots.
- Model/LLM output never grants execution authority.
- Do not claim real Cloudflare deployment/runtime verification unless it actually executes.
- TDD is mandatory; never call an unexecuted test PASS.

---

### Task 1: Persistence receipt parity for the first durable loop

**Files:**
- Modify: `src/persistence/ports.ts`
- Modify: `src/persistence/cloudflare/d1-runtime-persistence.ts`
- Test: `test/persistence/d1-runtime-persistence.test.ts`
- Test: `test/persistence/d1-runtime-persistence-invariants.test.ts`

**Interfaces:**
- Consumes: existing `CommandReceiptInput`, `MutationCommitResult<T>`, D1 coordinator and batch transaction primitives.
- Produces:
  - `createAgent({ agent, receipt?, auditEvent? }): Promise<MutationCommitResult<Agent>>`
  - `createSession({ session, receipt?, auditEvent? }): Promise<MutationCommitResult<Session>>`
  - `appendCheckpoint({ checkpoint, now, receipt?, auditEvent? }): Promise<MutationCommitResult<Checkpoint>>`
  - `appendPermissionDecision({ decision, expectedPreviousDecisionId, receipt?, auditEvent? }): Promise<MutationCommitResult<PermissionDecision>>`

- [ ] **Step 1: Write failing persistence receipt-parity tests**

Add focused tests proving for Agent, Session, Checkpoint, and human PermissionDecision:

```ts
const first = await persistence.createAgent({ agent, receipt });
expect(first.kind).toBe('committed');

const replay = await reopenedPersistence.createAgent({ agent, receipt });
expect(replay.kind).toBe('replayed');
expect(replay.receipt.responseSnapshot).toEqual(receipt.responseSnapshot);
```

For Checkpoint/PermissionDecision also assert exact replay does not append a second history record. Add one fingerprint-drift assertion for each new receipt-aware path.

- [ ] **Step 2: Run focused tests and capture RED**

Run the persistence-focused Vitest files. Expected failure: port/implementation methods do not yet accept or persist receipts atomically for these paths.

- [ ] **Step 3: Extend the persistence port and D1 implementation minimally**

For each method:

1. canonical-validate the record;
2. assert receipt/audit Workspace consistency;
3. enter the existing Workspace coordinator;
4. resolve an existing receipt first;
5. perform current semantic preconditions;
6. add record mutation + optional audit + optional receipt to one D1 batch;
7. return `{ kind: 'committed', value }` or `{ kind: 'replayed', receipt }`.

Do not weaken existing authority checks or introduce generic CRUD.

- [ ] **Step 4: Re-run persistence tests**

Expected: focused persistence receipt-parity tests PASS; all existing persistence invariants remain PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add receipt parity to durable mutation ports`

---

### Task 2: Supported runtime snapshot rehydration

**Files:**
- Modify: `src/runtime/in-memory-control-plane.ts`
- Modify/Create: `src/runtime/state-rehydration.ts` if keeping reconstruction logic outside the large control-plane file is cleaner.
- Test: `test/runtime/runtime-rehydration.test.ts`

**Interfaces:**
- Consumes: `WorkspaceStateSnapshot` shape or a runtime-neutral equivalent with Workspace/Goals/Tasks/Agents/Sessions/Leases/Checkpoints/Permission records/fencing counters.
- Produces a supported constructor/factory such as:

```ts
InMemoryControlPlane.rehydrate({
  snapshot,
  now,
  idFactory,
  leaseDurationMs,
  sessionTimeoutMs,
  validateCanonicalDomainRecord,
  permissionPolicy,
}): InMemoryControlPlane
```

The exact API may differ, but rehydration must be explicit and testable, not private-field mutation from the application layer.

- [ ] **Step 1: Write failing rehydration tests**

Construct runtime state through normal commands, export/load an equivalent canonical snapshot, rehydrate a fresh runtime, then assert:

- Task/Goal/Agent/Session/Lease reads match;
- checkpoint order is preserved;
- permission request/decision chains are preserved;
- current effective Lease/fence survives;
- next recovered claim uses a strictly higher fence;
- stale Session/Lease time semantics are re-evaluated using the new authoritative clock;
- inconsistent snapshot relationships fail closed.

- [ ] **Step 2: Run focused test and capture RED**

Expected failure: no supported rehydration API exists.

- [ ] **Step 3: Implement minimal rehydration seam**

Reuse the runtime’s existing internal structures and permission service rather than replaying public commands (which would alter revisions/timestamps/ids). Validate every canonical record and relationship before installing state. Restore fencing counters exactly. Rebuild effective-Lease mappings from authoritative Lease/Session/time semantics; do not persist derived maps.

- [ ] **Step 4: Re-run runtime rehydration + existing runtime tests**

Expected: new tests PASS and no lifecycle/idempotency regressions.

- [ ] **Step 5: Commit**

Commit message: `feat: support canonical runtime state rehydration`

---

### Task 3: Durable application dispatcher and deterministic receipt replay

**Files:**
- Create: `src/application/durable-dispatcher.ts`
- Create: `src/application/durable-errors.ts` if error mapping warrants a separate unit.
- Modify: `src/application/ports.ts` only if a composition dependency type is needed.
- Test: `test/application/durable-dispatcher.test.ts`

**Interfaces:**
- Consumes:
  - `ApplicationDispatcher`
  - `DurableRuntimePersistence`
  - `WorkspaceMutationCoordinator`
  - existing `semanticFingerprint()` / protocol response types
  - runtime rehydration seam
- Produces:

```ts
createDurableApplicationDispatcher(options): ApplicationDispatcher
```

Required options include persistence, authoritative clock/id policy, canonical validator, lease/session policies, and permission policy. No transport types belong here.

- [ ] **Step 1: Write failing dispatcher tests**

Prove:

- existing durable receipt is returned with `replayed: true` before runtime execution;
- same commandId with different fingerprint returns `IDEMPOTENCY_CONFLICT`;
- unknown Workspace returns bounded `NOT_FOUND`;
- no retained in-memory state is used between calls;
- persistence errors map deterministically without leaking SQL/internal messages.

Use spies/fakes at the persistence port for unit tests; D1 restart tests come later.

- [ ] **Step 2: Run tests and capture RED**

Expected failure: durable dispatcher factory does not exist.

- [ ] **Step 3: Implement dispatcher orchestration**

Flow for mutation commands:

```text
validate application command
→ durable receipt lookup
→ snapshot load
→ runtime rehydrate
→ execute existing ProtocolCommand semantics
→ convert successful runtime result into the command-specific durable commit
→ store receipt atomically with the durable mutation
→ return persisted result
```

Important: for `ClaimTask`, D1 allocates the final fencing token. The returned result/receipt must use the persisted Task/Lease, not the speculative ephemeral Lease token.

If a runtime command returns a terminal semantic error before any durable mutation, return the bounded error. Only persist terminal error receipts where ADR/persistence semantics explicitly admit them without violating pre-admission rules.

- [ ] **Step 4: Run dispatcher tests**

Expected: unit tests PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: add durable application dispatcher`

---

### Task 4: Durable query surface for restart verification and work acquisition

**Files:**
- Modify: `src/persistence/ports.ts`
- Modify: `src/persistence/cloudflare/d1-runtime-persistence.ts`
- Modify: `src/application/durable-dispatcher.ts`
- Test: `test/application/durable-queries.test.ts`

**Interfaces:**
- Add explicit persistence reads needed by application queries. Prefer bounded semantic methods over generic SQL access.
- Required durable queries:
  - `GetWorkspace`
  - `GetGoal`
  - `GetTask`
  - `GetLease`
  - `ListTaskCheckpoints`
  - `GetAgent`
  - `GetSession`
  - `GetPermissionRequest`
  - `ListPermissionDecisions`
  - `ListPendingHumanPermissions`
  - `ListClaimableTasks` if implementable from authoritative persisted Task/Agent/session-independent state without inventing new semantics.

- [ ] **Step 1: Write failing query tests**

Open a persistence-backed dispatcher, persist records, create a fresh dispatcher over the same DB, then issue application queries and assert all results come from D1. Include bounded limit/cursor behavior where applicable and no fallback to retained runtime state.

- [ ] **Step 2: Capture RED**

Expected: missing port reads/unsupported durable query results.

- [ ] **Step 3: Add explicit persistence read methods and dispatcher mappings**

Use canonical record JSON as the returned domain objects. Lists are deterministic and bounded. `ListClaimableTasks` is advisory only and never replaces claim-time revalidation.

- [ ] **Step 4: Run query tests**

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: expose durable application queries`

---

### Task 5: Restart-safe HTTP/application E2E

**Files:**
- Create: `test/e2e/durable-http-control-plane-e2e.test.ts`
- Reuse: `test/persistence/d1-sqlite-harness.ts`
- Reuse/extend: `test/persistence/setup.ts`

**Interfaces:**
- Consumes `createHttpTransport(createDurableApplicationDispatcher(...))` over a real SQLite file implementing the D1-like port.
- Produces executable evidence for restart safety.

- [ ] **Step 1: Write restart-after-claim E2E**

Through HTTP only:

```text
RegisterAgent → StartSession → CreateGoal → CreateTask → ClaimTask
close DB/application instance A
open instance B on same file
GetTask/GetLease → RecordCheckpoint → CompleteTask
```

Assert same Lease/fence survives restart and final Goal/Task state is durable.

- [ ] **Step 2: Run and capture RED**

Expected: durable dispatcher/composition gaps if any remain.

- [ ] **Step 3: Fix only the demonstrated gap**

Do not weaken tests or add an in-memory fallback.

- [ ] **Step 4: Write restart-after-HUMAN_REQUIRED E2E**

Through HTTP only:

```text
... → RequestPermission(repository.write) = HUMAN_REQUIRED
restart application/database handle
ListPendingHumanPermissions / GetPermissionRequest
RecordPermissionDecision(ALLOW)
CompleteTask
```

Assert the original execution authority remains required and decision history persists.

- [ ] **Step 5: Write response-loss replay E2E**

Execute a mutation, discard the first response/dispatcher, retry exact command through a fresh dispatcher, assert `replayed: true`, same immutable result ids, and one durable mutation.

- [ ] **Step 6: Write competing-instance claim E2E**

Use two dispatcher/coordinator instances against the same SQLite database file. Race claims from two Sessions. Assert exactly one authoritative effective Lease and monotonically increasing fencing after later recovery.

- [ ] **Step 7: Run the durable E2E file**

Expected: all restart/concurrency tests PASS.

- [ ] **Step 8: Commit**

Commit message: `test: prove durable application restart semantics`

---

### Task 6: Full verification, documentation reconciliation, PR and post-merge gate

**Files:**
- Modify: `docs/CURRENT_STATE.md`
- Modify: `docs/roadmap/V0_1.md`
- Modify: `CHANGELOG.md`
- Review: `.github/workflows/quality.yml`

**Interfaces:**
- Consumes all previous tasks.
- Produces a non-draft PR against `main` and merge evidence.

- [ ] **Step 1: Update docs with only executed facts**

State exactly which commands/queries are durable, which restart E2Es executed, and that SQLite/D1-like verification is not equivalent to deployed Cloudflare Workers/D1 verification.

- [ ] **Step 2: Run fresh full gates on the exact final tree**

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
```

- [ ] **Step 3: Perform final code review**

Check specifically for:

- duplicate lifecycle/permission authority;
- receipt written outside atomic state mutation;
- speculative fencing token returned instead of persisted token;
- in-memory fallback after restart;
- stale Session/Lease authority after rehydration;
- SQL/internal error leakage;
- generic persistence CRUD or transport-specific core coupling;
- temporary workflow/harness files.

- [ ] **Step 4: Open non-draft PR to `main`**

PR body must include exact RED/GREEN runs, full Quality/coverage evidence, restart/concurrency guarantees, and explicit non-capabilities.

- [ ] **Step 5: Require permanent `Quality` PASS on exact PR head**

Do not merge if the head moves after verification without rerunning the gate.

- [ ] **Step 6: Squash-merge with expected head SHA**

- [ ] **Step 7: Require push-triggered `Quality` PASS on merged `main`**

Only then call the durable application composition slice complete.
