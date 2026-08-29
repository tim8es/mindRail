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
    '`RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`.',
    '`RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, `CompleteTask`, `FailTask`, `BlockTask`, and `ResumeTask`.',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Durable Session/Lease liveness preserves the runtime authority model: heartbeat advances only Session liveness/revision, Lease renewal keeps the fencing token stable, release leaves the Task running/recoverable, and ending a Session revokes its still-effective active Leases without completing the Task.\n',
    '- Durable Session/Lease liveness preserves the runtime authority model: heartbeat advances only Session liveness/revision, Lease renewal keeps the fencing token stable, release leaves the Task running/recoverable, and ending a Session revokes its still-effective active Leases without completing the Task.\n- Durable task outcomes now preserve the same runtime semantics through persistence: `FailTask` and `BlockTask` atomically commit the Task transition, released Lease, terminal/blocked Checkpoint, and immutable command receipt; `ResumeTask` atomically commits the controller-authorized blocked-to-ready/pending Task transition and receipt without minting execution authority.\n',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- Durable Session/Lease liveness RED Quality run `33276800987` passed formatting/lint/typecheck/contracts and the previous **125 tests**, while all four new HTTP E2E regressions failed exactly because `HeartbeatSession`, `EndSession`, `RenewLease`, and `ReleaseLease` returned `UNSUPPORTED_OPERATION`. GREEN run `33276973691` then passed the focused 4/4 liveness E2E tests, full `pnpm check` with **31/31 test files and 129/129 tests**, and coverage at 85.19% statements, 73.88% branches, 96.3% functions, and 86.83% lines.\n',
    '- Durable Session/Lease liveness RED Quality run `33276800987` passed formatting/lint/typecheck/contracts and the previous **125 tests**, while all four new HTTP E2E regressions failed exactly because `HeartbeatSession`, `EndSession`, `RenewLease`, and `ReleaseLease` returned `UNSUPPORTED_OPERATION`. GREEN run `33276973691` then passed the focused 4/4 liveness E2E tests, full `pnpm check` with **31/31 test files and 129/129 tests**, and coverage at 85.19% statements, 73.88% branches, 96.3% functions, and 86.83% lines.\n- Durable task-outcome RED Quality run `33278105807` kept the previous **130 tests green** while both new outcome regressions failed on the expected `UNSUPPORTED_OPERATION` boundary. GREEN run `33278271723` passed full `pnpm check` and coverage after self-cleaning the one-time implementation harness. Review-hardening run `33278367867` then proved persisted FailTask Lease state, lost-response BlockTask replay, durable blocked Checkpoint storage, and complete persisted ResumeTask state. Atomicity run `33278493339` added D1-like mid-batch fault injection and passed **32/32 test files and 133/133 tests** plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines; the injected failure rolls back Checkpoint, Task, Lease, and receipt together before an exact retry succeeds.\n',
)
replace_once(
    'docs/CURRENT_STATE.md',
    '- The durable dispatcher still leaves `FailTask`, `BlockTask`, `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal` explicitly unsupported until matching atomic persistence mutations are added.',
    '- The durable dispatcher still leaves `RetryTask`, `CancelTask`, and `CancelGoal` explicitly unsupported until matching atomic persistence mutations are added.',
)

replace_once(
    'docs/roadmap/V0_1.md',
    '`RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`.',
    '`RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, `CompleteTask`, `FailTask`, `BlockTask`, and `ResumeTask`.',
)
replace_once(
    'docs/roadmap/V0_1.md',
    'The remaining local/runtime work is to extend atomic durable composition to the task failure/block/resume/retry/cancellation surface where required for dogfooding.',
    'The remaining local/runtime work is to extend atomic durable composition to `RetryTask`, `CancelTask`, and `CancelGoal` where required for dogfooding.',
)

replace_once(
    'CHANGELOG.md',
    '- Durable HTTP end-to-end regressions covering restart after claim, restart after `HUMAN_REQUIRED`, response-loss receipt replay after application replacement, competing independent application claims, and fencing advancement after Lease expiry/recovery against the SQLite D1-like persistence harness.\n',
    '- Durable HTTP end-to-end regressions covering restart after claim, restart after `HUMAN_REQUIRED`, response-loss receipt replay after application replacement, competing independent application claims, and fencing advancement after Lease expiry/recovery against the SQLite D1-like persistence harness.\n- Durable `FailTask`, `BlockTask`, and `ResumeTask` composition with atomic Task/Lease/Checkpoint/receipt persistence where applicable, restart-safe immutable replay, persisted blocked/failed evidence, controller-authorized resume, and D1-like fault-injection rollback coverage.\n',
)
replace_once(
    'CHANGELOG.md',
    '- Durable Session/Lease liveness composition now supports `HeartbeatSession`, `EndSession`, `RenewLease`, and `ReleaseLease` with atomic mutation receipts, restart-safe replay, stable renewal fencing, and recoverable released/revoked execution authority.\n',
    '- Durable Session/Lease liveness composition now supports `HeartbeatSession`, `EndSession`, `RenewLease`, and `ReleaseLease` with atomic mutation receipts, restart-safe replay, stable renewal fencing, and recoverable released/revoked execution authority.\n- Durable task-outcome persistence now revalidates execution/revision authority at commit time and stores failure/block transitions and their released Lease plus Checkpoint in one batch; `ResumeTask` recomputes dependency readiness and removes the blocking reason without granting a Lease.\n',
)
replace_once(
    'CHANGELOG.md',
    '- Frozen installation resolves `@mindrail/contracts 0.0.0 <- packages/contracts`, confirming the root runtime uses the workspace contract package.\n',
    '- Durable task-outcome RED run `33278105807` preserved the previous 130 passing tests while the new FailTask/BlockTask regressions failed at the expected unsupported boundary. Review/atomicity run `33278493339` passed **32/32 test files and 133/133 tests**, plus coverage at 84.99% statements, 74.15% branches, 96.36% functions, and 86.73% lines, including a forced mid-batch rollback followed by successful exact retry.\n- Frozen installation resolves `@mindrail/contracts 0.0.0 <- packages/contracts`, confirming the root runtime uses the workspace contract package.\n',
)
replace_once(
    'CHANGELOG.md',
    '- The durable dispatcher currently supports `RegisterAgent`, `StartSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`. Remaining v0.1 lifecycle/cancellation commands are still canonical runtime behavior but are explicitly unsupported by the durable composition until matching atomic persistence paths are added.',
    '- The durable dispatcher currently supports `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, `CompleteTask`, `FailTask`, `BlockTask`, and `ResumeTask`. `RetryTask`, `CancelTask`, and `CancelGoal` remain canonical runtime behavior but are explicitly unsupported by the durable composition until matching atomic persistence paths are added.',
)
