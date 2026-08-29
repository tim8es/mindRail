import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Goal, Lease, Session, Task } from '@mindrail/contracts';
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
  correlationId?: string;
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

interface EndSessionResult {
  session: Session;
  leases: Lease[];
}

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-durable-liveness-')), 'runtime.sqlite');
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

async function seedClaimedTask(transport: HttpTransport, prefix: string) {
  const systemActor = { type: 'system', id: 'system-1' } as const;
  const registered = await command<Agent>(
    transport,
    'RegisterAgent',
    `${prefix}-register`,
    systemActor,
    {
      displayName: 'Durable liveness worker',
      capabilities: ['repo.write'],
    },
  );
  const agentActor = { type: 'agent', id: registered.result.id } as const;
  const session = await command<Session>(
    transport,
    'StartSession',
    `${prefix}-session`,
    systemActor,
    {
      agentId: registered.result.id,
    },
  );
  const goal = await command<Goal>(transport, 'CreateGoal', `${prefix}-goal`, systemActor, {
    title: 'Durable liveness goal',
    objective: 'Exercise restart-safe Session and Lease liveness.',
    successCriteria: ['Liveness mutations remain authoritative after restart.'],
  });
  const task = await command<Task>(transport, 'CreateTask', `${prefix}-task`, systemActor, {
    goalId: goal.result.id,
    title: 'Durable liveness task',
    objective: 'Keep execution authority restart-safe.',
    acceptanceCriteria: ['Session and Lease state is durably composed.'],
    requiredCapabilities: ['repo.write'],
    dependencyTaskIds: [],
  });
  const claim = await command<ClaimResult>(transport, 'ClaimTask', `${prefix}-claim`, agentActor, {
    taskId: task.result.id,
    sessionId: session.result.id,
    expectedTaskRevision: task.result.revision,
  });
  return {
    systemActor,
    agentActor,
    agent: registered.result,
    session: session.result,
    task: task.result,
    claim: claim.result,
  };
}

describe('durable Session/Lease liveness E2E', () => {
  it('persists HeartbeatSession without extending the current Lease and replays after restart', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-30T10:00:00.000Z') };
    let app = await openApplication(path, 'heartbeat-before', clock);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.transport, 'heartbeat');
    const originalLease = seeded.claim.lease;
    app.database.close();

    clock.now = new Date('2026-08-30T10:00:15.000Z');
    app = await openApplication(path, 'heartbeat-after', clock);
    const heartbeat = await command<Session>(
      app.transport,
      'HeartbeatSession',
      'heartbeat-command',
      seeded.agentActor,
      {
        sessionId: seeded.session.id,
        expectedSessionRevision: seeded.session.revision,
        correlationId: 'heartbeat-first',
      },
    );
    expect(heartbeat.result).toMatchObject({
      id: seeded.session.id,
      revision: seeded.session.revision + 1,
      lastSeenAt: clock.now.toISOString(),
    });
    expect(
      await query<Lease>(app.transport, 'GetLease', seeded.agentActor, {
        leaseId: originalLease.id,
      }),
    ).toEqual(originalLease);
    app.database.close();

    app = await openApplication(path, 'heartbeat-replay', clock);
    const replay = await send(app.transport, 'commands', 'HeartbeatSession', seeded.agentActor, {
      commandId: 'heartbeat-command',
      correlationId: 'heartbeat-replay',
      sessionId: seeded.session.id,
      expectedSessionRevision: seeded.session.revision,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, correlationId: 'heartbeat-replay' });
    expect((replay.body.result as Session).revision).toBe(seeded.session.revision + 1);
    app.database.close();
  });

  it('persists RenewLease with a stable fence and replays the persisted Lease after restart', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-30T11:00:00.000Z') };
    let app = await openApplication(path, 'renew-before', clock, 60_000);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.transport, 'renew');
    app.database.close();

    clock.now = new Date('2026-08-30T11:00:20.000Z');
    app = await openApplication(path, 'renew-after', clock, 60_000);
    const renewed = await command<Lease>(
      app.transport,
      'RenewLease',
      'renew-command',
      seeded.agentActor,
      {
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        expectedLeaseRevision: seeded.claim.lease.revision,
        correlationId: 'renew-first',
      },
    );
    expect(renewed.result).toMatchObject({
      id: seeded.claim.lease.id,
      revision: seeded.claim.lease.revision + 1,
      fencingToken: seeded.claim.lease.fencingToken,
      status: 'active',
      expiresAt: '2026-08-30T11:01:20.000Z',
    });
    app.database.close();

    app = await openApplication(path, 'renew-replay', clock, 60_000);
    const replay = await send(app.transport, 'commands', 'RenewLease', seeded.agentActor, {
      commandId: 'renew-command',
      correlationId: 'renew-replay',
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: seeded.claim.lease.id,
      fencingToken: seeded.claim.lease.fencingToken,
      expectedLeaseRevision: seeded.claim.lease.revision,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, correlationId: 'renew-replay' });
    expect(replay.body.result).toEqual(renewed.result);
    app.database.close();
  });

  it('persists ReleaseLease and permits recovery with a strictly higher fencing token', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-30T12:00:00.000Z') };
    let app = await openApplication(path, 'release-before', clock);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.transport, 'release');
    const recoverySession = await command<Session>(
      app.transport,
      'StartSession',
      'release-recovery-session',
      seeded.systemActor,
      { agentId: seeded.agent.id },
    );
    app.database.close();

    app = await openApplication(path, 'release-after', clock);
    const released = await command<Lease>(
      app.transport,
      'ReleaseLease',
      'release-command',
      seeded.agentActor,
      {
        taskId: seeded.task.id,
        sessionId: seeded.session.id,
        leaseId: seeded.claim.lease.id,
        fencingToken: seeded.claim.lease.fencingToken,
        expectedLeaseRevision: seeded.claim.lease.revision,
      },
    );
    expect(released.result).toMatchObject({
      id: seeded.claim.lease.id,
      status: 'released',
      revision: seeded.claim.lease.revision + 1,
      fencingToken: seeded.claim.lease.fencingToken,
    });

    const recovered = await command<ClaimResult>(
      app.transport,
      'ClaimTask',
      'release-recovery-claim',
      seeded.agentActor,
      {
        taskId: seeded.task.id,
        sessionId: recoverySession.result.id,
        expectedTaskRevision: seeded.claim.task.revision,
      },
    );
    expect(recovered.result.lease.fencingToken).toBeGreaterThan(seeded.claim.lease.fencingToken);
    expect(recovered.result.lease.sessionId).toBe(recoverySession.result.id);
    app.database.close();

    app = await openApplication(path, 'release-replay', clock);
    const replay = await send(app.transport, 'commands', 'ReleaseLease', seeded.agentActor, {
      commandId: 'release-command',
      correlationId: 'release-replay',
      taskId: seeded.task.id,
      sessionId: seeded.session.id,
      leaseId: seeded.claim.lease.id,
      fencingToken: seeded.claim.lease.fencingToken,
      expectedLeaseRevision: seeded.claim.lease.revision,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, correlationId: 'release-replay' });
    expect(replay.body.result).toEqual(released.result);
    app.database.close();
  });

  it('ends a Session and revokes its active Lease atomically before recovery', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-30T13:00:00.000Z') };
    let app = await openApplication(path, 'end-before', clock);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.transport, 'end');
    const recoverySession = await command<Session>(
      app.transport,
      'StartSession',
      'end-recovery-session',
      seeded.systemActor,
      {
        agentId: seeded.agent.id,
      },
    );
    app.database.close();

    clock.now = new Date('2026-08-30T13:00:10.000Z');
    app = await openApplication(path, 'end-after', clock);
    const ended = await command<EndSessionResult>(
      app.transport,
      'EndSession',
      'end-command',
      seeded.agentActor,
      {
        sessionId: seeded.session.id,
        expectedSessionRevision: seeded.session.revision,
      },
    );
    expect(ended.result.session).toMatchObject({
      id: seeded.session.id,
      status: 'ended',
      revision: seeded.session.revision + 1,
      endedAt: clock.now.toISOString(),
    });
    expect(ended.result.leases).toHaveLength(1);
    expect(ended.result.leases[0]).toMatchObject({
      id: seeded.claim.lease.id,
      status: 'revoked',
      revision: seeded.claim.lease.revision + 1,
      fencingToken: seeded.claim.lease.fencingToken,
    });
    expect(
      await query<Lease>(app.transport, 'GetLease', seeded.systemActor, {
        leaseId: seeded.claim.lease.id,
      }),
    ).toEqual(ended.result.leases[0]);

    const recovered = await command<ClaimResult>(
      app.transport,
      'ClaimTask',
      'end-recovery-claim',
      seeded.agentActor,
      {
        taskId: seeded.task.id,
        sessionId: recoverySession.result.id,
        expectedTaskRevision: seeded.claim.task.revision,
      },
    );
    expect(recovered.result.lease.fencingToken).toBeGreaterThan(seeded.claim.lease.fencingToken);
    app.database.close();

    app = await openApplication(path, 'end-replay', clock);
    const replay = await send(app.transport, 'commands', 'EndSession', seeded.agentActor, {
      commandId: 'end-command',
      correlationId: 'end-replay',
      sessionId: seeded.session.id,
      expectedSessionRevision: seeded.session.revision,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ replayed: true, correlationId: 'end-replay' });
    expect(replay.body.result).toEqual(ended.result);
    app.database.close();
  });

  it('rolls back Session, Lease, and receipt together when EndSession batch fails mid-flight', async () => {
    const path = databasePath();
    const clock = { now: new Date('2026-08-30T14:00:00.000Z') };
    const app = await openApplication(path, 'end-rollback', clock);
    await app.persistence.bootstrapWorkspace(workspace());
    const seeded = await seedClaimedTask(app.transport, 'end-rollback');

    app.database.failNextBatchAfterStatements(1);
    const failed = await send(app.transport, 'commands', 'EndSession', seeded.agentActor, {
      commandId: 'end-rollback-command',
      sessionId: seeded.session.id,
      expectedSessionRevision: seeded.session.revision,
    });
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({
      replayed: false,
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(await app.persistence.getSession('ws-a', seeded.session.id)).toEqual(seeded.session);
    expect(await app.persistence.getLease('ws-a', seeded.claim.lease.id)).toEqual(
      seeded.claim.lease,
    );
    expect(await app.persistence.getCommandReceipt('ws-a', 'end-rollback-command')).toBeUndefined();

    const retry = await command<EndSessionResult>(
      app.transport,
      'EndSession',
      'end-rollback-command',
      seeded.agentActor,
      {
        sessionId: seeded.session.id,
        expectedSessionRevision: seeded.session.revision,
      },
    );
    expect(retry.result.session.status).toBe('ended');
    expect(retry.result.leases).toHaveLength(1);
    expect(retry.result.leases[0]?.status).toBe('revoked');
    app.database.close();
  });
});
