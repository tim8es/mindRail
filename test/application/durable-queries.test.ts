import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  Agent,
  Checkpoint,
  Goal,
  Lease,
  PermissionDecision,
  PermissionRequest,
  Session,
  Task,
  Workspace,
} from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';
import type { ApplicationDispatcher } from '../../src/application/ports.ts';
import type { DurableRuntimePersistence } from '../../src/persistence/ports.ts';
import { workspace } from '../persistence/fixtures.ts';
import { openPersistence } from '../persistence/setup.ts';
import { canonicalDomainValidator } from '../runtime/canonical-domain-validator.ts';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-durable-queries-')), 'runtime.sqlite');
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

async function seedDurableWorkspace(dispatcher: ApplicationDispatcher) {
  const actor = { type: 'system' as const, id: 'system-1' };
  const registered = successResult<Agent>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RegisterAgent',
      commandId: 'cmd-register',
      workspaceId: 'ws-a',
      actor,
      displayName: 'Durable query worker',
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
      agentId: registered.id,
    }),
  );
  const goal = successResult<Goal>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateGoal',
      commandId: 'cmd-goal',
      workspaceId: 'ws-a',
      actor,
      title: 'Durable query goal',
      objective: 'Verify reads after restart.',
      successCriteria: ['All reads come from D1.'],
    }),
  );
  const runningTask = successResult<Task>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateTask',
      commandId: 'cmd-task-running',
      workspaceId: 'ws-a',
      actor,
      goalId: goal.id,
      title: 'Running task',
      objective: 'Hold durable execution state.',
      acceptanceCriteria: ['Execution state is queryable.'],
      requiredCapabilities: ['repo.write'],
      dependencyTaskIds: [],
    }),
  );
  const claimableTask = successResult<Task>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'CreateTask',
      commandId: 'cmd-task-ready',
      workspaceId: 'ws-a',
      actor,
      goalId: goal.id,
      title: 'Claimable task',
      objective: 'Remain ready for work acquisition.',
      acceptanceCriteria: ['The task appears in claimable work.'],
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
      actor: { type: 'agent', id: registered.id },
      taskId: runningTask.id,
      sessionId: session.id,
      expectedTaskRevision: runningTask.revision,
    }),
  );
  const checkpointOne = successResult<Checkpoint>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RecordCheckpoint',
      commandId: 'cmd-checkpoint-1',
      workspaceId: 'ws-a',
      actor: { type: 'agent', id: registered.id },
      taskId: runningTask.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      kind: 'progress',
      summary: 'First durable checkpoint.',
      evidence: [],
      progressPercent: 25,
    }),
  );
  const checkpointTwo = successResult<Checkpoint>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RecordCheckpoint',
      commandId: 'cmd-checkpoint-2',
      workspaceId: 'ws-a',
      actor: { type: 'agent', id: registered.id },
      taskId: runningTask.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      kind: 'handoff',
      summary: 'Second durable checkpoint.',
      evidence: [],
    }),
  );
  const resolvedRequest = successResult<{
    request: PermissionRequest;
    decision: PermissionDecision;
  }>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RequestPermission',
      commandId: 'cmd-permission-resolved',
      workspaceId: 'ws-a',
      actor: { type: 'agent', id: registered.id },
      taskId: runningTask.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      permission: 'repository.write',
      justification: 'Resolve one permission chain.',
    }),
  );
  const humanDecision = successResult<PermissionDecision>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RecordPermissionDecision',
      commandId: 'cmd-permission-human',
      workspaceId: 'ws-a',
      actor: { type: 'human', id: 'human-1' },
      requestId: resolvedRequest.request.id,
      outcome: 'ALLOW',
      expectedPreviousDecisionId: resolvedRequest.decision.id,
      reasonCode: 'human.approved',
    }),
  );
  const pendingOne = successResult<{ request: PermissionRequest; decision: PermissionDecision }>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RequestPermission',
      commandId: 'cmd-permission-pending-1',
      workspaceId: 'ws-a',
      actor: { type: 'agent', id: registered.id },
      taskId: runningTask.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      permission: 'repository.write',
      justification: 'Keep the first permission pending.',
    }),
  );
  const pendingTwo = successResult<{ request: PermissionRequest; decision: PermissionDecision }>(
    await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'RequestPermission',
      commandId: 'cmd-permission-pending-2',
      workspaceId: 'ws-a',
      actor: { type: 'agent', id: registered.id },
      taskId: runningTask.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      permission: 'repository.write',
      justification: 'Keep the second permission pending.',
    }),
  );

  return {
    registered,
    session,
    goal,
    runningTask: claim.task,
    claimableTask,
    lease: claim.lease,
    checkpointOne,
    checkpointTwo,
    resolvedRequest,
    humanDecision,
    pendingOne,
    pendingTwo,
  };
}

function baseQuery(query: string) {
  return {
    protocolVersion: '0.1' as const,
    query,
    workspaceId: 'ws-a',
    actor: { type: 'system' as const, id: 'system-1' },
  };
}

describe('durable application queries', () => {
  it('reads authoritative single resources from D1 after restart', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedDurableWorkspace(dispatcherFor(opened.persistence, 'seed'));
    opened.database.close();

    opened = await openPersistence(path);
    const dispatcher = dispatcherFor(opened.persistence, 'fresh');

    expect(
      queryResult<Workspace>(await dispatcher.dispatchQuery(baseQuery('GetWorkspace') as never)),
    ).toEqual(workspace());
    expect(
      queryResult<Goal>(
        await dispatcher.dispatchQuery({
          ...baseQuery('GetGoal'),
          goalId: seeded.goal.id,
        } as never),
      ),
    ).toEqual(seeded.goal);
    expect(
      queryResult<Task>(
        await dispatcher.dispatchQuery({
          ...baseQuery('GetTask'),
          taskId: seeded.runningTask.id,
        } as never),
      ),
    ).toEqual(seeded.runningTask);
    expect(
      queryResult<Lease>(
        await dispatcher.dispatchQuery({
          ...baseQuery('GetLease'),
          leaseId: seeded.lease.id,
        } as never),
      ),
    ).toEqual(seeded.lease);
    expect(
      queryResult<Agent>(
        await dispatcher.dispatchQuery({
          ...baseQuery('GetAgent'),
          agentId: seeded.registered.id,
        } as never),
      ),
    ).toEqual(seeded.registered);
    expect(
      queryResult<Session>(
        await dispatcher.dispatchQuery({
          ...baseQuery('GetSession'),
          sessionId: seeded.session.id,
        } as never),
      ),
    ).toEqual(seeded.session);
    expect(
      queryResult<PermissionRequest>(
        await dispatcher.dispatchQuery({
          ...baseQuery('GetPermissionRequest'),
          requestId: seeded.resolvedRequest.request.id,
        } as never),
      ),
    ).toEqual(seeded.resolvedRequest.request);
    opened.database.close();
  });

  it('paginates checkpoint and permission-decision history deterministically', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedDurableWorkspace(dispatcherFor(opened.persistence, 'seed'));
    opened.database.close();

    opened = await openPersistence(path);
    const dispatcher = dispatcherFor(opened.persistence, 'fresh');
    const firstCheckpoints = queryResult<{ items: Checkpoint[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListTaskCheckpoints'),
        taskId: seeded.runningTask.id,
        limit: 1,
      } as never),
    );
    expect(firstCheckpoints.items).toEqual([seeded.checkpointOne]);
    expect(firstCheckpoints.nextCursor).toBe('c1');
    const secondCheckpoints = queryResult<{ items: Checkpoint[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListTaskCheckpoints'),
        taskId: seeded.runningTask.id,
        limit: 1,
        cursor: firstCheckpoints.nextCursor,
      } as never),
    );
    expect(secondCheckpoints).toEqual({ items: [seeded.checkpointTwo] });

    const firstDecisions = queryResult<{ items: PermissionDecision[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListPermissionDecisions'),
        requestId: seeded.resolvedRequest.request.id,
        limit: 1,
      } as never),
    );
    expect(firstDecisions.items).toEqual([seeded.resolvedRequest.decision]);
    expect(firstDecisions.nextCursor).toBe('c1');
    const secondDecisions = queryResult<{ items: PermissionDecision[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListPermissionDecisions'),
        requestId: seeded.resolvedRequest.request.id,
        limit: 1,
        cursor: firstDecisions.nextCursor,
      } as never),
    );
    expect(secondDecisions).toEqual({ items: [seeded.humanDecision] });
    opened.database.close();
  });

  it('returns pending human permissions and claimable work with bounded cursors', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedDurableWorkspace(dispatcherFor(opened.persistence, 'seed'));
    opened.database.close();

    opened = await openPersistence(path);
    const dispatcher = dispatcherFor(opened.persistence, 'fresh');
    const firstPending = queryResult<{
      items: Array<{ request: PermissionRequest; latestDecision: PermissionDecision }>;
      nextCursor?: string;
    }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListPendingHumanPermissions'),
        limit: 1,
      } as never),
    );
    expect(firstPending.items[0]?.request.id).toBe(seeded.pendingOne.request.id);
    expect(firstPending.nextCursor).toBe('c1');
    const secondPending = queryResult<{
      items: Array<{ request: PermissionRequest; latestDecision: PermissionDecision }>;
      nextCursor?: string;
    }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListPendingHumanPermissions'),
        limit: 1,
        cursor: firstPending.nextCursor,
      } as never),
    );
    expect(secondPending.items.map((item) => item.request.id)).toEqual([
      seeded.pendingTwo.request.id,
    ]);
    expect(secondPending.nextCursor).toBeUndefined();

    const claimable = queryResult<{ items: Task[]; nextCursor?: string }>(
      await dispatcher.dispatchQuery({
        ...baseQuery('ListClaimableTasks'),
        sessionId: seeded.session.id,
        limit: 10,
      } as never),
    );
    expect(claimable).toEqual({ items: [seeded.claimableTask] });
    opened.database.close();
  });

  it('does not retain query state between calls', async () => {
    const path = databasePath();
    const opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const dispatcher = dispatcherFor(opened.persistence, 'fresh');
    const externalGoal: Goal = {
      id: 'goal-external',
      workspaceId: 'ws-a',
      revision: 1,
      createdAt: '2026-08-29T18:00:00.000Z',
      updatedAt: '2026-08-29T18:00:00.000Z',
      title: 'Externally persisted goal',
      objective: 'Prove every query reads durable state.',
      successCriteria: ['The dispatcher observes the external mutation.'],
      status: 'active',
    };

    const missing = await dispatcher.dispatchQuery({
      ...baseQuery('GetGoal'),
      goalId: externalGoal.id,
    } as never);
    expect('error' in missing && missing.error.code).toBe('NOT_FOUND');

    await opened.persistence.createGoal({ goal: externalGoal });
    const observed = queryResult<Goal>(
      await dispatcher.dispatchQuery({ ...baseQuery('GetGoal'), goalId: externalGoal.id } as never),
    );
    expect(observed).toEqual(externalGoal);
    opened.database.close();
  });
});
