# GitHub Agent Continuity v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone GitHub-only repository template that lets disposable autonomous agent sessions recover state, claim work safely, run in parallel, checkpoint durable progress, and hand off across scheduled runs.

**Architecture:** Repository files store long-lived memory/procedure; GitHub Issues/dependencies model work; immutable generation claim refs serialize ownership; separate generation-specific work branches isolate stale writers without putting claim commits into product history; GitHub server timestamps bound leases; Issue comments project checkpoints; Pull Requests integrate work branches into authoritative base.

**Tech Stack:** Markdown, YAML, GitHub Issues, Git refs/branches, GitHub REST/Git Database API, Pull Requests. No runtime/package dependency.

**Spec:** `github-agent-continuity/docs/DESIGN.md`

## Global Constraints

- Standalone and extractable from MindRail.
- GitHub-only; no external database/service/runtime dependency.
- Cooperative coordination, not a security boundary.
- Immutable `gac-claim/issue-N-gK` ref owns generation; `agent/issue-N-gK` carries work.
- Claim commits must not be product-work ancestors merely because of GAC ownership metadata.
- GitHub-native Issue dependencies are authoritative.
- `agent:done` only after successful integration into authoritative base (or explicit non-code completion).
- Repository metadata bootstrap must not be applied to temporary MindRail host.

---

### Task 1: Foundation and durable memory

**Files:**
- Create: `github-agent-continuity/README.md`
- Create: `github-agent-continuity/.agent/config.yml`
- Create: `github-agent-continuity/.agent/PROJECT.md`
- Create: `github-agent-continuity/.agent/GOALS.md`
- Create: `github-agent-continuity/.agent/DECISIONS.md`
- Create: `github-agent-continuity/.agent/README.md`

- [x] Define repository-local lease/default-branch and claim/work-prefix configuration.
- [x] Define stable project-memory templates with no session diary.
- [x] Document standalone purpose, guarantees, limits, and extraction/install flow.
- [x] Keep MindRail references explanatory only, never runtime dependency.

### Task 2: Executable agent procedure and protocol references

**Files:**
- Create: `github-agent-continuity/.agents/skills/github-agent-continuity/SKILL.md`
- Create: `github-agent-continuity/docs/PROTOCOL.md`
- Create: `github-agent-continuity/docs/STATE_MODEL.md`
- Create: `github-agent-continuity/docs/PARALLELISM.md`

- [x] Encode mandatory cold-start recovery before editing.
- [x] Encode atomic empty claim commit + exact immutable claim-ref creation.
- [x] Encode separate generation work-ref creation from recorded claim source.
- [x] Encode lease renewal/yield using GitHub server timestamps.
- [x] Encode stale-generation isolation, dependency checks, stop conditions, and finalization.
- [x] Keep SKILL.md compact and move reference detail into docs.
- [x] Keep protocol/reference documents aligned on claim/work naming and state precedence.

### Task 3: GitHub installation and work templates

**Files:**
- Create: `github-agent-continuity/.github/ISSUE_TEMPLATE/agent-task.yml`
- Create: `github-agent-continuity/.github/pull_request_template.md`
- Create: `github-agent-continuity/docs/INSTALLATION.md`
- Create: `github-agent-continuity/docs/SCHEDULED_PROMPT.md`

- [x] Define Issue fields for outcome, acceptance criteria, scope, validation, human constraints.
- [x] State native Issue dependencies are authoritative after Issue creation.
- [x] Document required labels/minimum GitHub capabilities/permissions.
- [x] Document small scheduled-session prompt.
- [x] Do not create labels/settings in temporary MindRail repository.

### Task 4: Conformance scenarios and review

**Files:**
- Create: `github-agent-continuity/tests/SCENARIOS.md`

- [x] Cover design scenarios plus implementation-discovered lost-response/corruption/history-isolation cases.
- [x] Include initial-claim race, takeover race, crash windows, edited comments, yield, stale writes, finalization race, dependency cancellation, pagination, extraction.
- [ ] Fetch completed project tree and compare against plan/spec after final refactor.
- [ ] Search project files for accidental operational MindRail coupling/placeholders.
- [ ] Re-validate YAML structure after final refactor.
- [ ] Record limitations honestly; runtime concurrency scenarios remain NOT EXECUTED unless actually exercised.

## Implementation note

During review, the original single generation branch design was replaced with immutable claim refs + separate generation work branches. This preserves atomic claim serialization and stale-writer isolation while preventing empty GAC claim commits from entering normal PR/base history.
