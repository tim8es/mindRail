# Current State

**Last reconciled:** 2026-08-29

This document describes what exists, not what is intended. Roadmap items are never evidence of implementation.

## Implemented and verified

The following facts were verified through the GitHub repository/API or confirmed by the repository maintainer, not inferred from plans:

- Repository `tim8es/mindRail` exists as a private GitHub repository with `main` as the default branch.
- Development-foundation design and implementation plan exist under `docs/superpowers/`.
- Branch `foundation/development-foundation` contains the authoritative project index/current-state discipline, system overview, v0.1 roadmap, ADR process, accepted ADR-0001/ADR-0002, contribution/security/engineering/agent-review documentation, BUSL-1.1 license parameters, TypeScript quality configuration, a foundation sentinel test, GitHub issue/PR templates, and the permanent read-only quality workflow.
- The permanent quality workflow requests only `contents: read`, references no production secrets, derives Node/pnpm versions from repository package metadata, and pins GitHub-owned actions to immutable commits corresponding to `actions/checkout` v7.0.1 and `actions/setup-node` v6.4.0.
- The pnpm workspace explicitly contains only the repository root (`.`); no speculative package directories are declared.
- Draft PR #1 (`chore: establish MindRail development foundation`) exists as the review surface for this slice and is mergeable at the Git level.
- Issue #2 tracks the GitHub Actions execution blocker. The maintainer confirmed that the account's included private-repository Actions minutes are exhausted; this explains the observed jobs failing before runner assignment.
- Issue #3 tracks enforcement of the `main` quality gate once the repository is public or a plan supporting private-repository rulesets is used.
- Multiple GitHub Actions runs were actually observed, including bootstrap runs `33222230712` and `33222360080` and PR Quality runs `33222517533` and `33222675135`. They failed before any workflow step executed; observed jobs reported `runner_id: 0` and an empty `steps` list. No repository quality command executed in those runs.
- The repository rulesets API currently returns that GitHub Pro or a public repository is required. GitHub documentation likewise limits rulesets/protected branches for private repositories to Pro/Team/Enterprise plans. Therefore the current private repository cannot yet enforce the `Quality` workflow as a merge requirement on the present plan.
- A pre-public review of the final PR diff found no obvious credential-like material such as GitHub token prefixes, private-key blocks, AWS-style access keys, API-key markers, Gmail addresses, or passwords. The branch was rewritten to a single clean foundation commit before publication.
- The standard BUSL-1.1 body in `LICENSE` was compared with the SPDX-published BUSL-1.1 text; MindRail-specific parameters are kept separately above it.
- Lightweight syntax parsing confirmed that the committed `package.json`, `tsconfig.base.json`, workspace YAML, issue forms, and Quality workflow are structurally parseable. This is not a substitute for their real consumers.

## Implemented but not runtime-verified

- Root TypeScript/ESLint/Prettier/Vitest configuration is committed but has not successfully executed in a supported Node 24 + pnpm 11.24.0 environment.
- `src/foundation.ts` and `test/foundation.test.ts` exist to exercise the toolchain without representing product runtime capability, but the test has not executed successfully yet.
- `.github/workflows/quality.yml` is committed as the intended canonical CI gate, but no runner has executed it successfully.
- `pnpm-lock.yaml` is not committed because private-repository Actions minutes were exhausted before a runner could execute the bootstrap workflow. The lockfile has deliberately not been fabricated.
- The `Quality` workflow is not a mandatory merge gate yet; repository-level enforcement is unavailable while this repository remains private on the current GitHub plan.

## Planned

- MindRail domain contracts: Goal, Task, Agent, Session, Lease, Checkpoint, Permission Decision, Event.
- Vendor-neutral agent/control-plane protocol.
- Deterministic task/state transition and permission-policy engine.
- Reference runtime and persistence interfaces.
- GitHub integration.
- Cloudflare Workers/Durable Objects/D1 reference deployment.
- Codex, ChatGPT, MCP, and generic HTTP integration paths.
- Optional projections such as Google Sheets.

## Externally blocked / pending evidence

- The account's included private-repository GitHub Actions minutes are exhausted. Standard GitHub-hosted runners are free for public repositories, so the maintainer has authorized making MindRail public to remove this development blocker.
- A real Node 24 + pnpm 11.24.0 execution is still required to generate `pnpm-lock.yaml` and execute `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:coverage`, and `pnpm check`.
- Enforcing pull-request-only changes and required `Quality` checks on `main` requires making the repository public or moving to a GitHub plan that supports protection/rulesets for private repositories.
- MindRail-specific BUSL-1.1 parameters, Change License compatibility, licensor identity, and future contribution/dual-licensing mechanics have not received professional legal review. The repository must not imply otherwise.
- No Cloudflare, Codex, ChatGPT, or other external runtime integration has been implemented or verified.

## Explicit non-capabilities

MindRail currently does **not** orchestrate agents, issue runtime permissions, persist tasks, run a cloud control plane, or autonomously continue ChatGPT/Codex sessions. Those are roadmap goals.
