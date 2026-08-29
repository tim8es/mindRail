# ADR-0001: System boundaries

- **Status:** Accepted
- **Date:** 2026-08-29

## Context

Modern agents can execute increasingly long tasks, but project truth is commonly trapped in individual sessions, prompts, vendor-specific tools, or ad hoc automation. MindRail needs a stable boundary model before implementation begins so that a convenient reference deployment does not become the protocol architecture by accident.

## Decision

1. **MindRail is a vendor-neutral control plane and protocol with a reference implementation.** No model vendor, chat product, coding agent, cloud provider, or project-management system is part of the core definition.
2. **Declarative control and operational runtime state are separate authorities.**
   - Declarative policy/configuration is versioned and reviewable; Git is the initial reference source.
   - Active goals/tasks, leases, sessions, checkpoints, and decisions belong to runtime state behind explicit interfaces.
3. **Git is not the operational task database.** Git may contain project/workflow definitions and human-visible artifacts, but high-frequency coordination state is not modeled as commits.
4. **Agents are execution clients, not the system of record.** A ChatGPT/Codex/Claude/custom-agent session may disappear without losing durable project truth.
5. **The agent contract is transport-neutral.** HTTP, MCP, CLI helpers, or vendor-specific connectors are adapters over common semantics rather than independent orchestration systems.
6. **Authority is deterministic by default.** An LLM may propose an action or supply evidence, but permission outcomes are evaluated by explicit policy. The default result vocabulary is expected to include allow, deny, or require-human semantics.
7. **Reference infrastructure stays replaceable.** Cloudflare and GitHub are planned reference choices, not protocol dependencies. Provider-specific behavior belongs behind interfaces.
8. **New persistent domain concepts require explicit review.** Domain contracts will be defined in a later ADR/implementation slice rather than inferred prematurely in this foundation.

## Alternatives considered

### GitHub as the entire orchestrator

Rejected. It provides strong versioning and excellent human/agent accessibility, but Issues/Actions/Git commits are not a sufficient authority for fine-grained leases, heartbeats, checkpoints, retries, and permission decisions.

### A model-driven autonomous supervisor as the core

Rejected as the authority layer. It is useful as an optional planner/reviewer, but nondeterministic model output should not itself mint permissions or define runtime truth.

### Cloudflare-specific architecture from day one

Rejected. Cloudflare is a strong candidate for the reference deployment, but binding domain/protocol semantics to its primitives would make MindRail harder to reuse and harder to test locally.

### Microservices from day one

Rejected. The project starts as a modular monorepo/reference service. Service boundaries will be introduced only when operational requirements justify them.

## Consequences

- Early work prioritizes small domain contracts and ports/interfaces over cloud-specific code.
- ChatGPT and Codex can share one control plane while retaining different lifecycle limitations.
- A future Google Sheets integration is a projection/integration, not authoritative runtime storage.
- Policy decisions can be audited against versioned configuration and evidence.
- Some convenience integrations require extra adapter code, but core semantics remain portable.

## Compatibility and migration

There is no runtime implementation to migrate. Future implementation slices must preserve these boundaries or supersede this ADR explicitly.
