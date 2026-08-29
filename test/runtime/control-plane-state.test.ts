import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import { canonicalDomainValidator } from './canonical-domain-validator.ts';
import { RuntimeError } from '../../src/runtime/errors.ts';

function createRuntime(): InMemoryControlPlane {
  let sequence = 0;
  const now = new Date('2026-08-29T12:00:00.000Z');
  return new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'Dogfood',
    now: () => new Date(now),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
}

function createWorker(runtime: InMemoryControlPlane) {
  const agent = runtime.registerAgent({
    workspaceId: 'ws-1',
    displayName: 'Worker',
    capabilities: ['code.execute'],
  });
  return runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
}

describe('runtime state controls', () => {
  it('supports failure, retry, and task cancellation stop controls', () => {
    const runtime = createRuntime();
    const session = createWorker(runtime);
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Recover from failure',
      objective: 'Retry deliberately and retain deterministic authority.',
      successCriteria: ['Task can be retried or cancelled explicitly.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Fallible task',
      objective: 'Exercise failure and retry transitions.',
      acceptanceCriteria: ['Failure releases authority.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });
    const firstClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision,
    });

    const failed = runtime.failTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      leaseId: firstClaim.lease.id,
      fencingToken: firstClaim.lease.fencingToken,
      expectedTaskRevision: firstClaim.task.revision,
      reason: {
        code: 'task.execution_failed',
        summary: 'Worker reported a deterministic failure.',
      },
      summary: 'Execution failed.',
      evidence: [],
    });
    expect(failed.task.status).toBe('failed');
    expect(failed.lease.status).toBe('released');
    expect(failed.checkpoint.kind).toBe('result');

    const retried = runtime.retryTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      expectedTaskRevision: failed.task.revision,
    });
    expect(retried.status).toBe('ready');

    try {
      runtime.retryTask({
        workspaceId: 'ws-1',
        taskId: task.id,
        expectedTaskRevision: retried.revision,
      });
      throw new Error('Expected retry outside failed state to be rejected.');
    } catch (error) {
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe('INVALID_STATE_TRANSITION');
    }

    const secondClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: retried.revision,
    });
    expect(secondClaim.lease.fencingToken).toBe(2);

    const cancelled = runtime.cancelTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      expectedTaskRevision: secondClaim.task.revision,
      reason: { code: 'human.stop', summary: 'Stop this task.' },
    });
    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled.lease?.status).toBe('revoked');

    expect(() =>
      runtime.completeTask({
        workspaceId: 'ws-1',
        taskId: task.id,
        sessionId: session.id,
        leaseId: secondClaim.lease.id,
        fencingToken: secondClaim.lease.fencingToken,
        expectedTaskRevision: secondClaim.task.revision,
        summary: 'Stale completion.',
        evidence: [],
      }),
    ).toThrowError(RuntimeError);
  });

  it('cancels a goal, revokes leases, and rejects stale or new work', () => {
    const runtime = createRuntime();
    const session = createWorker(runtime);
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Stop the whole goal',
      objective: 'Prove Goal cancellation is a hard execution boundary.',
      successCriteria: ['No stale executor can continue after cancellation.'],
    });
    const runningTask = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Running task',
      objective: 'Own a Lease before cancellation.',
      acceptanceCriteria: ['Lease is revoked.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });
    const pendingTask = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Pending task',
      objective: 'Remain nonterminal until cancellation.',
      acceptanceCriteria: ['Task becomes cancelled.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [runningTask.id],
    });
    const claim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: runningTask.id,
      sessionId: session.id,
      expectedTaskRevision: runningTask.revision,
    });

    const cancelled = runtime.cancelGoal({
      workspaceId: 'ws-1',
      goalId: goal.id,
      expectedGoalRevision: goal.revision,
      reason: { code: 'human.stop', summary: 'Stop all work under this Goal.' },
    });

    expect(cancelled.goal.status).toBe('cancelled');
    expect(runtime.getTask('ws-1', runningTask.id).status).toBe('cancelled');
    expect(runtime.getTask('ws-1', pendingTask.id).status).toBe('cancelled');
    expect(runtime.getLease('ws-1', claim.lease.id).status).toBe('revoked');

    expect(() =>
      runtime.completeTask({
        workspaceId: 'ws-1',
        taskId: runningTask.id,
        sessionId: session.id,
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        expectedTaskRevision: claim.task.revision,
        summary: 'Too late.',
        evidence: [],
      }),
    ).toThrowError(RuntimeError);

    expect(() =>
      runtime.createTask({
        workspaceId: 'ws-1',
        goalId: goal.id,
        title: 'Late task',
        objective: 'Must not be admitted.',
        acceptanceCriteria: ['Rejected.'],
        requiredCapabilities: [],
        dependencyTaskIds: [],
      }),
    ).toThrowError(RuntimeError);
  });
});
