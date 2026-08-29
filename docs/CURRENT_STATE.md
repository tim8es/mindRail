# Current State

**Last reconciled:** 2026-08-29

This document describes what exists, not what is intended. Roadmap items are never evidence of implementation.

## Implemented and verified

The following facts are supported by repository state and executed GitHub Actions evidence:

- Repository `tim8es/mindRail` is public with `main` as the default branch.
- Development foundation, Domain Contracts, ADR-0001 through ADR-0005, Runtime Surface, Permission Engine, the reference persistence adapter, HTTP/MCP transport adapters, and the first durable application composition have executable verification evidence.
- JSON Schema Draft 2020-12 under `schemas/domain/v1/` is canonical for `Workspace`, `Goal`, `Task`, `Agent`, `Session`, `Lease`, `Checkpoint`, `PermissionRequest`, `PermissionDecision`, `AuditEvent`, and shared value objects. `@mindrail/contracts` provides deterministic generated TypeScript bindings and generated-drift checks.
- The deterministic reference runtime under `src/runtime/` consumes canonical contract types and validates authoritative domain records through the injected `CanonicalDomainValidator` seam before insertion/mutation.
- The runtime supports Agent registration; Session start, heartbeat, timeout expiry, and end; Goal/Task creation; Task claim/release/recovery; Lease renewal; checkpoints; completion/failure/block/resume/retry/cancellation; Goal cancellation; dependency release; and automatic Goal success.
- `Agent`, `Session`, `Task`, and `Lease` remain distinct authorities. Session liveness does not renew a Lease. A running Task may temporarily have no effective Lease and may be recovered by a new Session.
- Lease authority uses monotonic per-Task fencing. Same-Session semantic duplicate claim returns the current Lease without minting a new fence; recovery after release/expiry/session loss grants a strictly higher fence. Stale/revoked/replaced authority cannot renew, checkpoint, complete, or request permission.
- The canonical transport-neutral command surface includes every ADR-0005 v0.1 command: `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `CompleteTask`, `FailTask`, `BlockTask`, `ResumeTask`, `RetryTask`, `CancelTask`, `CancelGoal`, `RequestPermission`, and `RecordPermissionDecision`.
- `RegisterAgent` and `StartSession` pass through the same protocol pre-admission, `(workspaceId, commandId)` receipt/idempotency boundary, semantic fingerprinting, immutable replay semantics, and dispatcher as the other lifecycle commands. Agent bootstrap admission mirrors canonical bounds for display name and unique namespaced capabilities.
- Protocol pre-admission rejects malformed protocol version/discriminator, entity/actor references, revisions/fencing, canonical Reason/EvidenceRef/ResourceRef shapes, permission bounds, and bootstrap capability shapes before successful mutation or receipt insertion. Unknown Workspace returns a bounded protocol `NOT_FOUND` envelope.
- Controller-only lifecycle commands `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal` admit human/system actors and reject agent actors. `RecordPermissionDecision` is human-only and accepts only `ALLOW` or `DENY`.
- Implemented protocol mutations use `(workspaceId, commandId)` as the idempotency identity. Correlation/causation tracing fields do not alter semantic fingerprints; exact replay returns an immutable stored terminal snapshot; reuse of a command ID for different semantic intent returns `IDEMPOTENCY_CONFLICT`.
- The deterministic default permission policy is `PolicyRef { id: "mindrail.permission", version: "0.1.0" }`. Demonstration rules are `workspace.read -> ALLOW`, `external.publish -> DENY`, and `repository.write -> HUMAN_REQUIRED`; unmatched permissions fail closed to `DENY`.
- `RequestPermission` requires current Task/Session/Lease/fencing authority and creates a canonical PermissionRequest plus sequence-1 policy decision. Human follow-up requires the latest predecessor decision and a current `HUMAN_REQUIRED`; it derives sequence/supersession and cannot revive stale execution authority. MindRail permission decisions do not mint credentials or override host/IAM/sandbox/tool approval.
- A Cloudflare-oriented persistence adapter exists under `src/persistence/cloudflare/` together with a Workspace coordinator boundary. Executed persistence regressions prove command-receipt uniqueness by `(workspaceId, commandId)`, immutable terminal replay storage, stale permission-decision-head rejection, and that independent coordinators sharing the same durable test database cannot both acquire the same Task execution authority.
- Persistence receipt parity now covers Agent creation, Session creation, Checkpoint append, human PermissionDecision append, and the existing Goal/Task/claim/permission/completion mutation paths. State mutation and its command receipt are committed atomically on those paths.
- `ClaimTask` uses a deferred receipt snapshot so the returned/stored result is built only after the persistence layer allocates the authoritative fencing token. Executed regression coverage proves a replay returns the persisted Lease/fence rather than a speculative runtime token.
- `InMemoryControlPlane.rehydrate()` restores canonical Workspace/Goal/Task/Agent/Session/Lease/checkpoint/permission state plus durable per-Task fencing counters from a persistence snapshot. Rehydration validates record relationships, reconstructs effective Lease authority from canonical records and authoritative time, and fails closed on inconsistent state.
- `createDurableApplicationDispatcher(...)` composes the canonical runtime semantics with `DurableRuntimePersistence`. Each supported command loads authoritative durable state, rehydrates an ephemeral runtime, executes the existing semantics, and commits through explicit persistence methods. The dispatcher does not retain an in-memory fallback between requests.
- The first durable command loop is executable for `RegisterAgent`, `StartSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`.
- Durable command replay first reads the persisted `(workspaceId, commandId)` receipt. Exact retries survive application/database-handle replacement, return `replayed: true`, preserve the immutable stored result/error snapshot, and reflect the current correlation id. Semantic command-id drift fails with `IDEMPOTENCY_CONFLICT`.
- Explicit durable read ports and application queries are implemented for `GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListTaskCheckpoints`, `ListPendingHumanPermissions`, `ListPermissionDecisions`, and advisory `ListClaimableTasks`. List queries use bounded deterministic cursor paging; work acquisition still revalidates authority atomically at `ClaimTask`.
- HTTP and MCP adapters exist over the common application/protocol boundary. They preserve canonical error codes/idempotency envelopes, fail closed on authorization errors, enforce bounded structural admission, and do not expose generic shell/filesystem/browser/action authority tools.
- The in-memory application dispatcher delegates all ADR-0005 v0.1 commands to the canonical runtime. A deterministic HTTP/application E2E covers the complete local bootstrap/execution/permission/completion path.
- Durable HTTP E2E coverage runs the real HTTP adapter over the durable dispatcher and SQLite D1-like persistence file. It verifies: continuation of the same Lease/fence after closing and reopening the application/database handle; persistence of `HUMAN_REQUIRED` plus human decision history across restart; response-loss replay through a fresh dispatcher; and competing independent application instances preserving one effective Lease and advancing fencing from 1 to 2 after expiry/recovery.
- Durable query Task 4 integration run `33274741762` passed focused query/persistence tests, full `pnpm check`, and coverage after temporary harness cleanup.
- Permanent `Quality` run `33274903333` on the durable HTTP E2E tree passed formatting, lint, strict TypeScript, generated-contract drift checks, **29/29 test files and 123/123 tests**, and coverage. Reported overall coverage was 85.3% statements, 73.3% branches, 96.15% functions, and 86.95% lines.
- Runtime Surface PR #20 merged with post-merge Quality PASS. Persistence PR #24 merged with post-merge Quality #248 PASS. HTTP/MCP Transport PR #25 merged at `e142c1399aed5de3d8df53ad876499583728a6b4`; permanent Quality #249 and post-merge Quality #250 both passed full quality and coverage gates.
- Permanent `Quality` CI remains least-privilege and uses pinned GitHub-owned action commits.

## Implemented but not yet fully deployed / externally integrated

- The durable application composition is verified locally against the SQLite D1-like harness used by persistence tests. This is executable restart/concurrency evidence for the application/persistence contract, but it is **not** evidence of a deployed Cloudflare Worker, Durable Object, or production D1 environment.
- The durable dispatcher currently supports only the first command loop listed above. `HeartbeatSession`, `EndSession`, `RenewLease`, `ReleaseLease`, `FailTask`, `BlockTask`, `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal` remain implemented in canonical runtime semantics but are explicitly unsupported by the durable dispatcher until their atomic persistence mutations are added.
- Durable queries `ListGoals`, `ListGoalTasks`, and `GetTaskExecutionView` remain explicitly unsupported rather than inferred from retained application state.
- No deployed Cloudflare Worker/Durable Object service is claimed. Deployment configuration, environment provisioning, deployed-runtime restart verification, and real Cloudflare concurrency verification remain outstanding.
- The v0.1 permission policy is intentionally small, explicit, hard-coded, and versioned. It is not a policy DSL, IAM system, credential manager, model judge, or arbitrary-code policy runtime.
- `Quality` is executable on pull requests and `main`, but issue #3 still tracks repository-level enforcement as a required merge gate.

## Next implementation slices

- Complete durable persistence mutations for the remaining v0.1 lifecycle/cancellation commands without introducing a second state machine or generic CRUD authority.
- Add the remaining bounded durable queries only where required by agent/human workflows.
- Add GitHub integration while keeping GitHub as an adapter/projection rather than canonical state authority.
- Add minimal real Codex, ChatGPT-compatible, generic MCP, and generic HTTP agent bootstrap/worker paths on top of the stable protocol/application boundary.
- Deploy and verify the Cloudflare reference composition, including real Durable Object coordination and D1 restart/concurrency behavior, before making production-runtime claims.
- Add optional human-facing projections only after the durable control-plane composition is stable.

## External / non-technical follow-up

- MindRail-specific BUSL-1.1 parameters, Change License compatibility, licensor identity, and future contribution/dual-licensing mechanics have not received professional legal review. The repository must not imply otherwise.
- External code-contribution licensing mechanics are not finalized; see `CONTRIBUTING.md`.

## Explicit non-capabilities

MindRail does **not yet** provide a production-ready or fully unattended control plane. It does not yet expose a verified deployed Cloudflare durable HTTP/MCP service, integrate with real Codex/ChatGPT sessions, or guarantee continuation of a real external agent across host/platform termination. The current executable milestone is a canonical runtime plus a locally verified durable application/persistence composition with HTTP restart, receipt-replay, permission-history, competing-claim, and fencing-recovery evidence against the SQLite D1-like test environment.
