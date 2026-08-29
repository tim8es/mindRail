# Local Runtime Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first executable MindRail control-plane loop in a deterministic in-memory runtime: Workspace bootstrap → Goal/Task → Agent/Session → Lease/fence → Checkpoint → Complete → automatic Goal success, with safe recovery, idempotency, retry, and cancellation.

**Architecture:** Implement one transport-neutral in-memory control-plane class under `src/runtime/`. It consumes the canonical generated domain types, owns authoritative state in Maps, injects clock/id generation for deterministic tests, and exposes explicit lifecycle methods plus a protocol-command dispatcher. Cloudflare, D1, HTTP, MCP, authentication providers, and LLM planning remain out of scope.

**Tech Stack:** Node 24, TypeScript 6, Vitest 4, existing `@mindrail/contracts` generated types; no new third-party dependency.

**Spec:** `docs/superpowers/specs/2026-08-29-control-plane-protocol-v0-1-design.md`, ADR-0003, ADR-0004, ADR-0005.

## Global Constraints

- JSON Schema/domain v1 remains canonical; do not modify generated types manually.
- `Agent != Session != Task != Lease`.
- Runtime state is authoritative.
- Task `running` is durable and may exist without an active Lease.
- New Lease grants use strictly increasing per-Task fencing tokens.
- Stale Lease/fence pairs never authorize Checkpoint or Task terminalization.
- Same-Session duplicate claim returns the existing Lease/fence unchanged.
- Retry is explicit and only `failed -> ready`.
- Goal/Task terminal operations obey ADR-0004 ordering.
- Protocol idempotency key is exactly `(workspaceId, commandId)`.
- Tracing correlation/causation does not affect semantic command identity.
- Exact command replay returns an immutable original result/error snapshot and never re-executes.
- CancelGoal removes execution authority and prevents stale completion.
- No Cloudflare, HTTP, MCP, database, queue, event sourcing, model provider, or policy language in this slice.
- No production code before a test has been observed failing for the intended missing behavior.

---

### Task 1: Executable Goal-to-completion loop

**Files:**
- Create: `test/runtime/control-plane.test.ts`
- Create after RED: `src/runtime/in-memory-control-plane.ts`
- Create after RED: `src/runtime/errors.ts`

**Interfaces:**
- Produces: `InMemoryControlPlane`, `RuntimeError`.
- Constructor accepts deterministic `now`, `idFactory`, `leaseDurationMs`, and bootstrap Workspace identity/name.
- Methods: `getWorkspace`, `registerAgent`, `startSession`, `createGoal`, `createTask`, `claimTask`, `recordCheckpoint`, `completeTask`, `getGoal`, `getTask`, `getLease`, `listTaskCheckpoints`.

- [ ] **Step 1: Write failing end-to-end test**

Create one test that bootstraps Workspace `ws-1`, registers an Agent with `code.execute`, starts a Session, creates one Goal and one ready Task, claims it, appends a progress Checkpoint, completes it, and asserts:

```text
Task: ready -> running -> succeeded
Lease: active -> released
Checkpoint history: progress + result
Goal: active -> succeeded
fencingToken: 1
```

- [ ] **Step 2: Run focused test and observe RED**

Run:

```bash
pnpm vitest run test/runtime/control-plane.test.ts -t "executes the first complete control-plane loop"
```

Expected: FAIL because `src/runtime/in-memory-control-plane` does not exist.

- [ ] **Step 3: Implement the minimum lifecycle core**

Use canonical `Workspace`, `Goal`, `Task`, `Agent`, `Session`, `Lease`, and `Checkpoint` shapes. State is held in private Maps. Every accepted mutable change increments revision exactly once and uses the injected clock. Task creation validates active Goal and dependency state; completing the last non-empty Goal Task auto-succeeds the Goal.

- [ ] **Step 4: Run the focused test and observe GREEN**

```bash
pnpm vitest run test/runtime/control-plane.test.ts -t "executes the first complete control-plane loop"
```

Expected: PASS.

- [ ] **Step 5: Commit lifecycle core**

```bash
git add test/runtime/control-plane.test.ts src/runtime/in-memory-control-plane.ts src/runtime/errors.ts
git commit -m "feat: add executable local control-plane loop"
```

### Task 2: Lease ownership, recovery, and fencing

**Files:**
- Modify: `test/runtime/control-plane.test.ts`
- Modify after RED: `src/runtime/in-memory-control-plane.ts`

**Interfaces:**
- Add methods: `releaseLease`, and recovery claim semantics for running Tasks without an effective Lease.

- [ ] **Step 1: Add failing Lease/fencing tests**

Add tests that prove:

```text
same Session duplicate claim -> same Lease id and fencingToken
second Session while Lease active -> CONFLICT
release Lease -> Task stays running
new Session recovery claim -> new Lease with fencingToken 2
old Lease/fence checkpoint -> STALE_FENCING_TOKEN or LEASE_NOT_ACTIVE
```

- [ ] **Step 2: Run focused Lease tests and observe RED**

```bash
pnpm vitest run test/runtime/control-plane.test.ts -t "lease|fencing|recovery"
```

- [ ] **Step 3: Implement minimum authority checks**

Authority admission verifies Workspace, Task, Session, Lease id, Lease status/expiry, owning Session, active Agent, Task `running`, and current effective Task Lease. New grants increment a durable in-memory per-Task fence counter; release never rewinds Task to ready.

- [ ] **Step 4: Run focused Lease tests and observe GREEN**

```bash
pnpm vitest run test/runtime/control-plane.test.ts -t "lease|fencing|recovery"
```

- [ ] **Step 5: Commit**

```bash
git add test/runtime/control-plane.test.ts src/runtime/in-memory-control-plane.ts
git commit -m "feat: enforce lease fencing and recovery"
```

### Task 3: Protocol command idempotency

**Files:**
- Create: `src/runtime/protocol.ts`
- Modify: `test/runtime/control-plane.test.ts`
- Modify after RED: `src/runtime/in-memory-control-plane.ts`

**Interfaces:**
- Produce `ProtocolCommand`, `ProtocolSuccess`, `ProtocolFailure`, `execute(command)`.
- First dispatcher coverage: `CreateGoal`, `CreateTask`, `ClaimTask`, `RecordCheckpoint`, `CompleteTask`, `FailTask`, `RetryTask`, `CancelTask`, `CancelGoal`.

- [ ] **Step 1: Add failing replay/conflict tests**

Prove:

```text
exact command replay -> replayed=true and no second mutation
replay after later state changes -> original immutable result snapshot
same semantic command with changed correlationId/causationId -> exact replay
same (workspaceId, commandId) with different semantic intent -> IDEMPOTENCY_CONFLICT
```

- [ ] **Step 2: Run focused idempotency tests and observe RED**

```bash
pnpm vitest run test/runtime/control-plane.test.ts -t "idempot"
```

- [ ] **Step 3: Implement deterministic semantic fingerprints and receipts**

Canonicalize semantic command data recursively with sorted object keys while excluding tracing-only fields. Store a deep-cloned result/error snapshot keyed by `workspaceId + commandId`. Replay deep-clones the stored snapshot again so callers cannot mutate the receipt.

- [ ] **Step 4: Run focused idempotency tests and observe GREEN**

```bash
pnpm vitest run test/runtime/control-plane.test.ts -t "idempot"
```

- [ ] **Step 5: Commit**

```bash
git add test/runtime/control-plane.test.ts src/runtime/protocol.ts src/runtime/in-memory-control-plane.ts
git commit -m "feat: add protocol idempotency receipts"
```

### Task 4: Failure, retry, and stop controls

**Files:**
- Modify: `test/runtime/control-plane.test.ts`
- Modify after RED: `src/runtime/in-memory-control-plane.ts`
- Modify after RED: `src/runtime/protocol.ts`

**Interfaces:**
- Add/complete `failTask`, `retryTask`, `cancelTask`, `cancelGoal`.

- [ ] **Step 1: Add failing state-control tests**

Prove:

```text
FailTask -> failed + released Lease
RetryTask -> ready only from failed
CancelTask while running -> cancelled + revoked Lease
CancelGoal -> Goal cancelled + all nonterminal Tasks cancelled + active Leases revoked
stale executor completion after CancelGoal -> rejected
CreateTask after terminal Goal -> rejected
```

- [ ] **Step 2: Run focused state-control tests and observe RED**

```bash
pnpm vitest run test/runtime/control-plane.test.ts -t "retry|cancel|stale completion"
```

- [ ] **Step 3: Implement minimum deterministic transitions**

Keep cancellation synchronous and atomic inside the single-process runtime. Do not introduce queues, attempts, or staged Goal cancellation.

- [ ] **Step 4: Run focused tests and observe GREEN**

```bash
pnpm vitest run test/runtime/control-plane.test.ts -t "retry|cancel|stale completion"
```

- [ ] **Step 5: Commit**

```bash
git add test/runtime/control-plane.test.ts src/runtime/in-memory-control-plane.ts src/runtime/protocol.ts
git commit -m "feat: add retry and cancellation controls"
```

### Task 5: Reconcile repository state and verify the slice

**Files:**
- Modify: `docs/CURRENT_STATE.md`
- Modify: `docs/roadmap/V0_1.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run full verification**

```bash
pnpm install --frozen-lockfile
pnpm format:check
pnpm lint
pnpm typecheck
pnpm contracts:check-generated
pnpm test
pnpm check
pnpm test:coverage
```

All claims in docs must match actual executed results.

- [ ] **Step 2: Update current-state docs factually**

Record only implemented local runtime behavior. Explicitly keep HTTP/MCP, D1/DO, external agent integration, authentication provider, and Policy Engine runtime as not implemented.

- [ ] **Step 3: Re-run permanent Quality on final HEAD**

Expected: PASS on the exact final PR head.

- [ ] **Step 4: Final review**

Check that:

```text
no temporary write workflow remains
no new third-party runtime dependency exists
no Cloudflare/provider concept leaked into core runtime
no generated contract file was edited manually
no unexecuted behavior is called verified
```
