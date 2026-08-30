from pathlib import Path

path = Path('test/application/durable-retry-cancellation.test.ts')
text = path.read_text()
start = text.index("  it('rejects a stale CancelGoal snapshot when an independent Task commit changes membership before its batch'")
end = text.index('\n  });\n});', start) + len('\n  });')
replacement = r'''  it('rejects CreateTask when its Goal becomes terminal after precheck but before the durable batch', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T22:00:00.000Z');
    const app = await openDispatcher(path, 'create-goal-race', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'create-goal-race');
    const cancelledGoal: Goal = {
      ...seeded.goal,
      revision: seeded.goal.revision + 1,
      status: 'cancelled',
      updatedAt: now.toISOString(),
    };
    app.database.beforeNextBatch(async () => {
      await app.database
        .prepare(
          `UPDATE goals
           SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
           WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'`,
        )
        .bind(
          cancelledGoal.revision,
          cancelledGoal.status,
          now.getTime(),
          JSON.stringify(cancelledGoal),
          cancelledGoal.workspaceId,
          cancelledGoal.id,
          seeded.goal.revision,
        )
        .run();
    });

    const response = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateTask',
      commandId: 'create-goal-race-command',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      title: 'Stale Goal Task',
      objective: 'Must not commit beneath a terminal Goal.',
      acceptanceCriteria: ['Database predicate rejects stale admission.'],
      requiredCapabilities: [],
      dependencyTaskIds: [],
    });
    expect(response).toHaveProperty('error');

    const snapshot = await app.persistence.loadWorkspaceState('ws-a');
    expect(snapshot?.goals.find((goal) => goal.id === seeded.goal.id)).toEqual(cancelledGoal);
    expect(snapshot?.tasks.some((task) => task.title === 'Stale Goal Task')).toBe(false);
    expect(await app.persistence.getCommandReceipt('ws-a', 'create-goal-race-command')).toBeUndefined();
    app.database.close();
  });'''
path.write_text(text[:start] + replacement + text[end:])
