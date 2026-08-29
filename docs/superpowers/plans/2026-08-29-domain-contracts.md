# MindRail v1 Domain Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement executable, language-neutral v1 MindRail domain contracts with JSON Schema Draft 2020-12 as the canonical source, strict validation tests, and deterministic generated TypeScript bindings.

**Architecture:** Canonical schemas live under `schemas/domain/v1/`. A small test/build harness loads those schemas with Ajv 2020 in strict mode, validates representative fixtures, and generates committed TypeScript from the schemas with `json-schema-to-typescript`; the generated output is derivative and checked for drift. The contracts package contains no network, storage, cloud, policy-engine, or orchestration runtime behavior.

**Tech Stack:** Node.js 24, pnpm 11.24.0, JSON Schema Draft 2020-12, Ajv 8.20.0, ajv-formats 3.0.1, json-schema-to-typescript 15.0.4, Prettier 3.9.6, TypeScript 6.0.3, Vitest 4.1.11.

**Spec:** `docs/superpowers/specs/2026-08-29-domain-contracts-design.md`

## Global Constraints

- `schemas/domain/v1/` is the canonical authority; generated TypeScript must never redefine or outrank schema semantics.
- Every top-level schema uses JSON Schema Draft 2020-12 and a stable `urn:mindrail:schema:domain:v1:*` `$id`.
- Unknown top-level properties are rejected with `additionalProperties: false`, except the explicitly bounded flat `AuditEvent.attributes` object.
- `Workspace` is only an isolation boundary; do not add owner, team, billing, auth, OAuth/OIDC, role, subscription, or cloud settings.
- Keep `Goal`, `Task`, `Agent`, `Session`, `Lease`, `Checkpoint`, `PermissionRequest`, `PermissionDecision`, and `AuditEvent` as separate concepts exactly as specified.
- A task claim is a `Lease`; do not add a `claimed` task status.
- `revision` and `fencingToken` are distinct concurrency concepts and must remain distinct.
- Capability matching is exact string set inclusion in v1; do not add wildcard, prefix, hierarchy, fuzzy, or model-driven capability matching.
- Permission authority remains deterministic; schemas may represent decisions but do not implement policy evaluation in this slice.
- No unrestricted metadata object, embedded credentials, base64 artifacts, prompts/transcripts, or unbounded payloads.
- Cross-record/storage invariants remain documented contract invariants; do not fake them as JSON Schema validation when state lookup is required.
- No network API, persistence adapter, Cloudflare resource, GitHub adapter, MCP endpoint, auth system, policy engine, or task state machine in this plan.
- All new third-party packages are development-only root dependencies; `@mindrail/contracts` must have zero runtime dependencies.
- The existing `pnpm check` remains the single aggregate quality gate.

---

## File Map

### Canonical contracts

- `schemas/domain/v1/common.schema.json` — shared primitives/value objects only.
- `schemas/domain/v1/workspace.schema.json` — isolation boundary.
- `schemas/domain/v1/goal.schema.json` — durable desired outcome.
- `schemas/domain/v1/task.schema.json` — durable executable work unit.
- `schemas/domain/v1/agent.schema.json` — logical execution identity/capabilities.
- `schemas/domain/v1/session.schema.json` — concrete agent execution lifetime.
- `schemas/domain/v1/lease.schema.json` — temporary task execution authority and fencing token.
- `schemas/domain/v1/checkpoint.schema.json` — immutable bounded progress/evidence record.
- `schemas/domain/v1/permission-request.schema.json` — immutable task-scoped permission request.
- `schemas/domain/v1/permission-decision.schema.json` — immutable deterministic/human decision record.
- `schemas/domain/v1/audit-event.schema.json` — immutable bounded forensic event envelope.

### Contract tooling and package

- `scripts/contracts/schema-registry.mjs` — sorted schema discovery, JSON parsing, Ajv 2020 registry construction.
- `scripts/contracts/generate.mjs` — deterministic generated TypeScript writer/checker.
- `packages/contracts/package.json` — internal zero-runtime-dependency contract package metadata/scripts.
- `packages/contracts/tsconfig.json` — strict typecheck boundary for generated/barrel files.
- `packages/contracts/src/index.ts` — explicit exports only; no handwritten domain shapes.
- `packages/contracts/src/generated/v1/*.ts` — committed generated output, never hand edited.
- `packages/contracts/test/fixtures/v1.ts` — compact positive/negative fixture catalogue.
- `packages/contracts/test/schema-compilation.test.ts` — Draft 2020-12 compilation/id/ref tests.
- `packages/contracts/test/fixtures.test.ts` — fixture acceptance/rejection tests.
- `packages/contracts/test/generated.test.ts` — generation drift and generated-file header tests.

### Repository integration

- `package.json` — root dev dependencies and `contracts:*`/updated `typecheck`/`check` scripts.
- `pnpm-workspace.yaml` — add `packages/*` while retaining root workspace.
- `pnpm-lock.yaml` — regenerated only by pinned pnpm 11.24.0.
- `tsconfig.base.json` — remains root baseline; package has its own extending config.
- `docs/CURRENT_STATE.md`, `docs/roadmap/V0_1.md`, `CHANGELOG.md` — reconcile only after executable evidence exists.

---

## Task 1 — Contract toolchain, common primitives, and Workspace

**Files:**

- Modify: `package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `pnpm-lock.yaml` through pinned pnpm only
- Create: `scripts/contracts/schema-registry.mjs`
- Create: `packages/contracts/package.json`
- Create: `packages/contracts/tsconfig.json`
- Create: `packages/contracts/test/schema-compilation.test.ts`
- Create: `schemas/domain/v1/common.schema.json`
- Create: `schemas/domain/v1/workspace.schema.json`

**Interfaces:**

- Produces: `loadDomainSchemas(): Promise<Array<Record<string, unknown>>>`
- Produces: `createDomainAjv(): Promise<{ ajv: Ajv2020; schemas: Array<Record<string, unknown>> }>`
- Produces canonical `$defs`: `EntityId`, `UtcDateTime`, `NamespacedName`, `ActorRef`, `ResourceRef`, `EvidenceRef`, `PolicyRef`, `Reason`.

- [ ] **Step 1: Add the failing schema compilation test before canonical schemas exist**

Create `packages/contracts/test/schema-compilation.test.ts` with tests that:

```ts
import { describe, expect, it } from 'vitest';
import { createDomainAjv, loadDomainSchemas } from '../../../scripts/contracts/schema-registry.mjs';

describe('domain schema registry', () => {
  it('loads the complete v1 schema set with unique ids', async () => {
    const schemas = await loadDomainSchemas();
    expect(schemas).toHaveLength(11);

    const ids = schemas.map((schema) => schema.$id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('compiles every schema under strict Draft 2020-12 validation', async () => {
    const { ajv, schemas } = await createDomainAjv();
    for (const schema of schemas) {
      expect(() => ajv.getSchema(String(schema.$id)) ?? ajv.compile(schema)).not.toThrow();
    }
  });
});
```

- [ ] **Step 2: Run the focused test and record the expected RED result**

Run: `pnpm vitest run packages/contracts/test/schema-compilation.test.ts`

Expected: FAIL because `scripts/contracts/schema-registry.mjs` and/or the canonical schema directory does not exist yet. Do not call this PASS.

- [ ] **Step 3: Add only the required development dependencies and workspace boundary**

In root `package.json`, add exact dev dependencies:

```json
"ajv": "8.20.0",
"ajv-formats": "3.0.1",
"json-schema-to-typescript": "15.0.4"
```

Add scripts:

```json
"contracts:generate": "node scripts/contracts/generate.mjs",
"contracts:check-generated": "node scripts/contracts/generate.mjs --check"
```

Change root `typecheck` to:

```json
"typecheck": "tsc -p tsconfig.base.json && pnpm --filter @mindrail/contracts typecheck"
```

Do not yet add `contracts:check-generated` to `check`; generation does not exist until Task 5.

Change `pnpm-workspace.yaml` to:

```yaml
packages:
  - '.'
  - 'packages/*'
```

Create `packages/contracts/package.json`:

```json
{
  "name": "@mindrail/contracts",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "license": "BUSL-1.1",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit"
  }
}
```

Create `packages/contracts/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 4: Regenerate the lockfile with the pinned package manager**

Run: `pnpm install --lockfile-only`

Expected: `pnpm-lock.yaml` changes and resolves the exact three new dev dependencies. Then run `pnpm install --frozen-lockfile` and require PASS before proceeding.

- [ ] **Step 5: Implement the schema registry**

Create `scripts/contracts/schema-registry.mjs` using Node built-ins plus Ajv only:

```js
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const here = dirname(fileURLToPath(import.meta.url));
export const schemaDirectory = join(here, '../../schemas/domain/v1');

export async function loadDomainSchemas() {
  const names = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort();

  return Promise.all(
    names.map(async (name) => JSON.parse(await readFile(join(schemaDirectory, name), 'utf8'))),
  );
}

export async function createDomainAjv() {
  const schemas = await loadDomainSchemas();
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
  addFormats(ajv);

  for (const schema of schemas) {
    ajv.addSchema(schema);
  }

  return { ajv, schemas };
}
```

- [ ] **Step 6: Implement `common.schema.json` exactly as bounded primitives/value objects**

Use `$schema: "https://json-schema.org/draft/2020-12/schema"` and `$id: "urn:mindrail:schema:domain:v1:common"`.

Required `$defs` semantics:

```text
EntityId:
  string; minLength 1; maxLength 128;
  pattern ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$

UtcDateTime:
  string; format date-time;
  pattern Z$                  # offsets are intentionally rejected in v1

NamespacedName:
  string; minLength 1; maxLength 128;
  pattern ^[a-z0-9]+(?:[._-][a-z0-9]+)*$

ActorRef:
  object; additionalProperties false;
  required type,id;
  type enum system|human|agent;
  id -> EntityId

ResourceRef:
  object; additionalProperties false;
  required type,id;
  type -> NamespacedName;
  id -> EntityId

EvidenceRef:
  object; additionalProperties false;
  required uri;
  uri string format uri-reference maxLength 2048;
  mediaType optional string minLength 1 maxLength 255;
  sha256 optional string pattern ^[a-f0-9]{64}$;
  sizeBytes optional integer minimum 0

PolicyRef:
  object; additionalProperties false;
  required id,version;
  id -> EntityId;
  version string minLength 1 maxLength 128

Reason:
  object; additionalProperties false;
  required code,summary;
  code -> NamespacedName;
  summary string minLength 1 maxLength 1000
```

Do not put mutable-resource base objects in `common.schema.json`; explicit top-level properties are intentionally duplicated to avoid `allOf`/`additionalProperties` ambiguity and generator coupling.

- [ ] **Step 7: Implement `workspace.schema.json`**

Canonical properties and constraints:

```text
id -> EntityId
revision integer minimum 1
createdAt -> UtcDateTime
updatedAt -> UtcDateTime
name string minLength 1 maxLength 160
status enum active|archived
```

All six fields are required; `additionalProperties` is false.

- [ ] **Step 8: Re-run compilation tests**

Run: `pnpm vitest run packages/contracts/test/schema-compilation.test.ts`

Expected: still FAIL because the registry test requires the final 11-schema set and only two schemas exist. This is a deliberate intermediate RED, not a defect to hide.

- [ ] **Step 9: Commit the independently reviewable foundation**

Commit message: `feat: establish canonical domain schema toolchain`

---

## Task 2 — Goal and Task contracts

**Files:**

- Create: `schemas/domain/v1/goal.schema.json`
- Create: `schemas/domain/v1/task.schema.json`
- Create: `packages/contracts/test/fixtures/v1.ts` with initial Workspace/Goal/Task fixtures
- Create: `packages/contracts/test/fixtures.test.ts`

**Interfaces:**

- Produces top-level schemas `urn:mindrail:schema:domain:v1:goal` and `...:task`.
- Produces fixture catalogue keyed by schema `$id`.

- [ ] **Step 1: Write positive and negative fixtures first**

In `packages/contracts/test/fixtures/v1.ts`, export:

```ts
export const validFixtures: Record<string, unknown[]> = {
  /* populated with exact minimal records */
};
export const invalidFixtures: Record<string, unknown[]> = {
  /* each item intentionally violates one structural rule */
};
```

Include at minimum:

- Workspace: one minimal valid record; invalid unknown field; invalid non-UTC timestamp.
- Goal: one minimal valid record; invalid empty success criteria; invalid unknown status.
- Task: one minimal valid record; invalid duplicate capabilities; invalid duplicate dependency ids; invalid unknown field.

Use deterministic ids such as `ws_1`, `goal_1`, `task_1` and timestamp `2026-08-29T00:00:00Z`.

Create `packages/contracts/test/fixtures.test.ts` that obtains the validator by `$id` and asserts all valid fixtures pass and every invalid fixture fails.

- [ ] **Step 2: Run fixtures test and record RED**

Run: `pnpm vitest run packages/contracts/test/fixtures.test.ts`

Expected: FAIL because Goal/Task schemas do not exist.

- [ ] **Step 3: Implement Goal schema**

Required fields:

```text
id, workspaceId -> EntityId
revision integer >= 1
createdAt, updatedAt -> UtcDateTime
title string 1..160
objective string 1..8000
successCriteria array 1..32, each string 1..1000
status active|succeeded|failed|cancelled
```

Set `$id` to `urn:mindrail:schema:domain:v1:goal` and `additionalProperties: false`.

- [ ] **Step 4: Implement Task schema**

Required fields:

```text
id, workspaceId, goalId -> EntityId
revision integer >= 1
createdAt, updatedAt -> UtcDateTime
title string 1..160
objective string 1..8000
acceptanceCriteria array 1..32, each string 1..1000
requiredCapabilities array max 64, uniqueItems true, items NamespacedName
dependencyTaskIds array max 128, uniqueItems true, items EntityId
status pending|ready|running|blocked|succeeded|failed|cancelled
```

Optional `statusReason -> Reason`. Set `additionalProperties: false`.

Do not encode dependency acyclicity, same-goal dependency, self-dependency, or capability-to-Agent matching as local JSON Schema; those remain cross-record runtime invariants.

- [ ] **Step 5: Run Task/Goal fixtures**

Run: `pnpm vitest run packages/contracts/test/fixtures.test.ts`

Expected: Workspace/Goal/Task fixture cases PASS; overall compilation test still RED until all top-level schemas exist.

- [ ] **Step 6: Commit**

Commit message: `feat: define goal and task contracts`

---

## Task 3 — Agent, Session, and Lease contracts

**Files:**

- Create: `schemas/domain/v1/agent.schema.json`
- Create: `schemas/domain/v1/session.schema.json`
- Create: `schemas/domain/v1/lease.schema.json`
- Modify: `packages/contracts/test/fixtures/v1.ts`

**Interfaces:**

- Agent capabilities are exact `NamespacedName` strings.
- Session references one Agent by `agentId`.
- Lease references one Task and Session and carries `fencingToken`.

- [ ] **Step 1: Add failing fixtures**

Add minimal valid Agent/Session/Lease fixtures and invalid fixtures for:

- Agent duplicate capabilities;
- Session unknown status;
- Session timestamp with non-UTC offset;
- Lease fencing token `0`;
- Lease unknown status;
- Lease unknown property.

Run focused fixture tests and observe RED because schemas are absent.

- [ ] **Step 2: Implement Agent schema**

Fields:

```text
id, workspaceId -> EntityId
revision >= 1
createdAt, updatedAt -> UtcDateTime
displayName string 1..160
status active|disabled
capabilities unique array max 64 of NamespacedName
```

All listed fields required; additional properties false.

- [ ] **Step 3: Implement Session schema**

Required:

```text
id, workspaceId, agentId -> EntityId
revision >= 1
createdAt, updatedAt, lastSeenAt -> UtcDateTime
status active|ended|expired
```

Optional `endedAt -> UtcDateTime`. Additional properties false.

- [ ] **Step 4: Implement Lease schema**

Required:

```text
id, workspaceId, taskId, sessionId -> EntityId
revision >= 1
createdAt, updatedAt, expiresAt -> UtcDateTime
status active|released|expired|revoked
fencingToken integer >= 1
```

Additional properties false.

Do not encode “at most one active lease”, monotonic fencing across records, or same-workspace lookup rules locally.

- [ ] **Step 5: Run fixtures and compilation**

Run:

```bash
pnpm vitest run packages/contracts/test/fixtures.test.ts
pnpm vitest run packages/contracts/test/schema-compilation.test.ts
```

Expected: fixtures for all seven implemented top-level schemas PASS; compilation count remains RED until the four append-only record schemas are added.

- [ ] **Step 6: Commit**

Commit message: `feat: define agent session and lease contracts`

---

## Task 4 — Checkpoint, permissions, and audit contracts

**Files:**

- Create: `schemas/domain/v1/checkpoint.schema.json`
- Create: `schemas/domain/v1/permission-request.schema.json`
- Create: `schemas/domain/v1/permission-decision.schema.json`
- Create: `schemas/domain/v1/audit-event.schema.json`
- Modify: `packages/contracts/test/fixtures/v1.ts`

**Interfaces:**

- Append-only records contain `createdAt` but no `revision` or `updatedAt`.
- Permission decisions form a deterministic append-only chain through `sequence` and optional `supersedesDecisionId`.
- Audit attributes are the only dynamic object surface and are flat/bounded.

- [ ] **Step 1: Add failing fixtures covering security boundaries**

Add valid minimal fixtures for all four schemas and invalid fixtures for:

- Checkpoint summary over 4000 chars or evidence over 32 items;
- malformed EvidenceRef SHA-256;
- PermissionRequest empty justification;
- policy-basis PermissionDecision without `policyRef`;
- `HUMAN_REQUIRED` with `basis: human`;
- human decision with `decidedBy.type: agent`;
- AuditEvent attributes with 17 keys;
- AuditEvent nested object or array attribute;
- AuditEvent attribute key not matching NamespacedName;
- unknown top-level field on every new schema.

Run the fixture test and record RED.

- [ ] **Step 2: Implement Checkpoint schema**

Required:

```text
id, workspaceId, taskId, sessionId, leaseId -> EntityId
fencingToken integer >= 1
createdAt -> UtcDateTime
kind progress|handoff|blocked|result
summary string 1..4000
evidence array max 32 of EvidenceRef
```

Optional `progressPercent` integer 0..100. Additional properties false.

- [ ] **Step 3: Implement PermissionRequest schema**

Required:

```text
id, workspaceId, taskId, sessionId, leaseId -> EntityId
fencingToken integer >= 1
createdAt -> UtcDateTime
permission -> NamespacedName
justification string 1..2000
```

Optional `resource -> ResourceRef`. Additional properties false.

- [ ] **Step 4: Implement PermissionDecision schema with structural conditional rules**

Base required fields:

```text
id, workspaceId, requestId -> EntityId
createdAt -> UtcDateTime
sequence integer >= 1
outcome ALLOW|DENY|HUMAN_REQUIRED
basis policy|human
decidedBy -> ActorRef
reasonCode -> NamespacedName
```

Optional:

```text
policyRef -> PolicyRef
reason string 1..2000
supersedesDecisionId -> EntityId
```

Encode these structural rules with `allOf`/`if`/`then`:

1. `basis: policy` requires `policyRef` and requires `decidedBy.type` to be `system`.
2. `basis: human` restricts `outcome` to `ALLOW|DENY` and requires `decidedBy.type` to be `human`.
3. No schema branch grants authority; this is representation validation only.

The runtime slice will enforce sequence continuity, one supersession chain, and that a human supersession targets the preceding `HUMAN_REQUIRED` decision.

- [ ] **Step 5: Implement AuditEvent schema**

Required:

```text
id, workspaceId, correlationId -> EntityId
createdAt -> UtcDateTime
eventType -> NamespacedName
actor -> ActorRef
subject -> ResourceRef
```

Optional:

```text
related: unique array max 16 of ResourceRef
transition: object additionalProperties false, required from/to, each string 1..128
attributes: object maxProperties 16
```

For `attributes`:

- `propertyNames` references NamespacedName semantics;
- each value is exactly one of string(max 500), number, boolean, null;
- arrays and nested objects are rejected;
- additional properties are only allowed when their names/values satisfy those constraints.

Top-level AuditEvent itself still uses `additionalProperties: false`.

- [ ] **Step 6: Run all schema/fixture tests and obtain first full GREEN domain schema set**

Run:

```bash
pnpm vitest run packages/contracts/test/schema-compilation.test.ts
pnpm vitest run packages/contracts/test/fixtures.test.ts
```

Expected: PASS, 11 unique schemas all compile under strict Draft 2020-12, all valid fixtures accepted, all invalid fixtures rejected.

- [ ] **Step 7: Commit**

Commit message: `feat: define checkpoint permission and audit contracts`

---

## Task 5 — Deterministic TypeScript generation and drift detection

**Files:**

- Create: `scripts/contracts/generate.mjs`
- Create: `packages/contracts/src/generated/v1/*.ts`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/generated.test.ts`
- Modify: `package.json`

**Interfaces:**

- CLI: `node scripts/contracts/generate.mjs` writes canonical generated files.
- CLI: `node scripts/contracts/generate.mjs --check` compares generated content in memory with committed files and exits non-zero on drift.
- Package barrel exports top-level generated domain types and selected common value-object types; it never defines handwritten domain shapes.

- [ ] **Step 1: Write failing generation tests**

Create `packages/contracts/test/generated.test.ts` asserting:

1. running the generator in check mode exits successfully only when committed output is current;
2. each expected generated file exists;
3. every generated file begins with a fixed comment containing `GENERATED FILE` and `DO NOT EDIT`.

Expected generated file set:

```text
common.ts
workspace.ts
goal.ts
task.ts
agent.ts
session.ts
lease.ts
checkpoint.ts
permission-request.ts
permission-decision.ts
audit-event.ts
```

Run test and observe RED because generator/output do not exist.

- [ ] **Step 2: Implement deterministic generator**

`scripts/contracts/generate.mjs` must:

1. use sorted `*.schema.json` input names;
2. call `compileFromFile` from `json-schema-to-typescript` with:
   - `cwd: schemaDirectory`;
   - `bannerComment` set to a fixed MindRail generated warning;
   - `format: false`;
   - `unreachableDefinitions: true`;
3. format returned TypeScript with the repository's pinned Prettier using parser `typescript`, print width 100, single quotes, trailing commas `all`;
4. map `foo.schema.json -> packages/contracts/src/generated/v1/foo.ts`;
5. in normal mode create directories and write all files;
6. in `--check` mode read committed outputs and compare exact UTF-8 content without writing; missing/different/extra expected generated files cause non-zero exit with a concise path list.

Do not shell out to `git diff`; drift detection should work outside Git and should not dirty a checkout.

- [ ] **Step 3: Generate committed TypeScript**

Run: `pnpm contracts:generate`

Inspect output to ensure top-level generated symbols are named `Workspace`, `Goal`, `Task`, `Agent`, `Session`, `Lease`, `Checkpoint`, `PermissionRequest`, `PermissionDecision`, and `AuditEvent`. If a schema title produces a different top-level symbol, fix the schema `title`; do not patch generated TypeScript.

- [ ] **Step 4: Create explicit handwritten barrel containing exports only**

`packages/contracts/src/index.ts` may contain only type re-exports such as:

```ts
export type { Workspace } from './generated/v1/workspace.js';
export type { Goal } from './generated/v1/goal.js';
export type { Task } from './generated/v1/task.js';
export type { Agent } from './generated/v1/agent.js';
export type { Session } from './generated/v1/session.js';
export type { Lease } from './generated/v1/lease.js';
export type { Checkpoint } from './generated/v1/checkpoint.js';
export type { PermissionRequest } from './generated/v1/permission-request.js';
export type { PermissionDecision } from './generated/v1/permission-decision.js';
export type { AuditEvent } from './generated/v1/audit-event.js';
```

If the generated common file exposes stable `$defs` names (`EntityId`, `ActorRef`, `ResourceRef`, `EvidenceRef`, `PolicyRef`, `Reason`), explicitly re-export those too. Do not invent aliases when generator output does not expose them cleanly; canonical schemas remain directly consumable by non-TypeScript clients.

- [ ] **Step 5: Make generated drift part of the single quality gate**

Change root `check` to:

```json
"check": "pnpm format:check && pnpm lint && pnpm typecheck && pnpm contracts:check-generated && pnpm test"
```

- [ ] **Step 6: Verify generation and type surface**

Run:

```bash
pnpm contracts:check-generated
pnpm --filter @mindrail/contracts typecheck
pnpm vitest run packages/contracts/test/generated.test.ts
```

Expected: PASS.

- [ ] **Step 7: Prove drift detection with a temporary mutation**

Temporarily alter one canonical schema description or one generated file, run `pnpm contracts:check-generated`, and require FAIL. Revert the temporary mutation, rerun, require PASS. Do not commit the deliberate drift.

- [ ] **Step 8: Commit**

Commit message: `feat: generate TypeScript domain bindings`

---

## Task 6 — Final verification, docs reconciliation, and PR readiness

**Files:**

- Modify: `docs/adr/ADR-0003-domain-contracts-and-schema-authority.md`
- Modify: `docs/superpowers/specs/2026-08-29-domain-contracts-design.md`
- Modify: `docs/CURRENT_STATE.md`
- Modify: `docs/roadmap/V0_1.md`
- Modify: `CHANGELOG.md`
- Modify: PR #4 metadata/body as needed

**Interfaces:** none; this task reconciles repository truth only after evidence exists.

- [ ] **Step 1: Run the complete local/CI-equivalent command set on the final tree**

Run:

```bash
pnpm install --frozen-lockfile
pnpm contracts:check-generated
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm check
```

Every command claimed PASS must actually execute. Record failures exactly and fix only root causes inside this slice.

- [ ] **Step 2: Inspect final dependency/runtime boundary**

Verify:

- `@mindrail/contracts` has no runtime dependencies;
- Ajv, ajv-formats, and json-schema-to-typescript are root dev dependencies only;
- no schema/generator imports Cloudflare, GitHub, MCP, database, auth, model, or network libraries;
- generated TypeScript contains no handwritten edits;
- canonical schema count is exactly 11 including `common.schema.json`.

- [ ] **Step 3: Accept the architecture decision and approved spec status**

Change ADR-0003 status from `Proposed` to `Accepted` and spec status from `Written review pending` to `Approved / implemented` only after the implementation matches them and verification passes. If implementation exposed a contradiction requiring a semantic change, amend the spec/ADR first and document the reason before changing status.

- [ ] **Step 4: Reconcile factual docs**

Update `docs/CURRENT_STATE.md` to distinguish:

- implemented and runtime-verified canonical contracts/generation/tests;
- cross-record invariants documented but not implemented until local runtime slice;
- `Quality` still not repository-enforced because issue #3 is deferred;
- no control-plane API/runtime/persistence yet.

Update roadmap:

- Slice 0 Development foundation: implemented/verified except deferred branch enforcement;
- Slice 1 Domain contracts: implemented/verified;
- Slice 2 remains planned.

Update `CHANGELOG.md` with canonical schemas, generated bindings, validation/drift tests, and explicit non-capabilities.

- [ ] **Step 5: Run final `pnpm check` after documentation changes**

Expected: PASS. Formatting failures from Markdown count as real failures and must be fixed with pinned Prettier.

- [ ] **Step 6: Require a fresh GitHub Actions `quality` success on the final head**

Do not rely on an earlier green commit. Record the final run id and conclusion.

- [ ] **Step 7: Review the PR diff for scope and security**

Reject before merge if the diff contains:

- network/database/cloud runtime code;
- auth/billing/account model;
- generic metadata dumping surfaces;
- model-driven permission authority;
- wildcard capability semantics;
- event-sourcing infrastructure;
- generated TypeScript edits not reproducible from schemas.

- [ ] **Step 8: Commit final reconciliation**

Commit message: `docs: reconcile verified domain contracts`

## Exit Condition

The Domain Contracts slice is complete only when all 11 canonical schemas compile under strict Draft 2020-12 validation, positive/negative fixture tests pass, generated TypeScript is reproducible and drift-checked, the full repository quality gate passes on the final head, and current-state documentation explicitly leaves cross-record orchestration behavior to the later runtime slice.
