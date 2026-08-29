import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

import { createDurableApplicationDispatcher } from '../../src/application/durable-dispatcher.ts';
import { createHttpTransport, type HttpTransport } from '../../src/transports/http/adapter.ts';
import { workspace } from '../persistence/fixtures.ts';
import { openPersistence } from '../persistence/setup.ts';
import { canonicalDomainValidator } from '../runtime/canonical-domain-validator.ts';

type Actor = { type: 'system' | 'human' | 'agent'; id: string };

type SuccessEnvelope<T> = {
  protocolVersion: '0.1';
  commandId?: string;
  replayed?: boolean;
  result: T;
};

interface ApplicationInstance {
  database: Awaited<ReturnType<typeof openPersistence>>['database'];
  persistence: Awaited<ReturnType<typeof openPersistence>>['persistence'];
  transport: HttpTransport;
}

interface ClaimResult {
  task: Task;
  lease: Lease;
}

interface PermissionResult {
  request: PermissionRequest;
  decision: PermissionDecision;
}

interface CompleteResult {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
}

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-durable-http-')), 'runtime.sqlite');
}

async function openApplication(
  path: string,
  prefix: string,
  clock: { now: Date },
  leaseDurationMs = 120_000,
  sessionTimeoutMs = 300_000,
): Promise<ApplicationInstance> {
  const opened = await openPersistence(path);
  let sequence = 0;
  const dispatcher = createDurableApplicationDispatcher({
    persistence: opened.persistence,
    now: () => new Date(clock.now),
    idFactory: (kind) => `${prefix}-${kind}-${++sequence}`,
    leaseDurationMs,
    sessionTimeoutMs,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
  return {
    ...opened,
    transport: createHttpTransport({
      dispatcher,
      authorizer: { authorize: async () => true },
    }),
  };
}

async function send(
  transport: HttpTransport,
  kind: 'commands' | 'queries',
  name: string,
  actor: Actor,
  fields: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await transport.handle(
    new Request(`https://mindrail.invalid/v0.1/${kind}/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: '0.1',
        workspaceId: 'ws-a',
        actor,
        ...fields,
      }),
    }),
    { subject: `principal:${actor.type}:${actor.id}` },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function command<T>(
  transport: HttpTransport,
  name: string,
  commandId: string,
  actor: Actor,
  fields: Record<string, unknown>,
): Promise<SuccessEnvelope<T>> {
  const response = await send(transport, 'commands', name, actor, { commandId, ...fields });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).not.toHaveProperty('error');
  return response.body as unknown as SuccessEnvelope<T>;
}

async function query<T>(
  transport: HttpTransport,
  name: string,
  actor: Actor,
  fields: Record<string, unknown>,
): Promise<T> {
  const response = await send(transport, 'queries', name, actor, fields);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  expect(response.body).not.toHaveProperty('error');
  return (response.body as unknown as SuccessEnvelope<T>).result;
}

async function seedClaimedTask(transport: HttpTransport, commandPrefix: string) {
  const systemActor = { type: 'system', id: 'system-1' } as const;
  const registered = await command<Agent>(
    transport,
    'RegisterAgent',
    `${commandPrefix}-register`,
    systemActor,
    { displayName: 'Durable HTTP worker', capabilities: ['repo.write'] },
  );
  const agentActor = { type: 'agent', id: registered.result.id } as const;
  const session = await command<Session>(
    transport,
    'StartSession',
    `${commandPrefix}-session`,
    systemActor,
    { agentId: registered.result.id },
  );
  const goal = await command<Goal>(
    transport,
    'CreateGoal',
    `${commandPrefix}-goal`,
    systemActor,
    {
      title: 'Durable HTTP goal',
      objective: 'Prove restart-safe protocol execution.',
      successCriteria: ['The durable task completes after restart.'],
    },
  );
  const task = await command<Task>(
    transport,
    'CreateTask',
    `${commandPrefix}-task`,
    systemActor,
    {
      goalId: goal.result.id,
      title: 'Durable HTTP task',
      objective: 'Survive process replacement.',
      acceptanceCriteria: ['The same fenced execution remains authoritative.'],
      requiredCapabilities: ['repo.write'],
      dependencyTaskIds: [],
    },
  );
  const claim = await command<ClaimResult>(
    transport,
    'ClaimTask',
    `${commandPrefix}-claim`,
    agentActor,
    {
      taskId: task.result.id,
      sessionId: session.result.id,
      expectedTaskRevision: task.result.revision,
    },
  );
  return { systemActor, agentActor, agent: registered.result, session: session.result, goal: goal.result, task: task.result, claim: claim.result };
}

describe('durable HTTP control-plane E2E', () => {
  it('continues the same fenced execution after application/database restart', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-29T18:00:00.000Z') };
    let app = await openApplication(path, 'before', clock);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.transport, 'restart');
    app.database.close();

    app = await openApplication(path, 'after', clock);
    const recoveredTask = await query<Task>(app.transport, 'GetTask', seeded.agentActor, {
      taskId: seeded.task.id,
    });
    const recoveredLease = await query<Lease>(app.transport, 'GetLease', seeded.agentActor, {
      leaseId: seeded.claim.lease.id,
    });
    expect(recoveredTask).toEqual(seeded.claim.task);
    expect(recoveredLease).toEqual(seeded.claim.lease);

    await command<Checkpoint>(app.transport, 'RecordCheckpoint', 'restart-checkpoint', seeded.agentActor, {
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: recoveredLease.id,
      fencingToken: recoveredLease.fencingToken,
      kind: 'progress',
      summary: 'Execution continued after reopening durable state.',
      evidence: [],
      progressPercent: 80,
    });
    const completed = await command<CompleteResult>(
      app.transport,
      'CompleteTask',
      'restart-complete',
      seeded.agentActor,
      {
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: recoveredLease.id,
        fencingToken: recoveredLease.fencingToken,
        expectedTaskRevision: recoveredTask.revision,
        summary: 'Restart-safe execution completed.',
        evidence: [],
      },
    );
    expect(completed.result.task.status).toBe('succeeded');
    expect(completed.result.lease.status).toBe('released');
    expect((await query<Goal>(app.transport, 'GetGoal', seeded.systemActor, { goalId: seeded.goal.id })).status).toBe('succeeded');
    app.database.close();
  });

  it('preserves HUMAN_REQUIRED state and decision history across restart', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-29T18:00:00.000Z') };
    let app = await openApplication(path, 'permission-before', clock);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.transport, 'permission');
    const requested = await command<PermissionResult>(
      app.transport,
      'RequestPermission',
      'permission-request',
      seeded.agentActor,
      {
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        permission: 'repository.write',
        justification: 'A durable repository mutation requires human approval.',
      },
    );
    expect(requested.result.decision.outcome).toBe('HUMAN_REQUIRED');
    app.database.close();

    app = await openApplication(path, 'permission-after', clock);
    const pending = await query<{
      items: Array<{ request: PermissionRequest; latestDecision: PermissionDecision }>;
    }>(app.transport, 'ListPendingHumanPermissions', seeded.systemActor, { limit: 10 });
    expect(pending.items.map((item) => item.request.id)).toContain(requested.result.request.id);
    expect(
      await query<PermissionRequest>(app.transport, 'GetPermissionRequest', seeded.systemActor, {
        requestId: requested.result.request.id,
      }),
    ).toEqual(requested.result.request);

    const humanActor = { type: 'human', id: 'human-1' } as const;
    const decision = await command<PermissionDecision>(
      app.transport,
      'RecordPermissionDecision',
      'permission-allow',
      humanActor,
      {
        requestId: requested.result.request.id,
        outcome: 'ALLOW',
        expectedPreviousDecisionId: requested.result.decision.id,
        reasonCode: 'human.approved',
      },
    );
    expect(decision.result).toMatchObject({
      sequence: 2,
      outcome: 'ALLOW',
      supersedesDecisionId: requested.result.decision.id,
    });
    const history = await query<{ items: PermissionDecision[] }>(
      app.transport,
      'ListPermissionDecisions',
      humanActor,
      { requestId: requested.result.request.id, limit: 10 },
    );
    expect(history.items.map((item) => item.outcome)).toEqual(['HUMAN_REQUIRED', 'ALLOW']);

    const completed = await command<CompleteResult>(
      app.transport,
      'CompleteTask',
      'permission-complete',
      seeded.agentActor,
      {
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        expectedTaskRevision: seeded.claim.task.revision,
        summary: 'Human-approved execution completed after restart.',
        evidence: [],
      },
    );
    expect(completed.result.task.status).toBe('succeeded');
    app.database.close();
  });

  it('replays a lost mutation response from the durable receipt after restart', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-29T18:00:00.000Z') };
    let app = await openApplication(path, 'loss-before', clock);
    await app.persistence.bootstrapWorkspace(workspace());
    const systemActor = { type: 'system', id: 'system-1' } as const;
    const fields = {
      commandId: 'lost-response-goal',
      correlationId: 'corr-before',
      title: 'Response-loss goal',
      objective: 'Prove durable idempotent replay.',
      successCriteria: ['One durable mutation exists after retry.'],
    };
    const first = await send(app.transport, 'commands', 'CreateGoal', systemActor, fields);
    expect(first.status).toBe(200);
    app.database.close();

    app = await openApplication(path, 'loss-after', clock);
    const replay = await send(app.transport, 'commands', 'CreateGoal', systemActor, {
      ...fields,
      correlationId: 'corr-after',
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, correlationId: 'corr-after' });
    const durable = await app.persistence.loadWorkspaceState('ws-a');
    expect(durable?.goals).toHaveLength(1);
    expect((replay.body.result as Goal).id).toBe(durable?.goals[0]?.id);
    app.database.close();
  });

  it('keeps one authoritative Lease across competing application instances and advances fencing on recovery', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-29T18:00:00.000Z') };
    const first = await openApplication(path, 'race-a', clock, 60_000, 300_000);
    await first.persistence.bootstrapWorkspace(workspace());
    const systemActor = { type: 'system', id: 'system-1' } as const;

    const agentA = await command<Agent>(first.transport, 'RegisterAgent', 'race-register-a', systemActor, {
      displayName: 'Racer A',
      capabilities: ['repo.write'],
    });
    const agentB = await command<Agent>(first.transport, 'RegisterAgent', 'race-register-b', systemActor, {
      displayName: 'Racer B',
      capabilities: ['repo.write'],
    });
    const sessionA = await command<Session>(first.transport, 'StartSession', 'race-session-a', systemActor, {
      agentId: agentA.result.id,
    });
    const sessionB = await command<Session>(first.transport, 'StartSession', 'race-session-b', systemActor, {
      agentId: agentB.result.id,
    });
    const goal = await command<Goal>(first.transport, 'CreateGoal', 'race-goal', systemActor, {
      title: 'Competing claim goal',
      objective: 'Prove a single durable execution authority.',
      successCriteria: ['Only one effective Lease exists at a time.'],
    });
    const task = await command<Task>(first.transport, 'CreateTask', 'race-task', systemActor, {
      goalId: goal.result.id,
      title: 'Competing claim task',
      objective: 'Race two independent application instances.',
      acceptanceCriteria: ['Exactly one claim wins.'],
      requiredCapabilities: ['repo.write'],
      dependencyTaskIds: [],
    });

    const second = await openApplication(path, 'race-b', clock, 60_000, 300_000);
    const [claimA, claimB] = await Promise.all([
      send(first.transport, 'commands', 'ClaimTask', { type: 'agent', id: agentA.result.id }, {
        commandId: 'race-claim-a',
        taskId: task.result.id,
        sessionId: sessionA.result.id,
        expectedTaskRevision: task.result.revision,
      }),
      send(second.transport, 'commands', 'ClaimTask', { type: 'agent', id: agentB.result.id }, {
        commandId: 'race-claim-b',
        taskId: task.result.id,
        sessionId: sessionB.result.id,
        expectedTaskRevision: task.result.revision,
      }),
    ]);
    const winners = [claimA, claimB].filter((response) => response.status === 200);
    const losers = [claimA, claimB].filter((response) => response.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const firstLease = (winners[0]!.body.result as ClaimResult).lease;
    expect(firstLease.fencingToken).toBe(1);
    expect((await first.persistence.loadWorkspaceState('ws-a'))?.leases.filter((lease) => lease.status === 'active')).toHaveLength(1);

    const losingSession = firstLease.sessionId === sessionA.result.id ? sessionB.result : sessionA.result;
    const losingAgent = firstLease.sessionId === sessionA.result.id ? agentB.result : agentA.result;
    clock.now = new Date('2026-08-29T18:01:01.000Z');
    const currentTask = await query<Task>(second.transport, 'GetTask', systemActor, { taskId: task.result.id });
    const recovery = await command<ClaimResult>(
      second.transport,
      'ClaimTask',
      'race-recovery',
      { type: 'agent', id: losingAgent.id },
      {
        taskId: task.result.id,
        sessionId: losingSession.id,
        expectedTaskRevision: currentTask.revision,
      },
    );
    expect(recovery.result.lease.fencingToken).toBe(2);
    expect(recovery.result.lease.sessionId).toBe(losingSession.id);
    const state = await second.persistence.loadWorkspaceState('ws-a');
    expect(state?.fencingCounters[task.result.id]).toBe(2);
    expect(state?.leases.filter((lease) => lease.status === 'active')).toHaveLength(1);
    expect(state?.leases.find((lease) => lease.id === firstLease.id)?.status).toBe('expired');
    first.database.close();
    second.database.close();
  });
});
