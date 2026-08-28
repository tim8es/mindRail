# MindRail Development Foundation — Design

## Status

Proposed for implementation after maintainer review.

## Purpose

The first MindRail iteration is not the orchestrator runtime itself. It is the repository and engineering foundation that makes every subsequent human or agent contribution faster, more consistent, auditable, and easier to review.

The repository is intentionally empty today, so this iteration establishes the authoritative project structure before product code creates legacy constraints.

## Product context

MindRail is a vendor-neutral control plane for autonomous AI agents. Its long-term architecture separates:

- declarative, versioned policy and project configuration;
- runtime coordination state;
- agent-facing protocols;
- integrations and adapters;
- optional reasoning providers.

The reference implementation will target TypeScript and Cloudflare, while the core contracts must remain portable to other runtimes and providers.

## Goals

This foundation must:

1. Give any new coding agent a deterministic bootstrap path into the repository.
2. Make project state, architecture, decisions, constraints, and roadmap discoverable without reading chat history.
3. Create an ADR-first process for architectural decisions.
4. Establish senior-level contribution and review standards before implementation begins.
5. Add automated quality gates that future code cannot bypass accidentally.
6. Keep the initial repository minimal: no speculative packages, services, databases, or framework abstractions.
7. Prepare the repository for future public distribution without prematurely enabling community-facing machinery that is not yet needed.

## Non-goals

This iteration does not implement:

- the MindRail control-plane API;
- Goal, Task, Agent, Session, Lease, Permission, or Event runtime models;
- Cloudflare Workers, Durable Objects, D1, or R2;
- MCP or HTTP agent protocols;
- GitHub, Google Sheets, ChatGPT, Codex, or other runtime adapters;
- a web UI;
- LLM/provider abstractions;
- production deployment.

## Repository model

The repository should begin as a modular monorepo, not a monolith and not a microservice system.

Only directories with immediate value are created. Future `packages/`, `apps/`, `adapters/`, and `integrations/` directories should be introduced by the implementation slice that first needs them.

Initial structure:

```text
mindRail/
├── AGENTS.md
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE
├── CHANGELOG.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.js
├── prettier.config.mjs
├── .editorconfig
├── .gitignore
├── docs/
│   ├── 00_PROJECT_INDEX.md
│   ├── CURRENT_STATE.md
│   ├── architecture/
│   │   └── 01_SYSTEM_OVERVIEW.md
│   ├── adr/
│   │   ├── README.md
│   │   ├── ADR-0001-system-boundaries.md
│   │   └── ADR-0002-licensing-model.md
│   ├── development/
│   │   ├── ENGINEERING_STANDARDS.md
│   │   ├── AGENT_WORKFLOW.md
│   │   └── REVIEW_CHECKLIST.md
│   └── roadmap/
│       └── V0_1.md
└── .github/
    ├── ISSUE_TEMPLATE/
    │   ├── bug.yml
    │   ├── feature.yml
    │   └── architecture.yml
    ├── PULL_REQUEST_TEMPLATE.md
    └── workflows/
        └── quality.yml
```

## Authoritative-document hierarchy

Agents must not treat all Markdown as equally authoritative.

The repository will define the following precedence:

1. `AGENTS.md` — repository execution contract for coding agents.
2. Accepted ADRs — binding architecture and policy decisions.
3. `docs/CURRENT_STATE.md` — factual description of what exists now.
4. `docs/architecture/*` — current system architecture derived from accepted ADRs.
5. `docs/roadmap/*` — planned work; never evidence that functionality exists.
6. `README.md` — public-facing overview; useful but not authoritative over ADRs/current state.

If documents conflict, the higher-precedence source wins and the inconsistency must be corrected.

## AGENTS.md contract

`AGENTS.md` is the key development accelerator.

Every coding agent must be instructed to:

1. Read `docs/00_PROJECT_INDEX.md`.
2. Read `docs/CURRENT_STATE.md`.
3. Read accepted ADRs relevant to the task.
4. Inspect current repository state rather than trusting historical summaries.
5. Make the smallest coherent change that satisfies the task.
6. Avoid speculative abstractions and premature framework adoption.
7. Add or update tests before claiming behavioral work complete.
8. Never report an unexecuted check as passing.
9. Update authoritative documentation when implementation changes current reality.
10. Stop and propose an ADR before implementing a new persistent architectural concept or breaking an accepted system boundary.
11. Prefer isolated branches/worktrees for substantial changes.
12. Report evidence: commands executed, test results, limitations, and unverified platform claims.

The file must remain short enough to be loaded by default without materially increasing agent context cost.

## Project index

`docs/00_PROJECT_INDEX.md` is a routing document, not a knowledge dump.

It tells humans and agents where to find:

- current state;
- architecture;
- accepted ADRs;
- roadmap;
- engineering standards;
- agent workflow;
- security policy;
- contribution rules.

Its purpose is to reduce context discovery cost.

## Current-state discipline

`docs/CURRENT_STATE.md` must distinguish clearly between:

- implemented and verified;
- implemented but not runtime-verified;
- planned;
- externally blocked.

Planned architecture must never be described as existing functionality.

Every substantial implementation PR should update this file if the factual repository capability changes.

## ADR process

Architecture decisions that affect persistent contracts, security boundaries, storage authority, protocol semantics, licensing, compatibility guarantees, or deployment topology require ADRs.

ADR states:

- Proposed
- Accepted
- Superseded
- Rejected

Each ADR includes:

- context;
- decision;
- alternatives considered;
- consequences;
- compatibility/migration implications where relevant.

ADR numbering is monotonic. Accepted ADRs are immutable except for typo-level corrections; changed decisions are recorded by a superseding ADR.

## Initial ADRs

### ADR-0001 — System boundaries

Captures the architecture already agreed in design discussions:

- MindRail is a vendor-neutral control plane/protocol with a reference implementation.
- Declarative configuration and runtime state are separate concerns.
- Git is the versioned source of declarative policy/configuration, not the operational task database.
- Runtime coordination must remain behind interfaces so Cloudflare is a reference deployment, not a protocol dependency.
- Agents are executors/clients, not the system of record.
- Permission decisions are policy-driven and deterministic by default; an LLM may propose actions but does not unilaterally mint authority.

### ADR-0002 — Licensing model

Records the approved direction:

- Business Source License 1.1 for current releases;
- source-available rather than claiming OSI Open Source status during the BSL period;
- free development, testing, research, personal/self-hosted use and internal business use should remain possible under the Additional Use Grant;
- commercial redistribution or offering MindRail itself as a competing hosted/managed service requires a commercial license from the rights holder;
- each BSL release must define a Change Date and Change License;
- target Change License: AGPL-3.0-or-later unless superseded by a later accepted ADR;
- contribution policy must preserve the project's ability to dual-license future community contributions, with CLA/DCO mechanics finalized before accepting external contributions.

The exact Additional Use Grant language is a legal-text implementation detail and must be written conservatively and reviewed before the repository becomes public.

## Public documentation

### README

The README should explain, without hype:

- the problem: autonomous agents still lack a shared external control plane;
- the MindRail model: goal -> coordination -> agent execution -> evidence -> continue/escalate;
- what exists today versus roadmap;
- why the project is vendor-neutral;
- status: early/private development;
- license status accurately as BSL/source-available.

It must not claim capabilities that are not implemented.

### CONTRIBUTING

Initially documents the expected workflow even while the repository remains private:

- issue/ADR before significant architecture changes;
- branch naming;
- conventional commits;
- test and documentation expectations;
- review standards;
- licensing/contribution notice.

### SECURITY

Defines responsible reporting and states the intended security posture: least privilege, no implicit credential propagation to agents, auditable permission decisions, and no security claims without verification.

## Engineering baseline

The foundation will establish only ecosystem-level tooling needed by future TypeScript work.

### Runtime/tool choices

- Node.js: current active LTS line, pinned in `package.json` engines once implementation verifies the exact supported range.
- TypeScript: strict mode.
- Package manager: pnpm with repository-managed version declaration.
- Test runner: Vitest.
- Lint: ESLint flat config.
- Formatting: Prettier.
- CI: GitHub Actions.

No production framework is selected in this slice.

### Root scripts

The repository should converge on these stable commands:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm check
```

`pnpm check` is the local equivalent of the required CI quality gate.

## Quality gate

`.github/workflows/quality.yml` runs on pull requests and pushes to `main`.

It should:

1. install the pinned Node/pnpm environment;
2. install dependencies with a frozen lockfile;
3. run formatting checks;
4. run lint;
5. run TypeScript type checking;
6. run tests;
7. fail on any failed step.

Coverage thresholds should not be invented before product code exists. A threshold is introduced with the first behavioral package and documented deliberately.

## Review model

Every substantial change should be reviewable against explicit evidence.

The PR template asks for:

- purpose;
- scope;
- architecture/ADR impact;
- tests/checks actually executed;
- documentation changes;
- security/permission impact;
- known limitations or unverified claims.

The review checklist rejects:

- hidden scope expansion;
- speculative abstractions;
- claims unsupported by executed verification;
- docs that describe roadmap items as implemented;
- architectural changes without ADR coverage;
- broad agent permissions without an explicit policy rationale.

## Issue templates

The initial templates should distinguish:

- bug: observed behavior with reproduction/evidence;
- feature: user/problem/value-oriented proposal;
- architecture: a decision that may require an ADR.

The templates are intentionally short so contributors and agents will actually use them.

## Versioning and changelog

Before the first product package exists, MindRail uses `0.x` development versioning.

`CHANGELOG.md` follows a human-readable Keep-a-Changelog-style structure. Automated release tooling is deferred until there is something releasable.

## Licensing implementation constraints

The foundation may add the official BSL 1.1 license text and project parameters, but must not invent a bespoke license pretending to be BSL.

Repository wording must consistently say `source-available under BSL 1.1` until the Change License takes effect for a given release.

Commercial-license contact mechanics may initially point to the repository maintainer and should be replaceable later by a project/company contact.

## Security and dependency discipline

- Prefer no dependency over a dependency for repository-only tooling.
- Runtime dependencies require a concrete implementation need.
- Dev dependencies must have a clear quality/tooling purpose.
- No secrets are committed.
- CI receives only minimum permissions required for checks.
- Pull-request CI must not obtain production credentials.
- Dependency update automation is deferred until the initial dependency graph exists.

## Test strategy for this iteration

Because this slice primarily establishes repository machinery, verification consists of:

- clean dependency installation;
- all root quality commands executing successfully;
- CI configuration syntax/behavior validated through an actual GitHub Actions run once pushed;
- documentation-link checks or equivalent lightweight validation if introduced;
- inspection that agent/bootstrap documentation has no contradictory authority rules.

No test or CI check may be called passing unless it actually executed.

## Implementation order

1. Add repository governance and authoritative documentation.
2. Add and record licensing decision.
3. Add minimal Node/pnpm/TypeScript quality-tooling baseline.
4. Add agent workflow and review contracts.
5. Add GitHub issue/PR templates.
6. Add CI quality workflow.
7. Execute all local/verifiable quality checks available in the implementation environment.
8. Update `CURRENT_STATE.md` with only verified outcomes.

## Exit criteria

This foundation is complete when a fresh coding-agent session can enter the repository, read a small deterministic set of files, understand current reality and architecture constraints, make a scoped change, run one canonical quality command, and produce a PR with auditable evidence — without relying on prior chat context.

At that point the next architectural slice can define MindRail's domain contracts and agent/control-plane protocol.
