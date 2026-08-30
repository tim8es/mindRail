# Installing GitHub Agent Continuity

GAC has no package/runtime installation. Installation means copying repository files, creating required GitHub metadata, and verifying that the chosen agent integration exposes the GitHub primitives used by the protocol.

## 1. Copy the template

Place project contents at target repository root so these paths exist:

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
claim_branch_prefix: gac-claim/issue-
work_branch_prefix: agent/issue-
```

For hourly scheduled workers, 50 minutes normally lets a dead short session expire before the next hourly run. Choose TTL for actual cadence; avoid a TTL longer than scheduler interval unless deliberate.

`finalization_margin_minutes` must be lower than lease TTL and large enough to re-read authority, push, and perform finalization checks.

## 3. Create repository labels

Labels are repository metadata and do not travel merely because files exist in Git. Create once in target repository:

| Label | Meaning |
|---|---|
| `agent:ready` | eligible for initial claim after dependency checks |
| `agent:active` | current generation executing/finalizing |
| `agent:blocked` | objective prerequisite prevents execution |
| `agent:human-required` | one precise human decision/permission required |
| `agent:done` | successfully integrated/completed terminal state |
| `agent:cancelled` | intentionally abandoned/cancelled terminal state |

Do not use labels as ownership locks.

## 4. Verify GitHub feature/API capabilities

The agent/tool surface must expose equivalent operations for:

### Discovery/recovery

- read repository default branch/files;
- read Issues, labels, state, comments and comment `created_at`/`updated_at`;
- read native Issue dependencies;
- list/match refs for exact **claim prefix**;
- read commits/tree/parent metadata;
- read matching generation work branches;
- read PR and CI/status evidence.

### Claim/work

- create a Git commit object using existing tree + parent;
- create exact immutable claim ref/branch pointing to candidate commit and distinguish success/conflict;
- read created claim ref/commit back;
- create exact matching work branch from claim source;
- push/create commits on work branch without touching claim ref;
- create Issue comments/update labels;
- create Pull Requests when integration-ready.

If exact claim commit/ref operations are unavailable, full GAC ownership semantics are unavailable. Do **not** substitute labels/comments as mutex; extend tool capability or avoid concurrent autonomous claims.

## 5. Minimum permission intent

Grant only what workflow needs. Full autonomous protocol generally needs:

- repository Contents read/write, including Git commit/ref writes;
- Issues read/write;
- Pull Requests read/write;
- Issue dependency read, and write only if agent may manage relationships;
- CI/status read sufficient for required checks.

GitHub Issue dependencies are available on GitHub Free, Pro, Team, and Enterprise Cloud; repository permissions still determine who may create/manage relationships.

Merging/deploying may intentionally remain human-only through branch rules, environments, CODEOWNERS, or repository policy. GAC does not grant credentials or bypass protections.

## 6. Configure repository policy

Repository-specific instructions should state at least:

- validation/test commands or evidence expectations;
- whether agents may merge PRs autonomously;
- whether deployment/destructive changes require humans;
- protected/shared paths beyond GAC defaults;
- security/credential restrictions.

Repository policy outranks generic GAC skill.

## 7. Use native Issue dependencies

Create tasks through Agent Task template, then configure GitHub `blocked by` / `blocking` relationships.

Free-form dependency text is not machine authority.

A dependent GAC task becomes eligible only after blockers reach successful terminal outcome (`agent:done` for GAC-managed tasks), not merely because blocker was closed/cancelled.

## 8. Configure scheduler

Use `SCHEDULED_PROMPT.md`.

Multiple independent scheduled sessions may run same generic prompt. They compete for exact immutable **claim refs**; compliant losers re-read state and select another eligible task.

Do not embed project state in scheduler prompt. Long-lived context belongs in repository/GitHub state.

## 9. Bootstrap verification

Before unattended use, manually verify:

- Issue template renders;
- required labels exist;
- native Issue dependencies readable by agent integration;
- agent can list matching claim refs;
- agent can create empty claim commit + exact claim ref in disposable test namespace;
- second attempt at same exact claim ref returns detectable conflict;
- winning owner can create matching generation work branch from recorded source;
- claim ref remains unchanged while work branch advances;
- PR from work branch does not contain claim commit in its ancestry/diff history;
- comment metadata exposes `created_at`/`updated_at`;
- branch protection behaves as expected for PR/merge.

Use a disposable test Issue/repository for first concurrency probe.

## 10. Temporary-host warning

When GAC is developed inside another repository branch, do not create GAC labels/settings on that host merely to test file contents. Repository metadata is not branch-isolated. Apply bootstrap only after GAC is installed in intended target repository or disposable test repository.
