from pathlib import Path

path = Path('test/application/durable-task-outcomes.test.ts')
text = path.read_text()
marker = "\n});\n"
if not text.endswith(marker):
    raise RuntimeError('unexpected durable-task-outcomes test suffix')

test = r'''

  it('rolls back FailTask state, checkpoint, and receipt when the durable batch fails', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T17:00:00.000Z');
    let app = await openDispatcher(path, 'fail-atomic-before', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'fail-atomic');

    app.database.failNextBatchAfterStatements(1);
    const failedCommit = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'FailTask',
      commandId: 'fail-atomic-command',
      correlationId: 'fail-atomic-first',
      workspaceId: 'ws-a',
      actor: seeded.agentActor,
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: seeded.claim.lease.id,
      fencingToken: seeded.claim.lease.fencingToken,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'execution.failed', summary: 'Injected durable failure.' },
      summary: 'This transaction must roll back.',
      evidence: [],
    });
    expect(failedCommit).toHaveProperty('error');
    expect(await app.persistence.getTask('ws-a', seeded.task.id)).toMatchObject({
      status: 'running',
      revision: seeded.claim.task.revision,
    });
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toMatchObject({
      status: 'active',
      revision: seeded.claim.lease.revision,
      fencingToken: seeded.claim.lease.fencingToken,
    });
    expect(await app.persistence.listTaskCheckpoints('ws-a', seeded.task.id)).toEqual([]);
    expect(await app.persistence.getCommandReceipt('ws-a', 'fail-atomic-command')).toBeUndefined();
    app.database.close();

    app = await openDispatcher(path, 'fail-atomic-retry', now);
    const retry = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'FailTask',
      commandId: 'fail-atomic-command',
      correlationId: 'fail-atomic-retry',
      workspaceId: 'ws-a',
      actor: seeded.agentActor,
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: seeded.claim.lease.id,
      fencingToken: seeded.claim.lease.fencingToken,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'execution.failed', summary: 'Injected durable failure.' },
      summary: 'This transaction must roll back.',
      evidence: [],
    });
    const committed = success<TaskOutcomeResult>(retry);
    expect(committed.task.status).toBe('failed');
    expect(committed.lease.status).toBe('released');
    expect(await app.persistence.listTaskCheckpoints('ws-a', seeded.task.id)).toEqual([
      committed.checkpoint,
    ]);
    expect(await app.persistence.getCommandReceipt('ws-a', 'fail-atomic-command')).toBeDefined();
    app.database.close();
  });
'''

path.write_text(text[:-len(marker)] + test + marker)
