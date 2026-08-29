from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing docs anchor: {label}")
    return text.replace(old, new, 1)


current = Path('docs/CURRENT_STATE.md')
text = current.read_text()
text = replace_once(
    text,
    "- The first durable command loop is executable for `RegisterAgent`, `StartSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`.\n",
    "- The durable command loop is executable for `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`.\n- Durable Session/Lease liveness preserves the runtime authority model: heartbeat advances only Session liveness/revision, Lease renewal keeps the fencing token stable, release leaves the Task running/recoverable, and ending a Session revokes its still-effective active Leases without completing the Task.\n",
    'current durable command list',
)
text = replace_once(
    text,
    "- The durable dispatcher currently supports only the first command loop listed above. `HeartbeatSession`, `EndSession`, `RenewLease`, `ReleaseLease`, `FailTask`, `BlockTask`, `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal` remain implemented in canonical runtime semantics but are explicitly unsupported by the durable dispatcher until their atomic persistence mutations are added.\n",
    "- The durable dispatcher still leaves `FailTask`, `BlockTask`, `ResumeTask`, `RetryTask`, `CancelTask`, and `CancelGoal` explicitly unsupported until matching atomic persistence mutations are added.\n",
    'current remaining durable commands',
)
verification_anchor = "- Final correctness review RED run `33275182068` demonstrated both remaining defects: the two new regressions failed because terminal semantic errors had no durable receipt and recovery work discovery omitted a `running` Task after its effective Lease expired, while the previous **123 tests passed**. Review-fix run `33275312677` then passed focused regressions, full `pnpm check`, and coverage with **30/30 test files and 125/125 tests**. Overall coverage was 85.43% statements, 73.5% branches, 96.18% functions, and 87.07% lines.\n"
text = replace_once(
    text,
    verification_anchor,
    verification_anchor + "- Durable Session/Lease liveness RED Quality run `33276800987` passed formatting/lint/typecheck/contracts and the previous **125 tests**, while all four new HTTP E2E regressions failed exactly because `HeartbeatSession`, `EndSession`, `RenewLease`, and `ReleaseLease` returned `UNSUPPORTED_OPERATION`. GREEN run `33276973691` then passed the focused 4/4 liveness E2E tests, full `pnpm check` with **31/31 test files and 129/129 tests**, and coverage at 85.19% statements, 73.88% branches, 96.3% functions, and 86.83% lines.\n",
    'current liveness verification',
)
current.write_text(text)


roadmap = Path('docs/roadmap/V0_1.md')
text = roadmap.read_text()
text = replace_once(
    text,
    "The canonical runtime/application command surface implements all ADR-0005 v0.1 commands, including Agent registration and Session bootstrap, lifecycle/recovery, permission request/decision, cancellation, and idempotent replay. The first durable command loop is composed for `RegisterAgent`, `StartSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`. Remaining durable commands fail explicitly as unsupported until matching atomic persistence mutations exist.\n",
    "The canonical runtime/application command surface implements all ADR-0005 v0.1 commands, including Agent registration and Session bootstrap, lifecycle/recovery, permission request/decision, cancellation, and idempotent replay. Durable composition now covers `RegisterAgent`, `StartSession`, `HeartbeatSession`, `EndSession`, `CreateGoal`, `CreateTask`, `ClaimTask`, `RenewLease`, `ReleaseLease`, `RecordCheckpoint`, `RequestPermission`, `RecordPermissionDecision`, and `CompleteTask`. Remaining durable commands fail explicitly as unsupported until matching atomic persistence mutations exist.\n",
    'roadmap protocol durable list',
)
text = replace_once(
    text,
    "The remaining local/runtime work is to extend atomic durable composition to the rest of the v0.1 command surface where required for dogfooding. The executed SQLite/D1-like tests do not substitute for deployed Cloudflare verification.\n",
    "Durable Session/Lease liveness is now covered through HTTP restart E2E: heartbeat does not extend Lease authority, renew preserves the fence, release permits higher-fence recovery, and EndSession durably revokes active Lease authority before recovery. The remaining local/runtime work is to extend atomic durable composition to the task failure/block/resume/retry/cancellation surface where required for dogfooding. The executed SQLite/D1-like tests do not substitute for deployed Cloudflare verification.\n",
    'roadmap runtime remaining work',
)
roadmap.write_text(text)


changelog = Path('CHANGELOG.md')
text = changelog.read_text()
anchor = "- Admitted terminal semantic failures in the supported durable command loop now persist immutable `outcomeKind: error` command receipts and replay after restart instead of re-executing the command.\n"
text = replace_once(
    text,
    anchor,
    anchor + "- Durable Session/Lease liveness composition now supports `HeartbeatSession`, `EndSession`, `RenewLease`, and `ReleaseLease` with atomic mutation receipts, restart-safe replay, stable renewal fencing, and recoverable released/revoked execution authority.\n",
    'changelog liveness bullet',
)
changelog.write_text(text)
