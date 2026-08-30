from pathlib import Path

path = Path('test/application/durable-retry-cancellation.test.ts')
text = path.read_text()
start = text.index("  it('prevents a stale CreateTask batch from surviving beneath CancelGoal with independent coordinators'")
end = text.index('\n  });\n});', start) + len('\n  });')
replacement = r'''  it('rejects a stale CancelGoal snapshot when an independent persistence handle admits a Task before its batch', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T22:00:00.000Z');
    let seed = await openDispatcher(path, 'cancel-db-race-seed', now);
    await seed.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(seed.dispatcher, 'cancel-db-race');
    seed.database.close();

    const cancelApp = await openDispatcher(path, 'cancel-db-race-controller', now);
    const injector = await openPersistence(path);
    const concurrentTask: Task = {
      workspaceId: 'ws-a',
      id: 'cancel-db-race-concurrent-task',
      goalId: seeded.goal.id,
      title: 'Concurrent Task',
      objective: 'Commit after the cancellation snapshot but before its durable batch.',
      acceptanceCriteria: ['Never survive beneath a cancelled Goal.'],
      requiredCapabilities: [],
      dependencyTaskIds: [],
      status: 'ready',
      revision: 1,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    cancelApp.database.beforeNextBatch(async () => {
      const injected = await injector.persistence.createTask({ task: concurrentTask });
      expect(injected).toMatchObject({ kind: 'committed', value: concurrentTask });
    });

    const staleCancellation = await cancelApp.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cancel-db-race-goal',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      expectedGoalRevision: seeded.goal.revision,
      reason: { code: 'controller.cancelled', summary: 'Race database task admission.' },
    });
    expect(staleCancellation).toHaveProperty('error');

    const afterRace = await cancelApp.persistence.loadWorkspaceState('ws-a');
    expect(afterRace?.goals.find((goal) => goal.id === seeded.goal.id)?.status).toBe('active');
    expect(afterRace?.tasks.find((task) => task.id === concurrentTask.id)).toEqual(concurrentTask);

    const freshCancel = await cancelApp.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cancel-db-race-goal-fresh',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      expectedGoalRevision: seeded.goal.revision,
      reason: { code: 'controller.cancelled', summary: 'Retry with a fresh Task set.' },
    });
    const committed = success<CancelGoalResult>(freshCancel);
    expect(committed.goal.status).toBe('cancelled');
    expect(committed.tasks).toHaveLength(2);
    const finalSnapshot = await cancelApp.persistence.loadWorkspaceState('ws-a');
    const finalGoalTasks =
      finalSnapshot?.tasks.filter((task) => task.goalId === seeded.goal.id) ?? [];
    expect(finalGoalTasks).toHaveLength(2);
    expect(finalGoalTasks.every((task) => task.status === 'cancelled')).toBe(true);
    cancelApp.database.close();
    injector.database.close();
  });'''
path.write_text(text[:start] + replacement + text[end:])
