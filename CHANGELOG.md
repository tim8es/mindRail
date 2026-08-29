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
- Bounded HTTP and MCP adapters over one application/protocol surface, preserving protocol error/idempotency envelopes and avoiding generic shell/filesystem/browser/action authority tools.
- In-memory application dispatcher for all ADR-0005 commands plus bounded implemented queries (`GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `ListTaskCheckpoints`).
- HTTP/application end-to-end regression covering `RegisterAgent -> StartSession -> CreateGoal -> CreateTask -> ClaimTask -> RecordCheckpoint -> RequestPermission(repository.write) -> RecordPermissionDecision(ALLOW) -> CompleteTask`, followed by HTTP verification of final Task, Goal, Lease, and checkpoint state.

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

### Verification

- Runtime behavior was developed through focused RED -> GREEN GitHub Actions cycles for lifecycle, Lease/fencing recovery, idempotency, retry/cancellation controls, canonical-schema admission, protocol pre-admission, Session liveness, and permission semantics.
- Runtime Surface PR #20 merged with post-merge Quality PASS.
- Permission integration passed focused runtime/permission tests, full `pnpm check`, and coverage before integration.
- Persistence PR #24 passed its concurrency/integrity regressions and post-merge permanent Quality #248.
- HTTP/MCP Transport PR #25 passed integration run `33263935010`, including **98/98 tests**, full `pnpm check`, and `pnpm test:coverage`; permanent PR Quality #249 and post-merge Quality #250 also passed.
- Bootstrap protocol RED run `33267894635` failed all three new focused tests for the expected missing core `RegisterAgent`/`StartSession` behavior before production implementation.
- Bootstrap integration run `33268117966` then passed the focused bootstrap/transport suite and full `pnpm check` after temporary integration harness cleanup.
- HTTP control-plane E2E probe `33268217457` passed the complete local bootstrap/execution/permission/completion path without requiring another production fix.
- Frozen installation resolves `@mindrail/contracts 0.0.0 <- packages/contracts`, confirming the root runtime uses the workspace contract package.
- No new third-party runtime dependency was introduced for schema admission, protocol admission, bootstrap, transport, or permission semantics.

### Known limitations

- `Quality` is not yet enforced as a required `main` merge gate; repository protection remains tracked separately in issue #3.
- The local application/runtime composition is still in-memory. Its command receipts, Sessions, Leases, checkpoints, and permission state do not survive process restart.
- A D1/Workspace-coordinator persistence adapter is implemented and verified separately, but it is not yet composed beneath the common HTTP/MCP application dispatcher or verified through restart/recovery E2E.
- Several application queries remain explicitly unsupported: `ListGoals`, `ListGoalTasks`, `ListClaimableTasks`, `GetTaskExecutionView`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListPendingHumanPermissions`, and `ListPermissionDecisions`.
- MindRail does not yet expose a deployed Cloudflare control-plane service, GitHub adapter, real Codex/ChatGPT integration, or unattended continuation across host/runtime termination.
- The deterministic v0.1 permission policy is intentionally small and is not an IAM system, credential manager, arbitrary policy DSL, or model-based authority mechanism.
- MindRail-specific BUSL parameters and external-contribution licensing mechanics still require professional legal review before material reliance.
