from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing finalization anchor: {label}")
    return text.replace(old, new, 1)


dispatcher = Path('src/application/durable-dispatcher.ts')
text = dispatcher.read_text()
text = replace_once(
    text,
    """        const session = await options.persistence.getSession(query.workspaceId, query.sessionId);
        if (!session) return queryFailure(query, 'NOT_FOUND', 'Durable Session was not found.');
        const staleAt = Date.parse(session.lastSeenAt) + options.sessionTimeoutMs;
        if (session.status !== 'active' || options.now().getTime() >= staleAt) {
""",
    """        const session = await options.persistence.getSession(query.workspaceId, query.sessionId);
        if (!session) return queryFailure(query, 'NOT_FOUND', 'Durable Session was not found.');
        const now = options.now();
        const staleAt = Date.parse(session.lastSeenAt) + options.sessionTimeoutMs;
        if (session.status !== 'active' || now.getTime() >= staleAt) {
""",
    'single authoritative claimable now',
)
text = replace_once(
    text,
    """        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const now = options.now();
        const rows = await options.persistence.listClaimableTasks(
""",
    """        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listClaimableTasks(
""",
    'remove second claimable now',
)
dispatcher.write_text(text)


current = Path('docs/CURRENT_STATE.md')
text = current.read_text()
text = replace_once(
    text,
    """- Durable command replay first reads the persisted `(workspaceId, commandId)` receipt. Exact retries survive application/database-handle replacement, return `replayed: true`, preserve the immutable stored result/error snapshot, and reflect the current correlation id. Semantic command-id drift fails with `IDEMPOTENCY_CONFLICT`.
- Explicit durable read ports and application queries are implemented for `GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListTaskCheckpoints`, `ListPendingHumanPermissions`, `ListPermissionDecisions`, and advisory `ListClaimableTasks`. List queries use bounded deterministic cursor paging; work acquisition still revalidates authority atomically at `ClaimTask`.
""",
    """- Durable command replay first reads the persisted `(workspaceId, commandId)` receipt. Exact retries survive application/database-handle replacement, return `replayed: true`, preserve the immutable stored result/error snapshot, and reflect the current correlation id. Semantic command-id drift fails with `IDEMPOTENCY_CONFLICT`.
- Admitted terminal semantic failures on the supported durable command loop are also persisted as immutable error receipts, so an exact retry after restart replays the original terminal error instead of silently re-executing the command.
- Explicit durable read ports and application queries are implemented for `GetWorkspace`, `GetGoal`, `GetTask`, `GetLease`, `GetAgent`, `GetSession`, `GetPermissionRequest`, `ListTaskCheckpoints`, `ListPendingHumanPermissions`, `ListPermissionDecisions`, and advisory `ListClaimableTasks`. List queries use bounded deterministic cursor paging. `ListClaimableTasks` includes capability-compatible `ready` Tasks plus `running` Tasks whose prior Lease/Session authority is no longer effective at the authoritative server time; work acquisition still revalidates authority atomically at `ClaimTask`.
""",
    'current state durable receipt/query facts',
)
text = replace_once(
    text,
    """- Permanent `Quality` run `33274903333` on the durable HTTP E2E tree passed formatting, lint, strict TypeScript, generated-contract drift checks, **29/29 test files and 123/123 tests**, and coverage. Reported overall coverage was 85.3% statements, 73.3% branches, 96.15% functions, and 86.95% lines.
""",
    """- Permanent `Quality` run `33274903333` on the durable HTTP E2E tree passed formatting, lint, strict TypeScript, generated-contract drift checks, **29/29 test files and 123/123 tests**, and coverage. Reported overall coverage was 85.3% statements, 73.3% branches, 96.15% functions, and 86.95% lines.
- Final correctness review RED run `33275182068` demonstrated both remaining defects: the two new regressions failed because terminal semantic errors had no durable receipt and recovery work discovery omitted a `running` Task after its effective Lease expired, while the previous **123 tests passed**. Review-fix run `33275312677` then passed focused regressions, full `pnpm check`, and coverage with **30/30 test files and 125/125 tests**. Overall coverage was 85.43% statements, 73.5% branches, 96.18% functions, and 87.07% lines.
""",
    'current state review verification',
)
current.write_text(text)


roadmap = Path('docs/roadmap/V0_1.md')
text = roadmap.read_text()
text = replace_once(
    text,
    """- advisory `ListClaimableTasks` with atomic authority revalidation at `ClaimTask`.
""",
    """- advisory `ListClaimableTasks` for both new `ready` work and `running` recovery work without effective Lease authority, with atomic authority revalidation at `ClaimTask`.
""",
    'roadmap claimable recovery',
)
roadmap.write_text(text)


changelog = Path('CHANGELOG.md')
text = changelog.read_text()
text = replace_once(
    text,
    """- Durable `ListClaimableTasks` is advisory only; Task execution authority is still acquired and revalidated atomically by `ClaimTask`.
""",
    """- Durable `ListClaimableTasks` is advisory only; it exposes capability-compatible `ready` Tasks and `running` recovery Tasks whose prior Lease/Session authority is no longer effective at authoritative server time, while Task execution authority is still acquired and revalidated atomically by `ClaimTask`.
- Admitted terminal semantic failures in the supported durable command loop now persist immutable `outcomeKind: error` command receipts and replay after restart instead of re-executing the command.
""",
    'changelog correctness changes',
)
text = replace_once(
    text,
    """- Permanent Quality run `33274903333` passed the restart-safe durable HTTP E2E tree with **29/29 test files and 123/123 tests**, plus `pnpm test:coverage`. Overall coverage reported 85.3% statements, 73.3% branches, 96.15% functions, and 86.95% lines.
""",
    """- Permanent Quality run `33274903333` passed the restart-safe durable HTTP E2E tree with **29/29 test files and 123/123 tests**, plus `pnpm test:coverage`. Overall coverage reported 85.3% statements, 73.3% branches, 96.15% functions, and 86.95% lines.
- Final correctness-review RED run `33275182068` failed exactly the two new terminal-error-receipt and recovery-discovery regressions while the previous 123 tests passed. Review-fix run `33275312677` then passed focused regressions, full `pnpm check`, and coverage with **30/30 test files and 125/125 tests**; overall coverage was 85.43% statements, 73.5% branches, 96.18% functions, and 87.07% lines.
""",
    'changelog review verification',
)
changelog.write_text(text)
