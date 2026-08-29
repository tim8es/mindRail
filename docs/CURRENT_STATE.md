# Current State

**Last reconciled:** 2026-08-29

This document describes what exists, not what is intended. Roadmap items are never evidence of implementation.

## Implemented and verified

The following facts are supported by repository state and executed GitHub Actions evidence:

- Repository `tim8es/mindRail` is public with `main` as the default branch.
- Development foundation and Domain Contracts are merged into `main`.
- ADR-0001 through ADR-0005 are accepted: system boundaries, licensing, domain/schema authority, runtime lifecycle/concurrency, and control-plane protocol v0.1.
- JSON Schema Draft 2020-12 under `schemas/domain/v1/` is canonical for `Workspace`, `Goal`, `Task`, `Agent`, `Session`, `Lease`, `Checkpoint`, `PermissionRequest`, `PermissionDecision`, `AuditEvent`, and shared definitions.
- `@mindrail/contracts` provides deterministic generated TypeScript bindings. Generated drift, strict schema validation, fixtures, schema invariants, formatting, lint, and TypeScript checks are part of the repository quality gate.
- The Cloudflare reference persistence mapping is documented under `docs/architecture/02_CLOUDFLARE_RUNTIME_PERSISTENCE.md`; it is a design, not yet the deployed persistence implementation.
- A deterministic **in-memory local reference runtime** exists under `src/runtime/` and consumes canonical contract types rather than redefining persistent records.
- The runtime requires a `CanonicalDomainValidator` admission seam. Workspace, Agent, Session, Goal, Task, Lease, Checkpoint, PermissionRequest, and PermissionDecision records are validated against canonical constraints before authoritative insertion; external `Reason` values used by fail/block/cancel transitions are validated before state mutation. Reference tests wire the seam to the actual strict Draft 2020-12 schemas through existing dev-only Ajv tooling.
- The local runtime supports direct Workspace bootstrap plus Agent registration, Session start/heartbeat/end, Goal/Task creation, Task claim/release/recovery, Lease renewal, Checkpoints, Task completion/failure/block/resume/retry/cancellation, Goal cancellation, dependency release, and automatic Goal success when all Tasks succeed.
- Session authority has an explicit configurable `sessionTimeoutMs` policy using authoritative server time and the ADR-0004 half-open boundary. Heartbeat updates Session liveness without renewing a Lease. Ending or expiring a Session removes its Lease authority while leaving running Tasks recoverable.
- Lease authority is separated from Task state. A running Task may temporarily have no effective Lease and may be recovered by a new Session. Lease renewal requires current Session/Task/Lease/fencing authority plus the current Lease revision, extends expiry from authoritative server policy, increments Lease revision, and preserves the fencing token.
- Same-Session duplicate claim returns the current Lease without minting a new fencing token even when the duplicate carries the pre-claim Task revision. Recovery after release/expiry/session loss grants a strictly higher per-Task fence. Rejected Lease admission does not advance the fencing counter. Stale/revoked/replaced Lease authority cannot renew, checkpoint, complete, or create a permission request.
- `ReleaseLease` is available through the transport-neutral protocol surface and leaves a running Task recoverable. `BlockTask` removes execution authority and records a canonical blocked checkpoint. `ResumeTask` is controller-only, clears the blocked reason, returns to `ready` or `pending` according to dependencies, and never mints a Lease.
- The implemented protocol dispatcher covers `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `CompleteTask`, `FailTask`, `BlockTask`, `ResumeTask`, `RequestPermission`, `RecordPermissionDecision`, `RetryTask`, `CancelTask`, and `CancelGoal`.
- Protocol commands pass structural pre-admission before workspace admission, semantic fingerprinting, dispatch, or receipt insertion. Malformed protocol version/discriminator, EntityIds/ActorRef, command shapes, revisions, and fencing fields return `INVALID_INPUT` without mutation or receipt reservation. Unknown Workspace returns a bounded protocol `NOT_FOUND` envelope.
- Controller-only lifecycle commands `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal` admit human/system actors and reject agent actors with `ACTOR_NOT_AUTHORIZED`. Permission follow-up is stricter: `RecordPermissionDecision` is human-only and accepts only `ALLOW` or `DENY`.
- Implemented protocol mutations use `(workspaceId, commandId)` as the in-memory idempotency key. Semantic fingerprints exclude `correlationId` and `causationId`; exact replay returns the immutable stored result/error snapshot while reflecting the current retry correlation id; command-id reuse with different semantic intent returns `IDEMPOTENCY_CONFLICT`.
- The deterministic default permission policy is `PolicyRef { id: "mindrail.permission", version: "0.1.0" }`. Demonstration rules are `workspace.read -> ALLOW`, `external.publish -> DENY`, and `repository.write -> HUMAN_REQUIRED`; unmatched permissions fail closed to `DENY`. Policy exceptions or structurally invalid policy state return `POLICY_UNAVAILABLE` and append no permission records.
- `RequestPermission` requires current Task/Session/Lease/fencing authority, then appends a canonical PermissionRequest and sequence-1 policy PermissionDecision at one in-memory semantic boundary. Policy decisions are system-authored and carry the exact PolicyRef. `HUMAN_REQUIRED` grants nothing.
- Human permission follow-up requires the expected latest decision ID and a current `HUMAN_REQUIRED`, derives basis/sequence/supersession, and rejects stale predecessors, cross-workspace references, non-human actors, or repeated follow-up after a terminal human decision.
- A MindRail `ALLOW` is effective only for the exact PermissionRequest while its original Task/Session/Lease/fencing authority remains current. A late human decision may complete audit history after authority loss but cannot revive the old Lease or transfer the grant to replacement execution authority. MindRail permission decisions do not mint credentials or override host/IAM/sandbox/tool approval.
- Runtime Surface PR #20 was merged to `main` as `b6bdfb039fe3f6215271ea689163789e3c1f1444`; post-merge Quality run `33261724707` passed.
- Permission integration run `33261956633` reconciled the Permission Engine with the merged Runtime Surface, passed focused runtime/permission tests, full `pnpm check` with **14/14 test files and 55/55 tests**, and `pnpm test:coverage`. V8 reported 85.75% statements, 70.64% branches, 95.49% functions, and 86.11% lines overall; `src/policy` reported 100% and `src/runtime/in-memory-control-plane.ts` reported 91.45% statements / 91.42% lines. No repository-wide coverage threshold is claimed.
- Permanent `Quality` CI remains least-privilege and uses pinned GitHub-owned action commits.

## Implemented but not yet durable / externally integrated

- Runtime and permission correctness are currently in-memory and single-process. Tasks, Sessions, Leases, fencing counters, checkpoints, permission records, and command receipts do not yet survive process restart.
- The canonical validator is an injected core boundary; deployed/reference production composition still needs to wire the same canonical validation authority.
- Goal-level ordering is deterministic inside the synchronous local runtime. The D1/Durable Objects reference implementation must independently prove the corresponding concurrency guarantees.
- The v0.1 permission policy is intentionally small, explicit, hard-coded, and versioned. It is not a policy DSL, IAM system, credential manager, model judge, or arbitrary-code policy runtime.
- Runtime/protocol operations are not yet exposed by a merged HTTP/MCP transport implementation.
- `Quality` is executable on branches and `main`, but issue #3 still tracks repository-level enforcement as a required merge gate.

## Next implementation slices

- Integrate and harden the persistence boundary: durable records, command receipts, revision/fencing guards, audit append semantics, restart recovery, and the D1/Workspace Durable Object reference adapter.
- Integrate HTTP and MCP adapters over one application/protocol surface without moving lifecycle or permission authority into transports.
- Add a full integrated E2E path proving Session heartbeat → claim → renew/release → checkpoint/block/resume → permission request/decision → completion across the common application boundary and durable restart path.
- Add GitHub integration and minimal Codex/ChatGPT/generic-agent bootstrap paths only after the durable application boundary is stable.
- Add optional human-facing projections only after runtime state is durable.

## External / non-technical follow-up

- MindRail-specific BUSL-1.1 parameters, Change License compatibility, licensor identity, and future contribution/dual-licensing mechanics have not received professional legal review. The repository must not imply otherwise.
- External code-contribution licensing mechanics are not finalized; see `CONTRIBUTING.md`.

## Explicit non-capabilities

MindRail does **not yet** provide a production control plane. It does not yet persist operational state in the reference deployment, expose a merged/deployed HTTP/MCP service, run the Cloudflare reference runtime, integrate with real Codex/ChatGPT sessions, or continue agents unattended across process/runtime termination. The current executable milestone is a verified deterministic in-memory lifecycle + permission control plane awaiting durable persistence and transports.
