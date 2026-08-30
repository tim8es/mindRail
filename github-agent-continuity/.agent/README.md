# `.agent/` memory rules

This directory contains durable repository-local context used by zero-context agent sessions.

## What belongs here

- `config.yml` — GAC timing/ref defaults.
- `PROJECT.md` — stable mission, boundaries, architecture principles, success definition.
- `GOALS.md` — strategic direction across multiple Issues.
- `DECISIONS.md` — durable decisions not already authoritative elsewhere.

## What does not belong here

Do not store session diaries, raw chain-of-thought, command transcripts, temporary debugging notes, task checkpoints, lease state, or copied Issue history.

Operational state belongs in GitHub:

- task definition/lifecycle → Issues;
- dependencies → native Issue dependencies;
- ownership generation → immutable `gac-claim/issue-N-gK` refs;
- implementation → matching `agent/issue-N-gK` work branches;
- checkpoints/renewal/yield projection → Issue comments;
- integration → Pull Requests/base branch.

## Concurrent edits

Treat `.agent/**`, `.agents/**`, and GAC protocol/configuration files as shared control-plane scope. Ordinary implementation tasks should not edit them unless the Issue explicitly authorizes that change.
