import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Checkpoint, Goal, Lease, Session, Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';
import type { ApplicationDispatcher } from '../../src/application/ports.ts';
import { workspace } from '../persistence/fixtures.ts';
import { openPersistence } from '../persistence/setup.ts';
import { canonicalDomainValidator } from '../runtime/canonical-domain-validator.ts';

type CommandResponse = Awaited<ReturnType<ApplicationDispatcher['dispatchCommand']>>;

interface TaskOutcomeResult {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
}

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-durable-task-outcomes-')), 'runtime.sqlite');
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
      displayName: 'Outcome worker',
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
      title: 'Outcome goal',
      objective: 'Exercise durable task outcome transitions.',
      successCriteria: ['Outcome survives restart.'],
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
      title: 'Outcome task',
      objective: 'Exercise failure and blocking.',
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

describe('durable task outcomes', () => {
  it('persists FailTask atomically and replays the immutable failure result after restart', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T15:00:00.000Z');
    let app = await openDispatcher(path, 'fail-before', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'fail');
    app.database.close();

    app = await openDispatcher(path, 'fail-after', now);
    const failedResponse = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'FailTask',
      commandId: 'fail-command',
      correlationId: 'fail-first',
      workspaceId: 'ws-a',
      actor: seeded.agentActor,
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: seeded.claim.lease.id,
      fencingToken: seeded.claim.lease.fencingToken,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'execution.failed', summary: 'Execution failed deterministically.' },
      summary: 'Could not complete the task.',
      evidence: [],
    });
    const failed = success<TaskOutcomeResult>(failedResponse);
    expect(failed.task).toMatchObject({
      status: 'failed',
      revision: seeded.claim.task.revision + 1,
    });
    expect(failed.task.statusReason).toEqual({
      code: 'execution.failed',
      summary: 'Execution failed deterministically.',
    });
    expect(failed.lease).toMatchObject({
      status: 'released',
      fencingToken: seeded.claim.lease.fencingToken,
      revision: seeded.claim.lease.revision + 1,
    });
    expect(failed.checkpoint).toMatchObject({
      kind: 'result',
      summary: 'Could not complete the task.',
    });
    app.database.close();

    app = await openDispatcher(path, 'fail-replay', now);
    const replay = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'FailTask',
      commandId: 'fail-command',
      correlationId: 'fail-replay',
      workspaceId: 'ws-a',
      actor: seeded.agentActor,
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: seeded.claim.lease.id,
      fencingToken: seeded.claim.lease.fencingToken,
      expectedTaskRevision: seeded.claim.task.revision,
      reason: { code: 'execution.failed', summary: 'Execution failed deterministically.' },
      summary: 'Could not complete the task.',
      evidence: [],
    });
    expect(replay).toMatchObject({ replayed: true, correlationId: 'fail-replay' });
    expect(success<TaskOutcomeResult>(replay)).toEqual(failed);
    expect((await app.persistence.getTask('ws-a', seeded.task.id))?.status).toBe('failed');
    expect(await app.persistence.listTaskCheckpoints('ws-a', seeded.task.id)).toHaveLength(1);
    app.database.close();
  });

  it('persists BlockTask, then resumes blocked work through controller authority after restart', async () => {
    const path = databasePath();
    const now = new Date('2026-08-30T16:00:00.000Z');
    let app = await openDispatcher(path, 'block-before', now);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.dispatcher, 'block');
    app.database.close();

    app = await openDispatcher(path, 'block-after', now);
    const blockedResponse = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'BlockTask',
      commandId: 'block-command',
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
    const blocked = success<TaskOutcomeResult>(blockedResponse);
    expect(blocked.task).toMatchObject({
      status: 'blocked',
      revision: seeded.claim.task.revision + 1,
    });
    expect(blocked.lease.status).toBe('released');
    expect(blocked.checkpoint).toMatchObject({
      kind: 'blocked',
      summary: 'Waiting for an external dependency.',
    });
    app.database.close();

    app = await openDispatcher(path, 'resume-after', now);
    const resumedResponse = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'ResumeTask',
      commandId: 'resume-command',
      correlationId: 'resume-first',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: blocked.task.revision,
    });
    const resumed = success<Task>(resumedResponse);
    expect(resumed).toMatchObject({ status: 'ready', revision: blocked.task.revision + 1 });
    expect(resumed).not.toHaveProperty('statusReason');
    app.database.close();

    app = await openDispatcher(path, 'resume-replay', now);
    const replay = await app.dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'ResumeTask',
      commandId: 'resume-command',
      correlationId: 'resume-replay',
      workspaceId: 'ws-a',
      actor: seeded.systemActor,
      taskId: seeded.task.id,
      expectedTaskRevision: blocked.task.revision,
    });
    expect(replay).toMatchObject({ replayed: true, correlationId: 'resume-replay' });
    expect(success<Task>(replay)).toEqual(resumed);
    expect((await app.persistence.getTask('ws-a', seeded.task.id))?.status).toBe('ready');
    app.database.close();
  });
});
