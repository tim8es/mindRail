# Current State

**Last reconciled:** 2026-08-29

This document describes what exists, not what is intended. Roadmap items are never evidence of implementation.

## Implemented and verified

The following facts were verified through GitHub repository/API evidence and executed GitHub Actions runs:

- Repository `tim8es/mindRail` is public with `main` as the default branch.
- Development-foundation design and implementation records exist under `docs/superpowers/`.
- Branch `foundation/development-foundation` contains the authoritative project index/current-state discipline, system overview, v0.1 roadmap, ADR process, accepted ADR-0001/ADR-0002, contribution/security/engineering/agent-review documentation, BUSL-1.1 license parameters, TypeScript quality configuration, foundation sentinel test, GitHub issue/PR templates, lockfile, and permanent read-only quality workflow.
- Permanent `Quality` CI requests only `contents: read`, references no production secrets, derives Node/pnpm versions from repository package metadata, and pins GitHub-owned actions to immutable commits corresponding to `actions/checkout` v7.0.1 and `actions/setup-node` v6.4.0.
- Domain Contracts are implemented on branch `adr/domain-contracts` under draft PR #4, stacked on draft foundation PR #1. The slice is not merged into `main`.
- ADR-0003 is accepted for the v1 domain contract and schema-authority decision.
- JSON Schema Draft 2020-12 under `schemas/domain/v1/` is the canonical source for 10 v1 entities plus shared definitions: `Workspace`, `Goal`, `Task`, `Agent`, `Session`, `Lease`, `Checkpoint`, `PermissionRequest`, `PermissionDecision`, and `AuditEvent`.
- Generated TypeScript bindings under `packages/contracts/src/generated/v1/` are derived artifacts. `contracts:check-generated` compares deterministic generated output with committed files; generated files remain TypeScript-checked and Prettier-checked even though ESLint excludes them.
- Strict Ajv Draft 2020-12 validation, positive/negative fixtures, generated-output tests, and explicit schema-invariant tests execute in Vitest.
- The schema layer preserves Workspace isolation fields, separates Agent/Session/Task/Lease, keeps Lease fencing separate from Task state, restricts permission outcomes to `ALLOW` / `DENY` / `HUMAN_REQUIRED`, restricts policy decisions to system actors and human decisions to human actors, and keeps audit history append-only without adopting event sourcing.
- All 10 top-level v1 entity schemas use `additionalProperties: false`. Text/array/evidence/audit extension surfaces are bounded; timestamps are RFC 3339 `date-time` values normalized to trailing `Z`; identifiers remain opaque bounded strings; mutable entities require positive revisions; lease/checkpoint/permission fencing tokens are positive integers.
- `@mindrail/contracts` has zero runtime dependencies. `@types/node`, Ajv, ajv-formats, and json-schema-to-typescript are root dev dependencies only.
- GitHub Actions verification run `33251135323` on branch commit `a7d13afa265589d91f0754f98c19301482bfffe9` executed and passed `pnpm install --frozen-lockfile`, `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm contracts:check-generated`, `pnpm test`, and `pnpm check` as separate gates. Vitest reported 5/5 test files and 10/10 tests passing.
- The same verification run executed `pnpm test:coverage`; V8 reported 100% statements/branches/functions/lines for the files instrumented by the current test suite. This is not a claim of a repository-wide coverage threshold.
- The same verification run proved negative generated drift: an intentional change to generated `workspace.ts` caused `contracts:check-generated` to fail with `Generated contracts are stale: workspace.ts`; restoring the file made the command pass again and `git diff --exit-code` confirmed a clean checkout.
- `pnpm install --frozen-lockfile` reported that the lockfile passed pnpm supply-chain policy checks for 188 entries.
- The standard BUSL-1.1 body in `LICENSE` was compared with the SPDX-published BUSL-1.1 text; MindRail-specific parameters are kept separately above it.

## Implemented but not fully enforced

- `Quality` is executable and green on verified Domain Contracts commits, but it is not yet a mandatory repository-level merge gate on `main`.
- Issue #3 tracks enabling and verifying the minimal `main` protection/ruleset.
- JSON Schema enforces structural permission-decision supersession shape (`sequence = 1` has no predecessor; later decisions require `supersedesDecisionId`), but cross-record chain continuity remains a future runtime invariant.
- Workspace cross-reference resolution, capability satisfaction, dependency acyclicity, one-active-lease enforcement, monotonic lease fencing, stale-actor rejection, optimistic revision comparison, and append-only persistence behavior require state/storage and are intentionally deferred to the local runtime slice.

## Planned

- Vendor-neutral agent/control-plane protocol.
- Deterministic task/state transition and permission-policy engine.
- Reference runtime and persistence interfaces, including the cross-record invariants documented by ADR-0003.
- GitHub integration.
- Cloudflare Workers/Durable Objects/D1 reference deployment.
- Codex, ChatGPT, MCP, and generic HTTP integration paths.
- Optional projections such as Google Sheets.

## External / non-technical follow-up

- MindRail-specific BUSL-1.1 parameters, Change License compatibility, licensor identity, and future contribution/dual-licensing mechanics have not received professional legal review. The repository must not imply otherwise.
- External code-contribution licensing mechanics are not finalized; see `CONTRIBUTING.md`.

## Explicit non-capabilities

MindRail currently does **not** orchestrate agents, issue runtime permissions, persist tasks, run a cloud control plane, enforce cross-record lease/revision/workspace invariants, or autonomously continue ChatGPT/Codex sessions. Those remain later implementation slices.
