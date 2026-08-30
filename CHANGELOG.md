# Changelog

All notable changes to MindRail will be documented in this file.

The project is in `0.x` development and does not yet have a public product release.

## [Unreleased]

### Added

- Development-foundation design and implementation record.
- Authoritative project index, current-state discipline, system overview, and v0.1 roadmap.
- ADR process plus accepted system-boundary, licensing, v1 domain-contract/schema-authority, runtime/concurrency, and control-plane protocol v0.1 decisions.
- Contribution, security, engineering, agent-workflow, and review standards.
- Root Node.js 24 / pnpm / TypeScript / ESLint / Prettier / Vitest quality configuration.
- Least-privilege GitHub Actions quality workflow with external actions pinned by immutable commit SHA.
- Canonical JSON Schema Draft 2020-12 v1 contracts for Workspace, Goal, Task, Agent, Session, Lease, Checkpoint, PermissionRequest, PermissionDecision, and AuditEvent, plus shared value-object definitions.
- Deterministic generated TypeScript bindings under `packages/contracts/src/generated/v1/`, strict Ajv schema compilation, positive/negative fixtures, schema-invariant tests, and generated-output reproducibility/drift checks.
- Accepted Cloudflare D1 + Workspace Durable Object reference persistence design, kept outside canonical domain/protocol contracts.
- Deterministic in-memory control-plane runtime covering Agent registration; Session start/heartbeat/end/expiry; Goal/Task lifecycle; claim/release/recovery; Lease renewal; checkpoints; completion/failure/block/resume/retry; Task/Goal cancellation; dependency release; and automatic Goal success.
- Canonical ADR-0005 protocol execution for every v0.1 command, including `RegisterAgent` and `StartSession` through the same pre-admission/idempotency boundary as lifecycle and permission commands.
- Structural protocol pre-admission for protocol/envelope identity, ActorRef, revisions/fencing, canonical Reason/EvidenceRef/ResourceRef shapes, permission bounds, and Agent bootstrap capability constraints.
- In-memory `(workspaceId, commandId)` idempotency receipts with semantic fingerprinting, immutable terminal replay snapshots, tracing-field exclusion, and `IDEMPOTENCY_CONFLICT` handling.
- Deterministic permission engine with versioned policy decisions, `HUMAN_REQUIRED`, human-only follow-up, supersession sequencing, fail-closed policy evaluation, and grant effectiveness tied to current Task/Session/Lease/fencing authority.
- Cloudflare-oriented D1 persistence adapter and Workspace coordinator boundary with executable invariants for command receipt identity/replay, stale permission-decision heads, revision/fencing checks, and independent-coordinator claim serialization against one durable test database.
- Persistence receipt parity for Agent, Session, Checkpoint, human PermissionDecision, and the existing durable Goal/Task/claim/permission/completion mutation paths.
- Runtime canonical-state rehydration that restores persisted execution, checkpoint, permission, Session/Lease authority, and per-Task fencing counters without replaying commands.
- Durable application dispatcher that reloads authoritative persisted state for each supported command, reuses the canonical runtime semantics, and commits through explicit persistence methods without a retained in-memory fallback.
- Deferred `ClaimTask` receipt construction so the persisted/replayed response contains the fencing token allocated by the persistence transaction rather than a speculative runtime token.
- First durable command loop for `RegisterAgent`, `StartSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`.
- Explicit durable query ports and bounded query support for `GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListTaskCheckpoints`, `ListPendingHumanPermissions`, `ListPermissionDecisions`, and advisory `ListClaimableTasks`.
- Bounded HTTP and MCP adapters over one application/protocol surface, preserving protocol error/idempotency envelopes and avoiding generic shell/filesystem/browser/action authority tools.
- In-memory application dispatcher for all ADR-0005 commands plus bounded queries.
- HTTP/application end-to-end regression covering `RegisterAgent -> StartSession -> CreateGoal -> CreateTask -> ClaimTask -> RecordCheckpoint -> RequestPermission(repository.write) -> RecordPermissionDecision(ALLOW) -> CompleteTask`, followed by HTTP verification of final Task, Goal, Lease, and checkpoint state.
- Durable HTTP end-to-end regressions covering restart after claim, restart after `HUMAN_REQUIRED`, response-loss receipt replay after application replacement, competing independent application claims, and fencing advancement after Lease expiry/recovery against the SQLite D1-like persistence harness.
- Durable `FailTask`, `BlockTask`, and `ResumeTask` composition with atomic Task/Lease/Checkpoint/receipt persistence where applicable, restart-safe immutable replay, persisted blocked/failed evidence, controller-authorized resume, and D1-like fault-injection rollback coverage.
- Durable `RetryTask`, `CancelTask`, and `CancelGoal` composition with restart-safe receipts, controller authority, task-only cancellation when no effective Lease exists, atomic Goal/Task/Lease cancellation, and database-level concurrency guards against stale Goal admission and recovery-claim races.

### Changed

- Repository visibility changed from private to public to support transparent development and public-repository GitHub Actions/ruleset capabilities.
- Licensing assumptions were tightened: BUSL-1.1 controls production use outside the Additional Use Grant, especially competing hosted/managed use; it is not documented as a blanket prohibition on redistribution.
- Development tooling was aligned with supported 2026 versions and corrected against executable registry/CI evidence.
- Repository formatting and the pnpm lockfile were normalized by the pinned Prettier toolchain.
- Contract tooling uses an explicit Node `createRequire` boundary for Ajv CommonJS interop under TypeScript NodeNext.
- `skipLibCheck` remains enabled only because an executed removal test exposed a TypeScript 6 declaration incompatibility in `@apidevtools/json-schema-ref-parser@11.9.3`; first-party Ajv interop errors were fixed directly instead of suppressed.
- `NamespacedName` enforces the accepted lowercase-leading identifier grammar, and PermissionDecision structurally enforces first-decision/no-predecessor versus later-decision/required-predecessor shape.
- Root runtime code declares `@mindrail/contracts` as a `workspace:*` dependency so strict root TypeScript compilation consumes the canonical contract package through normal workspace resolution rather than compiler path aliases.
- Same-Session semantic duplicate claims return the existing Lease before the optimistic Task-revision gate, so transport-independent duplicate claim semantics do not mint a second fence.
- Idempotent replay preserves the stored result/error snapshot while reflecting the current retry correlation id; tracing-only correlation/causation fields remain outside semantic fingerprints.
- Pre-admission failures do not reserve command receipts. Unknown Workspace returns a protocol `NOT_FOUND` envelope instead of escaping from `execute()`, and malformed command envelopes return `INVALID_INPUT` before fingerprinting or dispatch.
- `RetryTask`, `CancelTask`, `CancelGoal`, and `ResumeTask` fail closed for agent actors; human/system actors retain controller authority.
- Runtime admission validates authoritative domain records before insertion/mutation, and rejected Lease admission does not advance the fencing counter.
- Effective Lease materialization includes Session liveness; stale Sessions are expired and their active Leases revoked using authoritative server time.
- Application transport validation now reuses the canonical runtime protocol validator for all commands instead of maintaining a separate bootstrap validator/command authority.
- Agent bootstrap pre-admission mirrors canonical Agent bounds: display name length, at most 64 unique namespaced capabilities, and no wildcard/fuzzy matching.
- Persistence list reads used by the durable application surface now support explicit bounded offsets while legacy unpaginated persistence reads remain available where existing internal tests depend on them.
- Durable `ListClaimableTasks` is advisory only; it exposes capability-compatible `ready` Tasks and `running` recovery Tasks whose prior Lease/Session authority is no longer effective at authoritative server time, while Task execution authority is still acquired and revalidated atomically by `ClaimTask`.
- Admitted terminal semantic failures in the supported durable command loop now persist immutable `outcomeKind: error` command receipts and replay after restart instead of re-executing the command.
- Durable Session/Lease liveness composition now supports `HeartbeatSession`, `EndSession`, `RenewLease`, and `ReleaseLease` with atomic mutation receipts, restart-safe replay, stable renewal fencing, and recoverable released/revoked execution authority.
- Durable task-outcome persistence now revalidates execution/revision authority at commit time and stores failure/block transitions and their released Lease plus Checkpoint in one batch; `ResumeTask` recomputes dependency readiness and removes the blocking reason without granting a Lease.
- D1 mutation batches now use transaction-aborting guard rows for conditional mutation races. Task creation/retry revalidate an active parent Goal inside the database batch; Goal cancellation terminalizes the Goal only after its cancellable Tasks/Leases and only when no cancellable work remains; claim/cancellation share fencing-counter and Task-state predicates so neither can return success with execution authority beneath cancelled state.

### Verification

- Runtime behavior was developed through focused RED -> GREEN GitHub Actions cycles for lifecycle, Lease/fencing recovery, idempotency, retry/cancellation controls, canonical-schema admission, protocol pre-admission, Session liveness, and permission semantics.
- Runtime Surface PR #20 merged with post-merge Quality PASS.
- Permission integration passed focused runtime/permission tests, full `pnpm check`, and coverage before integration.
- Persistence PR #24 passed its concurrency/integrity regressions and post-merge permanent Quality #248.
- HTTP/MCP Transport PR #25 passed integration run `33263935010`, including **98/98 tests**, full `pnpm check`, and `pnpm test:coverage`; permanent PR Quality #249 and post-merge Quality #250 also passed.
- Bootstrap protocol RED run `33267894635` failed all three new focused tests for the expected missing core `RegisterAgent`/`StartSession` behavior before production implementation.
- Bootstrap integration run `33268117966` then passed the focused bootstrap/transport suite and full `pnpm check` after temporary integration harness cleanup.
- HTTP control-plane E2E probe `33268217457` passed the complete local bootstrap/execution/permission/completion path without requiring another production fix.
- Durable receipt-parity TDD captured expected failures before the missing atomic receipt paths were implemented, then passed focused persistence tests, full `pnpm check`, and coverage.
- Runtime rehydration RED run failed all four new rehydration regressions while existing tests remained green; implementation run `33271407514` then passed focused rehydration verification, full `pnpm check`, and coverage.
- Durable dispatcher RED verification failed all four new dispatcher regressions for the expected missing composition, while existing tests remained green. Task 3 implementation run `33271753166` passed focused dispatcher/persistence verification, full `pnpm check`, and coverage.
- Durable query semantic RED run `33274570145` failed the four new query regressions because the durable dispatcher still returned `UNSUPPORTED_OPERATION`, while 115 existing tests passed. Task 4 integration run `33274741762` then passed focused durable-query/persistence verification, full `pnpm check`, and coverage.
- Permanent Quality run `33274903333` passed the restart-safe durable HTTP E2E tree with **29/29 test files and 123/123 tests**, plus `pnpm test:coverage`. Overall coverage reported 85.3% statements, 73.3% branches, 96.15% functions, and 86.95% lines.
- Final correctness-review RED run `33275182068` failed exactly the two new terminal-error-receipt and recovery-discovery regressions while the previous 123 tests passed. Review-fix run `33275312677` then passed focused regressions, full `pnpm check`, and coverage with **30/30 test files and 125/125 tests**; overall coverage was 85.43% statements, 73.5% branches, 96.18% functions, and 87.07% lines.
- Durable task-outcome RED run `33278105807` preserved the previous 130 passing tests while the new FailTask/BlockTask regressions failed at the expected unsupported boundary. Review/atomicity run `33278493339` passed **32/32 test files and 133/133 tests**, plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines, including a forced mid-batch rollback followed by successful exact retry.
- Durable retry/cancellation hardening run `33283962742` passed **33/33 test files and 143/143 tests**, full `pnpm check`, and coverage at 85.0% statements, 74.3% branches, 96.51% functions, and 86.71% lines after transaction-CAS, stale Goal admission, no-Lease cancellation, mid-batch rollback, false-receipt, and cancellation-versus-recovery claim regressions were made green.
- Frozen installation resolves `@mindrail/contracts 0.0.0 <- packages/contracts`, confirming the root runtime uses the workspace contract package.
- No new third-party runtime dependency was introduced for schema admission, protocol admission, bootstrap, transport, permission, persistence composition, rehydration, or durable query semantics.

### Known limitations

- `Quality` is not yet enforced as a required `main` merge gate; repository protection remains tracked separately in issue #3.
- The durable application composition is verified against the local SQLite D1-like test harness, not a deployed Cloudflare Worker/Durable Object/D1 environment.
- The durable dispatcher supports the complete ADR-0005 v0.1 command surface. The remaining explicit durable application gaps are read-side: `ListGoals`, `ListGoalTasks`, and `GetTaskExecutionView`.
- Durable application queries `ListGoals`, `ListGoalTasks`, and `GetTaskExecutionView` remain explicitly unsupported.
- MindRail does not yet expose a verified deployed Cloudflare control-plane service, GitHub adapter, real Codex/ChatGPT integration, or unattended continuation of a real external agent across host/platform termination.
- The deterministic v0.1 permission policy is intentionally small and is not an IAM system, credential manager, arbitrary policy DSL, or model-based authority mechanism.
- MindRail-specific BUSL parameters and external-contribution licensing mechanics still require professional legal review before material reliance.
