from pathlib import Path

path = Path('test/application/durable-task-outcomes.test.ts')
text = path.read_text()

replacements = [
    (
        """    expect((await app.persistence.getTask('ws-a', seeded.task.id))?.status).toBe('failed');
    expect(await app.persistence.listTaskCheckpoints('ws-a', seeded.task.id)).toHaveLength(1);
    app.database.close();""",
        """    expect((await app.persistence.getTask('ws-a', seeded.task.id))?.status).toBe('failed');
    expect(await app.persistence.listTaskCheckpoints('ws-a', seeded.task.id)).toHaveLength(1);
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toMatchObject({
      status: 'released',
      revision: failed.lease.revision,
      fencingToken: failed.lease.fencingToken,
    });
    app.database.close();""",
    ),
    (
        """      command: 'BlockTask',
      commandId: 'block-command',
      workspaceId: 'ws-a',""",
        """      command: 'BlockTask',
      commandId: 'block-command',
      correlationId: 'block-first',
      workspaceId: 'ws-a',""",
    ),
    (
        """    app.database.close();

    app = await openDispatcher(path, 'resume-after', now);""",
        """    app.database.close();

    app = await openDispatcher(path, 'block-replay', now);
    const blockReplay = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'BlockTask',
      commandId: 'block-command',
      correlationId: 'block-replay',
      workspaceId: 'ws-a',
      actor: seeded.agentActor,
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: seeded.claim.lease.id,
      fencingToken: seeded.claim.lease.fencingToken,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'dependency.blocked', summary: 'Waiting for an external dependency.' },
      evidence: [],
    });
    expect(blockReplay).toMatchObject({ replayed: true, correlationId: 'block-replay' });
    expect(success<TaskOutcomeResult>(blockReplay)).toEqual(blocked);
    expect(await app.persistence.listTaskCheckpoints('ws-a', seeded.task.id)).toEqual([
      blocked.checkpoint,
    ]);
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toMatchObject({
      status: 'released',
      revision: blocked.lease.revision,
      fencingToken: blocked.lease.fencingToken,
    });
    app.database.close();

    app = await openDispatcher(path, 'resume-after', now);""",
    ),
    (
        """    expect(success<Task>(replay)).toEqual(resumed);
    expect((await app.persistence.getTask('ws-a', seeded.task.id))?.status).toBe('ready');
    app.database.close();""",
        """    expect(success<Task>(replay)).toEqual(resumed);
    const persistedResumed = await app.persistence.getTask('ws-a', seeded.task.id);
    expect(persistedResumed).toMatchObject({
      status: 'ready',
      revision: resumed.revision,
    });
    expect(persistedResumed).not.toHaveProperty('statusReason');
    app.database.close();""",
    ),
]

for before, after in replacements:
    if text.count(before) != 1:
        raise RuntimeError(f'expected exactly one replacement marker, found {text.count(before)}')
    text = text.replace(before, after, 1)

path.write_text(text)
