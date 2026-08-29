import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { PersistenceError } from '../../src/persistence/ports.ts';
import {
  agent,
  auditEvent,
  checkpoint,
  goal,
  leaseCandidate,
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
  return join(mkdtempSync(join(tmpdir(), 'mindrail-persistence-')), 'runtime.sqlite');
}

async function seedExecution(path: string, options?: { secondSession?: boolean }) {
  const opened = await openPersistence(path);
  const { persistence } = opened;
  await persistence.bootstrapWorkspace(workspace());
  await persistence.createGoal({ goal: goal() });
  await persistence.createTask({ task: task() });
  await persistence.createAgent({ agent: agent() });
  await persistence.createSession({ session: session() });
  if (options?.secondSession) {
    await persistence.createAgent({ agent: agent('ws-a', 'agent-b') });
    await persistence.createSession({ session: session('ws-a', 'agent-b', 'session-b') });
  }
  return opened;
}

function expectCode(error: unknown, code: PersistenceError['code']): void {
  expect(error).toBeInstanceOf(PersistenceError);
  expect((error as PersistenceError).code).toBe(code);
}

describe('D1RuntimePersistence durable semantics', () => {
  it('reconstructs canonical state, fencing state, and receipts after adapter re-instantiation', async () => {
    const path = databasePath();
    let { database, persistence } = await seedExecution(path);
    const originalSnapshot = {
      protocolVersion: '0.1',
      commandId: 'cmd-claim-restart',
      replayed: false,
      result: { taskId: 'task-a', leaseId: 'lease-a', fencingToken: 1 },
    };

    const claim = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      expectedTaskRevision: 1,
      lease: leaseCandidate(),
      now: T0,
      receipt: receipt(
        'cmd-claim-restart',
        'fingerprint-claim-restart',
        originalSnapshot,
        'ws-a',
        'ClaimTask',
      ),
      auditEvent: auditEvent('ws-a', 'audit-claim-restart'),
    });
    expect(claim.kind).toBe('committed');
    if (claim.kind !== 'committed') throw new Error('expected committed claim');
    expect(claim.value.lease.fencingToken).toBe(1);

    database.close();
    ({ database, persistence } = await openPersistence(path));

    const state = await persistence.loadWorkspaceState('ws-a');
    expect(state?.workspace.id).toBe('ws-a');
    expect(state?.goals).toHaveLength(1);
    expect(state?.tasks).toEqual([
      expect.objectContaining({ id: 'task-a', status: 'running', revision: 2 }),
    ]);
    expect(state?.leases).toEqual([
      expect.objectContaining({ id: 'lease-a', status: 'active', fencingToken: 1 }),
    ]);
    expect(state?.fencingCounters).toEqual({ 'task-a': 1 });

    const storedReceipt = await persistence.getCommandReceipt('ws-a', 'cmd-claim-restart');
    expect(storedReceipt?.responseSnapshot).toEqual(originalSnapshot);
    database.close();
  });

  it('returns an immutable stored response on exact command replay without duplicating mutation', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    await persistence.bootstrapWorkspace(workspace());
    const originalSnapshot = {
      protocolVersion: '0.1',
      commandId: 'cmd-goal',
      replayed: false,
      result: { id: 'goal-a', revision: 1 },
    };
    const commandReceipt = receipt(
      'cmd-goal',
      'fingerprint-goal-a',
      originalSnapshot,
      'ws-a',
      'CreateGoal',
    );

    const first = await persistence.createGoal({ goal: goal(), receipt: commandReceipt });
    const second = await persistence.createGoal({ goal: goal(), receipt: commandReceipt });

    expect(first.kind).toBe('committed');
    expect(second.kind).toBe('replayed');
    if (second.kind !== 'replayed') throw new Error('expected replay');
    expect(second.receipt.responseSnapshot).toEqual(originalSnapshot);

    const mutableReplay = second.receipt.responseSnapshot as { result: { revision: number } };
    mutableReplay.result.revision = 99;
    const storedAgain = await persistence.getCommandReceipt('ws-a', 'cmd-goal');
    expect(storedAgain?.responseSnapshot).toEqual(originalSnapshot);

    const state = await persistence.loadWorkspaceState('ws-a');
    expect(state?.goals).toHaveLength(1);
    expect(state?.goals[0]).toEqual(expect.objectContaining({ id: 'goal-a', revision: 1 }));
    database.close();
  });

  it('rejects reuse of one workspace commandId with a different semantic fingerprint', async () => {
    const path = databasePath();
    const { database, persistence } = await openPersistence(path);
    await persistence.bootstrapWorkspace(workspace());
    await persistence.createGoal({
      goal: goal(),
      receipt: receipt('cmd-same', 'fingerprint-a', { result: 'a' }, 'ws-a', 'CreateGoal'),
    });

    await expect(
      persistence.createGoal({
        goal: goal('ws-a', 'goal-b'),
        receipt: receipt('cmd-same', 'fingerprint-b', { result: 'b' }, 'ws-a', 'CreateGoal'),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'IDEMPOTENCY_CONFLICT');
      return true;
    });

    expect((await persistence.loadWorkspaceState('ws-a'))?.goals.map((item) => item.id)).toEqual([
      'goal-a',
    ]);
    database.close();
  });

  it('serializes competing claims so only one session obtains effective ownership', async () => {
    const path = databasePath();
    const { database, persistence } = await seedExecution(path, { secondSession: true });

    const claims = await Promise.allSettled([
      persistence.claimTask({
        workspaceId: 'ws-a',
        taskId: 'task-a',
        sessionId: 'session-a',
        expectedTaskRevision: 1,
        lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-a', T3),
        now: T0,
      }),
      persistence.claimTask({
        workspaceId: 'ws-a',
        taskId: 'task-a',
        sessionId: 'session-b',
        expectedTaskRevision: 1,
        lease: leaseCandidate('ws-a', 'task-a', 'session-b', 'lease-b', T3),
        now: T0,
      }),
    ]);

    expect(claims.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(claims.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const rejection = claims.find((result) => result.status === 'rejected');
    if (!rejection || rejection.status !== 'rejected') throw new Error('expected rejected claim');
    expectCode(rejection.reason, 'CONFLICT');

    const state = await persistence.loadWorkspaceState('ws-a');
    expect(state?.leases.filter((lease) => lease.status === 'active')).toHaveLength(1);
    expect(state?.fencingCounters['task-a']).toBe(1);
    database.close();
  });

  it('allocates a strictly higher fencing token after expired-lease recovery', async () => {
    const path = databasePath();
    const { database, persistence } = await seedExecution(path, { secondSession: true });

    const first = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      expectedTaskRevision: 1,
      lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-a', T1),
      now: T0,
    });
    if (first.kind !== 'committed') throw new Error('expected first claim');

    const second = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-b',
      expectedTaskRevision: 2,
      lease: leaseCandidate('ws-a', 'task-a', 'session-b', 'lease-b', T3),
      now: T1,
    });
    if (second.kind !== 'committed') throw new Error('expected recovery claim');

    expect(first.value.lease.fencingToken).toBe(1);
    expect(second.value.lease.fencingToken).toBeGreaterThan(first.value.lease.fencingToken);
    expect(second.value.lease.fencingToken).toBe(2);

    const state = await persistence.loadWorkspaceState('ws-a');
    expect(state?.leases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lease-a', status: 'expired', fencingToken: 1 }),
        expect.objectContaining({ id: 'lease-b', status: 'active', fencingToken: 2 }),
      ]),
    );
    expect(state?.fencingCounters['task-a']).toBe(2);
    database.close();
  });

  it('makes a stale expected Task revision lose deterministically', async () => {
    const path = databasePath();
    const { database, persistence } = await seedExecution(path);
    const current = task();
    const updated: Task = {
      ...current,
      revision: 2,
      updatedAt: T1,
      status: 'blocked',
      statusReason: { code: 'task.waiting', summary: 'Waiting for deterministic input.' },
    };

    await expect(
      persistence.updateTask({ task: updated, expectedRevision: 2 }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'REVISION_MISMATCH');
      return true;
    });
    expect((await persistence.loadWorkspaceState('ws-a'))?.tasks[0]).toEqual(current);
    database.close();
  });

  it('rejects stale fences for checkpoint and completion after reassignment', async () => {
    const path = databasePath();
    const { database, persistence } = await seedExecution(path, { secondSession: true });
    const first = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      expectedTaskRevision: 1,
      lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-a', T1),
      now: T0,
    });
    if (first.kind !== 'committed') throw new Error('expected first claim');
    const second = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-b',
      expectedTaskRevision: 2,
      lease: leaseCandidate('ws-a', 'task-a', 'session-b', 'lease-b', T3),
      now: T1,
    });
    if (second.kind !== 'committed') throw new Error('expected second claim');

    await expect(
      persistence.appendCheckpoint({
        checkpoint: checkpoint('ws-a', 'task-a', 'session-a', 'lease-a', 1, 'checkpoint-stale', T2),
        now: T2,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'STALE_AUTHORITY');
      return true;
    });

    const completedTask: Task = {
      ...second.value.task,
      revision: second.value.task.revision + 1,
      updatedAt: T2,
      status: 'succeeded',
    };
    const staleReleasedLease = {
      ...first.value.lease,
      revision: first.value.lease.revision + 1,
      updatedAt: T2,
      status: 'released' as const,
    };
    await expect(
      persistence.completeTask({
        workspaceId: 'ws-a',
        task: completedTask,
        lease: staleReleasedLease,
        checkpoint: {
          ...checkpoint('ws-a', 'task-a', 'session-a', 'lease-a', 1, 'checkpoint-result-stale', T2),
          kind: 'result',
        },
        expectedTaskRevision: second.value.task.revision,
        now: T2,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'STALE_AUTHORITY');
      return true;
    });

    expect((await persistence.loadWorkspaceState('ws-a'))?.tasks[0]).toEqual(
      expect.objectContaining({ status: 'running', revision: 2 }),
    );
    database.close();
  });

  it('rolls back Task, Lease, fencing, audit, and receipt state when a claim batch fails', async () => {
    const path = databasePath();
    const { database, persistence } = await seedExecution(path);
    const duplicateAudit = auditEvent('ws-a', 'audit-duplicate', T1);
    await persistence.appendAuditEvent({ auditEvent: duplicateAudit });

    await expect(
      persistence.claimTask({
        workspaceId: 'ws-a',
        taskId: 'task-a',
        sessionId: 'session-a',
        expectedTaskRevision: 1,
        lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-failed', T3),
        now: T0,
        auditEvent: duplicateAudit,
        receipt: receipt(
          'cmd-failed-claim',
          'fingerprint-failed-claim',
          { result: 'must-not-exist' },
          'ws-a',
          'ClaimTask',
        ),
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectCode(error, 'INTEGRITY_ERROR');
      return true;
    });

    let state = await persistence.loadWorkspaceState('ws-a');
    expect(state?.tasks[0]).toEqual(expect.objectContaining({ status: 'ready', revision: 1 }));
    expect(state?.leases).toHaveLength(0);
    expect(state?.fencingCounters['task-a']).toBe(0);
    expect(await persistence.getCommandReceipt('ws-a', 'cmd-failed-claim')).toBeUndefined();

    const recovered = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      expectedTaskRevision: 1,
      lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-good', T3),
      now: T0,
      auditEvent: auditEvent('ws-a', 'audit-good', T1),
    });
    if (recovered.kind !== 'committed') throw new Error('expected recovered claim');
    expect(recovered.value.lease.fencingToken).toBe(1);
    state = await persistence.loadWorkspaceState('ws-a');
    expect(state?.fencingCounters['task-a']).toBe(1);
    database.close();
  });
});
