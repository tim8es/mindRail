# MindRail Development Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the repository, documentation, licensing, agent workflow, and TypeScript quality baseline that make future MindRail development fast, auditable, and consistent.

**Architecture:** Keep the repository intentionally minimal. Establish authoritative documentation and policy first, then add only root-level TypeScript tooling needed to validate future packages. No control-plane runtime, Cloudflare resources, protocol implementation, or speculative package structure is introduced in this slice.

**Tech Stack:** Markdown, BSL 1.1, Node.js 22 LTS, pnpm 10, TypeScript 5, ESLint 9 flat config, Prettier 3, Vitest 3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-29-development-foundation-design.md`

## Global Constraints

- MindRail remains source-available under Business Source License 1.1 during the BSL period; do not describe it as OSI Open Source.
- The Additional Use Grant must permit development, testing, research, personal/self-hosted use, and internal business use while restricting offering MindRail itself as a competing hosted/managed commercial service without a commercial license.
- BSL parameters must include a Change Date and `AGPL-3.0-or-later` as the Change License.
- No control-plane API, runtime domain models, Cloudflare resources, MCP/HTTP agent protocol, adapters, UI, LLM framework, or production deployment is implemented in this slice.
- `AGENTS.md` must stay concise and route agents to authoritative repository context rather than duplicate it.
- Accepted ADRs outrank current-state and architecture documentation; roadmap documents never prove implementation.
- Never claim an unexecuted validation as passing.
- Do not add a dependency without a concrete repository-quality purpose.
- CI must use least-privilege permissions and no production credentials.

---

## File map

### Repository contracts and public documentation
- `AGENTS.md` — concise execution contract and context bootstrap for coding agents.
- `README.md` — public product framing, present state, architecture summary, and development status.
- `CONTRIBUTING.md` — contribution workflow, branching, commits, tests, docs, ADRs, licensing notice.
- `SECURITY.md` — reporting process and security posture.
- `LICENSE` — official BSL 1.1 text plus MindRail project parameters.
- `CHANGELOG.md` — unreleased 0.x changelog.

### Authoritative project knowledge
- `docs/00_PROJECT_INDEX.md` — low-cost routing index.
- `docs/CURRENT_STATE.md` — factual implemented/planned/blocked state.
- `docs/architecture/01_SYSTEM_OVERVIEW.md` — architecture derived from accepted ADRs.
- `docs/adr/README.md` — ADR process and index.
- `docs/adr/ADR-0001-system-boundaries.md` — accepted system-boundary decision.
- `docs/adr/ADR-0002-licensing-model.md` — accepted licensing decision.
- `docs/development/ENGINEERING_STANDARDS.md` — code, dependency, testing, and verification standards.
- `docs/development/AGENT_WORKFLOW.md` — lifecycle for agent-driven changes.
- `docs/development/REVIEW_CHECKLIST.md` — evidence-oriented review gate.
- `docs/roadmap/V0_1.md` — planned v0.1 slices, explicitly non-authoritative for current capability.

### Tooling and CI
- `package.json` — repository metadata, pinned package manager, engines, and root quality scripts.
- `pnpm-workspace.yaml` — workspace root with future package locations omitted until needed.
- `tsconfig.base.json` — strict TypeScript baseline.
- `eslint.config.js` — minimal ESLint flat config for JS/TS files.
- `prettier.config.mjs` — deterministic formatting policy.
- `.editorconfig` — editor-neutral formatting defaults.
- `.gitignore` — Node/tooling artifacts and local secrets.
- `src/foundation.ts` — tiny typed sentinel module proving the root TypeScript quality pipeline actually executes; it is repository tooling evidence, not product runtime.
- `test/foundation.test.ts` — behavioral smoke test for the sentinel module.
- `.github/PULL_REQUEST_TEMPLATE.md` — evidence-focused PR template.
- `.github/ISSUE_TEMPLATE/bug.yml` — short bug template.
- `.github/ISSUE_TEMPLATE/feature.yml` — short feature template.
- `.github/ISSUE_TEMPLATE/architecture.yml` — architecture/ADR template.
- `.github/workflows/quality.yml` — canonical CI quality gate.

---

### Task 1: Establish authoritative project documentation

**Files:**
- Create: `AGENTS.md`
- Create: `README.md`
- Create: `docs/00_PROJECT_INDEX.md`
- Create: `docs/CURRENT_STATE.md`
- Create: `docs/architecture/01_SYSTEM_OVERVIEW.md`
- Create: `docs/roadmap/V0_1.md`

**Interfaces:**
- Consumes: approved design spec and previously agreed MindRail architecture.
- Produces: the authoritative-document hierarchy all later contributors and agents must follow.

- [ ] **Step 1:** Write `AGENTS.md` with the exact precedence order, startup reading sequence, minimal-change rule, ADR stop condition, evidence requirements, and prohibition on claiming unexecuted checks.
- [ ] **Step 2:** Write `docs/00_PROJECT_INDEX.md` as a routing index with one-line descriptions and authority level for each document family.
- [ ] **Step 3:** Write `docs/CURRENT_STATE.md` with separate sections for verified, implemented-not-runtime-verified, planned, and externally blocked work. Record that only repository foundation work exists.
- [ ] **Step 4:** Write `docs/architecture/01_SYSTEM_OVERVIEW.md` describing control-repo vs runtime state, agent/client boundary, deterministic policy decisions, provider-neutral adapters, and reference deployment portability without claiming implementation.
- [ ] **Step 5:** Write `docs/roadmap/V0_1.md` with ordered slices: foundation; domain contracts; protocol; local/reference runtime; GitHub adapter; Cloudflare reference deployment; ChatGPT/Codex integration. Mark every item planned unless implemented.
- [ ] **Step 6:** Write `README.md` with problem statement, architecture diagram, current status, vendor-neutral positioning, repository navigation, development commands placeholder that will be valid after Task 4, and accurate source-available wording.
- [ ] **Step 7:** Review all six documents for conflicting authority statements or claims that planned functionality already exists.

### Task 2: Record architecture and licensing decisions

**Files:**
- Create: `docs/adr/README.md`
- Create: `docs/adr/ADR-0001-system-boundaries.md`
- Create: `docs/adr/ADR-0002-licensing-model.md`
- Create: `LICENSE`

**Interfaces:**
- Consumes: authoritative-document hierarchy from Task 1 and the approved BSL direction.
- Produces: binding system-boundary and licensing decisions for later implementation.

- [ ] **Step 1:** Write `docs/adr/README.md` defining Proposed/Accepted/Superseded/Rejected states, monotonic numbering, accepted-ADR immutability, and required sections.
- [ ] **Step 2:** Write accepted ADR-0001 covering vendor neutrality, separation of declarative config from operational state, Git as declarative source rather than task DB, agents as clients rather than system of record, deterministic permission policy, and reference-runtime portability.
- [ ] **Step 3:** Write accepted ADR-0002 covering BSL 1.1, source-available terminology, permitted internal/self-hosted use, restriction on competing hosted/managed commercialization, Change License `AGPL-3.0-or-later`, Change Date policy, and future CLA requirement before accepting external contributions.
- [ ] **Step 4:** Add the official BSL 1.1 license text and project parameters. Use a conservative Additional Use Grant aligned with ADR-0002 and explicitly flag it for legal review before public launch.
- [ ] **Step 5:** Cross-check README, ADR-0002, and LICENSE so commercial-use wording does not contradict itself.

### Task 3: Establish contribution, security, agent, and review workflows

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `docs/development/ENGINEERING_STANDARDS.md`
- Create: `docs/development/AGENT_WORKFLOW.md`
- Create: `docs/development/REVIEW_CHECKLIST.md`
- Create: `CHANGELOG.md`

**Interfaces:**
- Consumes: ADR-0001, ADR-0002, `AGENTS.md`.
- Produces: deterministic contributor and agent execution/review process.

- [ ] **Step 1:** Write engineering standards covering strict TypeScript, dependency discipline, TDD for behavioral changes, small modules, no speculative abstractions, evidence-based verification, documentation updates, and conventional commits.
- [ ] **Step 2:** Write agent workflow covering context bootstrap, task scoping, branch isolation, plan/ADR triggers, implementation loop, test evidence, current-state update, and handoff format.
- [ ] **Step 3:** Write review checklist rejecting hidden scope expansion, undocumented architecture changes, unexecuted-test claims, roadmap-as-reality claims, excessive permissions, and unnecessary dependencies.
- [ ] **Step 4:** Write CONTRIBUTING with branch naming (`feat/`, `fix/`, `docs/`, `chore/`, `adr/`), conventional commits, quality command requirements, ADR rules, and licensing/contribution notice.
- [ ] **Step 5:** Write SECURITY with private reporting guidance, least-privilege principles, credential isolation, auditable permission decisions, and explicit non-claims about unverified security properties.
- [ ] **Step 6:** Write CHANGELOG with `[Unreleased]` and initial repository-foundation entries only.

### Task 4: Add minimal executable TypeScript quality baseline

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `eslint.config.js`
- Create: `prettier.config.mjs`
- Create: `.editorconfig`
- Create: `.gitignore`
- Create: `src/foundation.ts`
- Create: `test/foundation.test.ts`

**Interfaces:**
- Consumes: engineering standards from Task 3.
- Produces: stable root commands `format:check`, `lint`, `typecheck`, `test`, `test:coverage`, `check` and a minimal executable test target.

- [ ] **Step 1:** Add `src/foundation.ts` exporting `FOUNDATION_VERSION = "0.1" as const` and `getFoundationStatus()` returning `{ version: FOUNDATION_VERSION, runtimeImplemented: false } as const`.
- [ ] **Step 2:** Add `test/foundation.test.ts` asserting the exact status object. This intentionally proves the test runner, TS transform, and import graph work without pretending product runtime exists.
- [ ] **Step 3:** Add `package.json` with `private: true`, version `0.0.0`, Node `>=22 <23`, `packageManager: pnpm@10.15.0`, ES modules, and scripts: `format`, `format:check`, `lint`, `typecheck`, `test`, `test:coverage`, `check`.
- [ ] **Step 4:** Add only these dev dependencies: `typescript`, `vitest`, `@vitest/coverage-v8`, `eslint`, `@eslint/js`, `typescript-eslint`, `prettier`, `globals`.
- [ ] **Step 5:** Add strict `tsconfig.base.json` using ES2022/NodeNext-compatible settings, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noEmit`.
- [ ] **Step 6:** Add minimal ESLint flat config for repository JS/MJS/TS with recommended JS and TypeScript rules and Node globals.
- [ ] **Step 7:** Add deterministic Prettier and EditorConfig defaults and a conservative `.gitignore` covering dependencies, coverage, build output, env files, OS/editor artifacts.
- [ ] **Step 8:** Add `pnpm-workspace.yaml` with an empty/future-safe package pattern only when directories exist; otherwise keep a root-only workspace declaration that does not invent packages.
- [ ] **Step 9:** Generate and commit `pnpm-lock.yaml` during executable verification. If the execution environment cannot run pnpm, do not fabricate the lockfile; record the limitation in `CURRENT_STATE.md` instead.

### Task 5: Add GitHub contribution surfaces and CI

**Files:**
- Create: `.github/PULL_REQUEST_TEMPLATE.md`
- Create: `.github/ISSUE_TEMPLATE/bug.yml`
- Create: `.github/ISSUE_TEMPLATE/feature.yml`
- Create: `.github/ISSUE_TEMPLATE/architecture.yml`
- Create: `.github/workflows/quality.yml`

**Interfaces:**
- Consumes: contribution workflow and canonical root quality command.
- Produces: human/agent submission templates and reproducible GitHub Actions validation.

- [ ] **Step 1:** Add a PR template covering purpose, scope, architecture/ADR impact, checks actually executed, documentation, security/permission impact, limitations, and explicit verification evidence.
- [ ] **Step 2:** Add concise issue forms for bugs, features, and architecture decisions. Architecture form must ask whether an ADR is expected.
- [ ] **Step 3:** Add GitHub Actions workflow triggered by pull requests and pushes to `main`, with `contents: read`, Node 22, pnpm 10.15.0, frozen install, and `pnpm check`.
- [ ] **Step 4:** Ensure pull-request CI has no write permissions and references no secrets.

### Task 6: Verify and reconcile repository truth

**Files:**
- Modify: `docs/CURRENT_STATE.md`
- Modify: `CHANGELOG.md` if verification reveals noteworthy limitations.
- Modify: any foundation file only to correct issues discovered by verification.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that the repository foundation is coherent and an accurate current-state record.

- [ ] **Step 1:** Run/install verification in a real checkout: `pnpm install --frozen-lockfile` after the lockfile exists, otherwise `pnpm install` once to create it.
- [ ] **Step 2:** Run `pnpm format:check` and fix only formatting failures.
- [ ] **Step 3:** Run `pnpm lint` and fix only lint failures.
- [ ] **Step 4:** Run `pnpm typecheck` and fix only type failures.
- [ ] **Step 5:** Run `pnpm test` and confirm the smoke test executes.
- [ ] **Step 6:** Run `pnpm test:coverage` without inventing a coverage threshold.
- [ ] **Step 7:** Run `pnpm check` as the canonical aggregate quality gate.
- [ ] **Step 8:** Push/inspect GitHub Actions and only record CI as passing if an actual workflow run succeeds. If connector/runtime limitations prevent execution, record it as unverified.
- [ ] **Step 9:** Re-read `AGENTS.md`, accepted ADRs, `CURRENT_STATE.md`, architecture overview, README, and roadmap; correct any contradiction or false implementation claim.
- [ ] **Step 10:** Update `CURRENT_STATE.md` with exact executed evidence and unresolved limitations.

## Self-review

- Spec coverage: every design-spec requirement is mapped to Tasks 1–6; product runtime remains explicitly excluded.
- Placeholder scan: implementation steps contain concrete file responsibilities and exact validation commands; legal review is deliberately a documented release condition rather than a hidden TODO.
- Type consistency: root script names exactly match the design spec and CI consumes only `pnpm check`.
- Scope check: the sentinel module is intentionally tiny and exists only to make typecheck/lint/test tooling executable; it does not create a product package or runtime abstraction.
