import type { Lease } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import type { ProtocolCommand, ProtocolResponse } from '../../src/runtime/protocol.ts';
import { canonicalDomainValidator } from './canonical-domain-validator.ts';

function createRuntime() {
  let sequence = 0;
  let now = new Date('2026-08-29T15:00:00.000Z');
  const runtime = new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'Review',
    now: () => new Date(now),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: 120_000,
    sessionTimeoutMs: 300_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
  return {
    runtime,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function setupRunningTask(runtime: InMemoryControlPlane) {
  const agent = runtime.registerAgent({
    workspaceId: 'ws-1',
    displayName: 'Worker',
    capabilities: ['code.execute'],
  });
  const session = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
  const goal = runtime.createGoal({
    workspaceId: 'ws-1',
    title: 'Review goal',
    objective: 'Verify remaining lifecycle protocol invariants.',
    successCriteria: ['Release and renewal remain deterministic.'],
  });
  const task = runtime.createTask({
    workspaceId: 'ws-1',
    goalId: goal.id,
    title: 'Review task',
    objective: 'Verify Lease command semantics.',
    acceptanceCriteria: ['Lease authority remains fenced.'],
    requiredCapabilities: ['code.execute'],
    dependencyTaskIds: [],
  });
  const claim = runtime.claimTask({
    workspaceId: 'ws-1',
    taskId: task.id,
    sessionId: session.id,
    expectedTaskRevision: task.revision,
  });
  return { agent, session, task, claim };
}

function executeFuture<T>(
  runtime: InMemoryControlPlane,
  command: Record<string, unknown>,
): ProtocolResponse<T> {
  return runtime.execute(command as unknown as ProtocolCommand) as ProtocolResponse<T>;
}

describe('runtime surface review regressions', () => {
  it('rejects a second owner renewal that reuses the stale positive Lease revision', () => {
    const { runtime, advance } = createRuntime();
    const { agent, session, task, claim } = setupRunningTask(runtime);

    advance(1_000);
    const first = executeFuture<Lease>(runtime, {
      protocolVersion: '0.1',
      command: 'RenewLease',
      commandId: 'cmd-renew-first',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      taskId: task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedLeaseRevision: claim.lease.revision,
    });
    expect('error' in first).toBe(false);

    const stale = executeFuture<Lease>(runtime, {
      protocolVersion: '0.1',
      command: 'RenewLease',
      commandId: 'cmd-renew-stale-revision',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      taskId: task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedLeaseRevision: claim.lease.revision,
    });
    expect('error' in stale && stale.error.code).toBe('REVISION_MISMATCH');
  });

  it('supports ReleaseLease through the protocol and makes the running Task recoverable', () => {
    const { runtime } = createRuntime();
    const { agent, session, task, claim } = setupRunningTask(runtime);

    const released = executeFuture<Lease>(runtime, {
      protocolVersion: '0.1',
      command: 'ReleaseLease',
      commandId: 'cmd-release-lease',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      taskId: task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedLeaseRevision: claim.lease.revision,
    });

    expect('error' in released).toBe(false);
    if ('error' in released) throw new Error(released.error.code);
    expect(released.result.status).toBe('released');
    expect(runtime.getTask('ws-1', task.id).status).toBe('running');

    const replacement = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
    const recovered = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: replacement.id,
      expectedTaskRevision: claim.task.revision,
    });
    expect(recovered.lease.fencingToken).toBeGreaterThan(claim.lease.fencingToken);
  });
});
