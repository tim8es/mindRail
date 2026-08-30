## GAC task

- Issue: #
- Claim ref: `gac-claim/issue-N-gK`
- Work branch: `agent/issue-N-gK`
- Current claim generation confirmed before opening: yes / no

## Outcome

Describe the integrated result this PR is intended to deliver.

## Acceptance criteria

- [ ] Every Issue acceptance criterion was re-read before finalization.
- [ ] Native Issue dependencies were re-checked.
- [ ] The submitting claim generation was still highest after the final push.
- [ ] PR head is the generation work branch, not the immutable claim ref.

## Verification actually executed

List only commands/checks that were actually run and their observed result.

```text
command/check -> observed result
```

## Scope / concurrency

- Primary paths changed:
- Shared paths changed:
- Known overlap with another active GAC task:
- Supersedes an older generation PR: none / #

## Control-metadata check

- [ ] GAC claim commit is not part of the work-branch ancestry being integrated solely because of GAC ownership metadata.

## Human decisions

State any required human review/merge/deploy decision precisely. If human authorization is required, the linked Issue must not be marked `agent:done` before that decision and successful integration.

## Completion rule

An open or approved PR is not GAC task completion by itself. For coding tasks, `agent:done` is valid only after the intended result is present in the authoritative base branch and the Issue is closed successfully.
