import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Checkpoint, Goal, Lease, Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { PersistenceError } from '../../src/persistence/ports.ts';
import {
  agent,
  auditEvent,
  checkpoint,
  goal,
  humanDecision,
  leaseCandidate,
  permissionRequest,
  policyDecision,
  receipt,
  session,
  T0,
  T1,
  T2,
  T3,
  task,
  workspace,
} from './fixtures.ts';
import { openPersistence } from './setup.ts';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-persistence-invariants-')), 'runtime.sqlite');
}

function expectCode(error: unknown, code: PersistenceError['code']): void {
  expect(error).toBeInstanceOf(PersistenceError);
  expect((error as PersistenceError).code).toBe(code);
}

async function seedClaimedTask(
  persistence: Awaited<ReturnType<typeof openPersistence>>['persistence'],
  workspaceId: string,
  suffix: string,
) {
  const workspaceRecord = workspace(workspaceId);
  const goalRecord = goal(workspaceId, `goal-${suffix}`);
  const taskRecord = task(workspaceId, goalRecord.id, `task-${suffix}`);
  const agentRecord = agent(workspaceId, `agent-${suffix}`);
  const sessionRecord = session(workspaceId, agentRecord.id, `session-${suffix}`);
  await persistence.bootstrapWorkspace(workspaceRecord);
  await persistence.createGoal({ goal: goalRecord });
  await persistence.createTask({ task: taskRecord });
  await persistence.createAgent({ agent: agentRecord });
  await persistence.createSession({ session: sessionRecord });
  const claim = await persistence.claimTask({
    workspaceId,
    taskId: taskRecord.id,
    sessionId: sessionRecord.id,
    expectedTaskRevision: 1,
    lease: leaseCandidate(workspaceId, taskRecord.id, sessionRecord.id, `lease-${suffix}`, T3),
    now: T0,
  });
  if (claim.kind !== 'committed') throw new Error('expected committed seed claim');
  return {
    workspace: workspaceRecord,
    goal: goalRecord,
    originalTask: taskRecord,
    agent: agentRecord,
    session: sessionRecord,
    task: claim.value.task,
    lease: claim.value.lease,
  };
}

function completionRecords(
  currentTask: Task,
  currentLease: Lease,
  sessionId: string,
  checkpointId: string,
): { task: Task; lease: Lease; checkpoint: Checkpoint } {
  return {
    task: {
      ...currentTask,
      revision: currentTask.revision + 1,
      updatedAt: T1,
      status: 'succeeded',
    },
    lease: {
      ...currentLease,
      revision: currentLease.revision + 1,
      updatedAt: T1,
      status: 'released',
    },
    checkpoint: {
      ...checkpoint(
        currentTask.workspaceId,
        currentTask.id,
        sessionId,
        currentLease.id,
        currentLease.fencingToken,
        checkpointId,
        T1,
      ),
      kind: 'result',
      summary: 'Task completed.',
    },
  };
}

describe('D1RuntimePersistence ordering, isolation, and history invariants', () => {
  it('serializes CreateTask against Goal auto-terminalization in one deterministic Workspace order', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);

    const first = await seedClaimedTask(persistence, 'ws-complete-first', 'complete-first');
    const completedFirst = completionRecords(
      first.task,
      first.lease,
      first.session.id,
      'checkpoint-complete-first',
    );
    const completionPromise = persistence.completeTask({
      workspaceId: first.workspace.id,
      ...completedFirst,
      expectedTaskRevision: first.task.revision,
      now: T1,
    });
    const lateTaskPromise = persistence.createTask({
      task: task(first.workspace.id, first.goal.id, 'task-too-late'),
    });
    const [completionResult, lateTaskResult] = await Promise.allSettled([
      completionPromise,
      lateTaskPromise,
    ]);
    expect(completionResult.status).toBe('fulfilled');
    expect(lateTaskResult.status).toBe('rejected');
    if (lateTaskResult.status !== 'rejected') throw new Error('expected late Task rejection');
    expectCode(lateTaskResult.reason, 'INVALID_STATE_TRANSITION');
    const completedFirstState = await persistence.loadWorkspaceState(first.workspace.id);
    expect(completedFirstState?.goals[0]).toEqual(expect.objectContaining({ status: 'succeeded' }));
    expect(completedFirstState?.tasks.map((item) => item.id)).toEqual([first.task.id]);

    const second = await seedClaimedTask(persistence, 'ws-create-first', 'create-first');
    const completedSecond = completionRecords(
      second.task,
      second.lease,
      second.session.id,
      'checkpoint-create-first',
    );
    const earlyTaskPromise = persistence.createTask({
      task: task(second.workspace.id, second.goal.id, 'task-created-before-terminalization'),
    });
    const secondCompletionPromise = persistence.completeTask({
      workspaceId: second.workspace.id,
      ...completedSecond,
      expectedTaskRevision: second.task.revision,
      now: T1,
    });
    const [earlyTaskResult, secondCompletionResult] = await Promise.allSettled([
      earlyTaskPromise,
      secondCompletionPromise,
    ]);
    expect(earlyTaskResult.status).toBe('fulfilled');
    expect(secondCompletionResult.status).toBe('fulfilled');
    const createFirstState = await persistence.loadWorkspaceState(second.workspace.id);
    expect(createFirstState?.goals[0]).toEqual(expect.objectContaining({ status: 'active' }));
    expect(createFirstState?.tasks.map((item) => item.id).sort()).toEqual(
      [second.task.id, 'task-created-before-terminalization'].sort(),
    );
    database.close();
  });

  it('rejects cross-Workspace references before durable insertion', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    await persistence.bootstrapWorkspace(workspace('ws-a'));
    await persistence.bootstrapWorkspace(workspace('ws-b'));
    await persistence.createGoal({ goal: goal('ws-a', 'goal-a') });

    await expect(
      persistence.createTask({ task: task('ws-b', 'goal-a', 'task-cross-workspace') }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'NOT_FOUND');
      return true;
    });
    expect((await persistence.loadWorkspaceState('ws-b'))?.tasks).toHaveLength(0);
    database.close();
  });

  it('validates canonical records before commit and does not reserve a receipt for invalid input', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    await persistence.bootstrapWorkspace(workspace());
    await persistence.createGoal({ goal: goal() });
    const invalidTask = { ...task(), title: '' } as Task;

    await expect(
      persistence.createTask({
        task: invalidTask,
        receipt: receipt(
          'cmd-invalid-task',
          'fingerprint-invalid-task',
          { error: 'must-not-be-stored' },
          'ws-a',
          'CreateTask',
        ),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'INVALID_RECORD');
      return true;
    });
    expect(await persistence.getCommandReceipt('ws-a', 'cmd-invalid-task')).toBeUndefined();
    expect((await persistence.loadWorkspaceState('ws-a'))?.tasks).toHaveLength(0);
    database.close();
  });

  it('keeps checkpoints and audit history ordered and immutable', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    const seeded = await seedClaimedTask(persistence, 'ws-history', 'history');
    const firstCheckpoint = checkpoint(
      seeded.workspace.id,
      seeded.task.id,
      seeded.session.id,
      seeded.lease.id,
      seeded.lease.fencingToken,
      'checkpoint-1',
      T1,
    );
    const secondCheckpoint = {
      ...checkpoint(
        seeded.workspace.id,
        seeded.task.id,
        seeded.session.id,
        seeded.lease.id,
        seeded.lease.fencingToken,
        'checkpoint-2',
        T2,
      ),
      summary: 'Later checkpoint.',
    };
    await persistence.appendCheckpoint({ checkpoint: firstCheckpoint, now: T1 });
    await persistence.appendCheckpoint({ checkpoint: secondCheckpoint, now: T2 });
    await persistence.appendAuditEvent({
      auditEvent: auditEvent(seeded.workspace.id, 'audit-1', T1, seeded.task.id),
    });
    await persistence.appendAuditEvent({
      auditEvent: auditEvent(seeded.workspace.id, 'audit-2', T2, seeded.task.id),
    });

    expect(
      (await persistence.listTaskCheckpoints(seeded.workspace.id, seeded.task.id)).map(
        (item) => item.id,
      ),
    ).toEqual(['checkpoint-1', 'checkpoint-2']);
    expect(
      (await persistence.listAuditEvents(seeded.workspace.id, 10)).map((item) => item.id),
    ).toEqual(['audit-1', 'audit-2']);

    await expect(
      database.exec(
        `UPDATE checkpoints SET record_json = '{}' WHERE workspace_id = '${seeded.workspace.id}' AND id = 'checkpoint-1';`,
      ),
    ).rejects.toThrow(/append-only/i);
    await expect(
      database.exec(
        `DELETE FROM audit_events WHERE workspace_id = '${seeded.workspace.id}' AND id = 'audit-1';`,
      ),
    ).rejects.toThrow(/append-only/i);
    expect((await persistence.listTaskCheckpoints(seeded.workspace.id, seeded.task.id))[0]).toEqual(
      firstCheckpoint,
    );
    database.close();
  });

  it('supports pending-human permission reads and immutable decision-head advancement without evaluating policy', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    const seeded = await seedClaimedTask(persistence, 'ws-permission', 'permission');
    const request = permissionRequest(
      seeded.workspace.id,
      seeded.task.id,
      seeded.session.id,
      seeded.lease.id,
      seeded.lease.fencingToken,
      'permission-request-a',
    );
    const initialDecision = policyDecision(
      seeded.workspace.id,
      request.id,
      'permission-decision-a',
    );

    await persistence.appendPermissionRequestWithInitialDecision({
      request,
      decision: initialDecision,
      receipt: receipt(
        'cmd-permission',
        'fingerprint-permission',
        { requestId: request.id, decisionId: initialDecision.id },
        seeded.workspace.id,
        'RequestPermission',
      ),
      auditEvent: auditEvent(seeded.workspace.id, 'audit-permission', T1, seeded.task.id),
    });

    expect(await persistence.listPendingHumanPermissions(seeded.workspace.id, 10)).toEqual([
      { request, latestDecision: initialDecision },
    ]);

    const finalDecision = humanDecision(
      seeded.workspace.id,
      request.id,
      initialDecision.id,
      'permission-decision-b',
    );
    await persistence.appendPermissionDecision({
      decision: finalDecision,
      expectedPreviousDecisionId: initialDecision.id,
    });
    expect(await persistence.listPendingHumanPermissions(seeded.workspace.id, 10)).toEqual([]);
    expect(await persistence.listPermissionDecisions(seeded.workspace.id, request.id)).toEqual([
      initialDecision,
      finalDecision,
    ]);

    await expect(
      database.exec(
        `UPDATE permission_decisions SET record_json = '{}' WHERE workspace_id = '${seeded.workspace.id}' AND id = '${initialDecision.id}';`,
      ),
    ).rejects.toThrow(/append-only/i);
    database.close();
  });

  it('exposes authoritative recovery reads for active leases past expiry and sessions past liveness cutoff', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    await persistence.bootstrapWorkspace(workspace());
    await persistence.createGoal({ goal: goal() });
    await persistence.createTask({ task: task() });
    await persistence.createAgent({ agent: agent() });
    await persistence.createSession({ session: session() });
    const claim = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      expectedTaskRevision: 1,
      lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-expiring', T1),
      now: T0,
    });
    if (claim.kind !== 'committed') throw new Error('expected committed claim');

    expect(await persistence.listExpiredActiveLeases('ws-a', T1, 10)).toEqual([claim.value.lease]);
    expect(await persistence.listActiveSessionsLastSeenBefore('ws-a', T1, 10)).toEqual([session()]);
    database.close();
  });

  it('keeps Workspace command receipts isolated even when commandId values match', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    await persistence.bootstrapWorkspace(workspace('ws-a'));
    await persistence.bootstrapWorkspace(workspace('ws-b'));
    const goalA = goal('ws-a', 'goal-a');
    const goalB = goal('ws-b', 'goal-b');

    await persistence.createGoal({
      goal: goalA,
      receipt: receipt('cmd-shared', 'fp-a', { goalId: goalA.id }, 'ws-a', 'CreateGoal'),
    });
    await persistence.createGoal({
      goal: goalB,
      receipt: receipt('cmd-shared', 'fp-b', { goalId: goalB.id }, 'ws-b', 'CreateGoal'),
    });

    expect((await persistence.getCommandReceipt('ws-a', 'cmd-shared'))?.semanticFingerprint).toBe(
      'fp-a',
    );
    expect((await persistence.getCommandReceipt('ws-b', 'cmd-shared'))?.semanticFingerprint).toBe(
      'fp-b',
    );
    database.close();
  });

  it('does not expose mutable current state through receipt replay snapshots', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    await persistence.bootstrapWorkspace(workspace());
    const originalGoal = goal();
    await persistence.createGoal({
      goal: originalGoal,
      receipt: receipt(
        'cmd-goal-snapshot',
        'fp-goal-snapshot',
        { result: { goal: originalGoal } },
        'ws-a',
        'CreateGoal',
      ),
    });
    const succeededGoal: Goal = {
      ...originalGoal,
      revision: 2,
      updatedAt: T2,
      status: 'succeeded',
    };
    await persistence.updateGoal({ goal: succeededGoal, expectedRevision: 1 });

    const stored = await persistence.getCommandReceipt('ws-a', 'cmd-goal-snapshot');
    expect(stored?.responseSnapshot).toEqual({ result: { goal: originalGoal } });
    expect((await persistence.loadWorkspaceState('ws-a'))?.goals[0]).toEqual(succeededGoal);
    database.close();
  });
});
