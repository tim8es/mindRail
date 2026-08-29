# System Overview

> **Status:** target architecture. No runtime implementation is implied by this document. Accepted ADRs are authoritative over this overview.

## Purpose

MindRail is intended to be a vendor-neutral external control plane for autonomous AI agents. A user states goals; MindRail preserves project/runtime state, supplies bounded context and policy, coordinates agents, records evidence, and decides whether work should continue or require human input.

## Boundary model

```text
                         Human
                           │
                           ▼
                ┌─────────────────────┐
                │ Agent interfaces    │
                │ ChatGPT / Codex /   │
                │ Claude / custom     │
                └──────────┬──────────┘
                           │ protocol adapters
                           ▼
        ╔══════════════════════════════════════╗
        ║         MindRail control plane       ║
        ║                                      ║
        ║ goals / tasks / context / policy     ║
        ║ sessions / leases / checkpoints      ║
        ║ evidence / decisions / escalation    ║
        ╚═══════════════╤══════════════════════╝
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
   runtime state   integrations   audit/query views
          │             │             │
          └─────────────┴─────────────┘
                        ▲
                        │ declarative configuration
                 ┌──────┴──────┐
                 │ Git control │
                 │ repository  │
                 └─────────────┘
```

## Declarative control vs runtime state

These are separate authorities.

**Declarative control** describes how the system should operate: roles, policies, workflow definitions, project configuration, schemas, and other reviewable configuration. Git is the planned versioned source for these artifacts.

**Runtime state** describes what is happening now: active goals/tasks, assignments, sessions, leases, checkpoints, retries, decisions, and execution evidence. It belongs behind a runtime-state interface and is not modeled as Git commits.

## Agents are clients

ChatGPT, Codex, Claude Code, local workers, and future runtimes are execution clients. An agent session may disappear, reconnect, or be replaced. Goal/task truth therefore cannot live only in a prompt or conversation history.

The common protocol should expose a small set of concepts independent of the client transport. HTTP and MCP are planned adapters, not separate orchestration systems.

## Permission boundary

An LLM may request an action and provide evidence, but it must not unilaterally create authority. Permission outcomes should normally be deterministic policy results such as:

- `ALLOW`;
- `DENY`;
- `HUMAN_REQUIRED`.

Every meaningful decision should be attributable to a policy/configuration version and execution context.

## Context boundary

Agents should receive a task-specific context package rather than the entire project history. The context layer is intended to resolve the relevant role, project facts, accepted constraints, required files/evidence, permissions, and stop conditions.

## Deployment portability

The planned reference deployment uses Cloudflare because it can provide an inexpensive always-available control plane. Cloudflare-specific APIs must remain behind interfaces so compatible deployments can use other compute and persistence stacks.

Likewise, GitHub is a planned reference integration and declarative store, not a mandatory protocol dependency.

## Planned reference components

These names describe responsibilities, not implemented packages:

- Goal/task coordination;
- context assembly;
- deterministic policy/permission evaluation;
- agent/session registry;
- lease/checkpoint handling;
- append-only audit events plus queryable current state;
- integration adapters;
- optional reasoning providers.

Concrete package boundaries will be introduced only by the implementation slice that needs them.
