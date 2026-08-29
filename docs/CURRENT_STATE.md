# Current State

**Last reconciled:** 2026-08-29

This document describes what exists, not what is intended. Roadmap items are never evidence of implementation.

## Implemented and verified

The following facts are supported by repository state and executed GitHub Actions evidence:

- Repository `tim8es/mindRail` is public with `main` as the default branch.
- Development foundation, Domain Contracts, ADR-0001 through ADR-0005, Runtime Surface, Permission Engine, the reference persistence adapter, and HTTP/MCP transport adapters have executable verification evidence.
- JSON Schema Draft 2020-12 under `schemas/domain/v1/` is canonical for `Workspace`, `Goal`, `Task`, `Agent`, `Session`, `Lease`, `Checkpoint`, `PermissionRequest`, `PermissionDecision`, `AuditEvent`, and shared value objects. `@mindrail/contracts` provides deterministic generated TypeScript bindings and generated-drift checks.
- The deterministic local reference runtime under `src/runtime/` consumes canonical contract types and validates authoritative domain records through the injected `CanonicalDomainValidator` seam before insertion/mutation.
- The runtime supports Agent registration; Session start, heartbeat, timeout expiry, and end; Goal/Task creation; Task claim/release/recovery; Lease renewal; checkpoints; completion/failure/block/resume/retry/cancellation; Goal cancellation; dependency release; and automatic Goal success.
- `Agent`, `Session`, `Task`, and `Lease` remain distinct authorities. Session liveness does not renew a Lease. A running Task may temporarily have no effective Lease and may be recovered by a new Session.
- Lease authority uses monotonic per-Task fencing. Same-Session semantic duplicate claim returns the current Lease without minting a new fence; recovery after release/expiry/session loss grants a strictly higher fence. Stale/revoked/replaced authority cannot renew, checkpoint, complete, or request permission.
- The canonical transport-neutral command surface now includes every ADR-0005 v0.1 command: `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `CompleteTask`, `FailTask`, `BlockTask`, `ResumeTask`, `RetryTask`, `CancelTask`, `CancelGoal`, `RequestPermission`, and `RecordPermissionDecision`.
- `RegisterAgent` and `StartSession` pass through the same protocol pre-admission, `(workspaceId, commandId)` receipt/idempotency boundary, semantic fingerprinting, immutable replay semantics, and dispatcher as the other lifecycle commands. Agent bootstrap admission mirrors canonical bounds for display name and unique namespaced capabilities.
- Protocol pre-admission rejects malformed protocol version/discriminator, entity/actor references, revisions/fencing, canonical Reason/EvidenceRef/ResourceRef shapes, permission bounds, and bootstrap capability shapes before successful mutation or receipt insertion. Unknown Workspace returns a bounded protocol `NOT_FOUND` envelope.
- Controller-only lifecycle commands `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal` admit human/system actors and reject agent actors. `RecordPermissionDecision` is human-only and accepts only `ALLOW` or `DENY`.
- Implemented protocol mutations use `(workspaceId, commandId)` as the idempotency identity. Correlation/causation tracing fields do not alter semantic fingerprints; exact replay returns an immutable stored terminal snapshot; reuse of a command ID for different semantic intent returns `IDEMPOTENCY_CONFLICT`.
- The deterministic default permission policy is `PolicyRef { id: "mindrail.permission", version: "0.1.0" }`. Demonstration rules are `workspace.read -> ALLOW`, `external.publish -> DENY`, and `repository.write -> HUMAN_REQUIRED`; unmatched permissions fail closed to `DENY`.
- `RequestPermission` requires current Task/Session/Lease/fencing authority and creates a canonical PermissionRequest plus sequence-1 policy decision. Human follow-up requires the latest predecessor decision and a current `HUMAN_REQUIRED`; it derives sequence/supersession and cannot revive stale execution authority. MindRail permission decisions do not mint credentials or override host/IAM/sandbox/tool approval.
- A Cloudflare-oriented persistence adapter exists under `src/persistence/cloudflare/` together with a Workspace coordinator boundary. Executed persistence regressions prove command-receipt uniqueness by `(workspaceId, commandId)`, immutable terminal replay storage, stale permission-decision-head rejection, and that two independent coordinators sharing the same durable test database cannot both acquire the same Task execution authority.
- The persistence implementation keeps Cloudflare-specific types outside canonical domain/protocol types. Its verified adapter semantics are not evidence that a deployed Durable Object + D1 application composition already exists.
- HTTP and MCP adapters exist over the common application/protocol boundary. They preserve canonical error codes/idempotency envelopes, fail closed on authorization errors, enforce bounded structural admission, and do not expose generic shell/filesystem/browser/action authority tools.
- The in-memory application dispatcher delegates all ADR-0005 v0.1 commands to the canonical runtime. A bounded query subset is implemented (`GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `ListTaskCheckpoints`); the remaining query names are explicitly reported as unsupported rather than guessed.
- A deterministic HTTP/application E2E test exercises `RegisterAgent -> StartSession -> CreateGoal -> CreateTask -> ClaimTask -> RecordCheckpoint -> RequestPermission(repository.write) -> RecordPermissionDecision(ALLOW) -> CompleteTask`, then verifies final Task success, released Lease, automatic Goal success, and checkpoint history using HTTP queries only.
- Runtime Surface PR #20 merged with post-merge Quality PASS. Persistence PR #24 merged with post-merge Quality #248 PASS. HTTP/MCP Transport PR #25 merged at `e142c1399aed5de3d8df53ad876499583728a6b4`; permanent Quality #249 and post-merge Quality #250 both passed full quality and coverage gates.
- Bootstrap protocol TDD captured an expected RED before implementation, then integration run `33268117966` passed focused bootstrap/transport tests and full `pnpm check` on the cleaned Task-1 tree. HTTP E2E probe `33268217457` passed without requiring an additional production change.
- Permanent `Quality` CI remains least-privilege and uses pinned GitHub-owned action commits.

## Implemented but not yet fully composed / externally integrated

- The local HTTP/application E2E is in-memory. It proves the common command/permission/transport lifecycle, but not restart durability.
- The D1/Workspace-coordinator persistence adapter is implemented and tested separately; it is not yet wired as the authoritative persistence backend beneath the merged HTTP/MCP application dispatcher.
- No deployed Cloudflare Worker/Durable Object service is claimed. Deployment configuration, environment provisioning, and deployed-runtime restart verification remain outstanding.
- Several application queries are still explicitly unsupported in the in-memory dispatcher: `ListGoals`, `ListGoalTasks`, `ListClaimableTasks`, `GetTaskExecutionView`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListPendingHumanPermissions`, and `ListPermissionDecisions`.
- The v0.1 permission policy is intentionally small, explicit, hard-coded, and versioned. It is not a policy DSL, IAM system, credential manager, model judge, or arbitrary-code policy runtime.
- `Quality` is executable on pull requests and `main`, but issue #3 still tracks repository-level enforcement as a required merge gate.

## Next implementation slices

- Compose the verified persistence adapter with the application/runtime boundary and add restart/recovery E2E proving durable Goal/Task/Agent/Session/Lease/checkpoint/permission/receipt behavior under the same protocol semantics.
- Add the remaining bounded query implementations needed for agent work acquisition and human decision queues without introducing generic query/patch authority.
- Add GitHub integration while keeping GitHub as an adapter/projection rather than canonical state authority.
- Add minimal real Codex, ChatGPT-compatible, generic MCP, and generic HTTP agent bootstrap paths on top of the stable protocol/application boundary.
- Deploy and verify the Cloudflare reference composition only after durable application wiring is executable locally/testably.
- Add optional human-facing projections only after the durable control-plane composition is stable.

## External / non-technical follow-up

- MindRail-specific BUSL-1.1 parameters, Change License compatibility, licensor identity, and future contribution/dual-licensing mechanics have not received professional legal review. The repository must not imply otherwise.
- External code-contribution licensing mechanics are not finalized; see `CONTRIBUTING.md`.

## Explicit non-capabilities

MindRail does **not yet** provide a production-ready or fully unattended control plane. It does not yet expose a deployed durable HTTP/MCP service, run a verified Cloudflare reference deployment, integrate with real Codex/ChatGPT sessions, or guarantee continuation across process/runtime termination. The current executable milestone is a verified local lifecycle + permission + HTTP/MCP application path plus a separately verified durable persistence adapter awaiting composition, deployment, and real-agent integration.
