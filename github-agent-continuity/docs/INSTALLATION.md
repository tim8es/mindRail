# Installing GitHub Agent Continuity

GAC has no package/runtime installation. Installation means copying repository files, creating required GitHub metadata, and verifying that the chosen agent integration exposes the GitHub primitives used by the protocol.

## 1. Copy the template

Place the project contents at the target repository root so these paths exist:

```text
.agents/skills/github-agent-continuity/SKILL.md
.agent/config.yml
.agent/PROJECT.md
.agent/GOALS.md
.agent/DECISIONS.md
.github/ISSUE_TEMPLATE/agent-task.yml
.github/pull_request_template.md
docs/PROTOCOL.md
docs/STATE_MODEL.md
docs/PARALLELISM.md
docs/SCHEDULED_PROMPT.md
```

Fill project memory before scheduling autonomous workers.

## 2. Review configuration

Default `.agent/config.yml`:

```yaml
version: 1
base_branch: default
lease_ttl_minutes: 50
renewal_threshold_minutes: 15
finalization_margin_minutes: 10
branch_prefix: agent/issue-
```

For an hourly scheduled worker, `50` minutes allows a dead session to expire before the next hourly run in normal conditions. Choose a TTL appropriate to your actual scheduler/session duration; avoid a TTL longer than the scheduler interval unless deliberate.

`finalization_margin_minutes` must be lower than the lease TTL and high enough to re-read authority, push, and perform required finalization checks.

## 3. Create repository labels

These labels are repository metadata and do not travel merely because files exist on a branch/template. Create them once in the target repository:

| Label | Meaning |
|---|---|
| `agent:ready` | eligible for initial claim after dependency checks |
| `agent:active` | current generation is executing/finalizing |
| `agent:blocked` | objective prerequisite currently prevents execution |
| `agent:human-required` | one precise human decision/permission is required |
| `agent:done` | successfully integrated/completed terminal state |
| `agent:cancelled` | intentionally abandoned/cancelled terminal state |

Do not use labels as ownership locks.

## 4. Verify GitHub feature/API capabilities

The executing agent/tool surface must be able to perform or expose equivalent operations for:

### Required for task discovery/recovery

- read repository default branch and files;
- read Issues, labels, state, comments and comment `created_at`/`updated_at`;
- read native Issue dependencies;
- list/match Git refs for an Issue generation prefix;
- read commits and commit tree/parent metadata;
- read PR and CI/status evidence relevant to the task.

### Required for claiming/work

- create a Git commit object using an existing tree and parent;
- create an exact Git ref/branch pointing to that commit and distinguish success from conflict;
- read the created ref/claim commit back;
- push/create commits on the winning generation branch;
- create Issue comments and update task labels;
- create Pull Requests when integration-ready.

If the tool surface cannot perform exact generation claim commit/ref operations, full GAC ownership semantics are unavailable. Do **not** substitute labels/comments as a mutex; either extend the GitHub tool capability or do not run concurrent autonomous claims.

## 5. Minimum permission intent

Grant only permissions needed by the workflow/repository policy. The full autonomous protocol generally needs:

- repository Contents: read/write (including Git commit/ref writes);
- Issues: read/write;
- Pull Requests: read/write;
- Issue dependency read, and write only if the agent is allowed to manage dependency relationships;
- CI/status read access sufficient to inspect required checks.

Merging/deploying may intentionally remain human-only through branch rules, environments, CODEOWNERS, or repository policy.

GAC does not grant credentials or bypass GitHub protections.

## 6. Configure repository policy

Repository-specific instructions should state at least:

- validation/test commands or evidence expectations;
- whether agents may merge PRs autonomously;
- whether deployment/destructive changes require humans;
- protected/shared paths beyond GAC defaults;
- any security/credential restrictions.

Repository-specific policy outranks the generic GAC skill.

## 7. Use native Issue dependencies

Create tasks through the Agent Task template, then configure GitHub `blocked by` / `blocking` relationships for actual dependencies.

Do not rely on free-form dependency text as machine authority.

A dependent GAC task becomes eligible only after blockers reach a successful terminal outcome (`agent:done` for GAC-managed tasks), not merely because a blocker was closed/cancelled.

## 8. Configure the scheduler

Use the prompt in `SCHEDULED_PROMPT.md`.

Multiple independent scheduled sessions may run the same generic prompt. They will compete for exact generation refs; compliant losers re-read state and select another eligible task.

Do not embed project state into the scheduler prompt. Long-lived context belongs in repository/GitHub state so scheduled prompt changes are rarely required.

## 9. Bootstrap verification

Before unattended use, manually verify at least:

- Issue template renders;
- all required labels exist;
- native Issue dependencies are readable by the agent integration;
- the agent can list matching generation refs;
- the agent can create an empty claim commit and exact ref in a disposable test Issue/branch namespace;
- a second attempt to create the same exact generation ref returns a detectable conflict;
- comment metadata exposes `created_at` and `updated_at`;
- repository branch protection behaves as expected for PR/merge.

Delete/close disposable test artifacts only after confirming the protocol behavior; do not use a production task for the first concurrency probe.

## 10. Temporary-host warning

When GAC is developed inside another repository branch (as in the initial prototype), do not create GAC labels/settings on that host merely to test file contents. Repository metadata is not branch-isolated. Apply the bootstrap only after GAC is installed into the intended target repository or a disposable test repository.
