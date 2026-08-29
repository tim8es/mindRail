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

  it('rejects agent actors for controller stop commands without mutating state', () => {
    const runtime = createRuntime();
    const agent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'Worker',
      capabilities: ['code.execute'],
    });
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Protected goal',
      objective: 'Only a human or system actor may stop work.',
      successCriteria: ['Agent stop commands are rejected.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Protected task',
      objective: 'Remain ready after an unauthorized stop request.',
      acceptanceCriteria: ['Task remains ready.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });

    const cancelTask = runtime.execute({
      protocolVersion: '0.1',
      command: 'CancelTask',
      commandId: 'cmd-agent-cancel-task',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      taskId: task.id,
      expectedTaskRevision: task.revision,
      reason: { code: 'user.stop', summary: 'Agent attempted to stop itself.' },
    });
    expect('error' in cancelTask && cancelTask.error.code).toBe('ACTOR_NOT_AUTHORIZED');
    expect(runtime.getTask('ws-1', task.id).status).toBe('ready');

    const cancelGoal = runtime.execute({
      protocolVersion: '0.1',
      command: 'CancelGoal',
      commandId: 'cmd-agent-cancel-goal',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      reason: { code: 'user.stop', summary: 'Agent attempted to stop the Goal.' },
    });
    expect('error' in cancelGoal && cancelGoal.error.code).toBe('ACTOR_NOT_AUTHORIZED');
    expect(runtime.getGoal('ws-1', goal.id).status).toBe('active');
    expect(runtime.getTask('ws-1', task.id).status).toBe('ready');
  });

  it('rejects an agent actor from reopening a failed Task', () => {
    const runtime = createRuntime();
    const agent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'Worker',
      capabilities: ['code.execute'],
    });
    const session = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Protected retry',
      objective: 'Only controller authority may reopen failed work.',
      successCriteria: ['Unauthorized retry is rejected.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Fail once',
      objective: 'Reach failed state before the unauthorized retry.',
      acceptanceCriteria: ['Task stays failed.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });
    const claim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision,
    });
    const failed = runtime.failTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedTaskRevision: claim.task.revision,
      reason: { code: 'execution.failed', summary: 'Expected test failure.' },
      summary: 'Failed for retry authorization test.',
      evidence: [],
    });

    const retry = runtime.execute({
      protocolVersion: '0.1',
      command: 'RetryTask',
      commandId: 'cmd-agent-retry',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      taskId: task.id,
      expectedTaskRevision: failed.task.revision,
    });

    expect('error' in retry && retry.error.code).toBe('ACTOR_NOT_AUTHORIZED');
    expect(runtime.getTask('ws-1', task.id).status).toBe('failed');
  });
});
