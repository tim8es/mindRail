# MindRail Development Foundation Implementation Plan

> **Execution record:** This plan was approved and executed in `foundation/development-foundation`. It is retained as a task record, not an authoritative source of repository truth. `AGENTS.md`, accepted ADRs, `docs/CURRENT_STATE.md`, and the actual repository configuration outrank it.

**Goal:** Establish the repository, documentation, licensing, agent workflow, and TypeScript quality baseline that make future MindRail development fast, auditable, and consistent.

**Architecture:** Keep the repository intentionally minimal. Establish authoritative documentation and policy first, then add only root-level TypeScript tooling needed to validate future packages. No control-plane runtime, Cloudflare resources, protocol implementation, or speculative package structure is introduced in this slice.

**Tech Stack (as executed):** Markdown, BUSL-1.1, Node.js 24, pnpm 11.24.0, TypeScript 6.0.3, ESLint 10.9.1 flat config, typescript-eslint 8.68.0, Prettier 3.9.0, Vitest 4.1.11, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-08-29-development-foundation-design.md`

## Global constraints

- MindRail remains source-available under BUSL-1.1 during the BSL period; do not describe it as OSI Open Source.
- BUSL-1.1 is not a blanket prohibition on redistribution. The project grant is aimed at permitting internal/self-hosted production use while keeping competing hosted/managed production use outside the Additional Use Grant.
- Licensing parameters require legal review before public distribution/commercial licensing.
- No control-plane API, runtime domain models, Cloudflare resources, MCP/HTTP orchestration protocol, adapters, UI, LLM framework, or production deployment is implemented in this slice.
- `AGENTS.md` stays concise and routes agents to authoritative context rather than duplicating it.
- Accepted ADRs outrank current-state/architecture/roadmap assumptions according to the repository authority rules.
- Never claim an unexecuted validation passed.
- Do not add dependencies without a concrete repository-quality need.
- Permanent pull-request CI uses least privilege and no production credentials.
- A CI workflow is not considered an enforced quality gate until repository rules actually block non-compliant merges/pushes.

---

## Task 1 — Authoritative project documentation

**Deliverables:**

- `AGENTS.md`
- `README.md`
- `docs/00_PROJECT_INDEX.md`
- `docs/CURRENT_STATE.md`
- `docs/architecture/01_SYSTEM_OVERVIEW.md`
- `docs/roadmap/V0_1.md`

**Status:** implemented in draft PR #1.

- [x] Define the authority hierarchy and low-context agent bootstrap.
- [x] Separate factual current state from roadmap intent.
- [x] Document the target vendor-neutral system boundary without claiming runtime implementation.
- [x] Define ordered v0.1 implementation slices.
- [x] Reconcile README language with the actual foundation state.

## Task 2 — Architecture and licensing decisions

**Deliverables:**

- `docs/adr/README.md`
- `docs/adr/ADR-0001-system-boundaries.md`
- `docs/adr/ADR-0002-licensing-model.md`
- `LICENSE`

**Status:** implemented; legal review remains a pre-public-release gate.

- [x] Define Proposed/Accepted/Superseded/Rejected ADR lifecycle and monotonic numbering.
- [x] Accept system-boundary decision: declarative vs runtime authority, agents as clients, provider-neutral protocol, deterministic permission authority, replaceable reference infrastructure.
- [x] Record BUSL-1.1 source-available direction and intended AGPL-3.0-or-later Change License.
- [x] Correct the initial assumption that BSL could prohibit all commercial redistribution.
- [x] Add standard BUSL-1.1 text and conservative project parameters.
- [ ] Complete legal review of licensor identity, Additional Use Grant, Change License compatibility, and future contribution/dual-license mechanics before public release.

## Task 3 — Engineering, agent, security, and review workflow

**Deliverables:**

- `CONTRIBUTING.md`
- `SECURITY.md`
- `docs/development/ENGINEERING_STANDARDS.md`
- `docs/development/AGENT_WORKFLOW.md`
- `docs/development/REVIEW_CHECKLIST.md`
- `CHANGELOG.md`

**Status:** implemented in draft PR #1.

- [x] Define strict TypeScript, dependency discipline, TDD for behavioral work, evidence-based verification, documentation discipline, and conventional commits.
- [x] Define agent lifecycle from context bootstrap through evidence-based handoff.
- [x] Define rejection-oriented review criteria for scope creep, architecture drift, permission expansion, unsupported claims, and unnecessary dependencies.
- [x] Define private-stage security reporting and least-privilege principles.
- [x] Reconcile changelog with actual foundation changes and known limitations.

## Task 4 — Minimal executable TypeScript quality baseline

**Deliverables:**

- `package.json`
- `pnpm-workspace.yaml`
- `tsconfig.base.json`
- `eslint.config.js`
- `prettier.config.mjs`
- `.editorconfig`
- `.gitignore`
- `src/foundation.ts`
- `test/foundation.test.ts`
- `pnpm-lock.yaml` once generated by a real pinned toolchain

**Status:** configuration implemented; executable verification blocked.

- [x] Target current Node.js 24 line instead of the stale Node 22 assumption from the first plan draft.
- [x] Pin pnpm 11.24.0 and current compatible TypeScript/lint/test tooling.
- [x] Configure strict TypeScript, ESLint flat config, Prettier, EditorConfig, and conservative ignores.
- [x] Add stable root commands: `format:check`, `lint`, `typecheck`, `test`, `test:coverage`, `check`.
- [x] Add a tiny typed sentinel whose observable status explicitly says product runtime is not implemented.
- [x] Add a smoke test for that sentinel.
- [x] Use an explicit root-only pnpm workspace (`packages: ['.']`) instead of an empty package list that may make pnpm reject the workspace.
- [ ] Generate and commit `pnpm-lock.yaml` using Node 24 + pnpm 11.24.0. Do not fabricate it.
- [ ] Execute the real root quality commands.

## Task 5 — GitHub contribution surfaces, CI, and enforcement

**Deliverables:**

- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/ISSUE_TEMPLATE/bug.yml`
- `.github/ISSUE_TEMPLATE/feature.yml`
- `.github/ISSUE_TEMPLATE/architecture.yml`
- `.github/workflows/quality.yml`
- repository-level `main` protection/ruleset when the GitHub plan and Actions state allow it

**Status:** workflow implemented; hosted-runner execution and merge enforcement blocked.

- [x] Add concise evidence-focused PR and issue templates.
- [x] Add permanent CI for pull requests and pushes to `main`.
- [x] Restrict permanent workflow permissions to `contents: read` and use no production secrets.
- [x] Pin GitHub-owned actions by immutable commit SHA (`checkout` v7.0.1 and `setup-node` v6.4.0).
- [x] Derive Node and pnpm versions from `package.json` to avoid CI/toolchain version drift.
- [x] Require a committed lockfile and frozen install before `pnpm check`.
- [ ] Observe a Quality job actually execute on a runner (tracked by #2).
- [ ] Make `Quality` an enforced merge requirement on `main` and block direct/force/destructive changes once repository protection is available (tracked by #3).

The rulesets API currently reports that the private repository must either use GitHub Pro (or a higher supporting plan) or become public to enable the required repository-level enforcement. Do not fake this enforcement in workflow YAML.

## Task 6 — Verification and repository-truth reconciliation

**Status:** partially complete; executable and enforcement gates remain blocked.

Completed evidence:

- [x] Repository/API inspection confirmed the foundation files and draft PR #1.
- [x] Lightweight JSON/YAML parsing checked structural syntax of core config/forms/workflow. This is supplemental evidence only.
- [x] Multiple GitHub Actions attempts were observed and correctly recorded as failures before runner assignment rather than test failures.
- [x] Issue #2 records the runner-assignment blocker and investigation evidence.
- [x] Issue #3 records the missing repository-level quality enforcement and its plan/visibility prerequisite.
- [x] `docs/CURRENT_STATE.md` distinguishes verified facts, unverified executable tooling, planned product work, and external blockers.
- [x] Design/license wording was reconciled with accepted ADR-0002.

Still required before the foundation exit criteria are fully satisfied:

- [ ] Generate `pnpm-lock.yaml` in the pinned toolchain.
- [ ] Run `pnpm format:check`.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm test:coverage`.
- [ ] Run aggregate `pnpm check`.
- [ ] Observe a GitHub Actions Quality run with an assigned runner and real step output.
- [ ] Enable and verify `main` repository protection/ruleset requiring `Quality` before public release or multi-contributor development.
- [ ] Reconcile `docs/CURRENT_STATE.md` with that fresh evidence.

## Exit condition

Do **not** call this foundation fully verified while the executable/enforcement items above remain unchecked. The repository/documentation foundation is implemented in draft PR #1; runtime quality evidence is tracked in #2 and repository-level enforcement in #3.
