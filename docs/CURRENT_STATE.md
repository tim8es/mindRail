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
- The runtime requires a `CanonicalDomainValidator` admission seam. Workspace, Agent, Session, Goal, Task, Lease, Checkpoint, PermissionRequest, and PermissionDecision records are validated before authoritative insertion; external `Reason` values used by fail/cancel transitions are validated before state mutation. Reference tests wire this seam to the actual strict Draft 2020-12 schemas through the repository's existing dev-only Ajv tooling, so no third-party runtime dependency was added.
- The local runtime currently supports direct Workspace bootstrap plus Agent registration, Session start, Goal/Task creation, Task claim/release/recovery, Checkpoints, Task completion/failure/retry/cancellation, Goal cancellation, dependency release, automatic Goal success when all Tasks succeed, deterministic permission requests, and human permission follow-up decisions.
- Session authority now has an explicit configurable `sessionTimeoutMs` policy using authoritative server time and the ADR-0004 half-open boundary. A stale Session is materialized as `expired`; its active Leases are revoked and cease to authorize checkpoint/completion or new claims. Durable running Task state remains recoverable by a replacement Session with a higher fence.
- Lease authority is separated from Task state. A running Task may temporarily have no effective Lease and may be recovered by a new Session.
- Same-Session duplicate claim returns the current Lease without minting a new fencing token even when a semantic duplicate still carries the pre-claim Task revision. Recovery after Lease release/expiry/session loss grants a strictly higher per-Task fencing token. Rejected Lease admission does not advance the fencing counter. Stale/revoked Lease authority cannot checkpoint, complete work, or create permission requests.
- Capability requirements are checked at claim time, mutable operations use expected revisions where defined by the slice, and Task creation is rejected under a terminal Goal.
- The implemented protocol dispatcher covers `CreateGoal`, `CreateTask`, `ClaimTask`, `RecordCheckpoint`, `CompleteTask`, `FailTask`, `RequestPermission`, `RecordPermissionDecision`, `RetryTask`, `CancelTask`, and `CancelGoal`.
- Protocol commands pass structural pre-admission validation before workspace admission, semantic fingerprinting, dispatch, or receipt insertion. Invalid protocol version/discriminator, malformed EntityIds/ActorRef, malformed command shapes, and invalid revision/fencing fields return `INVALID_INPUT` without mutation or idempotency-key reservation. Unknown Workspace returns a protocol `NOT_FOUND` error envelope rather than escaping as an exception and is likewise not admitted as a receipt.
- Controller-only protocol commands `RetryTask`, `CancelTask`, and `CancelGoal` admit human/system actors and reject agent actors with `ACTOR_NOT_AUTHORIZED` before mutation. `RecordPermissionDecision` is stricter: only a human actor may append a follow-up and the only public follow-up outcomes are `ALLOW` or `DENY`.
- Implemented protocol mutations use `(workspaceId, commandId)` as the in-memory idempotency key. Semantic fingerprints exclude `correlationId` and `causationId`; exact replay returns an immutable stored result/error snapshot while reflecting the current retry's correlation id; command-id reuse with different semantic intent returns `IDEMPOTENCY_CONFLICT`. Exact `RequestPermission` replay therefore returns the original PermissionRequest/PermissionDecision IDs without duplicate records.
- The default deterministic permission policy is `PolicyRef { id: "mindrail.permission", version: "0.1.0" }`. Its explicit v0.1 demonstration rules are `workspace.read -> ALLOW`, `external.publish -> DENY`, and `repository.write -> HUMAN_REQUIRED`; unmatched permissions fail closed to `DENY` with `policy.no_matching_rule`. Policy exceptions or structurally invalid policy state return `POLICY_UNAVAILABLE` and append no permission records.
- Policy decisions are sequence 1, system-authored by `system:mindrail.permission-policy`, carry the exact PolicyRef, and never supersede a predecessor. `HUMAN_REQUIRED` grants nothing. Human follow-up requires the expected latest decision ID and a latest `HUMAN_REQUIRED`, derives basis/sequence/supersession, and rejects stale predecessors, cross-workspace request references, non-human actors, or repeated follow-up after a terminal human decision.
- A MindRail `ALLOW` is effective only for the exact PermissionRequest while its original Task/Session/Lease/fencing authority remains current. A late human decision may complete audit history after authority loss, but it cannot revive the old Lease or transfer the grant to replacement execution authority. The permission engine does not mint credentials or override host, IAM, sandbox, or tool approval.
- `CancelTask` revokes its effective Lease when present. `CancelGoal` terminalizes the Goal, cancels its nonterminal Tasks, and revokes their effective Leases; stale completion is rejected afterward.
- Root runtime code explicitly links to `@mindrail/contracts` with `workspace:*`; the frozen pnpm lockfile resolves it as the local workspace package.
- GitHub Actions full-verification run `33254737970` on commit `57491f9b153a8163b927b0a811edabe4083068cb` passed frozen installation, Prettier, ESLint, strict TypeScript checks, generated-contract drift detection, the complete Vitest suite, `pnpm check`, and `pnpm test:coverage`.
- Canonical-admission GREEN run `33256111682` executed the focused schema-admission regressions, full `pnpm check`, and `pnpm test:coverage`. It reported **9/9 test files and 26/26 tests passing**. V8 reported 90.22% statements, 72.63% branches, 98.33% functions, and 90.17% lines overall; `src/runtime` reported 89.22% statements and 89.16% lines. No repository-wide coverage threshold is claimed.
- Pre-admission/session hardening run `33256869136` passed the focused review regressions, full `pnpm check`, and `pnpm test:coverage` before committing the fix and deleting its one-time workflow.
- Permanent `Quality` CI remains read-only (`contents: read`) and uses pinned GitHub-owned action commits.

## Implemented but not yet durable / externally integrated

- Local runtime correctness is currently in-memory and single-process. It proves state-machine and protocol semantics but does not survive process restart.
- Command receipts, Lease counters, Tasks, Goals, Checkpoints, Sessions, PermissionRequests, PermissionDecisions, and other runtime state are not persisted yet.
- The canonical validator is an injected core boundary; the current executable reference composition proving it against the real schemas lives in test tooling. Production/deployed composition still needs to provide the same canonical validation boundary.
- Session timeout is enforced, but public `HeartbeatSession` and `EndSession` commands are not implemented yet; without heartbeat support, a long-lived real client cannot extend Session liveness through the protocol.
- The v0.1 permission policy is intentionally hard-coded and versioned. It is not a policy DSL, IAM system, credential manager, model judge, or arbitrary-code policy runtime.
- Goal-level ordering is deterministic inside the synchronous local runtime. The future D1/Durable Objects reference implementation must independently prove the concurrency guarantees from ADR-0004 and the persistence design.
- `Quality` is executable and green on verified branches, but issue #3 still tracks enabling the repository-level required merge gate on `main`.

## Next implementation slices

- Complete the remaining protocol/runtime command surface needed for v0.1, including Session heartbeat/end, Lease renewal, and block/resume.
- Add a persistence interface and durable local/reference storage implementation with command receipts, audit events, revision/fencing guards, canonical admission, and restart recovery.
- Implement the Cloudflare Workers/Durable Objects/D1 reference deployment behind the vendor-neutral runtime interfaces.
- Add transport adapters for HTTP and MCP without changing core lifecycle or permission semantics.
- Add GitHub integration and minimal Codex/ChatGPT/generic agent bootstrap paths.
- Add optional human-facing projections only after runtime state is durable.

## External / non-technical follow-up

- MindRail-specific BUSL-1.1 parameters, Change License compatibility, licensor identity, and future contribution/dual-licensing mechanics have not received professional legal review. The repository must not imply otherwise.
- External code-contribution licensing mechanics are not finalized; see `CONTRIBUTING.md`.

## Explicit non-capabilities

MindRail does **not yet** provide a production control plane. It does not persist operational state, expose a deployed HTTP/MCP service, issue credentials or external host/IAM authority, run the Cloudflare reference deployment, integrate with real Codex/ChatGPT sessions, or continue agents unattended across process/runtime termination. The current executable milestone is a deterministic in-memory control-plane slice.
