import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Checkpoint, Goal, Lease, Session, Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';
import type { ApplicationDispatcher } from '../../src/application/ports.ts';
import type { DurableRuntimePersistence } from '../../src/persistence/ports.ts';
import { workspace } from '../persistence/fixtures.ts';
import { openPersistence } from '../persistence/setup.ts';
import { canonicalDomainValidator } from '../runtime/canonical-domain-validator.ts';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-durable-query-parity-')), 'runtime.sqlite');
}

function dispatcherFor(
  persistence: DurableRuntimePersistence,
  prefix: string,
): ApplicationDispatcher {
  let sequence = 0;
  return createDurableApplicationDispatcher({
    persistence,
    now: () => new Date('2026-08-29T18:00:00.000Z'),
    idFactory: (kind) => `${prefix}-${kind}-${++sequence}`,
    leaseDurationMs: 120_000,
    sessionTimeoutMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
}

function successResult<T>(
  response: Awaited<ReturnType<ApplicationDispatcher['dispatchCommand']>>,
): T {
  expect('error' in response).toBe(false);
  if ('error' in response) throw new Error(`Expected success, got ${response.error.code}.`);
  return response.result as T;
}

function queryResult<T>(response: Awaited<ReturnType<ApplicationDispatcher['dispatchQuery']>>): T {
  expect('error' in response).toBe(false);
  if ('error' in response) throw new Error(`Expected query success, got ${response.error.code}.`);
  return response.result as T;
}

function baseQuery(query: string) {
  return {
    protocolVersion: '0.1' as const,
    query,
    workspaceId: 'ws-a',
    actor: { type: 'system' as const, id: 'system-1' },
  };
}

async function seed(dispatcher: ApplicationDispatcher) {
  const actor = { type: 'system' as const, id: 'system-1' };
  const agent = successResult<Agent>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RegisterAgent',
      commandId: 'cmd-register',
      workspaceId: 'ws-a',
      actor,
      displayName: 'Query parity worker',
      capabilities: ['repo.write'],
    }),
  );
  const session = successResult<Session>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'StartSession',
      commandId: 'cmd-session',
      workspaceId: 'ws-a',
      actor,
      agentId: agent.id,
    }),
  );
  const firstGoal = successResult<Goal>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateGoal',
      commandId: 'cmd-goal-1',
      workspaceId: 'ws-a',
      actor,
      title: 'First goal',
      objective: 'Exercise durable goal reads.',
      successCriteria: ['Goals are paged deterministically.'],
    }),
  );
  const secondGoal = successResult<Goal>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateGoal',
      commandId: 'cmd-goal-2',
      workspaceId: 'ws-a',
      actor,
      title: 'Second goal',
      objective: 'Provide a second durable goal.',
      successCriteria: ['Second page contains this Goal.'],
    }),
  );
  const firstTask = successResult<Task>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateTask',
      commandId: 'cmd-task-1',
      workspaceId: 'ws-a',
      actor,
      goalId: firstGoal.id,
      title: 'First task',
      objective: 'Exercise execution projection.',
      acceptanceCriteria: ['Latest execution state is queryable.'],
      requiredCapabilities: ['repo.write'],
      dependencyTaskIds: [],
    }),
  );
  const secondTask = successResult<Task>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateTask',
      commandId: 'cmd-task-2',
      workspaceId: 'ws-a',
      actor,
      goalId: firstGoal.id,
      title: 'Second task',
      objective: 'Provide a second Goal Task.',
      acceptanceCriteria: ['Task pagination is deterministic.'],
      requiredCapabilities: ['repo.write'],
      dependencyTaskIds: [],
    }),
  );
  const claim = successResult<{ task: Task; lease: Lease }>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'ClaimTask',
      commandId: 'cmd-claim',
      workspaceId: 'ws-a',
      actor: { type: 'agent', id: agent.id },
      taskId: firstTask.id,
      sessionId: session.id,
      expectedTaskRevision: firstTask.revision,
    }),
  );
  const firstCheckpoint = successResult<Checkpoint>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RecordCheckpoint',
      commandId: 'cmd-checkpoint-1',
      workspaceId: 'ws-a',
      actor: { type: 'agent', id: agent.id },
      taskId: claim.task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      kind: 'progress',
      summary: 'Earlier checkpoint.',
      evidence: [],
      progressPercent: 25,
    }),
  );
  const latestCheckpoint = successResult<Checkpoint>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RecordCheckpoint',
      commandId: 'cmd-checkpoint-2',
      workspaceId: 'ws-a',
      actor: { type: 'agent', id: agent.id },
      taskId: claim.task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      kind: 'handoff',
      summary: 'Latest checkpoint.',
      evidence: [],
    }),
  );

  return {
    agent,
    session,
    firstGoal,
    secondGoal,
    firstTask: claim.task,
    secondTask,
    lease: claim.lease,
    firstCheckpoint,
    latestCheckpoint,
  };
}

describe('durable query parity', () => {
  it('paginates ListGoals and ListGoalTasks from authoritative D1 state after restart', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const seeded = await seed(dispatcherFor(opened.persistence, 'seed'));
    opened.database.close();

    opened = await openPersistence(path);
    const dispatcher = dispatcherFor(opened.persistence, 'fresh');

    const firstGoals = queryResult<{ items: Goal[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({ ...baseQuery('ListGoals'), limit: 1 } as never),
    );
    expect(firstGoals).toEqual({ items: [seeded.firstGoal], nextCursor: 'c1' });
    const secondGoals = queryResult<{ items: Goal[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListGoals'),
        limit: 1,
        cursor: firstGoals.nextCursor,
      } as never),
    );
    expect(secondGoals).toEqual({ items: [seeded.secondGoal] });

    const firstTasks = queryResult<{ items: Task[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListGoalTasks'),
        goalId: seeded.firstGoal.id,
        limit: 1,
      } as never),
    );
    expect(firstTasks).toEqual({ items: [seeded.firstTask], nextCursor: 'c1' });
    const secondTasks = queryResult<{ items: Task[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListGoalTasks'),
        goalId: seeded.firstGoal.id,
        limit: 1,
        cursor: firstTasks.nextCursor,
      } as never),
    );
    expect(secondTasks).toEqual({ items: [seeded.secondTask] });
    opened.database.close();
  });

  it('returns a Task execution projection with only the effective Lease and latest Checkpoint', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const seeded = await seed(dispatcherFor(opened.persistence, 'seed'));
    opened.database.close();

    opened = await openPersistence(path);
    let dispatcher = dispatcherFor(opened.persistence, 'fresh');
    expect(
      queryResult<{
        task: Task;
        lease?: Lease;
        latestCheckpoint?: Checkpoint;
      }>(
        await dispatcher.dispatchQuery({
          ...baseQuery('GetTaskExecutionView'),
          taskId: seeded.firstTask.id,
        } as never),
      ),
    ).toEqual({
      task: seeded.firstTask,
      lease: seeded.lease,
      latestCheckpoint: seeded.latestCheckpoint,
    });

    successResult<Lease>(
      await dispatcher.dispatchCommand({
        protocolVersion: '0.1',
        command: 'ReleaseLease',
        commandId: 'cmd-release',
        workspaceId: 'ws-a',
        actor: { type: 'agent', id: seeded.agent.id },
        sessionId: seeded.session.id,
        taskId: seeded.firstTask.id,
        leaseId: seeded.lease.id,
        expectedLeaseRevision: seeded.lease.revision,
        fencingToken: seeded.lease.fencingToken,
      }),
    );
    opened.database.close();

    opened = await openPersistence(path);
    dispatcher = dispatcherFor(opened.persistence, 'after-release');
    expect(
      queryResult<{
        task: Task;
        lease?: Lease;
        latestCheckpoint?: Checkpoint;
      }>(
        await dispatcher.dispatchQuery({
          ...baseQuery('GetTaskExecutionView'),
          taskId: seeded.firstTask.id,
        } as never),
      ),
    ).toEqual({
      task: seeded.firstTask,
      latestCheckpoint: seeded.latestCheckpoint,
    });
    opened.database.close();
  });

  it('returns bounded NOT_FOUND failures for missing ListGoalTasks parents and Task execution views', async () => {
    const path = databasePath();
    const opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const dispatcher = dispatcherFor(opened.persistence, 'fresh');

    const missingGoal = await dispatcher.dispatchQuery({
      ...baseQuery('ListGoalTasks'),
      goalId: 'goal-missing',
      limit: 10,
    } as never);
    expect(missingGoal).toMatchObject({ error: { code: 'NOT_FOUND', retryable: false } });

    const missingTask = await dispatcher.dispatchQuery({
      ...baseQuery('GetTaskExecutionView'),
      taskId: 'task-missing',
    } as never);
    expect(missingTask).toMatchObject({ error: { code: 'NOT_FOUND', retryable: false } });
    opened.database.close();
  });
});
