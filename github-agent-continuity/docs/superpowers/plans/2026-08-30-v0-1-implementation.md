# GitHub Agent Continuity v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone GitHub-only repository template that lets disposable autonomous agent sessions recover state, claim work safely, run in parallel, checkpoint durable progress, and hand off across scheduled runs.

**Architecture:** Repository files store long-lived project memory and generic agent procedure; GitHub Issues/dependencies model work; generation-specific branches provide cooperative ownership isolation; GitHub server timestamps bound leases; Issue comments project checkpoints; Pull Requests integrate finished work into the authoritative base branch.

**Tech Stack:** Markdown, YAML, GitHub Issues, Git refs/branches, GitHub REST/Git Database API, Pull Requests. No runtime/package dependency.

**Spec:** `github-agent-continuity/docs/DESIGN.md`

## Global Constraints

- Standalone and extractable from MindRail.
- GitHub-only; no external database/service/runtime dependency.
- Cooperative coordination, not a security boundary.
- Generation branch is both claim and work isolation boundary.
- GitHub-native Issue dependencies are authoritative.
- `agent:done` only after successful integration into the authoritative base branch (or explicit non-code completion).
- Repository metadata bootstrap must not be applied to the temporary MindRail host.

---

### Task 1: Foundation and durable memory

**Files:**
- Create: `github-agent-continuity/README.md`
- Create: `github-agent-continuity/.agent/config.yml`
- Create: `github-agent-continuity/.agent/PROJECT.md`
- Create: `github-agent-continuity/.agent/GOALS.md`
- Create: `github-agent-continuity/.agent/DECISIONS.md`
- Create: `github-agent-continuity/.agent/README.md`

- [ ] Define repository-local lease/default-branch configuration.
- [ ] Define stable project-memory templates with no session diary.
- [ ] Document standalone purpose, guarantees, limits, and extraction/install flow.
- [ ] Verify none of these files refer to MindRail as a runtime dependency.

### Task 2: Executable agent procedure and protocol references

**Files:**
- Create: `github-agent-continuity/.agents/skills/github-agent-continuity/SKILL.md`
- Create: `github-agent-continuity/docs/PROTOCOL.md`
- Create: `github-agent-continuity/docs/STATE_MODEL.md`
- Create: `github-agent-continuity/docs/PARALLELISM.md`

- [ ] Encode mandatory cold-start recovery before editing.
- [ ] Encode atomic claim commit + exact generation-ref creation.
- [ ] Encode lease renewal/yield using GitHub server timestamps.
- [ ] Encode stale-generation isolation, dependency checks, stop conditions, and finalization.
- [ ] Keep SKILL.md concise enough to load routinely; move reference detail into docs.
- [ ] Verify protocol/reference documents agree on branch naming and state precedence.

### Task 3: GitHub installation and work templates

**Files:**
- Create: `github-agent-continuity/.github/ISSUE_TEMPLATE/agent-task.yml`
- Create: `github-agent-continuity/.github/pull_request_template.md`
- Create: `github-agent-continuity/docs/INSTALLATION.md`
- Create: `github-agent-continuity/docs/SCHEDULED_PROMPT.md`

- [ ] Define Issue fields for outcome, acceptance criteria, scope, validation, and human constraints.
- [ ] State that native Issue dependencies must be configured after Issue creation and are authoritative.
- [ ] Document required labels and minimum GitHub permissions as bootstrap metadata.
- [ ] Document the small scheduled-session prompt.
- [ ] Do not create labels/settings in the temporary MindRail repository.

### Task 4: Conformance scenarios and review

**Files:**
- Create: `github-agent-continuity/tests/SCENARIOS.md`

- [ ] Cover all 20 required DESIGN.md scenarios with preconditions, actions, and expected invariants.
- [ ] Include initial-claim race, takeover race, crash windows, edited comments, yield, stale writes, finalization race, dependency cancellation, pagination, and extraction.
- [ ] Fetch the completed project tree from the implementation branch and compare against the plan/spec.
- [ ] Search project files for accidental MindRail coupling and placeholders.
- [ ] Validate YAML structure by inspection/tooling available in the execution environment.
- [ ] Record limitations honestly; do not claim runtime concurrency tests were executed unless they actually were.
