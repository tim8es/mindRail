import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Lease, Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import type { ClaimTaskCommitValue, MutationCommitResult } from '../../src/persistence/ports.ts';
import { agent, goal, leaseCandidate, session, T0, T2, task, workspace } from './fixtures.ts';
import { openPersistence } from './setup.ts';

interface DeferredClaimPersistence {
  claimTask(input: {
    workspaceId: string;
    taskId: string;
    sessionId: string;
    expectedTaskRevision: number;
    lease: Omit<Lease, 'fencingToken'>;
    now: string;
    deferredReceipt: {
      workspaceId: string;
      commandId: string;
      command: string;
      semanticFingerprint: string;
      outcomeKind: 'result';
      createdAt: string;
      buildResponseSnapshot(value: ClaimTaskCommitValue): unknown;
    };
  }): Promise<MutationCommitResult<ClaimTaskCommitValue>>;
}

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-deferred-claim-')), 'runtime.sqlite');
}

describe('ClaimTask deferred durable receipt', () => {
  it('stores the final persisted fence in the receipt and replays without a new grant', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    await opened.persistence.createGoal({ goal: goal() });
    await opened.persistence.createTask({ task: task() });
    await opened.persistence.createAgent({ agent: agent() });
    await opened.persistence.createSession({ session: session() });

    const deferredReceipt = {
      workspaceId: 'ws-a',
      commandId: 'cmd-claim-deferred',
      command: 'ClaimTask',
      semanticFingerprint: 'fp-claim-deferred',
      outcomeKind: 'result' as const,
      createdAt: T0,
      buildResponseSnapshot(value: ClaimTaskCommitValue) {
        return {
          protocolVersion: '0.1',
          commandId: 'cmd-claim-deferred',
          replayed: false,
          result: value,
        };
      },
    };
    const persistence = opened.persistence as unknown as DeferredClaimPersistence;
    const first = await persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      expectedTaskRevision: 1,
      lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-a', T2),
      now: T0,
      deferredReceipt,
    });
    expect(first.kind).toBe('committed');
    if (first.kind !== 'committed') throw new Error('expected committed claim');

    const stored = await opened.persistence.getCommandReceipt('ws-a', 'cmd-claim-deferred');
    expect(stored).toBeDefined();
    const snapshot = stored?.responseSnapshot as { result: { task: Task; lease: Lease } };
    expect(snapshot.result.lease.fencingToken).toBe(first.value.lease.fencingToken);
    expect(snapshot.result.lease.id).toBe(first.value.lease.id);

    opened.database.close();
    opened = await openPersistence(path);
    const replay = await (opened.persistence as unknown as DeferredClaimPersistence).claimTask({
      workspaceId: 'ws-a',
      taskId: 'task-a',
      sessionId: 'session-a',
      expectedTaskRevision: 1,
      lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-other', T2),
      now: T0,
      deferredReceipt,
    });
    expect(replay.kind).toBe('replayed');
    expect((await opened.persistence.loadWorkspaceState('ws-a'))?.leases).toHaveLength(1);
    opened.database.close();
  });
});
