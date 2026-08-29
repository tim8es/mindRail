import type {
  Agent,
  Checkpoint,
  Goal,
  Lease,
  PermissionDecision,
  PermissionRequest,
  Session,
  Task,
} from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { createInMemoryApplicationDispatcher } from '../../src/application/in-memory-dispatcher.ts';
import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import { createHttpTransport } from '../../src/transports/http/adapter.ts';
import { canonicalDomainValidator } from '../runtime/canonical-domain-validator.ts';

type CommandEnvelope<T> = {
  protocolVersion: '0.1';
  commandId: string;
  replayed: boolean;
  result: T;
};

type QueryEnvelope<T> = {
  protocolVersion: '0.1';
  result: T;
};

interface ClaimResult {
  task: Task;
  lease: Lease;
}

interface RequestPermissionResult {
  request: PermissionRequest;
  decision: PermissionDecision;
}

interface CompleteResult {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
}

function createFixture() {
  let sequence = 0;
  const now = new Date('2026-08-29T18:30:00.000Z');
  const controlPlane = new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'HTTP dogfood',
    now: () => new Date(now),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: 120_000,
    sessionTimeoutMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
  const dispatcher = createInMemoryApplicationDispatcher(controlPlane);
  const transport = createHttpTransport({
    dispatcher,
    authorizer: {
      authorize: async () => true,
    },
  });

  async function command<T>(
    name: string,
    commandId: string,
    actor: { type: 'system' | 'human' | 'agent'; id: string },
    fields: Record<string, unknown>,
  ): Promise<CommandEnvelope<T>> {
    const response = await transport.handle(
      new Request(`https://mindrail.invalid/v0.1/commands/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: '0.1',
          commandId,
          workspaceId: 'ws-1',
          actor,
          ...fields,
        }),
      }),
      { subject: `principal:${actor.type}:${actor.id}` },
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).not.toHaveProperty('error');
    return body as unknown as CommandEnvelope<T>;
  }

  async function query<T>(
    name: string,
    actor: { type: 'system' | 'human' | 'agent'; id: string },
    fields: Record<string, unknown>,
  ): Promise<QueryEnvelope<T>> {
    const response = await transport.handle(
      new Request(`https://mindrail.invalid/v0.1/queries/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: '0.1',
          workspaceId: 'ws-1',
          actor,
          ...fields,
        }),
      }),
      { subject: `principal:${actor.type}:${actor.id}` },
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body).not.toHaveProperty('error');
    return body as unknown as QueryEnvelope<T>;
  }

  return { command, query };
}

describe('HTTP application control-plane E2E', () => {
  it('runs bootstrap, execution, human permission escalation, and completion through HTTP only', async () => {
    const { command, query } = createFixture();
    const systemActor = { type: 'system', id: 'system-1' } as const;
    const humanActor = { type: 'human', id: 'human-1' } as const;

    const register = await command<Agent>('RegisterAgent', 'cmd-register', systemActor, {
      displayName: 'Coding worker',
      capabilities: ['code.execute'],
    });
    expect(register.result).toMatchObject({ status: 'active', revision: 1 });
    const agentActor = { type: 'agent', id: register.result.id } as const;

    const start = await command<Session>('StartSession', 'cmd-session', systemActor, {
      agentId: register.result.id,
    });
    expect(start.result).toMatchObject({
      status: 'active',
      revision: 1,
      agentId: register.result.id,
    });

    const goal = await command<Goal>('CreateGoal', 'cmd-goal', systemActor, {
      title: 'Ship one autonomous slice',
      objective: 'Prove the complete v0.1 local application lifecycle.',
      successCriteria: ['The task finishes through the protocol boundary.'],
    });

    const task = await command<Task>('CreateTask', 'cmd-task', systemActor, {
      goalId: goal.result.id,
      title: 'Execute the slice',
      objective: 'Run a fenced task and escalate repository write permission.',
      acceptanceCriteria: ['A human-approved write is represented before completion.'],
      requiredCapabilities: ['code.execute'],
      dependencyTaskIds: [],
    });
    expect(task.result.status).toBe('ready');

    const claim = await command<ClaimResult>('ClaimTask', 'cmd-claim', agentActor, {
      taskId: task.result.id,
      sessionId: start.result.id,
      expectedTaskRevision: task.result.revision,
    });
    expect(claim.result.task.status).toBe('running');
    expect(claim.result.lease).toMatchObject({
      status: 'active',
      sessionId: start.result.id,
      fencingToken: 1,
    });

    const checkpoint = await command<Checkpoint>('RecordCheckpoint', 'cmd-checkpoint', agentActor, {
      taskId: task.result.id,
      sessionId: start.result.id,
      leaseId: claim.result.lease.id,
      fencingToken: claim.result.lease.fencingToken,
      kind: 'progress',
      summary: 'Execution reached the repository-write boundary.',
      evidence: [],
      progressPercent: 70,
    });
    expect(checkpoint.result.kind).toBe('progress');

    const permission = await command<RequestPermissionResult>(
      'RequestPermission',
      'cmd-permission',
      agentActor,
      {
        taskId: task.result.id,
        sessionId: start.result.id,
        leaseId: claim.result.lease.id,
        fencingToken: claim.result.lease.fencingToken,
        permission: 'repository.write',
        justification: 'The task needs to persist the reviewed implementation.',
      },
    );
    expect(permission.result.decision).toMatchObject({
      sequence: 1,
      outcome: 'HUMAN_REQUIRED',
      basis: 'policy',
      reasonCode: 'policy.human_required',
    });

    const humanDecision = await command<PermissionDecision>(
      'RecordPermissionDecision',
      'cmd-human-decision',
      humanActor,
      {
        requestId: permission.result.request.id,
        outcome: 'ALLOW',
        expectedPreviousDecisionId: permission.result.decision.id,
        reasonCode: 'human.approved',
        reason: 'Reviewed and approved for this execution.',
      },
    );
    expect(humanDecision.result).toMatchObject({
      sequence: 2,
      outcome: 'ALLOW',
      basis: 'human',
      supersedesDecisionId: permission.result.decision.id,
    });

    const complete = await command<CompleteResult>('CompleteTask', 'cmd-complete', agentActor, {
      taskId: task.result.id,
      sessionId: start.result.id,
      leaseId: claim.result.lease.id,
      fencingToken: claim.result.lease.fencingToken,
      expectedTaskRevision: claim.result.task.revision,
      summary: 'The task completed after the permission boundary was resolved.',
      evidence: [],
    });
    expect(complete.result.task.status).toBe('succeeded');
    expect(complete.result.lease.status).toBe('released');
    expect(complete.result.checkpoint.kind).toBe('result');

    const finalTask = await query<Task>('GetTask', agentActor, { taskId: task.result.id });
    const finalGoal = await query<Goal>('GetGoal', systemActor, { goalId: goal.result.id });
    const finalLease = await query<Lease>('GetLease', agentActor, {
      leaseId: claim.result.lease.id,
    });
    const checkpoints = await query<{ items: Checkpoint[] }>('ListTaskCheckpoints', agentActor, {
      taskId: task.result.id,
      limit: 100,
    });

    expect(finalTask.result.status).toBe('succeeded');
    expect(finalGoal.result.status).toBe('succeeded');
    expect(finalLease.result.status).toBe('released');
    expect(checkpoints.result.items.map((item) => item.kind)).toEqual(['progress', 'result']);
    expect(permission.result.decision.outcome).toBe('HUMAN_REQUIRED');
    expect(humanDecision.result.outcome).toBe('ALLOW');
  });
});
