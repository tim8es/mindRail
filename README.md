# MindRail

**A vendor-neutral control plane for autonomous AI agents.**

MindRail is an early-stage, source-available project exploring a simple problem: increasingly capable agents can execute long tasks, but they still lack a shared external system that tells them what matters now, coordinates work across sessions and runtimes, applies delegated permission policy, preserves state, and decides when a human actually needs to be interrupted.

MindRail aims to provide that control plane without making any single model vendor, agent runtime, cloud provider, or chat session the system of record.

> **Status:** private early development. The orchestrator runtime is not implemented yet. The repository currently establishes architecture and engineering foundations.

## Model

```text
Human goal
    │
    ▼
MindRail control plane
    │
    ├── context / task / policy
    ▼
Agent execution
    │
    ▼
Evidence + checkpoint
    │
    ▼
MindRail
    │
    ├── continue
    ├── re-plan
    ├── review
    └── ask human only when policy requires it
```

The long-term design separates:

- **declarative control** — versioned policy, roles, workflows, and project configuration;
- **runtime coordination** — goals, tasks, sessions, leases, checkpoints, and decisions;
- **agent protocols** — a small vendor-neutral contract exposed through adapters such as HTTP or MCP;
- **integrations** — GitHub, dashboards/projections, notifications, and other external systems;
- **optional reasoning providers** — useful for planning or review, but not trusted to mint authority by themselves.

## Design principles

1. **Agents are clients, not the system of record.** A chat or CLI session may disappear without losing the project state.
2. **Policy is explicit.** Permission decisions should be deterministic and auditable by default.
3. **State is external to prompts.** Agents receive the minimum context needed for the current work.
4. **Reference implementation is replaceable.** Cloudflare is a planned deployment target, not part of the protocol definition.
5. **Evidence over claims.** A test or platform behavior is not considered verified until it actually ran.
6. **YAGNI.** New abstractions enter the repository when a real slice needs them.

## What exists today

See [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) for the authoritative answer. Planned capabilities are documented separately and must not be interpreted as implemented functionality.

## Repository guide

- [`AGENTS.md`](AGENTS.md) — execution contract for coding agents.
- [`docs/00_PROJECT_INDEX.md`](docs/00_PROJECT_INDEX.md) — context routing index.
- [`docs/CURRENT_STATE.md`](docs/CURRENT_STATE.md) — factual current state.
- [`docs/adr/`](docs/adr/) — binding architecture decisions once accepted.
- [`docs/architecture/`](docs/architecture/) — architecture derived from accepted ADRs.
- [`docs/roadmap/`](docs/roadmap/) — planned work.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution workflow.

## Development

The repository baseline targets Node.js 24 and pins pnpm through `package.json`. The canonical aggregate quality command is:

```bash
pnpm check
```

A committed lockfile and successful execution of the toolchain are still pending because GitHub-hosted jobs currently fail before runner assignment. Consult `docs/CURRENT_STATE.md` for exact verification evidence rather than assuming the command has passed.

## License

MindRail is distributed under **Business Source License 1.1 (BUSL-1.1)** with project-specific parameters and a future Change License. During the BSL period it is **source-available, not OSI Open Source**.

The Additional Use Grant is intended to permit internal/self-hosted production use while protecting the project from use as a competing hosted/managed MindRail service. BSL does not provide a blanket prohibition on redistribution; the project-specific parameters require legal review before the repository becomes public or commercial licensing is offered.

See [`LICENSE`](LICENSE) and [`docs/adr/ADR-0002-licensing-model.md`](docs/adr/ADR-0002-licensing-model.md).
