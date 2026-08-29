# Bootstrap Protocol and Application E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining v0.1 bootstrap gap by making `RegisterAgent` and `StartSession` canonical protocol commands and prove one complete agent lifecycle through the merged HTTP/application boundary.

**Architecture:** Keep ADR-0005 as the protocol authority and `InMemoryControlPlane` as the local reference runtime. Remove the temporary application-only command split so HTTP/MCP parse and dispatch the same `ProtocolCommand` union as lifecycle and permission commands. Add a deterministic transport-level E2E over the existing in-memory composition; do not invent a second runtime, persistence authority, auth system, or protocol schema.

**Tech Stack:** Node 24, TypeScript 6, Vitest 4, existing `@mindrail/contracts`, existing HTTP/MCP adapters; no new runtime dependency.

**Spec:** `docs/adr/ADR-0005-control-plane-protocol-v0-1.md`, `docs/adr/ADR-0004-runtime-state-machine-and-concurrency.md`, `docs/CURRENT_STATE.md`.

## Global Constraints

- JSON Schema/domain v1 remains canonical; do not edit generated contract files manually.
- `Agent != Session != Task != Lease`.
- `RegisterAgent` creates an active Agent at revision 1 with exact namespaced capabilities.
- `StartSession` creates an active Session for an active Agent and never inherits old Lease/permission authority.
- Protocol idempotency remains exactly `(workspaceId, commandId)` and includes bootstrap commands.
- Bootstrap commands must pass the same structural pre-admission and immutable replay rules as all other protocol commands.
- HTTP/MCP remain adapters only; lifecycle, permission, and idempotency authority stay in the runtime/application boundary.
- No Cloudflare-specific type may enter canonical protocol/domain types.
- Do not claim durable end-to-end orchestration unless a test actually runs through the durable persistence composition.
- No production code before a failing test has been observed for the intended missing behavior.

---

### Task 1: Canonical bootstrap protocol commands

**Files:**

- Create: `test/runtime/bootstrap-protocol.test.ts`
- Modify after RED: `src/runtime/protocol.ts`
- Modify after RED: `src/runtime/protocol-validation.ts`
- Modify after RED: `src/runtime/in-memory-control-plane.ts`
- Modify after RED: `src/application/protocol.ts`
- Modify after RED: `src/application/validation.ts`
- Modify after RED: `src/application/in-memory-dispatcher.ts`

**Interfaces:**

- `ProtocolCommand` includes `RegisterAgentCommand` and `StartSessionCommand`.
- `InMemoryControlPlane.execute()` returns canonical `Agent` / `Session` results for those commands.
- `ApplicationCommand` becomes the same canonical runtime `ProtocolCommand` union instead of adding a parallel bootstrap union.
- `IN_MEMORY_UNSUPPORTED_COMMANDS` becomes empty once both bootstrap commands dispatch through the runtime.

- [ ] **Step 1: Write failing protocol tests**

Add tests proving:

```text
RegisterAgent through execute -> active Agent revision 1
exact RegisterAgent replay -> replayed=true and same immutable Agent snapshot
StartSession through execute -> active Session revision 1 for registered Agent
same commandId with changed bootstrap semantic intent -> IDEMPOTENCY_CONFLICT
invalid capability name / unknown Agent -> bounded protocol failure without successful mutation
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
pnpm vitest run test/runtime/bootstrap-protocol.test.ts
```

Expected: FAIL because bootstrap commands are not members of `ProtocolCommand` / runtime `execute`.

- [ ] **Step 3: Implement the minimum canonical bootstrap support**

Add only the two ADR-0005 commands to runtime protocol types and validation. Dispatch them through existing `registerAgent` / `startSession` methods inside the existing receipt/idempotency boundary. Reuse exact namespaced capability validation; do not add wildcard matching or a new registration subsystem.

Then remove the application-only `ParallelCommand` definitions/validator path and let the application dispatcher treat all `ApplicationCommand`s as canonical `ProtocolCommand`s.

- [ ] **Step 4: Run focused runtime + transport regressions and observe GREEN**

```bash
pnpm vitest run test/runtime/bootstrap-protocol.test.ts test/transports/review-regressions.test.ts test/transports/http-adapter.test.ts test/transports/mcp-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the bootstrap protocol slice**

Commit only production files plus the focused bootstrap tests.

### Task 2: Complete HTTP/application control-plane E2E

**Files:**

- Create: `test/e2e/http-control-plane-e2e.test.ts`
- Modify after RED only if required: existing runtime/application/transport files.

**Interfaces:**

- Uses `createHttpTransport(createInMemoryApplicationDispatcher(controlPlane), authorizer)` with a deterministic runtime fixture.
- Executes commands using only HTTP routes and parses protocol responses; it must not call direct lifecycle methods after bootstrap.

- [ ] **Step 1: Write the failing integrated E2E**

The test must drive this path through HTTP commands:

```text
RegisterAgent
→ StartSession
→ CreateGoal
→ CreateTask
→ ClaimTask
→ RecordCheckpoint
→ RequestPermission(repository.write) => HUMAN_REQUIRED
→ RecordPermissionDecision(ALLOW) by a human principal/actor
→ CompleteTask
```

Assert final Task `succeeded`, Lease `released`, Goal `succeeded`, permission history contains policy `HUMAN_REQUIRED` then human `ALLOW`, and no generic transport escape hatch is used.

- [ ] **Step 2: Run E2E and observe RED if any integration gap remains**

```bash
pnpm vitest run test/e2e/http-control-plane-e2e.test.ts
```

If it fails, fix only the concrete shared-boundary defect demonstrated by the test. Do not widen scope into deployment, auth-provider, or Cloudflare worker infrastructure.

- [ ] **Step 3: Run E2E plus relevant lifecycle/permission tests and observe GREEN**

```bash
pnpm vitest run test/e2e/http-control-plane-e2e.test.ts test/runtime/control-plane-runtime-surface.test.ts test/runtime/permission-engine.test.ts
```

- [ ] **Step 4: Commit the E2E slice**

Commit the E2E test and any minimal production integration fix required by the observed RED.

### Task 3: Reconcile repository truth and final verification

**Files:**

- Modify: `docs/CURRENT_STATE.md`
- Modify: `docs/roadmap/V0_1.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Reconcile factual state**

Record that Runtime Surface, Permission Engine, D1/Workspace coordinator persistence adapter, HTTP/MCP adapters, and bootstrap protocol commands are merged/verified only when supported by current branch evidence. Explicitly distinguish a verified persistence adapter from a deployed durable application/runtime composition.

- [ ] **Step 2: Run full verification on the exact final tree**

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
```

Also verify only `.github/workflows/quality.yml` remains and no temporary integration scripts/workflows are committed.

- [ ] **Step 3: Open a non-draft PR and require permanent Quality**

Permanent `Quality` must pass on the exact PR head before merge.

- [ ] **Step 4: Merge and verify `main` again**

Require the post-merge `Quality` run on `main` to pass before calling this closing slice complete.

- [ ] **Step 5: Report remaining v0.1 limitations exactly**

Do not call MindRail production-ready or fully unattended. If durable application composition, deployed Cloudflare runtime, GitHub adapter, or real Codex/ChatGPT bootstrap remain absent, list them as next slices rather than implying they exist.
