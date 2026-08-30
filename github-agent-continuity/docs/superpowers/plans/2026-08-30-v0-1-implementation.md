# GitHub Agent Continuity v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone GitHub-only repository template that lets disposable autonomous agent sessions recover state, claim work safely, run in parallel, checkpoint durable progress, and hand off across scheduled runs.

**Architecture:** Repository files store long-lived memory/procedure; GitHub Issues/dependencies model work; immutable generation claim refs serialize ownership; separate generation-specific work branches isolate stale writers without putting claim commits into product history; GitHub server event timestamps bound leases; Issue comments project checkpoints; Pull Requests integrate work branches into authoritative base.

**Tech Stack:** Markdown, YAML, GitHub Issues, Git refs/branches, GitHub REST/Git Database API, Pull Requests. No runtime/package dependency.

**Spec:** `github-agent-continuity/docs/DESIGN.md`

## Global Constraints

- Standalone and extractable from the temporary host repository.
- GitHub-only; no external database/service/runtime dependency.
- Cooperative coordination, not a security boundary.
- Immutable `gac-claim/issue-N-gK` ref owns generation; `agent/issue-N-gK` carries work.
- Claim commits are outside normal product-work ancestry.
- GitHub-native Issue dependencies are authoritative.
- `agent:done` only after successful integration into authoritative base (or explicit non-code completion).
- Repository metadata/bootstrap probes are not applied to the temporary host.

---

### Task 1: Foundation and durable memory

**Files:**
- `github-agent-continuity/README.md`
- `github-agent-continuity/.agent/config.yml`
- `github-agent-continuity/.agent/PROJECT.md`
- `github-agent-continuity/.agent/GOALS.md`
- `github-agent-continuity/.agent/DECISIONS.md`
- `github-agent-continuity/.agent/README.md`

- [x] Define repository-local lease/default-branch and claim/work-prefix configuration.
- [x] Define stable project-memory templates with no session diary.
- [x] Document standalone purpose, guarantees, limits, and extraction/install flow.
- [x] Keep temporary-host references explanatory only, never runtime dependency.

### Task 2: Executable agent procedure and protocol references

**Files:**
- `github-agent-continuity/.agents/skills/github-agent-continuity/SKILL.md`
- `github-agent-continuity/docs/PROTOCOL.md`
- `github-agent-continuity/docs/STATE_MODEL.md`
- `github-agent-continuity/docs/PARALLELISM.md`

- [x] Encode mandatory cold-start recovery before editing.
- [x] Encode atomic empty claim commit + exact immutable claim-ref creation.
- [x] Encode separate generation work-ref creation from recorded claim source.
- [x] Encode lease renewal/yield using GitHub event timestamps.
- [x] Encode server-current-time preference plus fail-safe local clock-skew grace for takeover.
- [x] Encode stale-generation isolation, dependency checks, stop conditions, finalization, and administrative reconciliation.
- [x] Keep SKILL.md compact and move reference detail into docs.
- [x] Keep protocol/reference documents aligned on claim/work naming and state precedence.

### Task 3: GitHub installation and work templates

**Files:**
- `github-agent-continuity/.github/ISSUE_TEMPLATE/agent-task.yml`
- `github-agent-continuity/.github/pull_request_template.md`
- `github-agent-continuity/docs/INSTALLATION.md`
- `github-agent-continuity/docs/SCHEDULED_PROMPT.md`

- [x] Define Issue fields for outcome, acceptance criteria, scope, validation, human constraints.
- [x] State native Issue dependencies are authoritative after Issue creation.
- [x] Document required labels/minimum GitHub capabilities/permissions.
- [x] Document small scheduled-session prompt.
- [x] Do not create labels/settings/claim refs in the temporary host repository.

### Task 4: Conformance scenarios and review

**Files:**
- `github-agent-continuity/tests/SCENARIOS.md`

- [x] Cover initial-claim race, takeover race, lost responses, crash windows, edited comments, yield, stale writes, finalization race, dependency cancellation, pagination, extraction, work/claim separation, and malformed state.
- [x] Fetch completed branch diff and compare file set against plan/spec.
- [x] Review operational files for accidental host-project dependency; remaining host mentions are portability/testing explanation only.
- [x] Parse the final Issue Form YAML successfully (`YAML OK`, eight body entries).
- [x] Record limitations honestly: runtime concurrency/crash scenarios are specified but **NOT EXECUTED** in the temporary host.

## Verification evidence

- GitHub compare `main...prototype/github-agent-continuity` after hardening: branch ahead, 17 standalone files under `github-agent-continuity/`; no host-project files modified by the template implementation.
- `.github/ISSUE_TEMPLATE/agent-task.yml`: parsed successfully with YAML parser after final naming changes.
- `DESIGN.md`, `PROTOCOL.md`, `STATE_MODEL.md`, `PARALLELISM.md`, `INSTALLATION.md`, README, skill, Issue Form, and scheduled prompt were re-read during the final consistency pass.
- No repository-level GAC labels/settings or runtime claim/work refs were created for conformance testing on the temporary host because those objects are not isolated by the prototype directory/branch.

## Implementation changes discovered during review

1. Replaced the original single generation branch with immutable claim refs + separate generation work branches to keep control metadata out of PR/base history.
2. Added lost-response read-back rules for both claim and work ref creation.
3. Added fail-closed handling for malformed highest claims and incompatible work branches.
4. Added server-current-time preference with `clock_skew_grace_minutes` fallback for safe takeover when an integration does not expose GitHub current server time.
5. Added idempotent administrative reconciliation for conclusively completed external actions without granting code-write authority.
