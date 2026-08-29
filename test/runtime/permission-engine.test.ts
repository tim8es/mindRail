import type { PermissionDecision, PermissionRequest } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { canonicalDomainValidator } from './canonical-domain-validator.ts';
import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import { RuntimeError } from '../../src/runtime/errors.ts';

type RuntimeOptions = ConstructorParameters<typeof InMemoryControlPlane>[0];

type Execution = ReturnType<typeof establishExecution>;

function createRuntime(
  options: {
    workspaceId?: string;
    permissionPolicy?: RuntimeOptions['permissionPolicy'];
  } = {},
) {
  const sequences = new Map<string, number>();
  let now = new Date('2026-08-29T12:00:00.000Z');
  const workspaceId = options.workspaceId ?? 'ws-1';
  const runtime = new InMemoryControlPlane({
    workspaceId,
    workspaceName: 'Dogfood',
    now: () => new Date(now),
    idFactory: (kind) => {
      const sequence = (sequences.get(kind) ?? 0) + 1;
      sequences.set(kind, sequence);
      return `${kind}-${sequence}`;
    },
    leaseDurationMs: 10 * 60_000,
    sessionTimeoutMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
    ...(options.permissionPolicy === undefined ? {} : { permissionPolicy: options.permissionPolicy }),
  });

  return {
    runtime,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function establishExecution(runtime: InMemoryControlPlane) {
  const workspaceId = runtime.getWorkspace('ws-1').id;
  const agent = runtime.registerAgent({
    workspaceId,
    displayName: 'Permission worker',
    capabilities: ['code.execute'],
  });
  const session = runtime.startSession({ workspaceId, agentId: agent.id });
  const goal = runtime.createGoal({
    workspaceId,
    title: 'Permission flow',
    objective: 'Exercise deterministic permission authority.',
    successCriteria: ['Permission records are auditable.'],
  });
  const task = runtime.createTask({
    workspaceId,
    goalId: goal.id,
    title: 'Request permission',
    objective: 'Request one bounded permission.',
    acceptanceCriteria: ['Permission authority remains fenced.'],
    requiredCapabilities: ['code.execute'],
    dependencyTaskIds: [],
  });
  const claim = runtime.claimTask({
    workspaceId,
    taskId: task.id,
    sessionId: session.id,
    expectedTaskRevision: task.revision,
  });
  return { workspaceId, agent, session, goal, task, claim };
}

function requestPermission(
  runtime: InMemoryControlPlane,
  execution: Execution,
  permission: string,
) {
  return runtime.requestPermission({
    workspaceId: execution.workspaceId,
    taskId: execution.task.id,
    sessionId: execution.session.id,
    leaseId: execution.claim.lease.id,
    fencingToken: execution.claim.lease.fencingToken,
    permission,
    justification: `Need ${permission} for the current task.`,
  });
}

function decisionInput(
  request: PermissionRequest,
  previous: PermissionDecision,
  actor: { type: 'human' | 'agent' | 'system'; id: string },
  outcome: 'ALLOW' | 'DENY',
) {
  return {
    workspaceId: request.workspaceId,
    requestId: request.id,
    actor,
    outcome,
    expectedPreviousDecisionId: previous.id,
    reasonCode: outcome === 'ALLOW' ? 'human.approved' : 'human.denied',
    reason: outcome === 'ALLOW' ? 'Reviewed and approved.' : 'Reviewed and denied.',
  };
}

function expectRuntimeError(code: RuntimeError['code'], operation: () => unknown): void {
  try {
    operation();
    throw new Error(`Expected RuntimeError ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe(code);
  }
}

describe('permission engine v0.1', () => {
  it('rejects stale Session, Lease, and fence authority before permission records are created', () => {
    const staleSessionFixture = createRuntime();
    const staleExecution = establishExecution(staleSessionFixture.runtime);
    staleSessionFixture.advance(60_000);

    expectRuntimeError('SESSION_NOT_ACTIVE', () =>
      requestPermission(staleSessionFixture.runtime, staleExecution, 'workspace.read'),
    );

    const replacementSession = staleSessionFixture.runtime.startSession({
      workspaceId: staleExecution.workspaceId,
      agentId: staleExecution.agent.id,
    });
    const recovered = staleSessionFixture.runtime.claimTask({
      workspaceId: staleExecution.workspaceId,
      taskId: staleExecution.task.id,
      sessionId: replacementSession.id,
      expectedTaskRevision: staleExecution.claim.task.revision,
    });
    const firstAfterRecovery = staleSessionFixture.runtime.requestPermission({
      workspaceId: staleExecution.workspaceId,
      taskId: staleExecution.task.id,
      sessionId: replacementSession.id,
      leaseId: recovered.lease.id,
      fencingToken: recovered.lease.fencingToken,
      permission: 'workspace.read',
      justification: 'Fresh authority should create the first request.',
    });
    expect(firstAfterRecovery.request.id).toBe('permission-request-1');

    const staleLeaseFixture = createRuntime();
    const leaseExecution = establishExecution(staleLeaseFixture.runtime);
    staleLeaseFixture.runtime.releaseLease({
      workspaceId: leaseExecution.workspaceId,
      taskId: leaseExecution.task.id,
      sessionId: leaseExecution.session.id,
      leaseId: leaseExecution.claim.lease.id,
      fencingToken: leaseExecution.claim.lease.fencingToken,
      expectedLeaseRevision: leaseExecution.claim.lease.revision,
    });
    expectRuntimeError('LEASE_NOT_ACTIVE', () =>
      requestPermission(staleLeaseFixture.runtime, leaseExecution, 'workspace.read'),
    );

    const nextSession = staleLeaseFixture.runtime.startSession({
      workspaceId: leaseExecution.workspaceId,
      agentId: leaseExecution.agent.id,
    });
    const nextClaim = staleLeaseFixture.runtime.claimTask({
      workspaceId: leaseExecution.workspaceId,
      taskId: leaseExecution.task.id,
      sessionId: nextSession.id,
      expectedTaskRevision: leaseExecution.claim.task.revision,
    });
    expectRuntimeError('STALE_FENCING_TOKEN', () =>
      staleLeaseFixture.runtime.requestPermission({
        workspaceId: leaseExecution.workspaceId,
        taskId: leaseExecution.task.id,
        sessionId: nextSession.id,
        leaseId: nextClaim.lease.id,
        fencingToken: leaseExecution.claim.lease.fencingToken,
        permission: 'workspace.read',
        justification: 'Old fencing must not authorize a new request.',
      }),
    );

    const firstWithCurrentFence = staleLeaseFixture.runtime.requestPermission({
      workspaceId: leaseExecution.workspaceId,
      taskId: leaseExecution.task.id,
      sessionId: nextSession.id,
      leaseId: nextClaim.lease.id,
      fencingToken: nextClaim.lease.fencingToken,
      permission: 'workspace.read',
      justification: 'Current fencing authority is valid.',
    });
    expect(firstWithCurrentFence.request.id).toBe('permission-request-1');
  });

  it('evaluates deterministic ALLOW, DENY, and HUMAN_REQUIRED paths with exact policy attribution', () => {
    const { runtime } = createRuntime();
    const execution = establishExecution(runtime);

    const allowed = requestPermission(runtime, execution, 'workspace.read');
    expect(allowed.decision).toMatchObject({
      sequence: 1,
      outcome: 'ALLOW',
      basis: 'policy',
      decidedBy: { type: 'system', id: 'mindrail.permission-policy' },
      policyRef: { id: 'mindrail.permission', version: '0.1.0' },
    });
    expect(allowed.decision.supersedesDecisionId).toBeUndefined();
    expect(
      runtime.isPermissionGrantEffective({
        workspaceId: execution.workspaceId,
        requestId: allowed.request.id,
        taskId: execution.task.id,
        sessionId: execution.session.id,
        leaseId: execution.claim.lease.id,
        fencingToken: execution.claim.lease.fencingToken,
      }),
    ).toBe(true);

    const denied = requestPermission(runtime, execution, 'external.publish');
    expect(denied.decision.outcome).toBe('DENY');
    expect(
      runtime.isPermissionGrantEffective({
        workspaceId: execution.workspaceId,
        requestId: denied.request.id,
        taskId: execution.task.id,
        sessionId: execution.session.id,
        leaseId: execution.claim.lease.id,
        fencingToken: execution.claim.lease.fencingToken,
      }),
    ).toBe(false);

    const humanRequired = requestPermission(runtime, execution, 'repository.write');
    expect(humanRequired.decision.outcome).toBe('HUMAN_REQUIRED');
    expect(
      runtime.isPermissionGrantEffective({
        workspaceId: execution.workspaceId,
        requestId: humanRequired.request.id,
        taskId: execution.task.id,
        sessionId: execution.session.id,
        leaseId: execution.claim.lease.id,
        fencingToken: execution.claim.lease.fencingToken,
      }),
    ).toBe(false);
  });

  it('allows only human ALLOW or DENY follow-up to the latest HUMAN_REQUIRED decision', () => {
    const { runtime } = createRuntime();
    const execution = establishExecution(runtime);
    const pending = requestPermission(runtime, execution, 'repository.write');

    expectRuntimeError('ACTOR_NOT_AUTHORIZED', () =>
      runtime.recordPermissionDecision(
        decisionInput(
          pending.request,
          pending.decision,
          { type: 'agent', id: execution.agent.id },
          'ALLOW',
        ),
      ),
    );
    expectRuntimeError('ACTOR_NOT_AUTHORIZED', () =>
      runtime.recordPermissionDecision(
        decisionInput(
          pending.request,
          pending.decision,
          { type: 'system', id: 'controller-1' },
          'DENY',
        ),
      ),
    );
    expectRuntimeError('CONFLICT', () =>
      runtime.recordPermissionDecision({
        ...decisionInput(
          pending.request,
          pending.decision,
          { type: 'human', id: 'human-1' },
          'ALLOW',
        ),
        expectedPreviousDecisionId: 'permission-decision-stale',
      }),
    );
    expectRuntimeError('INVALID_INPUT', () =>
      runtime.recordPermissionDecision({
        ...decisionInput(
          pending.request,
          pending.decision,
          { type: 'human', id: 'human-1' },
          'ALLOW',
        ),
        outcome: 'HUMAN_REQUIRED',
      } as never),
    );

    const approved = runtime.recordPermissionDecision(
      decisionInput(
        pending.request,
        pending.decision,
        { type: 'human', id: 'human-1' },
        'ALLOW',
      ),
    );
    expect(approved).toMatchObject({
      sequence: 2,
      outcome: 'ALLOW',
      basis: 'human',
      decidedBy: { type: 'human', id: 'human-1' },
      supersedesDecisionId: pending.decision.id,
    });
    expect(approved.policyRef).toBeUndefined();

    expectRuntimeError('INVALID_STATE_TRANSITION', () =>
      runtime.recordPermissionDecision(
        decisionInput(pending.request, approved, { type: 'human', id: 'human-2' }, 'DENY'),
      ),
    );
    expect(runtime.listPermissionDecisions('ws-1', pending.request.id)).toHaveLength(2);
  });

  it('rejects cross-workspace human decision references', () => {
    const first = createRuntime();
    const execution = establishExecution(first.runtime);
    const pending = requestPermission(first.runtime, execution, 'repository.write');

    const second = createRuntime({ workspaceId: 'ws-2' });
    expectRuntimeError('NOT_FOUND', () =>
      second.runtime.recordPermissionDecision({
        workspaceId: 'ws-2',
        requestId: pending.request.id,
        actor: { type: 'human', id: 'human-1' },
        outcome: 'ALLOW',
        expectedPreviousDecisionId: pending.decision.id,
        reasonCode: 'human.approved',
      }),
    );
  });

  it('records late human history without reviving or transferring execution authority', () => {
    const { runtime } = createRuntime();
    const execution = establishExecution(runtime);
    const pending = requestPermission(runtime, execution, 'repository.write');

    runtime.releaseLease({
      workspaceId: execution.workspaceId,
      taskId: execution.task.id,
      sessionId: execution.session.id,
      leaseId: execution.claim.lease.id,
      fencingToken: execution.claim.lease.fencingToken,
      expectedLeaseRevision: execution.claim.lease.revision,
    });
    const replacementSession = runtime.startSession({
      workspaceId: execution.workspaceId,
      agentId: execution.agent.id,
    });
    const replacement = runtime.claimTask({
      workspaceId: execution.workspaceId,
      taskId: execution.task.id,
      sessionId: replacementSession.id,
      expectedTaskRevision: execution.claim.task.revision,
    });

    const lateAllow = runtime.recordPermissionDecision(
      decisionInput(
        pending.request,
        pending.decision,
        { type: 'human', id: 'human-1' },
        'ALLOW',
      ),
    );
    expect(lateAllow.outcome).toBe('ALLOW');
    expect(
      runtime.isPermissionGrantEffective({
        workspaceId: execution.workspaceId,
        requestId: pending.request.id,
        taskId: execution.task.id,
        sessionId: execution.session.id,
        leaseId: execution.claim.lease.id,
        fencingToken: execution.claim.lease.fencingToken,
      }),
    ).toBe(false);
    expect(
      runtime.isPermissionGrantEffective({
        workspaceId: execution.workspaceId,
        requestId: pending.request.id,
        taskId: execution.task.id,
        sessionId: replacementSession.id,
        leaseId: replacement.lease.id,
        fencingToken: replacement.lease.fencingToken,
      }),
    ).toBe(false);

    const replacementRequest = runtime.requestPermission({
      workspaceId: execution.workspaceId,
      taskId: execution.task.id,
      sessionId: replacementSession.id,
      leaseId: replacement.lease.id,
      fencingToken: replacement.lease.fencingToken,
      permission: 'repository.write',
      justification: 'Replacement execution needs its own request.',
    });
    expect(replacementRequest.request.id).not.toBe(pending.request.id);
    expect(replacementRequest.decision.outcome).toBe('HUMAN_REQUIRED');
  });

  it('replays exact RequestPermission protocol retries without duplicate records', () => {
    const { runtime } = createRuntime();
    const execution = establishExecution(runtime);
    const command = {
      protocolVersion: '0.1' as const,
      command: 'RequestPermission' as const,
      commandId: 'cmd-permission-1',
      workspaceId: execution.workspaceId,
      actor: { type: 'agent' as const, id: execution.agent.id },
      correlationId: 'corr-first',
      taskId: execution.task.id,
      sessionId: execution.session.id,
      leaseId: execution.claim.lease.id,
      fencingToken: execution.claim.lease.fencingToken,
      permission: 'workspace.read',
      justification: 'Read the current workspace.',
    };

    const first = runtime.execute(command);
    if ('error' in first) throw new Error(`Unexpected protocol failure: ${first.error.code}`);
    const firstResult = first.result as {
      request: PermissionRequest;
      decision: PermissionDecision;
    };
    expect(first.replayed).toBe(false);

    const replay = runtime.execute({ ...command, correlationId: 'corr-retry' });
    if ('error' in replay) throw new Error(`Unexpected replay failure: ${replay.error.code}`);
    const replayResult = replay.result as {
      request: PermissionRequest;
      decision: PermissionDecision;
    };
    expect(replay.replayed).toBe(true);
    expect(replay.correlationId).toBe('corr-retry');
    expect(replayResult.request.id).toBe(firstResult.request.id);
    expect(replayResult.decision.id).toBe(firstResult.decision.id);
    expect(runtime.getPermissionRequest('ws-1', firstResult.request.id)).toEqual(firstResult.request);
    expect(runtime.listPermissionDecisions('ws-1', firstResult.request.id)).toEqual([
      firstResult.decision,
    ]);
  });

  it('fails closed when deterministic policy evaluation is unavailable and appends nothing', () => {
    const failingPolicy = {
      ref: { id: 'mindrail.permission', version: 'broken' },
      evaluate: () => {
        throw new Error('Policy source unavailable.');
      },
    };
    const { runtime } = createRuntime({ permissionPolicy: failingPolicy });
    const execution = establishExecution(runtime);
    const command = {
      protocolVersion: '0.1' as const,
      command: 'RequestPermission' as const,
      commandId: 'cmd-policy-failure',
      workspaceId: execution.workspaceId,
      actor: { type: 'agent' as const, id: execution.agent.id },
      taskId: execution.task.id,
      sessionId: execution.session.id,
      leaseId: execution.claim.lease.id,
      fencingToken: execution.claim.lease.fencingToken,
      permission: 'workspace.read',
      justification: 'This must fail closed.',
    };

    const first = runtime.execute(command);
    expect('error' in first && first.error.code).toBe('POLICY_UNAVAILABLE');
    expect(first.replayed).toBe(false);
    expectRuntimeError('NOT_FOUND', () =>
      runtime.getPermissionRequest(execution.workspaceId, 'permission-request-1'),
    );

    const replay = runtime.execute(command);
    expect('error' in replay && replay.error.code).toBe('POLICY_UNAVAILABLE');
    expect(replay.replayed).toBe(true);
  });

  it('fails closed with DENY when no deterministic rule matches', () => {
    const { runtime } = createRuntime();
    const execution = establishExecution(runtime);
    const unmatched = requestPermission(runtime, execution, 'unknown.permission');

    expect(unmatched.decision).toMatchObject({
      outcome: 'DENY',
      reasonCode: 'policy.no_matching_rule',
    });
  });

  it('canonical-validates every emitted PermissionRequest and PermissionDecision', () => {
    const { runtime } = createRuntime();
    const execution = establishExecution(runtime);
    const allowed = requestPermission(runtime, execution, 'workspace.read');
    const pending = requestPermission(runtime, execution, 'repository.write');
    const deniedByHuman = runtime.recordPermissionDecision(
      decisionInput(
        pending.request,
        pending.decision,
        { type: 'human', id: 'human-1' },
        'DENY',
      ),
    );

    expect(canonicalDomainValidator('PermissionRequest', allowed.request).valid).toBe(true);
    expect(canonicalDomainValidator('PermissionDecision', allowed.decision).valid).toBe(true);
    expect(canonicalDomainValidator('PermissionRequest', pending.request).valid).toBe(true);
    expect(canonicalDomainValidator('PermissionDecision', pending.decision).valid).toBe(true);
    expect(canonicalDomainValidator('PermissionDecision', deniedByHuman).valid).toBe(true);
  });
});
