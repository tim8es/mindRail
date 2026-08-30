import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Goal, Lease, Session, Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';
import { WorkspaceDurableObjectCoordinator } from '../../src/persistence/cloudflare/workspace-durable-object-coordinator.ts';
import type { WorkspaceMutationCoordinator } from '../../src/persistence/ports.ts';
import type { ApplicationDispatcher } from '../../src/application/ports.ts';
import type {
  CancelGoalResult,
  CancelTaskResult,
  FailTaskResult,
} from '../../src/runtime/in-memory-control-plane.ts';
import { workspace } from '../persistence/fixtures.ts';
import { openPersistence } from '../persistence/setup.ts';
import { canonicalDomainValidator } from '../runtime/canonical-domain-validator.ts';

type CommandResponse = Awaited<ReturnType<ApplicationDispatcher['dispatchCommand']>>;

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-durable-retry-cancel-')), 'runtime.sqlite');
}

async function openDispatcher(
  path: string,
  prefix: string,
  now: Date,
  coordinator?: WorkspaceMutationCoordinator,
) {
  const opened = await openPersistence(path, coordinator);
  let sequence = 0;
  return {
    ...opened,
    dispatcher: createDurableApplicationDispatcher({
      persistence: opened.persistence,
      now: () => new Date(now),
      idFactory: (kind) => `${prefix}-${kind}-${++sequence}`,
      leaseDurationMs: 120_000,
      sessionTimeoutMs: 300_000,
      validateCanonicalDomainRecord: canonicalDomainValidator,
    }),
  };
}

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

function success<T>(response: CommandResponse): T {
  expect(response).not.toHaveProperty('error');
  if ('error' in response) throw new Error(`Expected success, got ${response.error.code}.`);
  return response.result as T;
}

async function seedClaimedTask(dispatcher: ApplicationDispatcher, prefix: string) {
  const systemActor = { type: 'system' as const, id: 'system-1' };
  const agent = success<Agent>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RegisterAgent',
      commandId: `${prefix}-register`,
      workspaceId: 'ws-a',
      actor: systemActor,
      displayName: 'Cancellation worker',
      capabilities: ['repo.write'],
    }),
  );
  const agentActor = { type: 'agent' as const, id: agent.id };
  const session = success<Session>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'StartSession',
      commandId: `${prefix}-session`,
      workspaceId: 'ws-a',
      actor: systemActor,
      agentId: agent.id,
    }),
  );
  const goal = success<Goal>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateGoal',
      commandId: `${prefix}-goal`,
      workspaceId: 'ws-a',
      actor: systemActor,
      title: 'Retry cancellation goal',
      objective: 'Exercise durable controller transitions.',
      successCriteria: ['Controller transitions survive restart.'],
    }),
  );
  const task = success<Task>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateTask',
      commandId: `${prefix}-task`,
      workspaceId: 'ws-a',
      actor: systemActor,
      goalId: goal.id,
      title: 'Retry cancellation task',
      objective: 'Exercise retry and cancellation.',
      acceptanceCriteria: ['State is durable.'],
      requiredCapabilities: ['repo.write'],
      dependencyTaskIds: [],
    }),
  );
  const claim = success<{ task: Task; lease: Lease }>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'ClaimTask',
      commandId: `${prefix}-claim`,
      workspaceId: 'ws-a',
      actor: agentActor,
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision,
    }),
  );
  return { systemActor, agentActor, agent, session, goal, task, claim };
}

describe('durable retry and cancellation', () => {
  it('retries a durably failed Task through controller authority and replays after restart', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T18:00:00.000Z');
    let app = await openDispatcher(path, 'retry-before', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'retry');
    const failed = success<FailTaskResult>(
      await app.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'FailTask',
        commandId: 'retry-fail',
        workspaceId: 'ws-a',
        actor: seeded.agentActor,
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        expectedTaskRevision: seeded.claim.task.revision,
        reason: { code: 'execution.failed', summary: 'Retryable deterministic failure.' },
        summary: 'Retry this work.',
        evidence: [],
      }),
    );
    app.database.close();

    app = await openDispatcher(path, 'retry-after', now);
    const retryResponse = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RetryTask',
      commandId: 'retry-command',
      correlationId: 'retry-first',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: failed.task.revision,
    });
    const retried = success<Task>(retryResponse);
    expect(retried).toMatchObject({ status: 'ready', revision: failed.task.revision + 1 });
    expect(retried).not.toHaveProperty('statusReason');
    app.database.close();

    app = await openDispatcher(path, 'retry-replay', now);
    const replay = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RetryTask',
      commandId: 'retry-command',
      correlationId: 'retry-replay',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: failed.task.revision,
    });
    expect(replay).toMatchObject({ replayed: true, correlationId: 'retry-replay' });
    expect(success<Task>(replay)).toEqual(retried);
    expect(await app.persistence.getTask('ws-a', seeded.task.id)).toEqual(retried);
    app.database.close();
  });

  it('cancels a running Task with its active Lease in one durable controller mutation', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T19:00:00.000Z');
    let app = await openDispatcher(path, 'cancel-task-before', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'cancel-task');
    app.database.close();

    app = await openDispatcher(path, 'cancel-task-after', now);
    const response = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelTask',
      commandId: 'cancel-task-command',
      correlationId: 'cancel-task-first',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'controller.cancelled', summary: 'Work is no longer required.' },
    });
    const cancelled = success<CancelTaskResult>(response);
    expect(cancelled.task).toMatchObject({
      status: 'cancelled',
      revision: seeded.claim.task.revision + 1,
    });
    expect(cancelled.lease).toMatchObject({
      status: 'revoked',
      revision: seeded.claim.lease.revision + 1,
      fencingToken: seeded.claim.lease.fencingToken,
    });
    app.database.close();

    app = await openDispatcher(path, 'cancel-task-replay', now);
    const replay = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelTask',
      commandId: 'cancel-task-command',
      correlationId: 'cancel-task-replay',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'controller.cancelled', summary: 'Work is no longer required.' },
    });
    expect(replay).toMatchObject({ replayed: true, correlationId: 'cancel-task-replay' });
    expect(success<CancelTaskResult>(replay)).toEqual(cancelled);
    expect(await app.persistence.getTask('ws-a', seeded.task.id)).toEqual(cancelled.task);
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toEqual(cancelled.lease);
    app.database.close();
  });

  it('cancels a Goal, its cancellable Tasks, active Lease, and receipt atomically', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T20:00:00.000Z');
    let app = await openDispatcher(path, 'cancel-goal-before', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'cancel-goal');
    const secondTask = success<Task>(
      await app.dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'CreateTask',
        commandId: 'cancel-goal-second-task',
        workspaceId: 'ws-a',
        actor: seeded.systemActor,
        goalId: seeded.goal.id,
        title: 'Second cancellable task',
        objective: 'Remain unclaimed until cancellation.',
        acceptanceCriteria: ['Cancellation is durable.'],
        requiredCapabilities: [],
        dependencyTaskIds: [],
      }),
    );
    app.database.close();

    app = await openDispatcher(path, 'cancel-goal-after', now);
    const response = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cancel-goal-command',
      correlationId: 'cancel-goal-first',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      expectedGoalRevision: seeded.goal.revision,
      reason: { code: 'controller.cancelled', summary: 'The goal is no longer required.' },
    });
    const cancelled = success<CancelGoalResult>(response);
    expect(cancelled.goal).toMatchObject({
      status: 'cancelled',
      revision: seeded.goal.revision + 1,
    });
    expect(cancelled.tasks).toHaveLength(2);
    expect(cancelled.tasks.every((task) => task.status === 'cancelled')).toBe(true);
    expect(cancelled.leases).toEqual([
      expect.objectContaining({
        id: seeded.claim.lease.id,
        status: 'revoked',
        fencingToken: seeded.claim.lease.fencingToken,
      }),
    ]);
    app.database.close();

    app = await openDispatcher(path, 'cancel-goal-replay', now);
    const replay = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cancel-goal-command',
      correlationId: 'cancel-goal-replay',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      goalId: seeded.goal.id,
      expectedGoalRevision: seeded.goal.revision,
      reason: { code: 'controller.cancelled', summary: 'The goal is no longer required.' },
    });
    expect(replay).toMatchObject({ replayed: true, correlationId: 'cancel-goal-replay' });
    expect(success<CancelGoalResult>(replay)).toEqual(cancelled);
    expect(await app.persistence.getGoal('ws-a', seeded.goal.id)).toEqual(cancelled.goal);
    expect(await app.persistence.getTask('ws-a', seeded.task.id)).toEqual(
      cancelled.tasks.find((task) => task.id === seeded.task.id),
    );
    expect(await app.persistence.getTask('ws-a', secondTask.id)).toEqual(
      cancelled.tasks.find((task) => task.id === secondTask.id),
    );
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toEqual(
      cancelled.leases[0],
    );
    app.database.close();
  });

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
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toEqual(
      seeded.claim.lease,
    );
    expect(
      await app.persistence.getCommandReceipt('ws-a', 'cancel-goal-atomic-command'),
    ).toBeUndefined();
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
    expect(
      await second.persistence.getCommandReceipt('ws-a', 'retry-race-second-command'),
    ).toBeUndefined();

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

  it('rejects CreateTask when its Goal becomes terminal after precheck but before the durable batch', async () => {
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
    expect(
      await app.persistence.getCommandReceipt('ws-a', 'create-goal-race-command'),
    ).toBeUndefined();
    app.database.close();
  });
});
