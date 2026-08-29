import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Goal, Lease, Session, Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';
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

async function openDispatcher(path: string, prefix: string, now: Date) {
  const opened = await openPersistence(path);
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
});
