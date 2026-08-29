# Architecture Decision Records

ADRs record decisions that should survive individual chats, agents, implementations, and maintainers.

## When an ADR is required

Create or update a **Proposed** ADR before implementing a change that introduces or changes:

- a persistent domain concept or public contract;
- protocol semantics or compatibility guarantees;
- security, trust, credential, or permission boundaries;
- storage/system-of-record authority;
- deployment topology that affects core boundaries;
- licensing/governance policy;
- an accepted architectural constraint.

Routine implementation details that stay inside an accepted boundary do not need an ADR.

## States

- **Proposed** — under review; not binding.
- **Accepted** — binding until superseded.
- **Superseded** — replaced by a newer ADR; retain for history.
- **Rejected** — considered and explicitly not adopted.

## Rules

1. Numbers are monotonic and never reused.
2. Accepted ADRs are immutable except typo/format corrections that do not change meaning.
3. A changed decision gets a new ADR that names the ADR it supersedes.
4. Implementation and architecture docs must be reconciled to accepted ADRs.
5. If an implementation task contradicts an accepted ADR, stop that part of the implementation rather than silently changing the architecture.

## Required sections

Each ADR includes:

- status and date;
- context;
- decision;
- alternatives considered;
- consequences;
- compatibility/migration implications where relevant.

## Index

- [ADR-0001](ADR-0001-system-boundaries.md): **Accepted** — core system boundaries and vendor neutrality.
- [ADR-0002](ADR-0002-licensing-model.md): **Accepted** — BUSL-1.1 source-available licensing direction.
- [ADR-0003](ADR-0003-domain-contracts-and-schema-authority.md): **Accepted** — domain contracts and JSON Schema authority.
- [ADR-0004](ADR-0004-runtime-state-machine-and-concurrency.md): **Accepted** — runtime lifecycle, Goal/Task ordering, leases, fencing, and concurrency.
