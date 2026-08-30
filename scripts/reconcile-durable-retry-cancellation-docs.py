from pathlib import Path


def replace_once(path: str, before: str, after: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f'{path}: expected one marker, found {count}')
    file.write_text(text.replace(before, after, 1))


replace_once(
    'docs/CURRENT_STATE.md',
    '- The durable command loop is executable for `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, `CompleteTask`, `FailTask`, `BlockTask`, and `ResumeTask`.',
    '- The durable command loop is executable for the complete ADR-0005 v0.1 command surface: `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, `CompleteTask`, `FailTask`, `BlockTask`, `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal`.',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Durable task outcomes now preserve the same runtime semantics through persistence: `FailTask` and `BlockTask` atomically commit the Task transition, released Lease, terminal/blocked Checkpoint, and immutable command receipt; `ResumeTask` atomically commits the controller-authorized blocked-to-ready/pending Task transition and receipt without minting execution authority.',
    '- Durable task outcomes now preserve the same runtime semantics through persistence: `FailTask` and `BlockTask` atomically commit the Task transition, released Lease, terminal/blocked Checkpoint, and immutable command receipt; `ResumeTask` atomically commits the controller-authorized blocked-to-ready/pending Task transition and receipt without minting execution authority. `RetryTask`, `CancelTask`, and `CancelGoal` also commit through explicit durable mutations with controller authority, immutable receipts, Goal/Task/Lease revision checks, database-enforced Goal-versus-Task admission ordering, and fencing-counter guards that prevent recovery claims from surviving cancellation races.',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Durable task-outcome RED Quality run `33278105807` kept the previous **130 tests green** while both new outcome regressions failed on the expected `UNSUPPORTED_OPERATION` boundary. GREEN run `33278271723` passed full `pnpm check` and coverage after self-cleaning the one-time implementation harness. Review-hardening run `33278367867` then proved persisted FailTask Lease state, lost-response BlockTask replay, durable blocked Checkpoint storage, and complete persisted ResumeTask state. Atomicity run `33278493339` added D1-like mid-batch fault injection and passed **32/32 test files and 133/133 tests** plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines; the injected failure rolls back Checkpoint, Task, Lease, and receipt together before an exact retry succeeds.',
    '- Durable task-outcome RED Quality run `33278105807` kept the previous **130 tests green** while both new outcome regressions failed on the expected `UNSUPPORTED_OPERATION` boundary. GREEN run `33278271723` passed full `pnpm check` and coverage after self-cleaning the one-time implementation harness. Review-hardening run `33278367867` then proved persisted FailTask Lease state, lost-response BlockTask replay, durable blocked Checkpoint storage, and complete persisted ResumeTask state. Atomicity run `33278493339` added D1-like mid-batch fault injection and passed **32/32 test files and 133/133 tests** plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines; the injected failure rolls back Checkpoint, Task, Lease, and receipt together before an exact retry succeeds. Durable retry/cancellation review hardening culminated in run `33283962742`, which passed **33/33 test files and 143/143 tests**, full `pnpm check`, and coverage at 85.0% statements, 74.3% branches, 96.51% functions, and 86.71% lines. The regressions cover lost-response replay, `CancelTask` without an effective Lease, `CancelGoal` mid-batch rollback, stale Goal task admission, false-success receipt prevention after a lost CAS, and recovery-`ClaimTask` races against both Task and Goal cancellation.',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- The durable dispatcher still leaves `RetryTask`, `CancelTask`, and `CancelGoal` explicitly unsupported until matching atomic persistence mutations are added.\n',
    '',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Complete durable persistence mutations for the remaining v0.1 lifecycle/cancellation commands without introducing a second state machine or generic CRUD authority.',
    '- Audit and harden any remaining conditional durable mutations against the same database-CAS/receipt and Goal-level concurrency invariants before treating the local persistence composition as complete.',
)

replace_once(
    'docs/roadmap/V0_1.md',
    'The canonical runtime/application command surface implements all ADR-0005 v0.1 commands, including Agent registration and Session bootstrap, lifecycle/recovery, permission request/decision, cancellation, and idempotent replay. Durable composition now covers `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, `CompleteTask`, `FailTask`, `BlockTask`, and `ResumeTask`. Remaining durable commands fail explicitly as unsupported until matching atomic persistence mutations exist.',
    'The canonical runtime/application command surface implements all ADR-0005 v0.1 commands, including Agent registration and Session bootstrap, lifecycle/recovery, permission request/decision, cancellation, and idempotent replay. Durable composition now covers the complete ADR-0005 v0.1 command surface, including `RetryTask`, `CancelTask`, and `CancelGoal`. Database-enforced mutation guards preserve receipt atomicity, Goal-versus-Task admission ordering, and cancellation-versus-recovery fencing under the SQLite D1-like reference harness.',
)
replace_once(
    'docs/roadmap/V0_1.md',
    'Durable Session/Lease liveness is now covered through HTTP restart E2E: heartbeat does not extend Lease authority, renew preserves the fence, release permits higher-fence recovery, and EndSession durably revokes active Lease authority before recovery. The remaining local/runtime work is to extend atomic durable composition to `RetryTask`, `CancelTask`, and `CancelGoal` where required for dogfooding. The executed SQLite/D1-like tests do not substitute for deployed Cloudflare verification.',
    'Durable Session/Lease liveness is now covered through HTTP restart E2E: heartbeat does not extend Lease authority, renew preserves the fence, release permits higher-fence recovery, and EndSession durably revokes active Lease authority before recovery. Durable lifecycle/cancellation command parity is complete locally; remaining local work is bounded query parity plus persistence-concurrency hardening and final end-to-end reconciliation. The executed SQLite/D1-like tests do not substitute for deployed Cloudflare verification.',
)
replace_once(
    'docs/roadmap/V0_1.md',
    '**Current gap to that condition:** at least one real agent-host integration, deployed/reference-runtime hardening, and any remaining durable lifecycle mutations required by that integration are outstanding. The local durable HTTP composition now proves the control-plane persistence/restart contract, but it is not yet a real-agent or deployed-Cloudflare product path.',
    '**Current gap to that condition:** at least one real agent-host integration, the three remaining durable read queries, persistence/deployed-reference-runtime hardening, and real Cloudflare verification are outstanding. The local durable HTTP composition now proves the command-side persistence/restart contract, but it is not yet a real-agent or deployed-Cloudflare product path.',
)

replace_once(
    'CHANGELOG.md',
    '- Durable `FailTask`, `BlockTask`, and `ResumeTask` composition with atomic Task/Lease/Checkpoint/receipt persistence where applicable, restart-safe immutable replay, persisted blocked/failed evidence, controller-authorized resume, and D1-like fault-injection rollback coverage.',
    '- Durable `FailTask`, `BlockTask`, and `ResumeTask` composition with atomic Task/Lease/Checkpoint/receipt persistence where applicable, restart-safe immutable replay, persisted blocked/failed evidence, controller-authorized resume, and D1-like fault-injection rollback coverage.\n- Durable `RetryTask`, `CancelTask`, and `CancelGoal` composition with restart-safe receipts, controller authority, task-only cancellation when no effective Lease exists, atomic Goal/Task/Lease cancellation, and database-level concurrency guards against stale Goal admission and recovery-claim races.',
)
replace_once(
    'CHANGELOG.md',
    '- Durable task-outcome persistence now revalidates execution/revision authority at commit time and stores failure/block transitions and their released Lease plus Checkpoint in one batch; `ResumeTask` recomputes dependency readiness and removes the blocking reason without granting a Lease.',
    '- Durable task-outcome persistence now revalidates execution/revision authority at commit time and stores failure/block transitions and their released Lease plus Checkpoint in one batch; `ResumeTask` recomputes dependency readiness and removes the blocking reason without granting a Lease.\n- D1 mutation batches now use transaction-aborting guard rows for conditional mutation races. Task creation/retry revalidate an active parent Goal inside the database batch; Goal cancellation terminalizes the Goal only after its cancellable Tasks/Leases and only when no cancellable work remains; claim/cancellation share fencing-counter and Task-state predicates so neither can return success with execution authority beneath cancelled state.',
)
replace_once(
    'CHANGELOG.md',
    '- Durable task-outcome RED run `33278105807` preserved the previous 130 passing tests while the new FailTask/BlockTask regressions failed at the expected unsupported boundary. Review/atomicity run `33278493339` passed **32/32 test files and 133/133 tests**, plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines, including a forced mid-batch rollback followed by successful exact retry.',
    '- Durable task-outcome RED run `33278105807` preserved the previous 130 passing tests while the new FailTask/BlockTask regressions failed at the expected unsupported boundary. Review/atomicity run `33278493339` passed **32/32 test files and 133/133 tests**, plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines, including a forced mid-batch rollback followed by successful exact retry.\n- Durable retry/cancellation hardening run `33283962742` passed **33/33 test files and 143/143 tests**, full `pnpm check`, and coverage at 85.0% statements, 74.3% branches, 96.51% functions, and 86.71% lines after transaction-CAS, stale Goal admission, no-Lease cancellation, mid-batch rollback, false-receipt, and cancellation-versus-recovery claim regressions were made green.',
)
replace_once(
    'CHANGELOG.md',
    '- The durable dispatcher currently supports `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, `CompleteTask`, `FailTask`, `BlockTask`, and `ResumeTask`. `RetryTask`, `CancelTask`, and `CancelGoal` remain canonical runtime behavior but are explicitly unsupported by the durable composition until matching atomic persistence paths are added.',
    '- The durable dispatcher supports the complete ADR-0005 v0.1 command surface. The remaining explicit durable application gaps are read-side: `ListGoals`, `ListGoalTasks`, and `GetTaskExecutionView`.',
)
