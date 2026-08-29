import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';
import type { DurableRuntimePersistence } from '../../src/persistence/ports.ts';
import {
  T0,
  T1,
  T2,
  T3,
  agent,
  goal,
  leaseCandidate,
  session,
  task,
  workspace,
} from '../persistence/fixtures.ts';
import { openPersistence } from '../persistence/setup.ts';
import { canonicalDomainValidator } from '../runtime/canonical-domain-validator.ts';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-durable-review-')), 'runtime.sqlite');
}

function dispatcherFor(
  persistence: DurableRuntimePersistence,
  now: string,
  prefix: string,
  sessionTimeoutMs = 60 * 60 * 1000,
) {
  let sequence = 0;
  return createDurableApplicationDispatcher({
    persistence,
    now: () => new Date(now),
    idFactory: (kind) => `${prefix}-${kind}-${++sequence}`,
    leaseDurationMs: 120_000,
    sessionTimeoutMs,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
}

async function seedReadyTask(
  persistence: DurableRuntimePersistence,
  capabilities: string[],
): Promise<{ agent: Agent; task: Task }> {
  const seededAgent = { ...agent(), capabilities };
  await persistence.bootstrapWorkspace(workspace());
  await persistence.createAgent({ agent: seededAgent });
  await persistence.createSession({ session: session() });
  await persistence.createGoal({ goal: goal() });
  const seededTask = task();
  await persistence.createTask({ task: seededTask });
  return { agent: seededAgent, task: seededTask };
}

describe('durable idempotency and recovery review regressions', () => {
  it('persists and replays an admitted terminal semantic error', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    const seeded = await seedReadyTask(opened.persistence, []);
    const firstDispatcher = dispatcherFor(opened.persistence, T1, 'first');
    const command = {
      protocolVersion: '0.1' as const,
      command: 'ClaimTask' as const,
      commandId: 'cmd-terminal-capability-error',
      workspaceId: 'ws-a',
      actor: { type: 'agent' as const, id: seeded.agent.id },
      correlationId: 'corr-first',
      taskId: seeded.task.id,
      sessionId: 'session-a',
      expectedTaskRevision: seeded.task.revision,
    };

    const first = await firstDispatcher.dispatchCommand(command);
    expect(first).toMatchObject({
      replayed: false,
      error: { code: 'CAPABILITY_MISMATCH' },
    });
    const stored = await opened.persistence.getCommandReceipt('ws-a', command.commandId);
    expect(stored).toMatchObject({
      command: 'ClaimTask',
      outcomeKind: 'error',
    });
    opened.database.close();

    opened = await openPersistence(path);
    const replay = await dispatcherFor(opened.persistence, T1, 'second').dispatchCommand({
      ...command,
      correlationId: 'corr-second',
    });
    expect(replay).toMatchObject({
      correlationId: 'corr-second',
      replayed: true,
      error: { code: 'CAPABILITY_MISMATCH' },
    });
    opened.database.close();
  });

  it('lists a running Task as claimable after its effective Lease expires', async () => {
    const path = databasePath();
    const opened = await openPersistence(path);
    const seeded = await seedReadyTask(opened.persistence, ['repo.write']);
    const claimed = await opened.persistence.claimTask({
      workspaceId: 'ws-a',
      taskId: seeded.task.id,
      sessionId: 'session-a',
      expectedTaskRevision: seeded.task.revision,
      lease: leaseCandidate('ws-a', seeded.task.id, 'session-a', 'lease-a', T2),
      now: T0,
    });
    expect(claimed.kind).toBe('committed');

    const dispatcher = dispatcherFor(opened.persistence, T3, 'recovery');
    const response = await dispatcher.dispatchQuery({
      protocolVersion: '0.1',
      query: 'ListClaimableTasks',
      workspaceId: 'ws-a',
      actor: { type: 'system', id: 'system-1' },
      sessionId: 'session-a',
      limit: 10,
    });
    expect('error' in response).toBe(false);
    if ('error' in response) throw new Error(response.error.code);
    expect((response.result as { items: Task[] }).items.map((item) => item.id)).toEqual([
      seeded.task.id,
    ]);
    opened.database.close();
  });
});
