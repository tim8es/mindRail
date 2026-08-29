# Engineering Standards

MindRail optimizes for correctness, inspectability, and low maintenance cost before feature velocity.

## Scope discipline

- Implement the smallest coherent slice that solves the current problem.
- Do not introduce an abstraction solely because a future feature might need it.
- Avoid hidden scope expansion during fixes or reviews.
- New persistent domain concepts, security boundaries, storage authorities, protocol semantics, or deployment assumptions require ADR review.

## TypeScript

- Use strict TypeScript.
- Prefer explicit domain types at module boundaries.
- Avoid `any`; when unavoidable at an external boundary, isolate and validate it.
- Keep modules focused on one responsibility and small enough to understand without loading unrelated subsystems.
- Prefer pure functions and deterministic state transitions in core policy/domain code.
- Keep provider-specific code behind adapters.

## Dependencies

A dependency needs a concrete reason.

Before adding one, ask:

1. Is the capability needed in the current slice?
2. Is the standard library or a small local implementation adequate?
3. Does the dependency create runtime authority, network access, or supply-chain risk?
4. Is it maintained and compatible with the supported Node/TypeScript versions?

Runtime dependencies receive more scrutiny than development tooling.

## Testing

For behavioral changes, use red-green-refactor where the environment permits it:

1. write a focused failing test;
2. execute it and confirm the expected failure;
3. implement the smallest behavior that satisfies it;
4. execute the focused test and full relevant suite;
5. refactor while green.

If the environment cannot execute a required test, record it as **unverified**. Never convert absence of evidence into PASS.

Tests should assert observable behavior, not internal implementation details. Mocks are reserved for boundaries that cannot reasonably be exercised directly.

## Verification

The canonical repository quality gate is `pnpm check` once the tooling baseline is installed and verified.

A completion report names the commands that actually ran and separates:

- verified behavior;
- implemented but not runtime-verified behavior;
- externally blocked verification.

Platform claims require execution on that platform or a clearly scoped substitute; one environment never proves another environment's runtime behavior.

## Documentation

Update documentation when implementation changes repository truth.

- Accepted ADRs define binding decisions.
- `CURRENT_STATE.md` records facts and verification state.
- Architecture docs describe the accepted design.
- Roadmaps describe intent only.

Do not rewrite history to make a change appear pre-decided. Supersede decisions explicitly.

## Security

- Default to least privilege.
- Do not pass broad credentials into agent prompts or model context.
- Keep secrets out of source control, logs, test fixtures, and artifacts.
- Permission decisions should be explainable and attributable to explicit policy/evidence.
- No security property is considered proven solely because it appears in design documentation.

## Git and commits

Use small, reviewable commits with conventional prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, or `ci:`.

A commit should leave the repository in a comprehensible state. Do not mix unrelated cleanup into feature work.
