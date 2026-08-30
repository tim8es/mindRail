# Scheduled-session prompt

Keep the external scheduled task deliberately small. Project goals, protocol, task queue, ownership, checkpoints, and recovery state belong in GitHub/repository state rather than the scheduler prompt.

## Reference prompt

```text
Open the configured GitHub repository.
Read repository-specific agent/security instructions and load the github-agent-continuity skill from the repository.
Recover project goals and operational task state entirely from current GitHub/repository evidence; do not depend on prior conversation history.
Reconcile Issue state, native dependencies, generation refs, leases, checkpoints, branches, PRs, commits, and CI before editing.
Resume eligible yielded/expired work when appropriate; otherwise claim exactly one eligible ready task through the GAC generation protocol.
Continue autonomously only while repository policy, highest-generation ownership, and lease authority remain valid.
Persist coherent progress to GitHub incrementally, checkpoint durable state, and renew or gracefully yield before the session ends.
If required GitHub claim primitives or a human decision are unavailable, fail closed rather than approximating authority.
```

## Parallel scheduled workers

The same prompt may be used by multiple independent scheduled sessions. Do not assign a fixed Issue in the scheduler unless deliberate; each session should recover/rank/claim from GitHub state.

A claim loser must re-read state and try another eligible task, not assume failure means it should create the next generation.

## Cadence

The default GAC lease is 50 minutes, chosen for roughly hourly scheduled sessions. Adjust `.agent/config.yml` when the scheduler cadence or typical session length differs.

Prefer graceful yield when the host/session is ending normally. TTL expiry is the crash-recovery path, not the preferred routine handoff.

## What not to put in the prompt

Avoid copying:

- current Issue number;
- branch name;
- current goal text;
- latest checkpoint;
- lease timestamp;
- project architecture summary;
- task priority list.

Those become stale and defeat repository-based continuity.
