import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { PersistenceError } from '../../src/persistence/ports.ts';
import {
  agent,
  goal,
  humanDecision,
  leaseCandidate,
  permissionRequest,
  policyDecision,
  session,
  T0,
  T3,
  task,
  workspace,
} from './fixtures.ts';
import { openPersistence } from './setup.ts';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-persistence-review-')), 'runtime.sqlite');
}

async function seedTwoSessions(path: string) {
  const opened = await openPersistence(path);
  const { persistence } = opened;
  await persistence.bootstrapWorkspace(workspace());
  await persistence.createGoal({ goal: goal() });
  await persistence.createTask({ task: task() });
  await persistence.createAgent({ agent: agent() });
  await persistence.createSession({ session: session() });
  await persistence.createAgent({ agent: agent('ws-a', 'agent-b') });
  await persistence.createSession({ session: session('ws-a', 'agent-b', 'session-b') });
  return opened;
}

describe('persistence review regressions', () => {
  it('keeps one effective Lease across independent coordinators sharing the durable database', async () => {
    const path = databasePath();
    const first = await seedTwoSessions(path);
    const second = await openPersistence(path);
    const claims = await Promise.allSettled([
      first.persistence.claimTask({
        workspaceId: 'ws-a',
        taskId: 'task-a',
        sessionId: 'session-a',
        expectedTaskRevision: 1,
        lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-a', T3),
        now: T0,
      }),
      second.persistence.claimTask({
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
    const state = await first.persistence.loadWorkspaceState('ws-a');
    expect(state?.leases.filter((lease) => lease.status === 'active')).toHaveLength(1);
    expect(state?.fencingCounters['task-a']).toBe(1);
    first.database.close();
    second.database.close();
  });

  it('rejects a stale PermissionDecision predecessor without forking history or moving the head', async () => {
    const path = databasePath();
    const opened = await seedTwoSessions(path);
    const { persistence, database } = opened;
    const claimed = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      expectedTaskRevision: 1,
      lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-a', T3),
      now: T0,
    });
    if (claimed.kind !== 'committed') throw new Error('expected committed claim');
    const request = permissionRequest(
      'ws-a',
      'task-a',
      'session-a',
      claimed.value.lease.id,
      claimed.value.lease.fencingToken,
      'permission-request-review',
    );
    const initial = policyDecision('ws-a', request.id, 'permission-decision-review-a');
    await persistence.appendPermissionRequestWithInitialDecision({ request, decision: initial });
    const finalDecision = humanDecision(
      'ws-a',
      request.id,
      initial.id,
      'permission-decision-review-b',
    );
    await persistence.appendPermissionDecision({
      decision: finalDecision,
      expectedPreviousDecisionId: initial.id,
    });
    const before = await persistence.listPermissionDecisions('ws-a', request.id);
    const stale = humanDecision('ws-a', request.id, initial.id, 'permission-decision-review-c');
    await expect(
      persistence.appendPermissionDecision({
        decision: stale,
        expectedPreviousDecisionId: initial.id,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(PersistenceError);
      expect((error as PersistenceError).code).toBe('REVISION_MISMATCH');
      return true;
    });
    expect(await persistence.listPermissionDecisions('ws-a', request.id)).toEqual(before);
    expect(await persistence.listPendingHumanPermissions('ws-a', 10)).toEqual([]);
    database.close();
  });
});
