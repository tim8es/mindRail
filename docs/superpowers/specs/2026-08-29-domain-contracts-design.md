# MindRail v1 Domain Contracts — Design Specification

- **Status:** Written review pending
- **Date:** 2026-08-29
- **Depends on:** ADR-0001, proposed ADR-0003
- **Scope:** Domain vocabulary and executable contract artifacts only. No network API, database, state-machine implementation, cloud resources, or agent integration.

## 1. Objective

Create the smallest stable domain contract layer that later MindRail protocol, runtime, persistence, and agent integrations can all depend on without making TypeScript, Cloudflare, GitHub, MCP, or any model vendor the source of truth.

The slice is successful when:

1. canonical JSON Schema Draft 2020-12 contracts exist for the v1 domain;
2. every schema is structurally validated by a real JSON Schema validator;
3. representative valid/invalid fixtures prove important boundaries;
4. deterministic TypeScript bindings are generated from the schemas;
5. CI detects generated-code drift;
6. no runtime/database/network behavior is implied by the contract package.

## 2. Architectural choices

### 2.1 Canonical representation

`schemas/domain/v1/` is the authority. Generated TypeScript is a derivative build artifact.

```text
JSON Schema Draft 2020-12
          │
          ├── schema validation + fixtures
          │
          └── deterministic generation
                    │
                    ▼
             TypeScript bindings
```

Handwritten TypeScript must not redefine canonical domain shapes.

### 2.2 Schema identifiers

Schemas use stable URN identifiers, for example:

```text
urn:mindrail:schema:domain:v1:task
urn:mindrail:schema:domain:v1:common
```

This avoids coupling schema identity to a website or deployment hostname.

### 2.3 Resource categories

**Mutable resources**

- Workspace
- Goal
- Task
- Agent
- Session
- Lease

Mutable resources carry `revision`, `createdAt`, and `updatedAt`.

**Append-only records**

- Checkpoint
- PermissionRequest
- PermissionDecision
- AuditEvent

Append-only records carry `createdAt` but no mutable revision or `updatedAt`.

## 3. File layout

Target layout:

```text
schemas/
└── domain/
    └── v1/
        ├── common.schema.json
        ├── workspace.schema.json
        ├── goal.schema.json
        ├── task.schema.json
        ├── agent.schema.json
        ├── session.schema.json
        ├── lease.schema.json
        ├── checkpoint.schema.json
        ├── permission-request.schema.json
        ├── permission-decision.schema.json
        └── audit-event.schema.json

packages/
└── contracts/
    ├── src/
    │   ├── generated/
    │   │   └── v1/
    │   └── index.ts
    ├── test/
    │   ├── fixtures/
    │   └── *.test.ts
    └── package.json

scripts/
└── generate-contracts.*
```

`common.schema.json` contains shared `$defs` rather than creating one file per primitive/value object.

The exact maintained generation library is an implementation choice, not protocol semantics. It must be pinned, deterministic, offline after dependency installation, and compatible with the chosen schemas.

## 4. Shared primitives and value objects

All canonical object schemas reject unknown top-level fields with `additionalProperties: false`, except the explicitly bounded `AuditEvent.attributes` map described later.

### 4.1 EntityId

Opaque identifier. Storage implementation is intentionally unspecified.

- type: string
- length: 1–128
- pattern: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`

No UUID, database sequence, Cloudflare identifier, GitHub identifier, or provider-specific format is part of the contract.

### 4.2 UtcDateTime

- type: string
- JSON Schema format: `date-time`
- must use UTC `Z` form

Examples:

```text
2026-08-29T00:32:08Z
2026-08-29T00:32:08.123Z
```

### 4.3 NamespacedName

Used for capabilities, permissions, event types, resource types, and reason codes.

- type: string
- length: 1–128
- lowercase-oriented pattern allowing segments separated by `.`, `_`, or `-`

Examples:

```text
repository.read
repository.write
agent.codex
policy.requires-human
```

### 4.4 ActorRef

```text
type: system | human | agent
id: EntityId
```

An opaque human id does not define authentication or account ownership semantics.

### 4.5 ResourceRef

```text
type: NamespacedName
id: EntityId
```

Used when an audit/permission record needs to refer to a resource without embedding it.

### 4.6 EvidenceRef

```text
uri: URI reference, max 2048 chars
mediaType?: string, max 255 chars
sha256?: exactly 64 lowercase hex chars
sizeBytes?: integer >= 0
```

Evidence content is not embedded in the domain record.

### 4.7 PolicyRef

```text
id: EntityId
version: string, 1–128 chars
```

`version` may later be a Git commit SHA, immutable config digest, or another explicit policy version. The domain contract does not create a persistent `Policy` entity.

### 4.8 Reason

```text
code: NamespacedName
summary: string, 1–1000 chars
```

Used for durable machine-readable + human-readable status/decision explanations without arbitrary payloads.

## 5. Mutable resource base semantics

Except `Workspace`, mutable resources contain:

```text
id: EntityId
workspaceId: EntityId
revision: integer >= 1
createdAt: UtcDateTime
updatedAt: UtcDateTime
```

`Workspace` has the same fields except `workspaceId`.

Runtime authority, not an agent client, will authoritatively assign ids, revisions, and timestamps. Future protocol commands operate on domain resources rather than allowing clients to submit arbitrary authoritative resource snapshots.

`revision` begins at `1` and increases monotonically for every accepted mutation.

## 6. Workspace

Purpose: stable isolation/tenancy boundary only.

Required fields:

```text
id
revision
createdAt
updatedAt
name: string, 1–160 chars
status: active | archived
```

Not included in v1 Workspace:

- owner;
- organization/team membership;
- billing;
- OAuth/OIDC configuration;
- roles;
- subscription tier;
- cloud-provider settings.

Those belong to future identity/security/product decisions.

## 7. Goal

Purpose: durable desired outcome that can survive individual task/session lifetimes.

Required fields:

```text
id
workspaceId
revision
createdAt
updatedAt
title: string, 1–160 chars
objective: string, 1–8000 chars
successCriteria: array<string>, 1–32 items, each 1–1000 chars
status: active | succeeded | failed | cancelled
```

A Goal is not a Task and is not a Plan. Plan is deliberately not a persisted v1 concept.

## 8. Task

Purpose: durable unit of executable work under one Goal.

Required fields:

```text
id
workspaceId
goalId: EntityId
revision
createdAt
updatedAt
title: string, 1–160 chars
objective: string, 1–8000 chars
acceptanceCriteria: array<string>, 1–32 items, each 1–1000 chars
requiredCapabilities: unique array<NamespacedName>, 0–64 items
dependencyTaskIds: unique array<EntityId>, 0–128 items
status: pending | ready | running | blocked | succeeded | failed | cancelled
```

Optional:

```text
statusReason?: Reason
```

Cross-record invariants:

- dependency ids reference tasks in the same workspace and goal;
- a task cannot depend on itself;
- task dependencies form an acyclic graph.

Exact transition rules and retry behavior belong to the deterministic runtime/state-machine slice, not this structural schema slice.

## 9. Agent

Purpose: logical execution identity, independent of any one process/chat/session.

Required fields:

```text
id
workspaceId
revision
createdAt
updatedAt
displayName: string, 1–160 chars
status: active | disabled
capabilities: unique array<NamespacedName>, 0–64 items
```

No vendor enum is introduced. `Codex`, `ChatGPT`, `Claude`, and custom runtimes are integration concerns; capabilities are the core scheduling contract.

## 10. Session

Purpose: one concrete execution/connectivity lifetime for an Agent.

Required fields:

```text
id
workspaceId
agentId: EntityId
revision
createdAt
updatedAt
status: active | ended | expired
lastSeenAt: UtcDateTime
```

Optional:

```text
endedAt?: UtcDateTime
```

A Task never depends on a Session for durable existence. Session termination must not erase Task/Goal state.

## 11. Lease

Purpose: temporary execution authority from MindRail to one Session for one Task.

Required fields:

```text
id
workspaceId
taskId: EntityId
sessionId: EntityId
revision
createdAt
updatedAt
status: active | released | expired | revoked
fencingToken: integer >= 1
expiresAt: UtcDateTime
```

Binding invariants:

- task and session belong to the same workspace;
- at most one active lease exists for a task;
- fencing tokens increase monotonically for successive leases on one task;
- a stale fencing token cannot authorize checkpoint, completion, or task-scoped permission mutation.

A lease is the claim. No separate `claimed` Task status is introduced.

## 12. Checkpoint

Purpose: immutable progress/evidence record emitted during Task execution.

Required fields:

```text
id
workspaceId
taskId: EntityId
sessionId: EntityId
leaseId: EntityId
fencingToken: integer >= 1
createdAt
kind: progress | handoff | blocked | result
summary: string, 1–4000 chars
evidence: array<EvidenceRef>, 0–32 items
```

Optional:

```text
progressPercent?: integer 0–100
```

Checkpoint content is intentionally bounded. Large logs/files are evidence artifacts referenced by `EvidenceRef`.

A checkpoint is append-only after admission.

## 13. PermissionRequest

Purpose: immutable request by an executing session for authority not already granted by its current bounded context/policy.

Required fields:

```text
id
workspaceId
taskId: EntityId
sessionId: EntityId
leaseId: EntityId
fencingToken: integer >= 1
createdAt
permission: NamespacedName
justification: string, 1–2000 chars
```

Optional:

```text
resource?: ResourceRef
```

Permission requests are task-scoped in v1. Bootstrap/static grants are configuration/context concerns and do not require a synthetic PermissionRequest.

## 14. PermissionDecision

Purpose: immutable decision record for one PermissionRequest.

Required fields:

```text
id
workspaceId
requestId: EntityId
createdAt
sequence: integer >= 1
outcome: ALLOW | DENY | HUMAN_REQUIRED
basis: policy | human
decidedBy: ActorRef
reasonCode: NamespacedName
```

Optional:

```text
policyRef?: PolicyRef
reason?: string, 1–2000 chars
supersedesDecisionId?: EntityId
```

Rules:

- `basis = policy` requires `policyRef`;
- `HUMAN_REQUIRED` is non-authorizing;
- a later human `ALLOW` or `DENY` may supersede an interim `HUMAN_REQUIRED` decision;
- decisions for one request have strictly increasing `sequence`;
- historical decisions are never edited in place;
- future runtime logic must ensure there is no ambiguous pair of simultaneously final decisions.

This avoids introducing a separate persistent `HumanDecision` concept before its lifecycle proves independently necessary.

## 15. AuditEvent

Purpose: immutable forensic/audit envelope for meaningful system activity without turning the system into event sourcing.

Required fields:

```text
id
workspaceId
createdAt
eventType: NamespacedName
actor: ActorRef
subject: ResourceRef
correlationId: EntityId
```

Optional:

```text
related?: unique array<ResourceRef>, 0–16 items
transition?: {
  from: string, 1–128 chars
  to: string, 1–128 chars
}
attributes?: bounded flat scalar map
```

`attributes` is the one intentional dynamic object surface in v1:

- max 16 properties;
- property names must satisfy `NamespacedName`;
- values may only be string/number/boolean/null;
- strings max 500 chars;
- no nested objects;
- no arrays;
- no secrets, evidence bodies, prompts, transcripts, or large logs.

The domain state remains normal current-state records. Audit events document what happened; they are not required to rebuild the entire database.

## 16. Workspace isolation invariants

The following are binding even where JSON Schema cannot prove them without storage access:

1. every non-Workspace record belongs to exactly one Workspace;
2. every reference between domain records remains within that Workspace;
3. Task → Goal belongs to same Workspace;
4. Task dependency → Task belongs to same Workspace and Goal;
5. Session → Agent belongs to same Workspace;
6. Lease → Task/Session belongs to same Workspace;
7. Checkpoint and PermissionRequest references belong to same Workspace;
8. PermissionDecision → PermissionRequest belongs to same Workspace.

Future persistence adapters must make cross-workspace reference acceptance impossible or deterministically reject it.

## 17. Concurrency invariants

`revision` and `fencingToken` solve different problems and are both required.

### Revision

Protects a mutable resource from lost updates:

```text
read Task revision 17
mutate with expectedRevision 17
accepted → revision 18
stale expectedRevision → reject
```

### Fencing token

Protects a task from a stale execution owner:

```text
Session A gets token 4
lease expires
Session B gets token 5
Session A wakes up and submits token 4
→ reject even if its local data looks valid
```

This invariant must survive retries, delayed network delivery, and process resurrection.

## 18. Generated TypeScript contract

Generated bindings live under:

```text
packages/contracts/src/generated/v1/
```

Rules:

- generated files contain a clear generated header;
- generated files are committed for inspectability and simple downstream consumption;
- they are regenerated deterministically from canonical schemas;
- manual edits are prohibited;
- a hand-written package barrel may only re-export generated types/schema assets and must not alter domain shape;
- the generator must not require network access during generation;
- generation output must be stable on a clean checkout with the pinned toolchain.

The package does not expose a cloud/database implementation and does not make a validator library part of the public protocol.

## 19. Schema validation and test strategy

The implementation slice must include executable tests for:

### Schema compilation

- every canonical schema compiles under a Draft 2020-12 validator in strict mode;
- all `$ref` targets resolve;
- all `$id` values are unique.

### Positive fixtures

At least one minimal valid fixture for every top-level domain schema.

### Negative fixtures

Representative rejection tests for:

- unknown fields;
- invalid ids;
- non-UTC timestamps;
- text/array bounds;
- duplicate capabilities/dependencies;
- invalid enum values;
- malformed SHA-256 digest;
- nested/unbounded AuditEvent attributes;
- policy-basis PermissionDecision without `policyRef`.

Cross-record invariants such as dependency cycles and active-lease uniqueness are documented here but implemented/tested in the local runtime slice because they require state lookup.

### Generation drift

CI must regenerate TypeScript bindings and fail if the committed generated output differs.

### Existing quality gate

The new contracts checks become part of the existing `pnpm check`; no parallel quality command becomes an alternative authority.

## 20. Security and bounded-data rules

Domain contracts must not create convenient secret/log dumping grounds.

- no generic unrestricted `metadata: object`;
- no embedded credentials/tokens;
- no arbitrary nested JSON payloads;
- no raw binary/base64 artifact bodies;
- no unbounded strings or arrays;
- large evidence remains external and is referenced;
- audit attributes remain shallow and bounded;
- future adapters may impose stricter limits than these canonical maxima.

Schema validity does not imply content safety. Privacy/secret admission rules remain a higher-layer runtime responsibility.

## 21. Versioning

`domain/v1` is major contract version 1.

Breaking changes requiring a new major version include:

- required field removal/rename;
- incompatible field type changes;
- making an optional field required for existing records;
- materially incompatible lifecycle semantics;
- changing an identifier/reference meaning such that existing records become ambiguous.

An optional additive field may remain v1 only when existing valid records remain valid and consumers are not required to reinterpret existing fields.

A new persistent domain concept still requires ADR review even if it can be added without breaking JSON validation.

## 22. Explicit non-goals for this slice

Do not implement:

- HTTP endpoints;
- MCP tools;
- database tables/migrations;
- Cloudflare Workers, D1, or Durable Objects;
- GitHub adapters;
- policy evaluation;
- task transition engine;
- lease acquisition/heartbeat logic;
- authentication/authorization;
- agent runtime integrations;
- Plan/Project/Workflow/Policy/HumanDecision entities;
- event sourcing;
- generic extension/plugin payloads.

Those are later slices built on these contracts.

## 23. Acceptance criteria

The written design is implementation-ready when:

1. ADR-0003 is accepted;
2. no unresolved placeholder/TBD remains;
3. entity/value-object boundaries above are unambiguous;
4. schema-level versus runtime-level invariants are clearly separated;
5. a new contributor could implement the schemas/tests/generation without inventing missing domain semantics;
6. implementation does not need to choose a cloud, database, transport, or model vendor.