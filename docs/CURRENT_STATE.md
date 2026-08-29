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
- The Cloudflare reference persistence mapping is documented under `docs/architecture/02_CLOUDFLARE_RUNTIME_PERSISTENCE.md`; it is a design, not a deployed persistence implementation.
- A deterministic **in-memory local reference runtime vertical slice** exists under `src/runtime/` and consumes the canonical contracts package rather than redefining domain records.
- The runtime requires a `CanonicalDomainValidator` admission seam. Workspace, Agent, Session, Goal, Task, Lease, and Checkpoint records are validated before authoritative insertion; external `Reason` values used by fail/block/cancel transitions are validated before state mutation. Reference tests wire this seam to the actual strict Draft 2020-12 schemas through the repository's existing dev-only Ajv tooling, so no third-party runtime dependency was added.
- The local runtime currently supports direct Workspace bootstrap plus Agent registration, Session start/heartbeat/end, Goal/Task creation, Task claim/release/recovery, Lease renewal, Checkpoints, Task completion/failure/block/resume/retry/cancellation, Goal cancellation, dependency release, and automatic Goal success when all Tasks succeed.
- Session authority has an explicit configurable `sessionTimeoutMs` policy using authoritative server time and the ADR-0004 half-open boundary. A heartbeat is accepted only for an effectively active Session and updates Session liveness without renewing any Lease. Ending a Session immediately revokes its active Leases while leaving running Tasks recoverable. A stale Session is materialized as `expired`; its active Leases are revoked and cease to authorize checkpoint/completion or new claims. Ended or expired Sessions cannot be revived by heartbeat.
- Lease authority is separated from Task state. A running Task may temporarily have no effective Lease and may be recovered by a new Session. Lease renewal requires the current Session/Task/Lease/fencing authority plus the current Lease revision, extends expiry from authoritative server policy, increments the Lease revision, and preserves the fencing token.
- Same-Session duplicate claim returns the current Lease without minting a new fencing token even when a semantic duplicate still carries the pre-claim Task revision. Recovery after Lease release/expiry/session loss grants a strictly higher per-Task fencing token. Rejected Lease admission does not advance the fencing counter. Stale/revoked/replaced Lease authority cannot renew, checkpoint, or complete work.
- `BlockTask` requires current executor authority and Task revision, validates its bounded canonical `Reason`, appends a `blocked` Checkpoint, transitions the Task to `blocked`, stores `statusReason`, and releases execution authority so the stale executor fails closed afterward.
- `ResumeTask` is controller-only, requires the current blocked Task revision and no effective Lease, clears `statusReason`, and returns the Task to `ready` when dependencies are satisfied or `pending` otherwise. It never mints a Lease.
- Capability requirements are checked at claim time, mutable operations use expected revisions where defined by the slice, and Task creation is rejected under a terminal Goal.
- The implemented protocol dispatcher covers `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `RecordCheckpoint`, `CompleteTask`, `FailTask`, `BlockTask`, `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal`.
- Protocol commands pass structural pre-admission validation before workspace admission, semantic fingerprinting, dispatch, or receipt insertion. Invalid protocol version/discriminator, malformed EntityIds/ActorRef, malformed command shapes, and invalid revision/fencing fields return `INVALID_INPUT` without mutation or idempotency-key reservation. Unknown Workspace returns a protocol `NOT_FOUND` error envelope rather than escaping as an exception and is likewise not admitted as a receipt.
- Controller-only protocol commands `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal` admit human/system actors and reject agent actors with `ACTOR_NOT_AUTHORIZED` before mutation.
- Implemented protocol mutations use `(workspaceId, commandId)` as the in-memory idempotency key. Semantic fingerprints exclude `correlationId` and `causationId`; exact replay returns an immutable stored result/error snapshot while reflecting the current retry's correlation id; command-id reuse with different semantic intent returns `IDEMPOTENCY_CONFLICT`.
- `CancelTask` revokes its effective Lease when present. `CancelGoal` terminalizes the Goal, cancels its nonterminal Tasks, and revokes their effective Leases; stale completion is rejected afterward.
- Root runtime code explicitly links to `@mindrail/contracts` with `workspace:*`; the frozen pnpm lockfile resolves it as the local workspace package.
- GitHub Actions full-verification run `33254737970` on commit `57491f9b153a8163b927b0a811edabe4083068cb` passed frozen installation, Prettier, ESLint, strict TypeScript checks, generated-contract drift detection, the complete Vitest suite, `pnpm check`, and `pnpm test:coverage`.
- Canonical-admission GREEN run `33256111682` executed the focused schema-admission regressions, full `pnpm check`, and `pnpm test:coverage`. It reported **9/9 test files and 26/26 tests passing**. V8 reported 90.22% statements, 72.63% branches, 98.33% functions, and 90.17% lines overall; `src/runtime` reported 89.22% statements and 89.16% lines. No repository-wide coverage threshold is claimed.
- Pre-admission/session hardening run `33256869136` passed the focused review regressions, full `pnpm check`, and `pnpm test:coverage` before committing the fix and deleting its one-time workflow.
- Permanent `Quality` CI remains read-only (`contents: read`) and uses pinned GitHub-owned action commits.

## Implemented but not yet durable / externally integrated

- Local runtime correctness is currently in-memory and single-process. It proves state-machine and protocol semantics but does not survive process restart.
- Command receipts, Lease counters, Tasks, Goals, Checkpoints, Sessions, and other runtime state are not persisted yet.
- The canonical validator is an injected core boundary; the current executable reference composition proving it against the real schemas lives in test tooling. Production/deployed composition still needs to provide the same canonical validation boundary.
- Session heartbeat/end and Lease renewal are available only through the transport-neutral in-memory runtime surface; no deployed client transport invokes them yet.
- Goal-level ordering is deterministic inside the synchronous local runtime. The future D1/Durable Objects reference implementation must independently prove the concurrency guarantees from ADR-0004 and the persistence design.
- `Quality` is executable and green on verified branches, but issue #3 still tracks enabling the repository-level required merge gate on `main`.

## Next implementation slices

- Complete the remaining protocol/runtime command surface needed for v0.1, including permission commands.
- Implement deterministic permission-policy evaluation and human decision handling.
- Add a persistence interface and durable local/reference storage implementation with command receipts, audit events, revision/fencing guards, canonical admission, and restart recovery.
- Implement the Cloudflare Workers/Durable Objects/D1 reference deployment behind the vendor-neutral runtime interfaces.
- Add transport adapters for HTTP and MCP without changing core lifecycle semantics.
- Add GitHub integration and minimal Codex/ChatGPT/generic agent bootstrap paths.
- Add optional human-facing projections only after runtime state is durable.

## External / non-technical follow-up

- MindRail-specific BUSL-1.1 parameters, Change License compatibility, licensor identity, and future contribution/dual-licensing mechanics have not received professional legal review. The repository must not imply otherwise.
- External code-contribution licensing mechanics are not finalized; see `CONTRIBUTING.md`.

## Explicit non-capabilities

MindRail does **not yet** provide a production control plane. It does not persist operational state, expose a deployed HTTP/MCP service, issue runtime permissions, run the Cloudflare reference deployment, integrate with real Codex/ChatGPT sessions, or continue agents unattended across process/runtime termination. The current executable milestone is a verified deterministic in-memory control-plane slice.
