# Durable Application Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing MindRail v0.1 application/protocol path restart-safe over D1-backed durable state without introducing a second runtime authority.

**Architecture:** Use rehydrate → execute existing runtime semantics → persist through existing D1 atomic command boundaries. D1 remains the only durable source of truth; each command may construct a fresh ephemeral runtime from a validated snapshot, execute the canonical protocol logic, persist only through `DurableRuntimePersistence`, and then discard the ephemeral runtime. Workspace serialization is owned by the persistence mutation methods already using `WorkspaceMutationCoordinator`; the dispatcher must not re-enter the same non-reentrant coordinator around those methods.

**Tech Stack:** TypeScript 6, Node.js 24, pnpm, Vitest, Node `sqlite` test harness, JSON Schema/Ajv test validators, existing D1-like adapter and Workspace coordinator abstractions.

**Spec:** `docs/superpowers/specs/2026-08-29-durable-application-composition-design.md`

## Global Constraints

- Read `AGENTS.md`, ADR-0001, ADR-0003, ADR-0004, ADR-0005, the spec above, and `docs/architecture/02_CLOUDFLARE_RUNTIME_PERSISTENCE.md` before implementation.
- Canonical JSON Schema under `schemas/domain/v1/` remains authoritative; do not change schemas for adapter convenience.
- Do not create a second `DurableControlPlane` state machine or duplicate lifecycle/permission semantics in persistence/application code.
- D1/persistence is the only durable source of truth. Ephemeral runtime state must be discarded after each command/request.
- Command idempotency key remains exactly `(workspaceId, commandId)`.
- Durable receipts store immutable bounded terminal result/error snapshots, never pointers to mutable state.
- Protocol `correlationId`/`causationId` remain tracing-only and excluded from semantic fingerprint identity.
- Lease/fencing authority, optimistic revisions, Session liveness, controller actor restrictions, and permission authority remain as accepted in ADR-0004/0005.
- The dispatcher must not nest `WorkspaceMutationCoordinator.runSerialized()` around persistence methods that already enter that coordinator; doing so can self-deadlock because the reference coordinator is non-reentrant.
- No Cloudflare-specific type may enter canonical domain/protocol/application contracts.
- No event sourcing, OAuth/IAM, credentials, model-based policy authority, GitHub integration, Codex/ChatGPT integration, UI, or deployment work in this plan.
- Every implementation task starts with a real RED test and ends with focused GREEN evidence plus a commit.
- Never call an unexecuted test PASS.
- Final integration requires `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm test:coverage`, permanent PR `Quality` PASS on the exact head, and post-merge `Quality` PASS on `main`.

---

## File Structure

New/changed responsibilities for this slice:

- `src/persistence/ports.ts` — receipt-aware atomic mutation contracts used by durable application composition.
- `src/persistence/cloudflare/d1-runtime-persistence.ts` — D1 implementation of receipt parity and durable read helpers; no lifecycle redesign.
- `src/runtime/hydration.ts` — runtime-local hydration types/functions over canonical records; must not import persistence types.
- `src/runtime/in-memory-control-plane.ts` — supported rehydration entry point only; existing command semantics remain authoritative.
- `src/runtime/permission-service.ts` — supported rehydration of permission request/decision chains without changing policy rules.
- `src/application/durable-dispatcher.ts` — durable `ApplicationDispatcher` orchestration: receipt lookup, snapshot load, rehydration, execute, persist, query reads, bounded error translation.
- `src/application/durable-commit.ts` — command-to-persistence commit mapping for the first dogfood loop; this module maps results to existing persistence primitives but must not decide lifecycle transitions.
- `src/application/durable-errors.ts` — deterministic persistence → application/protocol error translation.
- `test/application/durable-dispatcher.test.ts` — focused durable command/replay tests.
- `test/e2e/durable-restart-e2e.test.ts` — restart-after-claim, restart-after-permission, response-loss replay, and competing-instance acceptance tests using a real SQLite file through the D1 harness.
- `test/persistence/d1-runtime-persistence*.test.ts` — receipt-parity regression coverage.
- `docs/CURRENT_STATE.md`, `docs/roadmap/V0_1.md`, `CHANGELOG.md` — reconciled only after executable evidence exists.

---

### Task 1: Add atomic command-receipt parity to persistence mutations

**Files:**
- Modify: `src/persistence/ports.ts`
- Modify: `src/persistence/cloudflare/d1-runtime-persistence.ts`
- Test: `test/persistence/d1-runtime-persistence.test.ts`
- Test: `test/persistence/d1-runtime-persistence-invariants.test.ts`

**Interfaces:**
- Consumes: existing `CommandReceiptInput`, `MutationCommitResult<T>`, `DurableRuntimePersistence`, D1 coordinator/transaction helpers.
- Produces these exact port signatures:

```ts
createAgent(input: {
  agent: Agent;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}): Promise<MutationCommitResult<Agent>>;

createSession(input: {
  session: Session;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}): Promise<MutationCommitResult<Session>>;

appendCheckpoint(input: {
  checkpoint: Checkpoint;
  now: string;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}): Promise<MutationCommitResult<Checkpoint>>;

appendPermissionDecision(input: {
  decision: PermissionDecision;
  expectedPreviousDecisionId: string;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}): Promise<MutationCommitResult<PermissionDecision>>;
```

- Each method must call durable receipt resolution before mutation, reject semantic drift with `IDEMPOTENCY_CONFLICT`, and commit record/audit/receipt in the same D1 batch/atomic boundary.

- [ ] **Step 1: Write receipt-parity RED tests**

Add tests equivalent to:

```ts
it('replays Agent creation from a durable command receipt without a second insert', async () => {
  const first = await persistence.createAgent({ agent, receipt });
  expect(first.kind).toBe('committed');

  const replay = await reopenedPersistence.createAgent({ agent, receipt });
  expect(replay.kind).toBe('replayed');
  expect(replay.receipt.responseSnapshot).toEqual(receipt.responseSnapshot);

  const snapshot = await reopenedPersistence.loadWorkspaceState(agent.workspaceId);
  expect(snapshot?.agents).toHaveLength(1);
});
```

Repeat the same invariant for Session, Checkpoint, and human PermissionDecision. For Checkpoint and PermissionDecision, assert append-only history length remains unchanged on replay.

Also add semantic-drift coverage:

```ts
await expect(
  persistence.createSession({
    session,
    receipt: { ...receipt, semanticFingerprint: 'different' },
  }),
).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
```

- [ ] **Step 2: Run focused persistence tests and verify RED**

Run:

```bash
pnpm vitest run \
  test/persistence/d1-runtime-persistence.test.ts \
  test/persistence/d1-runtime-persistence-invariants.test.ts
```

Expected: new tests fail because the four current methods do not accept/store/replay receipts atomically.

- [ ] **Step 3: Extend the persistence port types**

Replace the four current signatures in `DurableRuntimePersistence` with the receipt-aware `MutationCommitResult<T>` signatures shown above. Keep all other port contracts unchanged.

- [ ] **Step 4: Implement D1 receipt parity without changing domain semantics**

For each of the four methods:

```ts
this.assertReceipt(workspaceId, input.receipt);
this.assertRelatedAudit(workspaceId, input.auditEvent);

return this.coordinator.runSerialized(workspaceId, async () => {
  const replay = await this.resolveReceipt(input.receipt);
  if (replay) return replay;

  // existing canonical/authority checks remain here
  const statements = [existingMutationStatement];
  this.pushAuditStatement(statements, input.auditEvent);
  this.pushReceiptStatement(statements, input.receipt);
  await this.batch(statements, '<existing operation name>');
  return { kind: 'committed', value: clone(record) };
});
```

For `appendPermissionDecision`, preserve the persisted permission-head predecessor check and update in the same batch as decision + audit + receipt.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the same Vitest command from Step 2. Expected: all focused persistence tests PASS.

- [ ] **Step 6: Run persistence review/invariant suite**

```bash
pnpm vitest run test/persistence
```

Expected: PASS, including existing two-coordinator claim and stale permission-head regressions.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/persistence/ports.ts src/persistence/cloudflare/d1-runtime-persistence.ts test/persistence
git commit -m "feat: make durable mutation receipts atomic"
```

---

### Task 2: Add a supported runtime hydration seam

**Files:**
- Create: `src/runtime/hydration.ts`
- Modify: `src/runtime/in-memory-control-plane.ts`
- Modify: `src/runtime/permission-service.ts`
- Test: `test/runtime/control-plane-hydration.test.ts`

**Interfaces:**
- Consumes canonical contract records only; `src/runtime/*` must not import `src/persistence/*`.
- Produces:

```ts
export interface RuntimeHydrationState {
  workspace: Workspace;
  agents: Agent[];
  sessions: Session[];
  goals: Goal[];
  tasks: Task[];
  leases: Lease[];
  checkpoints: Checkpoint[];
  permissionRequests: PermissionRequest[];
  permissionDecisions: PermissionDecision[];
  fencingCounters: Readonly<Record<string, number>>;
}

export interface RehydrateControlPlaneOptions {
  state: RuntimeHydrationState;
  now: () => Date;
  idFactory: (kind: string) => string;
  leaseDurationMs: number;
  sessionTimeoutMs: number;
  validateCanonicalDomainRecord: CanonicalDomainValidator;
  permissionPolicy?: PermissionPolicy;
}

export function rehydrateInMemoryControlPlane(
  options: RehydrateControlPlaneOptions,
): InMemoryControlPlane;
```

- Permission-service hydration must restore immutable request/decision chains but must not replay policy evaluation.
- Runtime hydration must not restore command receipts.
- Effective Lease identity must be reconstructed from loaded Lease records and current authoritative time; stale active rows may remain present but must not regain authority.

- [ ] **Step 1: Write hydration RED tests**

Create `test/runtime/control-plane-hydration.test.ts` with at least these cases:

```ts
it('continues checkpoint/completion authority from a hydrated running Task and Lease', () => {
  const hydrated = rehydrateInMemoryControlPlane({ state: snapshot, ...runtimeOptions });
  const checkpoint = hydrated.execute(recordCheckpointCommand);
  expect(checkpoint).not.toHaveProperty('error');
});

it('restores fencing counters so recovery grants a strictly higher token', () => {
  const hydrated = rehydrateInMemoryControlPlane({ state: snapshotWithFence7AndExpiredLease, ...runtimeOptions });
  const claim = hydrated.execute(recoveryClaimCommand);
  expect(success(claim).lease.fencingToken).toBe(8);
});

it('restores HUMAN_REQUIRED permission history without re-evaluating policy', () => {
  const hydrated = rehydrateInMemoryControlPlane({ state: snapshotWithPermissionHistory, ...runtimeOptions });
  const followup = hydrated.execute(humanDecisionCommand);
  expect(success(followup).sequence).toBe(2);
});
```

Also add fail-closed integrity tests for duplicate IDs, cross-workspace records, permission chain inconsistency, and a fencing counter lower than an existing Lease token.

- [ ] **Step 2: Run hydration test and verify RED**

```bash
pnpm vitest run test/runtime/control-plane-hydration.test.ts
```

Expected: FAIL because no supported hydration API exists.

- [ ] **Step 3: Implement runtime-local hydration validation**

In `src/runtime/hydration.ts`, validate before constructing runtime state:

```ts
function assertSingleWorkspace(state: RuntimeHydrationState): void;
function assertUniqueIds(state: RuntimeHydrationState): void;
function assertReferences(state: RuntimeHydrationState): void;
function assertPermissionChains(state: RuntimeHydrationState): void;
function assertFencingCounters(state: RuntimeHydrationState): void;
```

Throw bounded `RuntimeError('CONFLICT', 'Hydrated runtime state is inconsistent.')` or the existing integrity-equivalent runtime code; do not silently repair records.

- [ ] **Step 4: Add explicit state-seeding hooks inside the runtime**

Prefer a private/internal constructor seed rather than replaying public mutation methods. The seed must clone all records and restore maps/indexes directly so hydration does not create new revisions/IDs/checkpoints.

Add a permission-service seed such as:

```ts
export interface PermissionServiceHydrationState {
  requests: PermissionRequest[];
  decisions: PermissionDecision[];
}
```

and initialize its internal maps from validated immutable history.

- [ ] **Step 5: Reconstruct effective Lease/fencing indexes**

On hydration:

- retain all canonical Lease history;
- set an effective Lease mapping only for an `active` Lease whose Session is effectively active and whose `expiresAt` is after `now()`;
- reject multiple simultaneously-effective Leases for one Task;
- initialize each Task fence counter from `state.fencingCounters[taskId]` and verify it is `>=` every historical Lease fence for that Task.

- [ ] **Step 6: Run hydration tests and verify GREEN**

```bash
pnpm vitest run test/runtime/control-plane-hydration.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run all runtime/permission tests**

```bash
pnpm vitest run test/runtime test/policy
```

Expected: PASS with no lifecycle/policy semantic changes.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/runtime/hydration.ts src/runtime/in-memory-control-plane.ts src/runtime/permission-service.ts test/runtime/control-plane-hydration.test.ts
git commit -m "feat: rehydrate runtime from canonical state"
```

---

### Task 3: Implement durable command dispatch for the first dogfood loop

**Files:**
- Create: `src/application/durable-errors.ts`
- Create: `src/application/durable-commit.ts`
- Create: `src/application/durable-dispatcher.ts`
- Modify: `src/application/ports.ts` only if a construction dependency type is needed; do not change `ApplicationDispatcher` command/query semantics.
- Test: `test/application/durable-dispatcher.test.ts`

**Interfaces:**
- Consumes: `ApplicationDispatcher`, `ApplicationCommand`, `ApplicationQuery`, `DurableRuntimePersistence`, `RuntimeHydrationState`, `rehydrateInMemoryControlPlane`, `semanticFingerprint`/existing protocol response types.
- Produces:

```ts
export interface DurableApplicationDispatcherOptions {
  persistence: DurableRuntimePersistence;
  now: () => Date;
  idFactory: (kind: string) => string;
  leaseDurationMs: number;
  sessionTimeoutMs: number;
  validateCanonicalDomainRecord: CanonicalDomainValidator;
  permissionPolicy?: PermissionPolicy;
}

export function createDurableApplicationDispatcher(
  options: DurableApplicationDispatcherOptions,
): ApplicationDispatcher;
```

- First-loop durable mutation support is exactly: `RegisterAgent`, `StartSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, `CompleteTask`.
- Other mutations must return deterministic `UNSUPPORTED_OPERATION` until Task 6 or a later slice adds parity; they must never fall back to retained in-memory state.

- [ ] **Step 1: Write durable-dispatch RED tests**

Create tests proving:

```ts
it('loads D1 state for every durable command instead of retaining runtime state', async () => {
  const dispatcherA = createDurableApplicationDispatcher(options);
  await dispatcherA.dispatchCommand(registerAgent);

  const dispatcherB = createDurableApplicationDispatcher(options);
  const session = await dispatcherB.dispatchCommand(startSessionUsingAgentFromA);
  expect(session).not.toHaveProperty('error');
});

it('replays an exact durable receipt before runtime execution', async () => {
  const first = await dispatcher.dispatchCommand(createGoal);
  const restarted = createDurableApplicationDispatcher(options);
  const replay = await restarted.dispatchCommand({ ...createGoal, correlationId: 'retry-corr' });
  expect(replay.replayed).toBe(true);
  expect(replay.correlationId).toBe('retry-corr');
  expect(result(replay)).toEqual(result(first));
});
```

Also cover semantic-drift conflict and bounded persistence error translation.

- [ ] **Step 2: Run durable-dispatch tests and verify RED**

```bash
pnpm vitest run test/application/durable-dispatcher.test.ts
```

Expected: FAIL because `createDurableApplicationDispatcher` does not exist.

- [ ] **Step 3: Implement deterministic persistence error translation**

In `src/application/durable-errors.ts`, define one mapping function:

```ts
export function persistenceErrorResponse(
  command: ApplicationCommand,
  error: PersistenceError,
): CommandResponse;
```

Map at minimum:

```ts
NOT_FOUND -> NOT_FOUND
CONFLICT -> CONFLICT
REVISION_MISMATCH -> REVISION_MISMATCH
STALE_AUTHORITY -> STALE_AUTHORITY
IDEMPOTENCY_CONFLICT -> IDEMPOTENCY_CONFLICT
INVALID_STATE_TRANSITION -> INVALID_STATE_TRANSITION
INVALID_RECORD -> CONFLICT
INTEGRITY_ERROR -> INTERNAL_ERROR
```

Messages returned to transports must be bounded and must not include SQL/stack/credential/internal adapter details.

- [ ] **Step 4: Implement durable receipt preflight**

Before hydration:

```ts
const stored = await persistence.getCommandReceipt(command.workspaceId, command.commandId);
if (stored) {
  // compare command discriminator + semantic fingerprint
  // on exact match reconstruct ProtocolResponse from stored.responseSnapshot,
  // set replayed=true and use current correlationId
  // on mismatch return IDEMPOTENCY_CONFLICT
}
```

Do not insert any receipt for structural/application pre-admission failures; transport/application validation has already run before this dispatcher.

- [ ] **Step 5: Load and map Workspace snapshots into runtime hydration state**

For all first-loop commands except the initial Workspace bootstrap itself:

```ts
const snapshot = await persistence.loadWorkspaceState(command.workspaceId);
if (!snapshot) return notFound(command, 'Workspace was not found.');
const runtime = rehydrateInMemoryControlPlane({
  state: {
    workspace: snapshot.workspace,
    agents: snapshot.agents,
    sessions: snapshot.sessions,
    goals: snapshot.goals,
    tasks: snapshot.tasks,
    leases: snapshot.leases,
    checkpoints: snapshot.checkpoints,
    permissionRequests: snapshot.permissionRequests,
    permissionDecisions: snapshot.permissionDecisions,
    fencingCounters: snapshot.fencingCounters,
  },
  ...runtimeOptions,
});
```

No snapshot/runtime instance is cached between commands.

- [ ] **Step 6: Execute canonical runtime semantics and build the durable receipt**

Execute:

```ts
const ephemeralResponse = runtime.execute(command);
```

For a runtime terminal result/error, create a `CommandReceiptInput` using the existing semantic fingerprint and an immutable bounded terminal snapshot. Store only the terminal `result` or `error` data needed to reconstruct the protocol response; tracing is reconstructed for the current request.

- [ ] **Step 7: Implement command-to-persistence commit mapping**

In `src/application/durable-commit.ts`, create:

```ts
export async function persistDurableCommandResult(
  persistence: DurableRuntimePersistence,
  command: ApplicationCommand,
  result: unknown,
  receipt: CommandReceiptInput,
  before: WorkspaceStateSnapshot,
): Promise<unknown>;
```

This function may inspect command type and the canonical runtime result but must not decide transitions. Map commands as follows:

- `RegisterAgent` → `createAgent({ agent: result, receipt })`
- `StartSession` → `createSession({ session: result, receipt })`
- `CreateGoal` → `createGoal({ goal: result, receipt })`
- `CreateTask` → `createTask({ task: result, receipt })`
- `ClaimTask` → `claimTask(...)`, using pre-command Task revision and the runtime-produced Lease without treating the speculative fence as authoritative; return the persisted Task/Lease value from D1.
- `RecordCheckpoint` → `appendCheckpoint({ checkpoint: result, now, receipt })`
- `RequestPermission` → `appendPermissionRequestWithInitialDecision({ request, decision, receipt })`
- `RecordPermissionDecision` → `appendPermissionDecision({ decision: result, expectedPreviousDecisionId: command.expectedPreviousDecisionId, receipt })`
- `CompleteTask` → `completeTask(...)`, using the persisted pre-command Task revision and runtime-produced Task/Lease/result Checkpoint; return the persisted value.

On any persistence conflict, discard the ephemeral response and return the translated persistence failure.

- [ ] **Step 8: Ensure persistence-generated claim authority wins**

For `ClaimTask`, assert the response returned to the client uses the `claimTask()` committed value from persistence. Never return an ephemeral fence/Lease if D1 generated a different authoritative fence.

- [ ] **Step 9: Run durable-dispatch tests and verify GREEN**

```bash
pnpm vitest run test/application/durable-dispatcher.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run application/runtime/persistence suites**

```bash
pnpm vitest run test/application test/runtime test/persistence test/policy
```

Expected: PASS.

- [ ] **Step 11: Commit Task 3**

```bash
git add src/application test/application
git commit -m "feat: add durable application command dispatcher"
```

---

### Task 4: Implement durable query reads needed by restart-safe dogfooding

**Files:**
- Modify: `src/persistence/ports.ts`
- Modify: `src/persistence/cloudflare/d1-runtime-persistence.ts`
- Modify: `src/application/durable-dispatcher.ts`
- Test: `test/application/durable-queries.test.ts`

**Interfaces:**
- Produces bounded durable query helpers through `DurableRuntimePersistence` rather than exposing D1 SQL to the application layer.
- Add exact port methods:

```ts
getWorkspace(workspaceId: string): Promise<Workspace | undefined>;
getGoal(workspaceId: string, goalId: string): Promise<Goal | undefined>;
getTask(workspaceId: string, taskId: string): Promise<Task | undefined>;
getAgent(workspaceId: string, agentId: string): Promise<Agent | undefined>;
getSession(workspaceId: string, sessionId: string): Promise<Session | undefined>;
getLease(workspaceId: string, leaseId: string): Promise<Lease | undefined>;
getPermissionRequest(
  workspaceId: string,
  requestId: string,
): Promise<PermissionRequest | undefined>;
```

Existing list methods remain in use for checkpoints, decisions, pending permissions.

- [ ] **Step 1: Write durable query RED tests**

Cover exact dispatcher queries:

```ts
GetWorkspace
GetGoal
GetTask
GetLease
ListTaskCheckpoints
GetAgent
GetSession
GetPermissionRequest
ListPermissionDecisions
ListPendingHumanPermissions
```

For every query, create a fresh dispatcher after the write and assert the result comes from the same database file. Also verify unknown IDs return bounded `NOT_FOUND` and no query uses retained runtime state.

- [ ] **Step 2: Run query tests and verify RED**

```bash
pnpm vitest run test/application/durable-queries.test.ts
```

Expected: missing persistence/public query helpers and durable query routing cause failures.

- [ ] **Step 3: Expose bounded persistence read methods**

Promote existing private D1 getters to satisfy the port signatures above, or add thin public wrappers around them. Preserve same-Workspace filtering in every query.

- [ ] **Step 4: Route durable application queries directly to persistence**

Do not hydrate a runtime for pure reads when D1 can answer them directly. Use the existing `QueryResponse` envelope and deterministic unsupported/not-found helpers.

For `ListPendingHumanPermissions`, cap the requested `limit` through the existing persistence limit guard; never add arbitrary filter expressions.

- [ ] **Step 5: Run query tests and verify GREEN**

```bash
pnpm vitest run test/application/durable-queries.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run HTTP/MCP adapter suites against the unchanged application port**

```bash
pnpm vitest run test/transports
```

Expected: PASS; transports must not need lifecycle-specific changes.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/persistence src/application test/application/durable-queries.test.ts
git commit -m "feat: add durable control-plane queries"
```

---

### Task 5: Prove restart, response-loss replay, and competing-instance behavior

**Files:**
- Create: `test/e2e/durable-restart-e2e.test.ts`
- Modify: `test/persistence/setup.ts` only if a reusable durable-dispatcher fixture is needed.
- Modify implementation files only when a failing acceptance test identifies a real defect.

**Interfaces:**
- Uses the real migration set and `SqliteD1Database` file-backed harness.
- Uses `createDurableApplicationDispatcher()` through the same `ApplicationDispatcher` surface used by HTTP/MCP.
- No test-only in-memory fallback is permitted.

- [ ] **Step 1: Write restart-after-claim RED test**

```ts
it('continues a fenced execution after process restart', async () => {
  const file = tempDatabasePath();
  const appA = await openDurableApplication(file);
  const execution = await bootstrapThroughClaim(appA.dispatcher);
  appA.database.close();

  const appB = await openDurableApplication(file);
  const checkpoint = await appB.dispatcher.dispatchCommand(
    checkpointCommandUsing(execution.session, execution.lease),
  );
  expect(checkpoint).not.toHaveProperty('error');

  const completed = await appB.dispatcher.dispatchCommand(
    completeCommandUsing(execution.task, execution.session, execution.lease),
  );
  expect(result(completed).task.status).toBe('succeeded');
  appB.database.close();
});
```

- [ ] **Step 2: Write restart-after-HUMAN_REQUIRED RED test**

Persist a `repository.write` request, close the first DB/process composition, reopen it, list pending permissions from D1, record human `ALLOW` using the persisted predecessor decision ID, then complete the original Task with still-current Lease/fence authority.

- [ ] **Step 3: Write response-loss/idempotency RED test**

Execute `CreateGoal` or `RequestPermission`, discard the first dispatcher without using its response, reopen the DB, retry the exact same command ID and semantic body with a different `correlationId`, then assert:

```ts
expect(retry.replayed).toBe(true);
expect(retry.correlationId).toBe('retry-correlation');
expect(await countRows('goals')).toBe(1); // or one PermissionRequest/initial decision chain
```

- [ ] **Step 4: Write competing-instance RED test**

Use two independently-created durable application dispatchers against the same SQLite file and distinct Session IDs. Race:

```ts
const [a, b] = await Promise.all([
  dispatcherA.dispatchCommand(claimA),
  dispatcherB.dispatchCommand(claimB),
]);
```

Assert exactly one successful new Lease grant, one bounded loser response, one authoritative active Lease after reopen, and fencing counter `>=` the winning Lease token.

- [ ] **Step 5: Run the durable E2E file and verify RED where integration gaps remain**

```bash
pnpm vitest run test/e2e/durable-restart-e2e.test.ts
```

Expected: any remaining orchestration/hydration/atomicity defects fail here. Do not weaken tests to accommodate implementation.

- [ ] **Step 6: Fix defects minimally through the existing boundaries**

Allowed fix locations:

```text
src/application/durable-dispatcher.ts
src/application/durable-commit.ts
src/application/durable-errors.ts
src/runtime/hydration.ts
src/persistence/ports.ts
src/persistence/cloudflare/d1-runtime-persistence.ts
```

Do not add a parallel state machine. If the acceptance test exposes a semantic requirement not covered by the accepted ADR/spec, stop and update the design/ADR before continuing.

- [ ] **Step 7: Run durable E2E and verify GREEN**

```bash
pnpm vitest run test/e2e/durable-restart-e2e.test.ts
```

Expected: PASS for all four acceptance scenarios.

- [ ] **Step 8: Run all E2E + persistence + runtime integration tests**

```bash
pnpm vitest run test/e2e test/application test/runtime test/persistence test/policy test/transports
```

Expected: PASS.

- [ ] **Step 9: Commit Task 5**

```bash
git add test/e2e test/persistence/setup.ts src
git commit -m "test: prove durable restart and concurrency"
```

---

### Task 6: Reconcile repository state and pass release gates

**Files:**
- Modify: `docs/CURRENT_STATE.md`
- Modify: `docs/roadmap/V0_1.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-29-durable-application-composition-design.md` only to record the coordinator-ownership clarification if not already incorporated.

**Interfaces:**
- Documentation may claim only capabilities actually executed by Task 5 and final CI.

- [ ] **Step 1: Update `CURRENT_STATE` with exact proven guarantees**

Record only executed facts:

- durable first-loop commands now use D1 as SoR;
- restart after claim and after HUMAN_REQUIRED is proven by SQLite-backed D1 tests;
- exact receipt replay survives dispatcher/process reconstruction;
- competing durable dispatchers cannot commit two effective new Leases;
- durable query subset supported;
- Cloudflare production deployment is still unverified;
- remaining lifecycle parity/agent integrations remain future work.

- [ ] **Step 2: Update roadmap statuses without overstating v0.1 completion**

Mark durable application composition as implemented/verified while leaving actual Cloudflare deployment, GitHub integration, real agent bootstrap/dogfooding, and any unsupported command/query parity open.

- [ ] **Step 3: Update changelog with implementation and test evidence**

Do not write final test counts until the final exact-head run has completed.

- [ ] **Step 4: Run frozen install and full local CI-equivalent gate**

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
```

Expected: all commands PASS on the exact tree intended for PR.

- [ ] **Step 5: Inspect final diff for architecture drift**

Explicit review checklist:

```text
[ ] no DurableControlPlane/second lifecycle implementation
[ ] no retained per-Workspace runtime cache used as authority
[ ] no nested use of the same non-reentrant Workspace coordinator
[ ] every first-loop durable mutation has atomic receipt parity
[ ] claim response uses persistence-authoritative fence/Lease
[ ] no protocol/domain schema changes
[ ] no transport-specific lifecycle logic
[ ] no SQL/internal errors leaked to protocol responses
[ ] no temporary workflows/scripts committed
[ ] docs distinguish SQLite D1-harness verification from real Cloudflare deployment
```

- [ ] **Step 6: Commit docs/final reconciliation**

```bash
git add docs/CURRENT_STATE.md docs/roadmap/V0_1.md CHANGELOG.md docs/superpowers
git commit -m "docs: reconcile durable application composition"
```

- [ ] **Step 7: Open a non-draft PR to `main`**

PR body must include:

- spec and plan paths;
- RED evidence per task;
- focused GREEN evidence;
- final `pnpm check` and coverage evidence;
- exact limitations;
- explicit statement that real Cloudflare runtime/deployment verification has not been performed unless it actually was.

- [ ] **Step 8: Require permanent `Quality` PASS on exact PR head**

Do not merge on a previous commit's green run.

- [ ] **Step 9: Review all changed production files and resolve blocking review threads**

Critical/Important findings are fixed before merge. Re-run permanent Quality after any production/test change.

- [ ] **Step 10: Squash-merge using expected head SHA and verify `main`**

After merge, require the push-triggered permanent `Quality` run on the new `main` SHA to PASS before calling this slice complete.

---

## Self-Review

### Spec coverage

- Receipt parity: Task 1.
- Runtime hydration without persistence coupling: Task 2.
- Durable dispatcher / one semantic implementation: Task 3.
- Durable reads: Task 4.
- Restart after ClaimTask: Task 5.
- Restart after HUMAN_REQUIRED: Task 5.
- Response-loss durable replay: Task 5.
- Competing application instances: Task 5.
- Error bounding/translation: Task 3.
- No nested coordinator/self-deadlock: Global Constraints + Task 3.
- Documentation and exact verification evidence: Task 6.

No spec requirement in the first durable dogfood slice is left without an implementation/test task.

### Placeholder scan

The plan intentionally contains no TBD/TODO/future-fill placeholders. Unsupported lifecycle parity is explicitly out of this plan rather than left as an incomplete implementation step.

### Type consistency

- Persistence receipt-parity methods consistently return `MutationCommitResult<T>`.
- Runtime hydration depends only on canonical record types and runtime-local interfaces.
- Durable dispatcher continues to implement the existing `ApplicationDispatcher` interface.
- D1 snapshot mapping occurs in application composition, not in runtime.
- Command commit mapping always returns persistence-authoritative committed values where persistence may allocate/resolve authority (especially ClaimTask).
