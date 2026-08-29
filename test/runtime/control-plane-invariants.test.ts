import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import { RuntimeError } from '../../src/runtime/errors.ts';

function createRuntime() {
  let sequence = 0;
  let nowMs = Date.parse('2026-08-29T12:00:00.000Z');
  const runtime = new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'Dogfood',
    now: () => new Date(nowMs),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: 60_000,
  });

  return {
    runtime,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

function createSession(runtime: InMemoryControlPlane, displayName: string) {
  const agent = runtime.registerAgent({
    workspaceId: 'ws-1',
    displayName,
    capabilities: ['code.execute'],
  });
  return runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
}

describe('critical control-plane invariants', () => {
  it('releases dependent work only after its dependencies succeed', () => {
    const { runtime } = createRuntime();
    const session = createSession(runtime, 'Worker');
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Ordered work',
      objective: 'Execute dependent Tasks in order.',
      successCriteria: ['Both Tasks succeed.'],
    });
    const first = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'First',
      objective: 'Finish before the dependent Task.',
      acceptanceCriteria: ['First result exists.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });
    const second = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Second',
      objective: 'Wait for the first Task.',
      acceptanceCriteria: ['Second result exists.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [first.id],
    });

    expect(second.status).toBe('pending');

    const firstClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: first.id,
      sessionId: session.id,
      expectedTaskRevision: first.revision,
    });
    runtime.completeTask({
      workspaceId: 'ws-1',
      taskId: first.id,
      sessionId: session.id,
      leaseId: firstClaim.lease.id,
      fencingToken: firstClaim.lease.fencingToken,
      expectedTaskRevision: firstClaim.task.revision,
      summary: 'First done.',
      evidence: [],
    });

    const releasedSecond = runtime.getTask('ws-1', second.id);
    expect(releasedSecond.status).toBe('ready');
    expect(releasedSecond.revision).toBe(2);
    expect(runtime.getGoal('ws-1', goal.id).status).toBe('active');

    const secondClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: second.id,
      sessionId: session.id,
      expectedTaskRevision: releasedSecond.revision,
    });
    runtime.completeTask({
      workspaceId: 'ws-1',
      taskId: second.id,
      sessionId: session.id,
      leaseId: secondClaim.lease.id,
      fencingToken: secondClaim.lease.fencingToken,
      expectedTaskRevision: secondClaim.task.revision,
      summary: 'Second done.',
      evidence: [],
    });

    expect(runtime.getGoal('ws-1', goal.id).status).toBe('succeeded');
  });

  it('recovers an expired Lease with a higher fence and rejects the old executor', () => {
    const { runtime, advance } = createRuntime();
    const firstSession = createSession(runtime, 'First worker');
    const recoverySession = createSession(runtime, 'Recovery worker');
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Expiry recovery',
      objective: 'Recover work after Lease expiry.',
      successCriteria: ['New executor owns a higher fence.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Expiring task',
      objective: 'Outlive the first Lease.',
      acceptanceCriteria: ['Stale executor loses authority.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });
    const firstClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: firstSession.id,
      expectedTaskRevision: task.revision,
    });

    advance(60_001);

    const recovered = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: recoverySession.id,
      expectedTaskRevision: firstClaim.task.revision,
    });

    expect(runtime.getLease('ws-1', firstClaim.lease.id).status).toBe('expired');
    expect(recovered.lease.fencingToken).toBe(2);
    expect(recovered.task.revision).toBe(firstClaim.task.revision);

    try {
      runtime.recordCheckpoint({
        workspaceId: 'ws-1',
        taskId: task.id,
        sessionId: firstSession.id,
        leaseId: firstClaim.lease.id,
        fencingToken: firstClaim.lease.fencingToken,
        kind: 'progress',
        summary: 'Stale write.',
        evidence: [],
      });
      throw new Error('Expected expired executor authority to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe('LEASE_EXPIRED');
    }
  });

  it('replays the original terminal protocol error without re-executing it', () => {
    const { runtime } = createRuntime();
    const command = {
      protocolVersion: '0.1' as const,
      command: 'CreateGoal' as const,
      commandId: 'cmd-error-1',
      workspaceId: 'ws-1',
      actor: { type: 'human' as const, id: 'human-1' },
      correlationId: 'corr-1',
      title: 'Invalid goal',
      objective: 'Prove terminal errors are replayable.',
      successCriteria: [],
    };

    const first = runtime.execute(command);
    expect('error' in first).toBe(true);
    if (!('error' in first)) {
      throw new Error('Expected protocol error.');
    }
    expect(first.replayed).toBe(false);
    expect(first.error.code).toBe('INVALID_INPUT');

    const replay = runtime.execute({ ...command, correlationId: 'corr-2' });
    expect('error' in replay).toBe(true);
    if (!('error' in replay)) {
      throw new Error('Expected replayed protocol error.');
    }
    expect(replay.replayed).toBe(true);
    expect(replay.error).toEqual(first.error);
  });
});
