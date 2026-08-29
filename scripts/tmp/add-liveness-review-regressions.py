from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing review anchor: {label}")
    return text.replace(old, new, 1)


harness = Path('test/persistence/d1-sqlite-harness.ts')
text = harness.read_text()
text = replace_once(
    text,
    """export class SqliteD1Database implements D1DatabaseLike {
  private readonly database: DatabaseSync;

  constructor(path: string) {
""",
    """export class SqliteD1Database implements D1DatabaseLike {
  private readonly database: DatabaseSync;
  private failNextBatchAfterStatementCount: number | undefined;

  constructor(path: string) {
""",
    'harness failure state',
)
text = replace_once(
    text,
    """  async batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const results = statements.map((statement) => {
        if (!(statement instanceof SqliteD1PreparedStatement)) {
          throw new TypeError('SqliteD1Database can only batch its own prepared statements.');
        }
        return statement.runSync();
      });
      this.database.exec('COMMIT;');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  async exec(sql: string): Promise<void> {
""",
    """  async batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const results: D1ResultLike[] = [];
      for (const statement of statements) {
        if (!(statement instanceof SqliteD1PreparedStatement)) {
          throw new TypeError('SqliteD1Database can only batch its own prepared statements.');
        }
        if (
          this.failNextBatchAfterStatementCount !== undefined &&
          results.length === this.failNextBatchAfterStatementCount
        ) {
          throw new Error('Injected D1-like batch failure.');
        }
        results.push(statement.runSync());
      }
      this.failNextBatchAfterStatementCount = undefined;
      this.database.exec('COMMIT;');
      return results;
    } catch (error) {
      this.failNextBatchAfterStatementCount = undefined;
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  failNextBatchAfterStatements(statementCount: number): void {
    if (!Number.isSafeInteger(statementCount) || statementCount < 0) {
      throw new TypeError('statementCount must be a non-negative safe integer.');
    }
    this.failNextBatchAfterStatementCount = statementCount;
  }

  async exec(sql: string): Promise<void> {
""",
    'harness batch failure injection',
)
harness.write_text(text)


test_file = Path('test/e2e/durable-session-lease-liveness-e2e.test.ts')
text = test_file.read_text()
release_anchor = """    expect(recovered.result.lease.fencingToken).toBeGreaterThan(seeded.claim.lease.fencingToken);
    expect(recovered.result.lease.sessionId).toBe(recoverySession.result.id);
    app.database.close();
  });

  it('ends a Session and revokes its active Lease atomically before recovery', async () => {
"""
release_replacement = """    expect(recovered.result.lease.fencingToken).toBeGreaterThan(seeded.claim.lease.fencingToken);
    expect(recovered.result.lease.sessionId).toBe(recoverySession.result.id);
    app.database.close();

    app = await openApplication(path, 'release-replay', clock);
    const replay = await send(app.transport, 'commands', 'ReleaseLease', seeded.agentActor, {
      commandId: 'release-command',
      correlationId: 'release-replay',
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: seeded.claim.lease.id,
      fencingToken: seeded.claim.lease.fencingToken,
      expectedLeaseRevision: seeded.claim.lease.revision,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, correlationId: 'release-replay' });
    expect(replay.body.result).toEqual(released.result);
    app.database.close();
  });

  it('ends a Session and revokes its active Lease atomically before recovery', async () => {
"""
text = replace_once(text, release_anchor, release_replacement, 'release replay')

end_anchor = """    expect(recovered.result.lease.fencingToken).toBeGreaterThan(seeded.claim.lease.fencingToken);
    app.database.close();
  });
});
"""
end_replacement = """    expect(recovered.result.lease.fencingToken).toBeGreaterThan(seeded.claim.lease.fencingToken);
    app.database.close();

    app = await openApplication(path, 'end-replay', clock);
    const replay = await send(app.transport, 'commands', 'EndSession', seeded.agentActor, {
      commandId: 'end-command',
      correlationId: 'end-replay',
      sessionId: seeded.session.id,
      expectedSessionRevision: seeded.session.revision,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, correlationId: 'end-replay' });
    expect(replay.body.result).toEqual(ended.result);
    app.database.close();
  });

  it('rolls back Session, Lease, and receipt together when EndSession batch fails mid-flight', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-30T14:00:00.000Z') };
    const app = await openApplication(path, 'end-rollback', clock);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.transport, 'end-rollback');

    app.database.failNextBatchAfterStatements(1);
    const failed = await send(app.transport, 'commands', 'EndSession', seeded.agentActor, {
      commandId: 'end-rollback-command',
      sessionId: seeded.session.id,
      expectedSessionRevision: seeded.session.revision,
    });
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({
      replayed: false,
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(await app.persistence.getSession('ws-a', seeded.session.id)).toEqual(seeded.session);
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toEqual(seeded.claim.lease);
    expect(await app.persistence.getCommandReceipt('ws-a', 'end-rollback-command')).toBeUndefined();

    const retry = await command<EndSessionResult>(
      app.transport,
      'EndSession',
      'end-rollback-command',
      seeded.agentActor,
      {
        sessionId: seeded.session.id,
        expectedSessionRevision: seeded.session.revision,
      },
    );
    expect(retry.result.session.status).toBe('ended');
    expect(retry.result.leases).toHaveLength(1);
    expect(retry.result.leases[0]?.status).toBe('revoked');
    app.database.close();
  });
});
"""
text = replace_once(text, end_anchor, end_replacement, 'end replay and rollback')
test_file.write_text(text)
