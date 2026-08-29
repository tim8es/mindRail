import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import { RuntimeError } from '../../src/runtime/errors.ts';

describe('in-memory control plane', () => {
  it('executes the first complete control-plane loop', () => {
    let sequence = 0;
    const now = new Date('2026-08-29T12:00:00.000Z');
    const runtime = new InMemoryControlPlane({
      workspaceId: 'ws-1',
      workspaceName: 'Dogfood',
      now: () => new Date(now),
      idFactory: (kind) => `${kind}-${++sequence}`,
      leaseDurationMs: 60_000,
    });

    const agent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'Codex worker',
      capabilities: ['code.execute'],
    });
    const session = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Ship vertical slice',
      objective: 'Prove the first durable control-plane execution loop.',
      successCriteria: ['The only task succeeds.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Implement slice',
      objective: 'Execute the vertical slice.',
      acceptanceCriteria: ['Result checkpoint is recorded.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });

    expect(task.status).toBe('ready');

    const claimed = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision,
    });

    expect(claimed.task.status).toBe('running');
    expect(claimed.lease.status).toBe('active');
    expect(claimed.lease.fencingToken).toBe(1);

    const progress = runtime.recordCheckpoint({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      leaseId: claimed.lease.id,
      fencingToken: claimed.lease.fencingToken,
      kind: 'progress',
      summary: 'Halfway done.',
      evidence: [],
      progressPercent: 50,
    });

    expect(progress.kind).toBe('progress');

    const completed = runtime.completeTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      leaseId: claimed.lease.id,
      fencingToken: claimed.lease.fencingToken,
      expectedTaskRevision: claimed.task.revision,
      summary: 'Vertical slice complete.',
      evidence: [],
    });

    expect(completed.task.status).toBe('succeeded');
    expect(completed.lease.status).toBe('released');
    expect(completed.checkpoint.kind).toBe('result');
    expect(runtime.getGoal('ws-1', goal.id).status).toBe('succeeded');
    expect(runtime.getTask('ws-1', task.id).status).toBe('succeeded');
    expect(runtime.listTaskCheckpoints('ws-1', task.id).map((checkpoint) => checkpoint.kind)).toEqual([
      'progress',
      'result',
    ]);
  });

  it('enforces lease ownership, fencing, and recovery', () => {
    let sequence = 0;
    const now = new Date('2026-08-29T12:00:00.000Z');
    const runtime = new InMemoryControlPlane({
      workspaceId: 'ws-1',
      workspaceName: 'Dogfood',
      now: () => new Date(now),
      idFactory: (kind) => `${kind}-${++sequence}`,
      leaseDurationMs: 60_000,
    });

    const firstAgent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'First worker',
      capabilities: ['code.execute'],
    });
    const firstSession = runtime.startSession({ workspaceId: 'ws-1', agentId: firstAgent.id });
    const secondAgent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'Recovery worker',
      capabilities: ['code.execute'],
    });
    const secondSession = runtime.startSession({ workspaceId: 'ws-1', agentId: secondAgent.id });
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Recover safely',
      objective: 'Prove leases can move without stale authority.',
      successCriteria: ['Recovered worker owns a higher fence.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Recover task',
      objective: 'Release and reclaim execution authority.',
      acceptanceCriteria: ['Stale execution is rejected.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });

    const firstClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: firstSession.id,
      expectedTaskRevision: task.revision,
    });

    const duplicateClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: firstSession.id,
      expectedTaskRevision: firstClaim.task.revision,
    });
    expect(duplicateClaim.lease.id).toBe(firstClaim.lease.id);
    expect(duplicateClaim.lease.fencingToken).toBe(1);
    expect(duplicateClaim.task.revision).toBe(firstClaim.task.revision);

    expect(() =>
      runtime.claimTask({
        workspaceId: 'ws-1',
        taskId: task.id,
        sessionId: secondSession.id,
        expectedTaskRevision: firstClaim.task.revision,
      }),
    ).toThrowError(RuntimeError);

    const released = runtime.releaseLease({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: firstSession.id,
      leaseId: firstClaim.lease.id,
      fencingToken: firstClaim.lease.fencingToken,
      expectedLeaseRevision: firstClaim.lease.revision,
    });
    expect(released.status).toBe('released');
    expect(runtime.getTask('ws-1', task.id).status).toBe('running');

    const recovered = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: secondSession.id,
      expectedTaskRevision: firstClaim.task.revision,
    });
    expect(recovered.task.status).toBe('running');
    expect(recovered.lease.id).not.toBe(firstClaim.lease.id);
    expect(recovered.lease.fencingToken).toBe(2);

    try {
      runtime.recordCheckpoint({
        workspaceId: 'ws-1',
        taskId: task.id,
        sessionId: firstSession.id,
        leaseId: firstClaim.lease.id,
        fencingToken: firstClaim.lease.fencingToken,
        kind: 'progress',
        summary: 'Stale worker tried to write.',
        evidence: [],
      });
      throw new Error('Expected stale executor to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect(['LEASE_NOT_ACTIVE', 'STALE_FENCING_TOKEN']).toContain((error as RuntimeError).code);
    }
  });

  it('makes protocol commands idempotent across retries and tracing changes', () => {
    let sequence = 0;
    const now = new Date('2026-08-29T12:00:00.000Z');
    const runtime = new InMemoryControlPlane({
      workspaceId: 'ws-1',
      workspaceName: 'Dogfood',
      now: () => new Date(now),
      idFactory: (kind) => `${kind}-${++sequence}`,
      leaseDurationMs: 60_000,
    });

    const command = {
      protocolVersion: '0.1' as const,
      command: 'CreateGoal' as const,
      commandId: 'cmd-1',
      workspaceId: 'ws-1',
      actor: { type: 'human' as const, id: 'human-1' },
      correlationId: 'corr-1',
      causationId: 'cause-1',
      title: 'Idempotent goal',
      objective: 'Create exactly one Goal despite retries.',
      successCriteria: ['Retry returns the original Goal snapshot.'],
    };

    const first = runtime.execute(command);
    if ('error' in first) {
      throw new Error(`Unexpected protocol failure: ${first.error.code}`);
    }
    expect(first.replayed).toBe(false);
    expect(first.result.status).toBe('active');
    const originalGoalId = first.result.id;

    const agent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'Completer',
      capabilities: ['code.execute'],
    });
    const session = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: originalGoalId,
      title: 'Mutate later state',
      objective: 'Move the Goal after its original protocol result was stored.',
      acceptanceCriteria: ['Goal becomes succeeded.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });
    const claim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision,
    });
    runtime.completeTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedTaskRevision: claim.task.revision,
      summary: 'Done.',
      evidence: [],
    });
    expect(runtime.getGoal('ws-1', originalGoalId).status).toBe('succeeded');

    const replay = runtime.execute({
      ...command,
      correlationId: 'corr-2',
      causationId: 'cause-2',
    });
    if ('error' in replay) {
      throw new Error(`Unexpected replay failure: ${replay.error.code}`);
    }
    expect(replay.replayed).toBe(true);
    expect(replay.result.id).toBe(originalGoalId);
    expect(replay.result.status).toBe('active');
    expect(replay.result.revision).toBe(1);

    const conflict = runtime.execute({
      ...command,
      title: 'Different semantic intent',
    });
    expect('error' in conflict && conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
