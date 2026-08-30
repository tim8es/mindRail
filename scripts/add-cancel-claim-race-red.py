from pathlib import Path

path = Path('test/application/durable-retry-cancellation.test.ts')
text = path.read_text()
new_tests = r'''

  it('prevents a paused recovery ClaimTask from minting authority after CancelTask commits first', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T22:30:00.000Z');
    const seed = await openDispatcher(path, 'cancel-claim-race-seed', now);
    await seed.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(seed.dispatcher, 'cancel-claim-race');
    success<Lease>(
      await seed.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'ReleaseLease',
        commandId: 'cancel-claim-race-release',
        workspaceId: 'ws-a',
        actor: seeded.agentActor,
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        expectedLeaseRevision: seeded.claim.lease.revision,
      }),
    );
    seed.database.close();

    const claimApp = await openDispatcher(path, 'cancel-claim-race-claim', now);
    const cancelApp = await openDispatcher(path, 'cancel-claim-race-cancel', now);
    let claimArrivedResolve!: () => void;
    let releaseClaim!: () => void;
    const claimArrived = new Promise<void>((resolve) => (claimArrivedResolve = resolve));
    const claimRelease = new Promise<void>((resolve) => (releaseClaim = resolve));
    claimApp.database.beforeNextBatch(async () => {
      claimArrivedResolve();
      await claimRelease;
    });

    const claimPromise = claimApp.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'ClaimTask',
      commandId: 'cancel-claim-race-claim-command',
      workspaceId: 'ws-a',
      actor: seeded.agentActor,
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      expectedTaskRevision: seeded.claim.task.revision,
    });
    await claimArrived;

    const cancelled = success<CancelTaskResult>(
      await cancelApp.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'CancelTask',
        commandId: 'cancel-claim-race-cancel-command',
        workspaceId: 'ws-a',
        actor: seeded.systemActor,
        taskId: seeded.task.id,
        expectedTaskRevision: seeded.claim.task.revision,
        reason: { code: 'controller.cancelled', summary: 'Cancellation wins the recovery race.' },
      }),
    );
    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled).not.toHaveProperty('lease');

    releaseClaim();
    const staleClaim = await claimPromise;
    expect(staleClaim).toHaveProperty('error');
    const snapshot = await cancelApp.persistence.loadWorkspaceState('ws-a');
    expect(snapshot?.tasks.find((task) => task.id === seeded.task.id)?.status).toBe('cancelled');
    expect(
      snapshot?.leases.some(
        (lease) => lease.taskId === seeded.task.id && lease.status === 'active',
      ),
    ).toBe(false);
    expect(await claimApp.persistence.getCommandReceipt('ws-a', 'cancel-claim-race-claim-command')).toBeUndefined();
    claimApp.database.close();
    cancelApp.database.close();
  });

  it('prevents a paused recovery ClaimTask from minting authority after CancelGoal commits first', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T23:00:00.000Z');
    const seed = await openDispatcher(path, 'goal-claim-race-seed', now);
    await seed.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(seed.dispatcher, 'goal-claim-race');
    success<Lease>(
      await seed.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'ReleaseLease',
        commandId: 'goal-claim-race-release',
        workspaceId: 'ws-a',
        actor: seeded.agentActor,
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        expectedLeaseRevision: seeded.claim.lease.revision,
      }),
    );
    seed.database.close();

    const claimApp = await openDispatcher(path, 'goal-claim-race-claim', now);
    const cancelApp = await openDispatcher(path, 'goal-claim-race-cancel', now);
    let claimArrivedResolve!: () => void;
    let releaseClaim!: () => void;
    const claimArrived = new Promise<void>((resolve) => (claimArrivedResolve = resolve));
    const claimRelease = new Promise<void>((resolve) => (releaseClaim = resolve));
    claimApp.database.beforeNextBatch(async () => {
      claimArrivedResolve();
      await claimRelease;
    });

    const claimPromise = claimApp.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'ClaimTask',
      commandId: 'goal-claim-race-claim-command',
      workspaceId: 'ws-a',
      actor: seeded.agentActor,
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      expectedTaskRevision: seeded.claim.task.revision,
    });
    await claimArrived;

    const cancelled = success<CancelGoalResult>(
      await cancelApp.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'CancelGoal',
        commandId: 'goal-claim-race-cancel-command',
        workspaceId: 'ws-a',
        actor: seeded.systemActor,
        goalId: seeded.goal.id,
        expectedGoalRevision: seeded.goal.revision,
        reason: { code: 'controller.cancelled', summary: 'Goal cancellation wins recovery race.' },
      }),
    );
    expect(cancelled.goal.status).toBe('cancelled');
    expect(cancelled.tasks).toHaveLength(1);
    expect(cancelled.leases).toHaveLength(0);

    releaseClaim();
    const staleClaim = await claimPromise;
    expect(staleClaim).toHaveProperty('error');
    const snapshot = await cancelApp.persistence.loadWorkspaceState('ws-a');
    expect(snapshot?.goals.find((goal) => goal.id === seeded.goal.id)?.status).toBe('cancelled');
    expect(snapshot?.tasks.find((task) => task.id === seeded.task.id)?.status).toBe('cancelled');
    expect(
      snapshot?.leases.some(
        (lease) => lease.taskId === seeded.task.id && lease.status === 'active',
      ),
    ).toBe(false);
    expect(await claimApp.persistence.getCommandReceipt('ws-a', 'goal-claim-race-claim-command')).toBeUndefined();
    claimApp.database.close();
    cancelApp.database.close();
  });
'''
marker = '\n});\n'
if not text.endswith(marker):
    raise RuntimeError('unexpected test suffix')
path.write_text(text[:-len(marker)] + new_tests + marker)
