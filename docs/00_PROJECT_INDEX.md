# Project Index

This file is a routing map. Keep it short; do not turn it into a second architecture document.

## Authority order

| Priority | Source                  | Purpose                                              |
| -------- | ----------------------- | ---------------------------------------------------- |
| 1        | `AGENTS.md`             | Repository execution contract for agents             |
| 2        | Accepted `docs/adr/*`   | Binding architecture and policy decisions            |
| 3        | `docs/CURRENT_STATE.md` | Factual repository capability and verification state |
| 4        | `docs/architecture/*`   | Current architecture derived from accepted ADRs      |
| 5        | `docs/roadmap/*`        | Planned work only                                    |
| 6        | `README.md`             | Public overview                                      |

If sources conflict, the higher-priority source wins and the contradiction must be corrected.

## Where to look

- **Current reality:** [`CURRENT_STATE.md`](CURRENT_STATE.md)
- **System architecture:** [`architecture/01_SYSTEM_OVERVIEW.md`](architecture/01_SYSTEM_OVERVIEW.md)
- **Architecture decisions:** [`adr/README.md`](adr/README.md)
- **v0.1 roadmap:** [`roadmap/V0_1.md`](roadmap/V0_1.md)
- **Engineering standards:** [`development/ENGINEERING_STANDARDS.md`](development/ENGINEERING_STANDARDS.md)
- **Agent workflow:** [`development/AGENT_WORKFLOW.md`](development/AGENT_WORKFLOW.md)
- **Review gate:** [`development/REVIEW_CHECKLIST.md`](development/REVIEW_CHECKLIST.md)
- **Contribution process:** [`../CONTRIBUTING.md`](../CONTRIBUTING.md)
- **Security policy:** [`../SECURITY.md`](../SECURITY.md)

## Design and implementation records

Design specs and implementation plans under `docs/superpowers/` document approved work slices and their execution plans. They do not outrank accepted ADRs or current-state evidence.
