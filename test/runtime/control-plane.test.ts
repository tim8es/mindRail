import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';

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
});
