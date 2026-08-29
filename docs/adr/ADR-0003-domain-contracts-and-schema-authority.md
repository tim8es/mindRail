# ADR-0003: Domain contracts and schema authority

- **Status:** Proposed
- **Date:** 2026-08-29

## Context

ADR-0001 establishes MindRail as a vendor-neutral control plane whose agents, transports, persistence adapters, and reference cloud infrastructure are replaceable. The next implementation slices will depend on a shared domain vocabulary. If those contracts are defined only as TypeScript interfaces, the reference implementation would accidentally become the protocol authority and non-TypeScript clients would depend on generated or reverse-engineered semantics.

MindRail also needs enough structure now to avoid expensive breaking migrations later, without introducing speculative SaaS, event-sourcing, workflow, or cloud abstractions.

## Decision

### 1. JSON Schema is the canonical contract format

MindRail domain contracts use **JSON Schema Draft 2020-12** as their source of truth.

Canonical schemas live under:

```text
schemas/domain/v1/
```

TypeScript types are generated from those schemas and are never edited as an independent source of domain truth.

Each schema uses a stable `urn:mindrail:schema:...` `$id` rather than a vendor or deployment URL.

### 2. v1 domain vocabulary

The first durable domain vocabulary is intentionally limited to:

- `Workspace`;
- `Goal`;
- `Task`;
- `Agent`;
- `Session`;
- `Lease`;
- `Checkpoint`;
- `PermissionRequest`;
- `PermissionDecision`;
- `AuditEvent`.

Small shared structures such as `ActorRef`, `ResourceRef`, `EvidenceRef`, `PolicyRef`, and `Reason` are value objects, not independent persisted authorities.

### 3. Workspace is the isolation boundary

Every durable domain record except `Workspace` carries `workspaceId`. Cross-record references must resolve within the same workspace.

`Workspace` is deliberately **not** an account, billing, organization, team, or authentication model. Ownership and identity-provider semantics are deferred to a later security/authentication decision.

Adding the isolation boundary now avoids a future migration in which nearly every durable record and uniqueness rule would need to become tenant-aware.

### 4. Agent, Session, Task, and Lease are separate concepts

- `Agent` is a logical execution identity with declared capabilities.
- `Session` is one concrete execution/connectivity lifetime for an agent.
- `Task` is durable work and survives session loss.
- `Lease` is temporary authority for one session to execute a task.

A task claim is not modeled as a special task status. Lease authority is separate from task progress state.

### 5. Leases use fencing tokens

Each lease has a positive integer `fencingToken`. Tokens increase monotonically for successive lease grants on the same task.

A checkpoint, completion, or task-scoped permission request that presents a stale fencing token must be rejectable by the future runtime. At most one lease may be active for a task at a time.

This prevents a delayed or partitioned session from mutating a task after its authority expired and another session acquired the task.

### 6. Mutable resources use optimistic revisions

Mutable resources carry a positive integer `revision`. The future protocol will use expected revisions for optimistic concurrency.

Idempotency keys belong to protocol commands rather than domain entities and therefore are not added to every schema.

### 7. Append-only records stay append-only

`Checkpoint`, `PermissionRequest`, `PermissionDecision`, and `AuditEvent` are append-only records in v1. Corrections are represented by later records rather than mutation of historical evidence.

`PermissionDecision` supports `ALLOW`, `DENY`, and `HUMAN_REQUIRED`. `HUMAN_REQUIRED` grants no authority. A later final human decision may supersede the interim decision without rewriting history.

### 8. Audit is not event sourcing

MindRail keeps normal current-state domain records plus append-only audit events. The event log is not the sole source from which current state must be reconstructed.

Audit event-specific attributes are deliberately bounded and shallow; large/nested arbitrary payloads are not part of the audit contract.

### 9. Evidence is referenced, not embedded

`EvidenceRef` can point to an artifact and optionally carry media type, SHA-256 digest, and byte size. Domain contracts do not embed large logs, screenshots, files, or model transcripts.

### 10. Domain contracts reject unknown fields

Canonical resource/value-object schemas use `additionalProperties: false` unless a specific bounded extension surface is explicitly designed. Text, arrays, URIs, and flat audit attributes have explicit upper bounds.

The goal is to prevent accidental protocol expansion, unbounded persistence, and silent acceptance of misspelled fields.

## Core invariants

The schema documents define structural validity. Cross-record/runtime invariants that JSON Schema alone cannot enforce are still binding domain semantics:

1. all referenced records belong to the same workspace;
2. task dependencies refer to tasks in the same goal/workspace, contain no self-reference, and form an acyclic graph;
3. a session belongs to its declared agent;
4. a lease's task and session belong to the same workspace;
5. at most one lease is active per task;
6. fencing tokens increase monotonically per task and stale tokens cannot authorize mutation;
7. mutable entity revisions increase monotonically on mutation;
8. append-only records are never updated in place;
9. a `HUMAN_REQUIRED` permission decision does not authorize the requested action;
10. generated language bindings never override canonical schema semantics.

The local runtime slice will implement and test the invariants that require state or cross-record lookup.

## Alternatives considered

### TypeScript-first contracts

Rejected as the canonical authority. It is convenient for the reference implementation but makes a specific implementation language the definition of the protocol.

### TypeScript-only interfaces

Rejected. They provide no runtime validation contract and force other clients to infer wire semantics.

### Full event sourcing

Rejected for v0.1. It would add event versioning, replay, projection, and migration complexity before MindRail has evidence that those costs are justified.

### No Workspace until multi-user SaaS exists

Rejected. Tenant/isolation scoping affects almost every durable identity and reference. Adding a minimal isolation key now is cheap; retrofitting it later is not.

### Plan, Project, Workflow, Policy, and HumanDecision as additional v1 entities

Rejected for now. None is necessary to express the first executable control-plane loop. They may be introduced through a later ADR when an implementation slice demonstrates a persistent independent lifecycle.

## Consequences

- The first contracts remain usable by TypeScript, Rust, Python, CLI, MCP, HTTP, and other clients.
- The TypeScript reference implementation pays a small generation/build cost in exchange for language-neutral semantics.
- Workspace scoping and fencing tokens add a few fields early but avoid high-risk tenant and concurrency migrations later.
- Some business rules cannot be expressed in JSON Schema and must be implemented as deterministic runtime invariants.
- Schema evolution becomes an explicit compatibility concern rather than an incidental TypeScript refactor.

## Compatibility and evolution

`schemas/domain/v1/` represents major contract version 1. Once v1 is consumed by an external implementation, breaking field removals/renames, incompatible type changes, or materially incompatible state semantics require a new major schema version.

Additive optional fields may be introduced within v1 only when they preserve existing validation/consumer expectations. New persistent concepts still require ADR review under `AGENTS.md`.

No runtime data exists yet, so this decision requires no migration.