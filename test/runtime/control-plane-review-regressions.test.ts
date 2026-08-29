import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';

function createRuntime() {
  let sequence = 0;
  const now = new Date('2026-08-29T12:00:00.000Z');
  return new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'Dogfood',
    now: () => new Date(now),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: 60_000,
  });
}

describe('pre-merge runtime review regressions', () => {
  it('returns the current Lease for a same-Session duplicate claim even with the pre-claim Task revision', () => {
    const runtime = createRuntime();
    const agent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'Worker',
      capabilities: ['code.execute'],
    });
    const session = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Duplicate claim',
      objective: 'Keep semantic duplicate claims idempotent outside transport retries.',
      successCriteria: ['Duplicate claim returns the existing Lease.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Claim once',
      objective: 'Claim the Task exactly once.',
      acceptanceCriteria: ['No new Lease or fence is minted.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });

    const firstClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision,
    });
    expect(firstClaim.task.revision).toBeGreaterThan(task.revision);

    const duplicateClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision,
    });

    expect(duplicateClaim.task).toEqual(firstClaim.task);
    expect(duplicateClaim.lease).toEqual(firstClaim.lease);
  });

  it('uses the retry correlation id when replaying an immutable success outcome', () => {
    const runtime = createRuntime();
    const command = {
      protocolVersion: '0.1' as const,
      command: 'CreateGoal' as const,
      commandId: 'cmd-success',
      workspaceId: 'ws-1',
      actor: { type: 'human' as const, id: 'human-1' },
      correlationId: 'corr-first',
      causationId: 'cause-first',
      title: 'Replay success',
      objective: 'Keep outcome immutable while tracing the current retry.',
      successCriteria: ['Replay uses the current correlation id.'],
    };

    const first = runtime.execute(command);
    expect('error' in first).toBe(false);
    expect(first.correlationId).toBe('corr-first');

    const replay = runtime.execute({
      ...command,
      correlationId: 'corr-retry',
      causationId: 'cause-retry',
    });

    expect('error' in replay).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.correlationId).toBe('corr-retry');
    if ('error' in first || 'error' in replay) {
      throw new Error('Expected successful protocol responses.');
    }
    expect(replay.result).toEqual(first.result);
  });

  it('uses the retry correlation id when replaying an immutable terminal error', () => {
    const runtime = createRuntime();
    const command = {
      protocolVersion: '0.1' as const,
      command: 'CreateGoal' as const,
      commandId: 'cmd-error',
      workspaceId: 'ws-1',
      actor: { type: 'human' as const, id: 'human-1' },
      correlationId: 'corr-first',
      title: 'Replay error',
      objective: 'Keep terminal errors immutable while tracing the current retry.',
      successCriteria: [],
    };

    const first = runtime.execute(command);
    expect('error' in first).toBe(true);
    expect(first.correlationId).toBe('corr-first');

    const replay = runtime.execute({ ...command, correlationId: 'corr-retry' });

    expect('error' in replay).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(replay.correlationId).toBe('corr-retry');
    if (!('error' in first) || !('error' in replay)) {
      throw new Error('Expected terminal protocol errors.');
    }
    expect(replay.error).toEqual(first.error);
  });
});
