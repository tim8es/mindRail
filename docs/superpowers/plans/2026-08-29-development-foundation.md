# MindRail Development Foundation Implementation Plan

> **Execution record:** This plan was approved and executed in `foundation/development-foundation`. It is retained as a task record, not an authoritative source of repository truth. `AGENTS.md`, accepted ADRs, `docs/CURRENT_STATE.md`, and actual repository configuration outrank it.

**Goal:** Establish the repository, documentation, licensing, agent workflow, and TypeScript quality baseline that make future MindRail development fast, auditable, and consistent.

**Architecture:** Keep the repository intentionally minimal. Establish authoritative documentation and policy first, then add only root-level TypeScript tooling needed to validate future packages. No control-plane runtime, Cloudflare resources, protocol implementation, or speculative package structure is introduced in this slice.

**Tech Stack (verified):** Markdown, BUSL-1.1, Node.js 24, pnpm 11.24.0, TypeScript 6.0.3, ESLint 10.9.1, `@eslint/js` 10.0.1, typescript-eslint 8.68.0, Prettier 3.9.6, Vitest 4.1.11, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-29-development-foundation-design.md`

## Global constraints

- MindRail remains source-available under BUSL-1.1 during the BSL period; do not describe it as OSI Open Source.
- BUSL-1.1 is not a blanket prohibition on redistribution.
- MindRail-specific licensing parameters require professional review before material commercial reliance.
- No control-plane API, runtime domain models, Cloudflare resources, MCP/HTTP orchestration protocol, adapters, UI, LLM framework, or production deployment is implemented in this slice.
- `AGENTS.md` stays concise and routes agents to authoritative context rather than duplicating it.
- Never claim an unexecuted validation passed.
- Permanent pull-request CI uses least privilege and no production credentials.
- A CI workflow is not an enforced quality gate until repository rules actually block non-compliant merges/pushes.

## Task 1 — Authoritative project documentation

**Status:** complete for this slice.

- [x] Define the authority hierarchy and low-context agent bootstrap.
- [x] Separate factual current state from roadmap intent.
- [x] Document the target vendor-neutral system boundary without claiming runtime implementation.
- [x] Define ordered v0.1 implementation slices.

## Task 2 — Architecture and licensing decisions

**Status:** repository decision complete; professional legal review remains external follow-up.

- [x] Define ADR lifecycle and monotonic numbering.
- [x] Accept ADR-0001 system boundaries.
- [x] Accept ADR-0002 BUSL-1.1 direction and intended AGPL-3.0-or-later Change License.
- [x] Keep standard BUSL-1.1 text separate from project parameters.
- [ ] Obtain professional review of licensor identity, Additional Use Grant, Change License compatibility, and contribution/dual-license mechanics.

## Task 3 — Engineering, agent, security, and review workflow

**Status:** complete for this slice.

- [x] Define strict TypeScript, dependency discipline, TDD expectations, evidence-based verification, documentation discipline, and conventional commits.
- [x] Define agent lifecycle from context bootstrap through evidence-based handoff.
- [x] Define review criteria for scope creep, architecture drift, permission expansion, unsupported claims, and unnecessary dependencies.
- [x] Define security reporting and least-privilege principles.

## Task 4 — Executable TypeScript quality baseline

**Status:** verified.

- [x] Use Node.js 24 and pinned pnpm 11.24.0.
- [x] Configure supported TypeScript/lint/test/format tooling.
- [x] Use explicit root-only pnpm workspace (`packages: ['.']`).
- [x] Generate and commit `pnpm-lock.yaml` with the real pinned toolchain.
- [x] Execute frozen install successfully.
- [x] Execute `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, aggregate `pnpm check`, and `pnpm test:coverage` successfully.

## Task 5 — GitHub contribution surfaces, CI, and enforcement

**Status:** CI verified; repository-level enforcement pending.

- [x] Add concise evidence-focused PR and issue templates.
- [x] Add permanent CI for pull requests and pushes to `main`.
- [x] Restrict permanent workflow permissions to `contents: read` and use no production secrets.
- [x] Pin GitHub-owned actions by immutable commit SHA.
- [x] Derive Node and pnpm versions from `package.json`.
- [x] Require a committed lockfile and frozen install before `pnpm check`.
- [x] Observe `Quality` execute successfully on a GitHub-hosted runner.
- [ ] Make `Quality` an enforced merge requirement on `main`, require PRs, and block force-push/deletion; tracked by #3.

## Task 6 — Verification and repository-truth reconciliation

**Status:** executable verification complete; enforcement verification pending.

- [x] Verify repository/configuration structure.
- [x] Generate and verify the lockfile with the pinned toolchain.
- [x] Run formatting, lint, typecheck, tests, coverage, and aggregate quality gate with observed success.
- [x] Reconcile `docs/CURRENT_STATE.md` with fresh evidence.
- [ ] Enable and test `main` repository protection/ruleset requiring `Quality`.

## Exit condition

The development/tooling foundation is executable and verified. The remaining foundation infrastructure item is repository-level enforcement on `main` (#3); the remaining licensing item is external professional review. Product/runtime capabilities remain deliberately out of scope for this slice.
