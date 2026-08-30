from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'target not found in {path}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))


replace_once(
    'docs/CURRENT_STATE.md',
    '**Last reconciled:** 2026-08-29',
    '**Last reconciled:** 2026-08-30',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Explicit durable read ports and application queries are implemented for `GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListTaskCheckpoints`, `ListPendingHumanPermissions`, `ListPermissionDecisions`, and advisory `ListClaimableTasks`. List queries use bounded deterministic cursor paging. `ListClaimableTasks` includes capability-compatible `ready` Tasks plus `running` Tasks whose prior Lease/Session authority is no longer effective at the authoritative server time; work acquisition still revalidates authority atomically at `ClaimTask`.',
    '- Explicit durable read ports and application queries cover the complete ADR-0005 v0.1 query surface: `GetWorkspace`, `ListGoals`, `GetGoal`, `ListGoalTasks`, `GetTask`, `GetTaskExecutionView`, `ListClaimableTasks`, `GetLease`, `GetAgent`, `GetSession`, `ListTaskCheckpoints`, `GetPermissionRequest`, `ListPendingHumanPermissions`, and `ListPermissionDecisions`. List queries use bounded deterministic cursor paging. `ListClaimableTasks` includes capability-compatible `ready` Tasks plus `running` Tasks whose prior Lease/Session authority is no longer effective at authoritative server time; work acquisition still revalidates authority atomically at `ClaimTask`. `GetTaskExecutionView` reads Task, effective Lease, and latest Checkpoint through one D1 statement so the projection is coherent at one database read snapshot.',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Durable queries `ListGoals`, `ListGoalTasks`, and `GetTaskExecutionView` remain explicitly unsupported rather than inferred from retained application state.\n',
    '- The locally verified durable application composition now has command and query parity with the complete ADR-0005 v0.1 protocol surface; remaining product gaps are external integration and deployed-reference verification rather than retained in-memory fallbacks.\n',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Add the remaining bounded durable queries only where required by agent/human workflows.\n',
    '',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Durable task-outcome RED Quality run `33278105807` kept the previous **130 tests green** while both new outcome regressions failed on the expected `UNSUPPORTED_OPERATION` boundary. GREEN run `33278271723` passed full `pnpm check` and coverage after self-cleaning the one-time implementation harness. Review-hardening run `33278367867` then proved persisted FailTask Lease state, lost-response BlockTask replay, durable blocked Checkpoint storage, and complete persisted ResumeTask state. Atomicity run `33278493339` added D1-like mid-batch fault injection and passed **32/32 test files and 133/133 tests** plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines; the injected failure rolls back Checkpoint, Task, Lease, and receipt together before an exact retry succeeds. Durable retry/cancellation review hardening culminated in run `33283962742`, which passed **33/33 test files and 143/143 tests**, full `pnpm check`, and coverage at 85.0% statements, 74.3% branches, 96.51% functions, and 86.71% lines. The regressions cover lost-response replay, `CancelTask` without an effective Lease, `CancelGoal` mid-batch rollback, stale Goal task admission, false-success receipt prevention after a lost CAS, and recovery-`ClaimTask` races against both Task and Goal cancellation.',
    '- Durable task-outcome RED Quality run `33278105807` kept the previous **130 tests green** while both new outcome regressions failed on the expected `UNSUPPORTED_OPERATION` boundary. GREEN run `33278271723` passed full `pnpm check` and coverage after self-cleaning the one-time implementation harness. Review-hardening run `33278367867` then proved persisted FailTask Lease state, lost-response BlockTask replay, durable blocked Checkpoint storage, and complete persisted ResumeTask state. Atomicity run `33278493339` added D1-like mid-batch fault injection and passed **32/32 test files and 133/133 tests** plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines; the injected failure rolls back Checkpoint, Task, Lease, and receipt together before an exact retry succeeds. Durable retry/cancellation review hardening culminated in run `33283962742`, which passed **33/33 test files and 143/143 tests**, full `pnpm check`, and coverage at 85.0% statements, 74.3% branches, 96.51% functions, and 86.71% lines. The regressions cover lost-response replay, `CancelTask` without an effective Lease, `CancelGoal` mid-batch rollback, stale Goal task admission, false-success receipt prevention after a lost CAS, and recovery-`ClaimTask` races against both Task and Goal cancellation. Durable query-parity RED Quality run `33284893955` kept those **143 tests green** while exactly three new query regressions failed on the expected `UNSUPPORTED_OPERATION` boundary. Query hardening run `33285112259` then passed **34/34 test files and 146/146 tests**, full `pnpm check`, and coverage at 85.1% statements, 74.51% branches, 96.79% functions, and 86.86% lines after `ListGoals`, `ListGoalTasks`, and the single-statement `GetTaskExecutionView` projection were made durable.',
)

replace_once(
    'docs/roadmap/V0_1.md',
    '**Status:** v0.1 command surface implemented and verified; durable command/query composition remains intentionally partial.',
    '**Status:** v0.1 command/query surface implemented and verified; durable protocol parity is complete locally.',
)
replace_once(
    'docs/roadmap/V0_1.md',
    'Durable read/query support now includes single-resource execution/permission reads, checkpoint and permission-decision history, the pending-human queue, and advisory claimable work. `ListGoals`, `ListGoalTasks`, and `GetTaskExecutionView` remain pending.',
    'Durable read/query support now covers the complete ADR-0005 v0.1 query surface, including bounded `ListGoals`, bounded `ListGoalTasks`, and `GetTaskExecutionView`. The execution view returns Task, effective Lease, and latest Checkpoint from one durable database statement; advisory `ListClaimableTasks` still revalidates execution authority atomically at `ClaimTask`.',
)
replace_once(
    'docs/roadmap/V0_1.md',
    '- durable queries for `GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListTaskCheckpoints`, `ListPendingHumanPermissions`, `ListPermissionDecisions`, and advisory `ListClaimableTasks`;',
    '- durable queries for the complete ADR-0005 v0.1 surface, including bounded `ListGoals` / `ListGoalTasks`, coherent `GetTaskExecutionView`, execution-resource reads, checkpoint and permission history, pending-human work, and advisory `ListClaimableTasks`;',
)
replace_once(
    'docs/roadmap/V0_1.md',
    'Durable Session/Lease liveness is now covered through HTTP restart E2E: heartbeat does not extend Lease authority, renew preserves the fence, release permits higher-fence recovery, and EndSession durably revokes active Lease authority before recovery. Durable lifecycle/cancellation command parity is complete locally; remaining local work is bounded query parity plus persistence-concurrency hardening and final end-to-end reconciliation. The executed SQLite/D1-like tests do not substitute for deployed Cloudflare verification.',
    'Durable Session/Lease liveness is now covered through HTTP restart E2E: heartbeat does not extend Lease authority, renew preserves the fence, release permits higher-fence recovery, and EndSession durably revokes active Lease authority before recovery. Durable command and query parity is complete locally; remaining local hardening is correctness-focused persistence/concurrency review plus real agent/deployed-reference integration. The executed SQLite/D1-like tests do not substitute for deployed Cloudflare verification.',
)
replace_once(
    'docs/roadmap/V0_1.md',
    '**Current gap to that condition:** at least one real agent-host integration, the three remaining durable read queries, persistence/deployed-reference-runtime hardening, and real Cloudflare verification are outstanding. The local durable HTTP composition now proves the command-side persistence/restart contract, but it is not yet a real-agent or deployed-Cloudflare product path.',
    '**Current gap to that condition:** at least one real agent-host integration, persistence/deployed-reference-runtime hardening, and real Cloudflare verification are outstanding. The local durable HTTP composition now proves full v0.1 command/query persistence and restart semantics, but it is not yet a real-agent or deployed-Cloudflare product path.',
)

replace_once(
    'CHANGELOG.md',
    '- Explicit durable query ports and bounded query support for `GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListTaskCheckpoints`, `ListPendingHumanPermissions`, `ListPermissionDecisions`, and advisory `ListClaimableTasks`.',
    '- Explicit durable query ports and bounded query support for the complete ADR-0005 v0.1 surface: `GetWorkspace`, `ListGoals`, `GetGoal`, `ListGoalTasks`, `GetTask`, `GetTaskExecutionView`, `ListClaimableTasks`, `GetLease`, `GetAgent`, `GetSession`, `ListTaskCheckpoints`, `GetPermissionRequest`, `ListPendingHumanPermissions`, and `ListPermissionDecisions`.',
)
replace_once(
    'CHANGELOG.md',
    '- D1 mutation batches now use transaction-aborting guard rows for conditional mutation races. Task creation/retry revalidate an active parent Goal inside the database batch; Goal cancellation terminalizes the Goal only after its cancellable Tasks/Leases and only when no cancellable work remains; claim/cancellation share fencing-counter and Task-state predicates so neither can return success with execution authority beneath cancelled state.',
    '- D1 mutation batches now use transaction-aborting guard rows for conditional mutation races. Task creation/retry revalidate an active parent Goal inside the database batch; Goal cancellation terminalizes the Goal only after its cancellable Tasks/Leases and only when no cancellable work remains; claim/cancellation share fencing-counter and Task-state predicates so neither can return success with execution authority beneath cancelled state. `GetTaskExecutionView` now derives Task, effective Lease, and latest Checkpoint in one D1 statement so the read projection cannot mix separate database snapshots.',
)
replace_once(
    'CHANGELOG.md',
    '- Durable retry/cancellation hardening run `33283962742` passed **33/33 test files and 143/143 tests**, full `pnpm check`, and coverage at 85.0% statements, 74.3% branches, 96.51% functions, and 86.71% lines after transaction-CAS, stale Goal admission, no-Lease cancellation, mid-batch rollback, false-receipt, and cancellation-versus-recovery claim regressions were made green.',
    '- Durable retry/cancellation hardening run `33283962742` passed **33/33 test files and 143/143 tests**, full `pnpm check`, and coverage at 85.0% statements, 74.3% branches, 96.51% functions, and 86.71% lines after transaction-CAS, stale Goal admission, no-Lease cancellation, mid-batch rollback, false-receipt, and cancellation-versus-recovery claim regressions were made green. Durable query-parity RED Quality run `33284893955` preserved those **143 passing tests** while exactly three new query regressions failed on `UNSUPPORTED_OPERATION`; hardening run `33285112259` then passed **34/34 test files and 146/146 tests**, full `pnpm check`, and coverage at 85.1% statements, 74.51% branches, 96.79% functions, and 86.86% lines.',
)
replace_once(
    'CHANGELOG.md',
    '- The durable dispatcher supports the complete ADR-0005 v0.1 command surface. The remaining explicit durable application gaps are read-side: `ListGoals`, `ListGoalTasks`, and `GetTaskExecutionView`.\n- Durable application queries `ListGoals`, `ListGoalTasks`, and `GetTaskExecutionView` remain explicitly unsupported.\n',
    '- The durable dispatcher supports the complete ADR-0005 v0.1 command and query surface against the local SQLite D1-like reference harness; this does not imply deployed Cloudflare verification.\n',
)
