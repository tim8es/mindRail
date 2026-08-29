import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import { canonicalDomainValidator } from './canonical-domain-validator.ts';

function createRuntime() {
  let sequence = 0;
  let now = new Date('2026-08-29T12:00:00.000Z');
  const runtime = new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'Dogfood',
    now: () => new Date(now),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: 10 * 60_000,
    sessionTimeoutMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  } as ConstructorParameters<typeof InMemoryControlPlane>[0] & { sessionTimeoutMs: number });

  return {
    runtime,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

describe('control-plane pre-admission and session authority', () => {
  it('returns NOT_FOUND for an unknown workspace without admitting an idempotency receipt', () => {
    const { runtime } = createRuntime();
    const command = {
      protocolVersion: '0.1' as const,
      command: 'CreateGoal' as const,
      commandId: 'cmd-other-workspace',
      workspaceId: 'ws-other',
      actor: { type: 'human' as const, id: 'human-1' },
      title: 'Must not execute',
      objective: 'Unknown workspace is a pre-admission failure.',
      successCriteria: ['No mutation occurs.'],
    };

    const first = runtime.execute(command);
    expect('error' in first && first.error.code).toBe('NOT_FOUND');
    expect(first.replayed).toBe(false);

    const second = runtime.execute(command);
    expect('error' in second && second.error.code).toBe('NOT_FOUND');
    expect(second.replayed).toBe(false);
  });

  it('rejects malformed protocol envelope fields before mutation or receipt reservation', () => {
    const { runtime } = createRuntime();

    const malformedActor = runtime.execute({
      protocolVersion: '0.1',
      command: 'CreateGoal',
      commandId: 'cmd-pre-admission',
      workspaceId: 'ws-1',
      actor: { type: 'human', id: '' },
      title: 'Malformed actor',
      objective: 'ActorRef must be structurally valid before command admission.',
      successCriteria: ['No mutation occurs.'],
    });
    expect('error' in malformedActor && malformedActor.error.code).toBe('INVALID_INPUT');
    expect(malformedActor.replayed).toBe(false);

    const invalidCommandId = runtime.execute({
      protocolVersion: '0.1',
      command: 'CreateGoal',
      commandId: '',
      workspaceId: 'ws-1',
      actor: { type: 'human', id: 'human-1' },
      title: 'Malformed command id',
      objective: 'An invalid command id must not be admitted.',
      successCriteria: ['No mutation occurs.'],
    });
    expect('error' in invalidCommandId && invalidCommandId.error.code).toBe('INVALID_INPUT');
    expect('commandId' in invalidCommandId).toBe(false);

    const admitted = runtime.execute({
      protocolVersion: '0.1',
      command: 'CreateGoal',
      commandId: 'cmd-pre-admission',
      workspaceId: 'ws-1',
      actor: { type: 'human', id: 'human-1' },
      title: 'Valid retry',
      objective: 'The malformed pre-admission attempt must not reserve the command id.',
      successCriteria: ['The retry executes exactly once.'],
    });
    expect('error' in admitted).toBe(false);
    expect(admitted.replayed).toBe(false);
    if ('error' in admitted) {
      throw new Error('Expected valid command admission.');
    }
    expect((admitted.result as { id: string }).id).toBe('goal-1');
  });

  it('expires a stale Session, revokes its Lease authority, and allows fenced recovery', () => {
    const { runtime, advance } = createRuntime();
    const agent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'Worker',
      capabilities: ['code.execute'],
    });
    const staleSession = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Session recovery',
      objective: 'Stale Sessions must lose execution authority at the server-time boundary.',
      successCriteria: ['A replacement Session receives a higher fence.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Recover stale work',
      objective: 'Keep durable Task state while Session authority expires.',
      acceptanceCriteria: ['Old Session cannot checkpoint after timeout.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });
    const firstClaim = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: staleSession.id,
      expectedTaskRevision: task.revision,
    });

    advance(60_000);

    expect(() =>
      runtime.recordCheckpoint({
        workspaceId: 'ws-1',
        taskId: task.id,
        sessionId: staleSession.id,
        leaseId: firstClaim.lease.id,
        fencingToken: firstClaim.lease.fencingToken,
        kind: 'progress',
        summary: 'This stale write must be rejected.',
        evidence: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));

    expect(runtime.getLease('ws-1', firstClaim.lease.id).status).toBe('revoked');

    const replacement = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
    const recovered = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: replacement.id,
      expectedTaskRevision: firstClaim.task.revision,
    });
    expect(recovered.task.status).toBe('running');
    expect(recovered.lease.fencingToken).toBeGreaterThan(firstClaim.lease.fencingToken);
  });
});
