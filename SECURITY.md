# Security Policy

MindRail is intended to coordinate autonomous agents and delegated permissions, so security boundaries are product behavior rather than documentation-only concerns.

## Reporting a vulnerability

While the repository is private, report suspected vulnerabilities privately to the repository maintainer rather than opening a public issue. A dedicated security contact/process will be established before public release.

Do not include live credentials, private user data, or exploitable production details in an issue or pull request.

## Security principles

The project architecture is guided by:

- least privilege;
- explicit trust boundaries;
- no implicit propagation of user/master credentials into agent context;
- deterministic, auditable permission decisions by default;
- scoped/temporary authority where practical;
- separation of policy/configuration from execution state;
- durable evidence for security-relevant decisions;
- provider-neutral core semantics so a vendor integration cannot silently redefine authority.

## Credentials

Agents should interact through constrained capabilities/adapters where practical instead of receiving reusable master tokens. Secrets must not be committed to the repository or intentionally exposed in logs, prompts, test fixtures, or artifacts.

## Verification policy

A security control described in an ADR or architecture document is **not considered implemented** until the corresponding code exists and relevant verification has executed.

Do not infer:

- production security from unit tests alone;
- one operating system's behavior from another;
- cloud-provider IAM behavior from a local mock;
- absence of a vulnerability from absence of a failing test.

## Supported versions

There is no public production release yet. A supported-version policy will be published with the first releasable version.
