# MindRail Development Foundation — Design

## Status

**Approved for implementation on 2026-08-29.** Implementation is tracked in draft PR #1.

This design is an implementation artifact. `AGENTS.md`, accepted ADRs, and `docs/CURRENT_STATE.md` outrank it where later evidence or accepted decisions refine an assumption.

## Purpose

The first MindRail iteration is not the orchestrator runtime. It is the repository and engineering foundation that makes every later human or agent contribution faster, consistent, auditable, and reviewable without relying on chat history.

MindRail is intended to become a vendor-neutral control plane for autonomous AI agents. The long-term system separates declarative/versioned control, runtime coordination state, agent-facing protocols, provider adapters, and optional reasoning providers.

## Goals

The foundation must:

1. give a fresh coding-agent session a deterministic low-context bootstrap path;
2. make current state, architecture, decisions, constraints, and roadmap discoverable in-repository;
3. establish ADR-first governance for persistent architectural decisions;
4. define engineering, contribution, security, and evidence standards before product implementation;
5. provide one canonical TypeScript quality gate;
6. remain minimal — no speculative runtime packages, cloud services, databases, or framework abstractions;
7. prepare for future public distribution without adding community/release machinery before it is needed.

## Non-goals

This slice does **not** implement:

- the MindRail control-plane API;
- Goal, Task, Agent, Session, Lease, Permission, Checkpoint, or Event runtime contracts;
- Cloudflare Workers, Durable Objects, D1, or R2;
- MCP/HTTP orchestration protocols;
- GitHub, Google Sheets, ChatGPT, Codex, or other product adapters;
- a web UI;
- an LLM/provider framework;
- production deployment.

## Repository model

Start as a modular monorepo repository, not a monolithic application and not a microservice system. Only directories with current value are created. Future `packages/`, `apps/`, `adapters/`, and `integrations/` directories are introduced by the first implementation slice that needs them.

Foundation structure:

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
├── src/
│   └── foundation.ts
├── test/
│   └── foundation.test.ts
├── docs/
│   ├── 00_PROJECT_INDEX.md
│   ├── CURRENT_STATE.md
│   ├── architecture/01_SYSTEM_OVERVIEW.md
│   ├── adr/
│   │   ├── README.md
│   │   ├── ADR-0001-system-boundaries.md
│   │   └── ADR-0002-licensing-model.md
│   ├── development/
│   │   ├── ENGINEERING_STANDARDS.md
│   │   ├── AGENT_WORKFLOW.md
│   │   └── REVIEW_CHECKLIST.md
│   └── roadmap/V0_1.md
└── .github/
    ├── ISSUE_TEMPLATE/
    │   ├── bug.yml
    │   ├── feature.yml
    │   └── architecture.yml
    ├── PULL_REQUEST_TEMPLATE.md
    └── workflows/quality.yml
```

## Authority and agent bootstrap

Agents must not treat all Markdown as equally authoritative.

Precedence:

1. `AGENTS.md` — repository execution contract;
2. accepted ADRs — binding architecture/policy decisions;
3. `docs/CURRENT_STATE.md` — factual implemented/verification state;
4. `docs/architecture/*` — architecture derived from ADRs;
5. `docs/roadmap/*` — future intent only;
6. `README.md` — public overview.

Design specs and implementation plans support a change but do not outrank the sources above.

A new coding agent is instructed to read the project index, current state, relevant accepted ADRs, then inspect current repository evidence. `AGENTS.md` remains intentionally short so this bootstrap does not become a permanent token tax.

Agents must make the smallest coherent change, avoid speculative abstractions, never claim an unexecuted check passed, update repository truth when it changes, and stop for ADR review before introducing a new persistent architectural/security/storage/protocol boundary.

## Current-state discipline

`docs/CURRENT_STATE.md` distinguishes:

- implemented and verified;
- implemented but not runtime-verified;
- planned;
- externally blocked/pending evidence.

Roadmap text is never evidence of implementation. A substantial PR updates current state whenever factual capability or verification status changes.

## ADR process

ADRs are required for persistent contracts, security/trust boundaries, storage authority, protocol semantics, licensing/governance, compatibility guarantees, or deployment topology that affects core boundaries.

States are `Proposed`, `Accepted`, `Superseded`, and `Rejected`. Accepted ADR meaning is immutable; changed decisions receive a new superseding ADR.

### ADR-0001 — System boundaries

Records that MindRail is vendor-neutral; declarative configuration and operational state are separate authorities; Git is declarative/versioned control rather than the operational task database; agents are clients rather than the system of record; permission authority is deterministic/policy-driven by default; and Cloudflare/GitHub remain replaceable reference choices.

### ADR-0002 — Licensing model

Records the approved BUSL-1.1 direction and is authoritative over the earlier licensing assumptions that led to this design.

Key points:

- MindRail is `source-available under BUSL-1.1` during the BSL period, not OSI Open Source;
- the Additional Use Grant is intended to allow development, testing, research, personal/self-hosted production use, and internal business production use;
- competing hosted/managed/SaaS production use of substantially equivalent MindRail control-plane functionality is outside that Additional Use Grant and requires separate commercial rights;
- **BUSL-1.1 does not create a blanket prohibition on redistribution or every form of commercialization** — its standard terms already grant redistribution rights subject to BSL;
- initial Change License direction is `AGPL-3.0-or-later` and the Change Date/project parameters require legal confirmation before public release;
- contribution/dual-licensing mechanics require a separate governance decision before accepting external contributors.

If the project later requires a broader ban on commercialization than BUSL can provide, ADR-0002 must be superseded rather than attempting to add an invalid restriction to the BSL Additional Use Grant.

## Engineering baseline

Only ecosystem-level tooling needed by future TypeScript work is selected:

- Node.js 24 active-LTS line for the current foundation;
- TypeScript strict mode;
- pnpm pinned through `package.json`;
- Vitest;
- ESLint flat config;
- Prettier;
- GitHub Actions.

No production framework is selected.

Stable root commands:

```text
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm check
```

`pnpm check` is the canonical aggregate local/CI quality gate.

The small `src/foundation.ts` + smoke test exists only to prove that lint/typecheck/test wiring is executable; it must explicitly report that product runtime is not implemented.

## Quality and CI

The permanent `Quality` workflow runs on pull requests and pushes to `main` and must:

1. use least-privilege read-only repository permissions;
2. pin third-party/GitHub Actions by immutable commit where practical;
3. install the pinned Node/pnpm toolchain;
4. require a committed lockfile;
5. install with a frozen lockfile;
6. run `pnpm check`;
7. fail on any failed step.

Coverage thresholds are deliberately deferred until behavioral product code exists.

A CI/test check is never described as passing unless it actually executed. Repository/config syntax inspection is useful evidence but is not equivalent to executing Node, pnpm, ESLint, TypeScript, Vitest, or GitHub-hosted runner behavior.

## Review model

The PR template requires purpose, scope, ADR impact, checks actually executed, documentation impact, security/permission impact, and known/unverified limitations.

The review checklist rejects hidden scope expansion, speculative abstractions, unsupported success claims, roadmap-as-reality documentation, architecture drift without ADRs, broad permissions without policy rationale, and dependencies without a current need.

Issue templates stay short and distinguish bugs (observed reproducible behavior), features (problem/outcome/value), and architecture decisions (likely ADR work).

## Security and dependency discipline

- prefer no dependency over a dependency when the current slice does not need one;
- runtime dependencies require concrete product need;
- dev dependencies require concrete quality/tooling value;
- no credentials or secrets in source, logs, fixtures, prompts, or artifacts;
- pull-request CI receives no production credentials;
- dependency automation and release automation are deferred until they solve a real maintenance/release problem.

## Licensing implementation constraints

Use the standard BUSL-1.1 text plus project parameters; do not invent a bespoke license while calling it BSL. Repository wording remains source-available until the applicable Change License takes effect.

The exact Additional Use Grant, licensor identity, Change License compatibility, and future commercial/contributor mechanics are a **pre-public-release legal gate**.

## Verification strategy

Foundation verification requires evidence from the real consumers where available:

- dependency installation from a committed lockfile;
- formatting, lint, typecheck, tests, coverage command, and aggregate `pnpm check`;
- an actual GitHub Actions job executing on a runner;
- documentation/authority reconciliation;
- lightweight static syntax checks as supplemental evidence only.

When the environment blocks a check, record it as unverified rather than replacing it with an inference.

## Exit criteria

The foundation is complete only when a fresh coding agent can enter the repository, discover the authoritative context cheaply, understand current reality and constraints, make a scoped change, run the canonical quality gate, and produce review evidence without relying on chat history.

At present the repository structure/workflow portion is implemented in draft PR #1, while executable quality-gate exit criteria remain blocked by GitHub runner assignment and the missing real-generated `pnpm-lock.yaml`; `docs/CURRENT_STATE.md` is authoritative for the exact status.
