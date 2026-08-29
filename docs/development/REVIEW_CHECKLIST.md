# Review Checklist

Use this as a rejection-oriented gate: reviewers should look for reasons a change is unsafe, misleading, or unnecessarily complex before polishing style.

## Scope

- [ ] The change solves the stated problem without unrelated refactoring.
- [ ] No speculative framework, package, service, or abstraction was added.
- [ ] New dependencies have a concrete current need.
- [ ] The change is small enough to reason about and test independently.

## Architecture

- [ ] Accepted ADRs were read and followed.
- [ ] New persistent concepts/boundaries have ADR coverage.
- [ ] Provider-specific details have not silently become core protocol semantics.
- [ ] Git/declarative control and operational runtime state remain distinct authorities.
- [ ] Agents are not treated as the durable system of record.

## Correctness and evidence

- [ ] Behavioral changes have focused tests.
- [ ] Claimed checks were actually executed.
- [ ] A failed or unexecuted test is not described as PASS.
- [ ] Platform/runtime claims match the environment in which they were verified.
- [ ] Error and recovery paths are explicit enough for the slice.

## Security and permissions

- [ ] The change follows least privilege.
- [ ] No secrets or broad credentials enter model context, logs, fixtures, or source.
- [ ] Permission/trust-boundary changes are explicit and reviewed.
- [ ] Model output does not mint authority without policy evaluation.

## Documentation

- [ ] `CURRENT_STATE.md` matches current facts.
- [ ] Roadmap text is not presented as implemented behavior.
- [ ] Architecture docs agree with accepted ADRs.
- [ ] README/public wording avoids unsupported capability or security claims.

## Maintainability

- [ ] Names and boundaries explain intent without reading unrelated internals.
- [ ] Duplication is preferable to a premature abstraction when the stable pattern is not yet known.
- [ ] The implementation can be replaced behind its interface if it is provider-specific.
- [ ] The PR clearly lists known limitations and unverified assumptions.
