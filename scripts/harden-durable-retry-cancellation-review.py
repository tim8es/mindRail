from pathlib import Path


def replace_once(path: str, before: str, after: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f'{path}: expected one marker, found {count}')
    file.write_text(text.replace(before, after, 1))


replace_once(
    'test/persistence/setup.ts',
    "import { D1RuntimePersistence } from '../../src/persistence/cloudflare/d1-runtime-persistence.ts';\n",
    "import { D1RuntimePersistence } from '../../src/persistence/cloudflare/d1-runtime-persistence.ts';\nimport type { WorkspaceMutationCoordinator } from '../../src/persistence/ports.ts';\n",
)
replace_once(
    'test/persistence/setup.ts',
    '''export async function openPersistence(path: string): Promise<{
  database: SqliteD1Database;
  persistence: D1RuntimePersistence;
}> {''',
    '''export async function openPersistence(
  path: string,
  coordinator: WorkspaceMutationCoordinator = new WorkspaceDurableObjectCoordinator(),
): Promise<{
  database: SqliteD1Database;
  persistence: D1RuntimePersistence;
}> {''',
)
replace_once(
    'test/persistence/setup.ts',
    '''  const persistence = new D1RuntimePersistence({
    database,
    coordinator: new WorkspaceDurableObjectCoordinator(),
    validateCanonicalDomainRecord: persistenceCanonicalValidator,
  });''',
    '''  const persistence = new D1RuntimePersistence({
    database,
    coordinator,
    validateCanonicalDomainRecord: persistenceCanonicalValidator,
  });''',
)

replace_once(
    'test/persistence/d1-sqlite-harness.ts',
    '''  private failNextBatchAfterStatementCount: number | undefined;
''',
    '''  private failNextBatchAfterStatementCount: number | undefined;
  private beforeNextBatchHook: (() => Promise<void>) | undefined;
''',
)
replace_once(
    'test/persistence/d1-sqlite-harness.ts',
    '''  async batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    this.database.exec('BEGIN IMMEDIATE;');''',
    '''  async batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    const beforeBatch = this.beforeNextBatchHook;
    this.beforeNextBatchHook = undefined;
    if (beforeBatch) await beforeBatch();
    this.database.exec('BEGIN IMMEDIATE;');''',
)
replace_once(
    'test/persistence/d1-sqlite-harness.ts',
    '''  failNextBatchAfterStatements(statementCount: number): void {
    if (!Number.isSafeInteger(statementCount) || statementCount < 0) {
      throw new TypeError('statementCount must be a non-negative safe integer.');
    }
    this.failNextBatchAfterStatementCount = statementCount;
  }
''',
    '''  failNextBatchAfterStatements(statementCount: number): void {
    if (!Number.isSafeInteger(statementCount) || statementCount < 0) {
      throw new TypeError('statementCount must be a non-negative safe integer.');
    }
    this.failNextBatchAfterStatementCount = statementCount;
  }

  beforeNextBatch(hook: () => Promise<void>): void {
    this.beforeNextBatchHook = hook;
  }
''',
)

replace_once(
    'test/application/durable-retry-cancellation.test.ts',
    "import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';\n",
    "import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';\nimport { WorkspaceDurableObjectCoordinator } from '../../src/persistence/cloudflare/workspace-durable-object-coordinator.ts';\nimport type { WorkspaceMutationCoordinator } from '../../src/persistence/ports.ts';\n",
)
replace_once(
    'test/application/durable-retry-cancellation.test.ts',
    '''async function openDispatcher(path: string, prefix: string, now: Date) {
  const opened = await openPersistence(path);''',
    '''async function openDispatcher(
  path: string,
  prefix: string,
  now: Date,
  coordinator?: WorkspaceMutationCoordinator,
) {
  const opened = await openPersistence(path, coordinator);''',
)

class_code = r'''
class OrderedTwoPartyCoordinator implements WorkspaceMutationCoordinator {
  readonly firstArrived: Promise<void>;
  private firstArrivedResolve!: () => void;
  private secondArrived: Promise<void>;
  private secondArrivedResolve!: () => void;
  private firstQueued: Promise<void>;
  private firstQueuedResolve!: () => void;
  private arrivals = 0;

  constructor(private readonly inner: WorkspaceMutationCoordinator) {
    this.firstArrived = new Promise((resolve) => {
      this.firstArrivedResolve = resolve;
    });
    this.secondArrived = new Promise((resolve) => {
      this.secondArrivedResolve = resolve;
    });
    this.firstQueued = new Promise((resolve) => {
      this.firstQueuedResolve = resolve;
    });
  }

  runSerialized<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    this.arrivals += 1;
    const position = this.arrivals;
    if (position === 1) {
      this.firstArrivedResolve();
      return this.queueFirst(workspaceId, operation);
    }
    if (position === 2) {
      this.secondArrivedResolve();
      return this.queueSecond(workspaceId, operation);
    }
    return this.inner.runSerialized(workspaceId, operation);
  }

  private async queueFirst<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    await this.secondArrived;
    const result = this.inner.runSerialized(workspaceId, operation);
    this.firstQueuedResolve();
    return result;
  }

  private async queueSecond<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    await this.firstQueued;
    return this.inner.runSerialized(workspaceId, operation);
  }
}
'''
replace_once(
    'test/application/durable-retry-cancellation.test.ts',
    "\nfunction success<T>(response: CommandResponse): T {",
    class_code + "\nfunction success<T>(response: CommandResponse): T {",
)

new_tests = r'''

  it('cancels a recoverable running Task without requiring an effective Lease', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T19:30:00.000Z');
    let app = await openDispatcher(path, 'cancel-no-lease-before', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'cancel-no-lease');
    success<Lease>(
      await app.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'ReleaseLease',
        commandId: 'cancel-no-lease-release',
        workspaceId: 'ws-a',
        actor: seeded.agentActor,
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        expectedLeaseRevision: seeded.claim.lease.revision,
      }),
    );
    app.database.close();

    app = await openDispatcher(path, 'cancel-no-lease-after', now);
    const response = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelTask',
      commandId: 'cancel-no-lease-command',
      correlationId: 'cancel-no-lease-first',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'controller.cancelled', summary: 'Recoverable work is no longer required.' },
    });
    const cancelled = success<CancelTaskResult>(response);
    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled).not.toHaveProperty('lease');
    app.database.close();

    app = await openDispatcher(path, 'cancel-no-lease-replay', now);
    const replay = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelTask',
      commandId: 'cancel-no-lease-command',
      correlationId: 'cancel-no-lease-replay',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'controller.cancelled', summary: 'Recoverable work is no longer required.' },
    });
    expect(replay).toMatchObject({ replayed: true, correlationId: 'cancel-no-lease-replay' });
    expect(success<CancelTaskResult>(replay)).toEqual(cancelled);
    expect(await app.persistence.getTask('ws-a', seeded.task.id)).toEqual(cancelled.task);
    app.database.close();
  });

  it('rolls back Goal, Tasks, Lease, and receipt when CancelGoal batch fails mid-transaction', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T20:30:00.000Z');
    let app = await openDispatcher(path, 'cancel-goal-atomic-before', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'cancel-goal-atomic');
    const secondTask = success<Task>(
      await app.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'CreateTask',
        commandId: 'cancel-goal-atomic-second-task',
        workspaceId: 'ws-a',
        actor: seeded.systemActor,
        goalId: seeded.goal.id,
        title: 'Second atomic cancellation task',
        objective: 'Remain ready before injected cancellation failure.',
        acceptanceCriteria: ['Rollback preserves this Task.'],
        requiredCapabilities: [],
        dependencyTaskIds: [],
      }),
    );

    app.database.failNextBatchAfterStatements(2);
    const failed = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cancel-goal-atomic-command',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      expectedGoalRevision: seeded.goal.revision,
      reason: { code: 'controller.cancelled', summary: 'Injected atomic cancellation failure.' },
    });
    expect(failed).toHaveProperty('error');
    expect(await app.persistence.getGoal('ws-a', seeded.goal.id)).toEqual(seeded.goal);
    expect(await app.persistence.getTask('ws-a', seeded.task.id)).toEqual(seeded.claim.task);
    expect(await app.persistence.getTask('ws-a', secondTask.id)).toEqual(secondTask);
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toEqual(seeded.claim.lease);
    expect(await app.persistence.getCommandReceipt('ws-a', 'cancel-goal-atomic-command')).toBeUndefined();
    app.database.close();

    app = await openDispatcher(path, 'cancel-goal-atomic-retry', now);
    const retry = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cancel-goal-atomic-command',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      expectedGoalRevision: seeded.goal.revision,
      reason: { code: 'controller.cancelled', summary: 'Injected atomic cancellation failure.' },
    });
    const committed = success<CancelGoalResult>(retry);
    expect(committed.goal.status).toBe('cancelled');
    expect(committed.tasks).toHaveLength(2);
    expect(committed.leases).toHaveLength(1);
    app.database.close();
  });

  it('serializes stale CreateTask persistence behind CancelGoal through one Workspace authority', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T21:00:00.000Z');
    let seed = await openDispatcher(path, 'cancel-race-seed', now);
    await seed.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(seed.dispatcher, 'cancel-race');
    seed.database.close();

    const sharedAuthority = new WorkspaceDurableObjectCoordinator('ws-a');
    const rendezvous = new OrderedTwoPartyCoordinator(sharedAuthority);
    const cancelApp = await openDispatcher(path, 'cancel-race-controller', now, rendezvous);
    const createApp = await openDispatcher(path, 'cancel-race-creator', now, rendezvous);

    const cancelPromise = cancelApp.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cancel-race-goal-shared',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      expectedGoalRevision: seeded.goal.revision,
      reason: { code: 'controller.cancelled', summary: 'Cancel before stale Task commit.' },
    });
    await rendezvous.firstArrived;

    const createPromise = createApp.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateTask',
      commandId: 'cancel-race-create-shared',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      title: 'Stale observed Task',
      objective: 'Must not survive beneath a cancelled Goal.',
      acceptanceCriteria: ['Persistence rejects stale creation.'],
      requiredCapabilities: [],
      dependencyTaskIds: [],
    });

    const [cancelledResponse, createResponse] = await Promise.all([cancelPromise, createPromise]);
    expect(success<CancelGoalResult>(cancelledResponse).goal.status).toBe('cancelled');
    expect('error' in createResponse && createResponse.error.code).toBe('INVALID_STATE_TRANSITION');

    const snapshot = await cancelApp.persistence.loadWorkspaceState('ws-a');
    expect(snapshot?.goals.find((goal) => goal.id === seeded.goal.id)?.status).toBe('cancelled');
    const goalTasks = snapshot?.tasks.filter((task) => task.goalId === seeded.goal.id) ?? [];
    expect(goalTasks).toHaveLength(1);
    expect(goalTasks.every((task) => task.status === 'cancelled')).toBe(true);
    cancelApp.database.close();
    createApp.database.close();
  });

  it('does not retain a success receipt when RetryTask loses its database CAS race', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T21:30:00.000Z');
    let seed = await openDispatcher(path, 'retry-race-seed', now);
    await seed.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(seed.dispatcher, 'retry-race');
    const failed = success<FailTaskResult>(
      await seed.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'FailTask',
        commandId: 'retry-race-fail',
        workspaceId: 'ws-a',
        actor: seeded.agentActor,
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        expectedTaskRevision: seeded.claim.task.revision,
        reason: { code: 'execution.failed', summary: 'Prepare a retry race.' },
        summary: 'Race retries.',
        evidence: [],
      }),
    );
    seed.database.close();

    const first = await openDispatcher(path, 'retry-race-first', now);
    const second = await openDispatcher(path, 'retry-race-second', now);
    let firstArrivedResolve!: () => void;
    let secondArrivedResolve!: () => void;
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstArrived = new Promise<void>((resolve) => (firstArrivedResolve = resolve));
    const secondArrived = new Promise<void>((resolve) => (secondArrivedResolve = resolve));
    const firstRelease = new Promise<void>((resolve) => (releaseFirst = resolve));
    const secondRelease = new Promise<void>((resolve) => (releaseSecond = resolve));
    first.database.beforeNextBatch(async () => {
      firstArrivedResolve();
      await firstRelease;
    });
    second.database.beforeNextBatch(async () => {
      secondArrivedResolve();
      await secondRelease;
    });

    const firstPromise = first.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RetryTask',
      commandId: 'retry-race-first-command',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: failed.task.revision,
    });
    await firstArrived;
    const secondPromise = second.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RetryTask',
      commandId: 'retry-race-second-command',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: failed.task.revision,
    });
    await secondArrived;

    releaseFirst();
    success<Task>(await firstPromise);
    releaseSecond();
    const lost = await secondPromise;
    expect('error' in lost && lost.error.code).toBe('REVISION_MISMATCH');
    expect(await second.persistence.getCommandReceipt('ws-a', 'retry-race-second-command')).toBeUndefined();

    const replayAttempt = await second.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RetryTask',
      commandId: 'retry-race-second-command',
      correlationId: 'retry-race-replay',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: failed.task.revision,
    });
    expect('error' in replayAttempt && replayAttempt.error.code).toBe('REVISION_MISMATCH');
    expect(replayAttempt).not.toHaveProperty('replayed', true);
    first.database.close();
    second.database.close();
  });

  it('prevents a stale CreateTask batch from surviving beneath CancelGoal with independent coordinators', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T22:00:00.000Z');
    let seed = await openDispatcher(path, 'cancel-db-race-seed', now);
    await seed.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(seed.dispatcher, 'cancel-db-race');
    seed.database.close();

    const cancelApp = await openDispatcher(path, 'cancel-db-race-controller', now);
    const createApp = await openDispatcher(path, 'cancel-db-race-creator', now);
    let cancelArrivedResolve!: () => void;
    let releaseCancel!: () => void;
    const cancelArrived = new Promise<void>((resolve) => (cancelArrivedResolve = resolve));
    const cancelRelease = new Promise<void>((resolve) => (releaseCancel = resolve));
    cancelApp.database.beforeNextBatch(async () => {
      cancelArrivedResolve();
      await cancelRelease;
    });

    const cancelPromise = cancelApp.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cancel-db-race-goal',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      expectedGoalRevision: seeded.goal.revision,
      reason: { code: 'controller.cancelled', summary: 'Race database task admission.' },
    });
    await cancelArrived;

    const createdResponse = await createApp.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateTask',
      commandId: 'cancel-db-race-create',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      title: 'Concurrent Task',
      objective: 'Either commit before cancellation or be rejected.',
      acceptanceCriteria: ['Never survive under a cancelled Goal.'],
      requiredCapabilities: [],
      dependencyTaskIds: [],
    });
    const created = success<Task>(createdResponse);
    releaseCancel();
    const staleCancellation = await cancelPromise;
    expect(staleCancellation).toHaveProperty('error');

    const afterRace = await cancelApp.persistence.loadWorkspaceState('ws-a');
    expect(afterRace?.goals.find((goal) => goal.id === seeded.goal.id)?.status).toBe('active');
    expect(afterRace?.tasks.find((task) => task.id === created.id)?.status).toBe('ready');

    const freshCancel = await createApp.dispatcher.dispatchCommand({
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
    const finalSnapshot = await createApp.persistence.loadWorkspaceState('ws-a');
    const finalGoalTasks = finalSnapshot?.tasks.filter((task) => task.goalId === seeded.goal.id) ?? [];
    expect(finalGoalTasks).toHaveLength(2);
    expect(finalGoalTasks.every((task) => task.status === 'cancelled')).toBe(true);
    cancelApp.database.close();
    createApp.database.close();
  });
'''

path = Path('test/application/durable-retry-cancellation.test.ts')
text = path.read_text()
marker = '\n});\n'
if not text.endswith(marker):
    raise RuntimeError('unexpected retry cancellation test suffix')
path.write_text(text[:-len(marker)] + new_tests + marker)
