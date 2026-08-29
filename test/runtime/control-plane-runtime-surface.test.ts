import type { Checkpoint, Lease, Session, Task } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import type { ProtocolCommand, ProtocolResponse } from '../../src/runtime/protocol.ts';
import { RuntimeError } from '../../src/runtime/errors.ts';
import { canonicalDomainValidator } from './canonical-domain-validator.ts';

interface EndSessionResult {
  session: Session;
  leases: Lease[];
}

interface BlockTaskResult {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
}

function createRuntime(options: { leaseDurationMs?: number; sessionTimeoutMs?: number } = {}) {
  let sequence = 0;
  let now = new Date('2026-08-29T12:00:00.000Z');
  const runtime = new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'Dogfood',
    now: () => new Date(now),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: options.leaseDurationMs ?? 120_000,
    sessionTimeoutMs: options.sessionTimeoutMs ?? 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });

  return {
    runtime,
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    timestamp() {
      return now.toISOString();
    },
  };
}

function createWorker(runtime: InMemoryControlPlane, displayName = 'Worker') {
  const agent = runtime.registerAgent({
    workspaceId: 'ws-1',
    displayName,
    capabilities: ['code.execute'],
  });
  const session = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
  return { agent, session };
}

function createRunningTask(runtime: InMemoryControlPlane, sessionId: string) {
  const goal = runtime.createGoal({
    workspaceId: 'ws-1',
    title: 'Runtime lifecycle',
    objective: 'Exercise remaining deterministic runtime lifecycle commands.',
    successCriteria: ['Lifecycle semantics remain fenced and deterministic.'],
  });
  const task = runtime.createTask({
    workspaceId: 'ws-1',
    goalId: goal.id,
    title: 'Run lifecycle task',
    objective: 'Own execution authority for lifecycle tests.',
    acceptanceCriteria: ['Authority transitions remain deterministic.'],
    requiredCapabilities: ['code.execute'],
    dependencyTaskIds: [],
  });
  const claim = runtime.claimTask({
    workspaceId: 'ws-1',
    taskId: task.id,
    sessionId,
    expectedTaskRevision: task.revision,
  });
  return { goal, task, claim };
}

function executeFuture<T>(
  runtime: InMemoryControlPlane,
  command: Record<string, unknown>,
): ProtocolResponse<T> {
  return runtime.execute(command as unknown as ProtocolCommand) as ProtocolResponse<T>;
}

function expectSuccess<T>(response: ProtocolResponse<T>): T {
  expect('error' in response).toBe(false);
  if ('error' in response) {
    throw new Error(`Expected protocol success, received ${response.error.code}.`);
  }
  return response.result;
}

function expectFailure(response: ProtocolResponse, code: RuntimeError['code']): void {
  expect('error' in response && response.error.code).toBe(code);
}

function seedBlockedTask(runtime: InMemoryControlPlane, task: Task): Task {
  const internal = runtime as unknown as { tasks: Map<string, Task> };
  const stored = internal.tasks.get(task.id);
  if (!stored) throw new Error(`Task ${task.id} was not found in test setup.`);
  stored.status = 'blocked';
  stored.statusReason = { code: 'controller.blocked', summary: 'Blocked by controller.' };
  stored.revision += 1;
  return structuredClone(stored);
}

describe('remaining runtime lifecycle surface', () => {
  it('heartbeats just before timeout and rejects the half-open timeout boundary without revival', () => {
    const { runtime, advance, timestamp } = createRuntime();
    const agent = runtime.registerAgent({
      workspaceId: 'ws-1',
      displayName: 'Heartbeat worker',
      capabilities: ['code.execute'],
    });
    const liveSession = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
    const boundarySession = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });

    advance(59_999);
    const heartbeat = expectSuccess<Session>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'HeartbeatSession',
        commandId: 'cmd-heartbeat-before-timeout',
        workspaceId: 'ws-1',
        actor: { type: 'agent', id: agent.id },
        sessionId: liveSession.id,
        expectedSessionRevision: liveSession.revision,
      }),
    );
    expect(heartbeat.revision).toBe(2);
    expect(heartbeat.lastSeenAt).toBe(timestamp());
    expect(heartbeat.updatedAt).toBe(timestamp());

    advance(1);
    const boundary = executeFuture<Session>(runtime, {
      protocolVersion: '0.1',
      command: 'HeartbeatSession',
      commandId: 'cmd-heartbeat-boundary',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      sessionId: boundarySession.id,
      expectedSessionRevision: boundarySession.revision,
    });
    expectFailure(boundary, 'SESSION_NOT_ACTIVE');

    const noRevival = executeFuture<Session>(runtime, {
      protocolVersion: '0.1',
      command: 'HeartbeatSession',
      commandId: 'cmd-heartbeat-no-revival',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      sessionId: boundarySession.id,
      expectedSessionRevision: boundarySession.revision + 1,
    });
    expectFailure(noRevival, 'SESSION_NOT_ACTIVE');
  });

  it('heartbeat updates Session liveness without changing Lease expiry', () => {
    const { runtime, advance, timestamp } = createRuntime();
    const { agent, session } = createWorker(runtime);
    const { claim } = createRunningTask(runtime, session.id);
    const originalExpiry = claim.lease.expiresAt;

    advance(10_000);
    const heartbeat = expectSuccess<Session>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'HeartbeatSession',
        commandId: 'cmd-heartbeat-no-lease-renewal',
        workspaceId: 'ws-1',
        actor: { type: 'agent', id: agent.id },
        sessionId: session.id,
        expectedSessionRevision: session.revision,
      }),
    );

    expect(heartbeat.lastSeenAt).toBe(timestamp());
    expect(runtime.getLease('ws-1', claim.lease.id).expiresAt).toBe(originalExpiry);
  });

  it('ends an active Session, revokes its Leases, and permits higher-fence recovery', () => {
    const { runtime } = createRuntime();
    const { agent, session } = createWorker(runtime);
    const { task, claim } = createRunningTask(runtime, session.id);

    const ended = expectSuccess<EndSessionResult>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'EndSession',
        commandId: 'cmd-end-session',
        workspaceId: 'ws-1',
        actor: { type: 'agent', id: agent.id },
        sessionId: session.id,
        expectedSessionRevision: session.revision,
      }),
    );

    expect(ended.session.status).toBe('ended');
    expect(ended.session.endedAt).toBeDefined();
    expect(ended.session.revision).toBe(session.revision + 1);
    expect(ended.leases).toHaveLength(1);
    expect(ended.leases[0]?.status).toBe('revoked');
    expect(runtime.getLease('ws-1', claim.lease.id).status).toBe('revoked');
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

  it('renews only the current owner Lease, preserving its fence and extending expiry', () => {
    const { runtime, advance } = createRuntime({ leaseDurationMs: 60_000, sessionTimeoutMs: 300_000 });
    const owner = createWorker(runtime, 'Owner');
    const other = createWorker(runtime, 'Other');
    const { task, claim } = createRunningTask(runtime, owner.session.id);

    advance(10_000);
    const renewed = expectSuccess<Lease>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'RenewLease',
        commandId: 'cmd-renew-owner',
        workspaceId: 'ws-1',
        actor: { type: 'agent', id: owner.agent.id },
        taskId: task.id,
        sessionId: owner.session.id,
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        expectedLeaseRevision: claim.lease.revision,
      }),
    );

    expect(renewed.revision).toBe(claim.lease.revision + 1);
    expect(renewed.fencingToken).toBe(claim.lease.fencingToken);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(claim.lease.expiresAt));

    const nonOwner = executeFuture<Lease>(runtime, {
      protocolVersion: '0.1',
      command: 'RenewLease',
      commandId: 'cmd-renew-non-owner',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: other.agent.id },
      taskId: task.id,
      sessionId: other.session.id,
      leaseId: renewed.id,
      fencingToken: renewed.fencingToken,
      expectedLeaseRevision: renewed.revision,
    });
    expectFailure(nonOwner, 'LEASE_NOT_ACTIVE');
  });

  it('rejects Lease renewal from a stale Session', () => {
    const { runtime, advance } = createRuntime({ leaseDurationMs: 120_000, sessionTimeoutMs: 60_000 });
    const { agent, session } = createWorker(runtime);
    const { task, claim } = createRunningTask(runtime, session.id);

    advance(60_000);
    const staleRenewal = executeFuture<Lease>(runtime, {
      protocolVersion: '0.1',
      command: 'RenewLease',
      commandId: 'cmd-renew-stale-session',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      taskId: task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedLeaseRevision: claim.lease.revision,
    });

    expectFailure(staleRenewal, 'SESSION_NOT_ACTIVE');
    expect(runtime.getLease('ws-1', claim.lease.id).status).toBe('revoked');
  });

  it('rejects renewal of a released and replaced Lease', () => {
    const { runtime } = createRuntime({ sessionTimeoutMs: 300_000 });
    const first = createWorker(runtime, 'First owner');
    const second = createWorker(runtime, 'Replacement owner');
    const { task, claim } = createRunningTask(runtime, first.session.id);

    runtime.releaseLease({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: first.session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedLeaseRevision: claim.lease.revision,
    });
    const replacement = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: second.session.id,
      expectedTaskRevision: claim.task.revision,
    });
    expect(replacement.lease.fencingToken).toBeGreaterThan(claim.lease.fencingToken);

    const staleRenewal = executeFuture<Lease>(runtime, {
      protocolVersion: '0.1',
      command: 'RenewLease',
      commandId: 'cmd-renew-replaced-lease',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: first.agent.id },
      taskId: task.id,
      sessionId: first.session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedLeaseRevision: claim.lease.revision + 1,
    });
    expectFailure(staleRenewal, 'LEASE_NOT_ACTIVE');
  });

  it('blocks running work with a blocked checkpoint and removes stale execution authority', () => {
    const { runtime } = createRuntime();
    const { agent, session } = createWorker(runtime);
    const { task, claim } = createRunningTask(runtime, session.id);

    const blocked = expectSuccess<BlockTaskResult>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'BlockTask',
        commandId: 'cmd-block-task',
        workspaceId: 'ws-1',
        actor: { type: 'agent', id: agent.id },
        taskId: task.id,
        sessionId: session.id,
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        expectedTaskRevision: claim.task.revision,
        reason: { code: 'task.blocked', summary: 'Waiting for an external prerequisite.' },
        evidence: [],
      }),
    );

    expect(blocked.task.status).toBe('blocked');
    expect(blocked.task.statusReason?.code).toBe('task.blocked');
    expect(blocked.lease.status).toBe('released');
    expect(blocked.checkpoint.kind).toBe('blocked');
    expect(runtime.listTaskCheckpoints('ws-1', task.id)).toHaveLength(1);

    expect(() =>
      runtime.recordCheckpoint({
        workspaceId: 'ws-1',
        taskId: task.id,
        sessionId: session.id,
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        kind: 'progress',
        summary: 'Stale progress after block.',
        evidence: [],
      }),
    ).toThrowError(RuntimeError);

    expect(() =>
      runtime.completeTask({
        workspaceId: 'ws-1',
        taskId: task.id,
        sessionId: session.id,
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        expectedTaskRevision: claim.task.revision,
        summary: 'Stale completion after block.',
        evidence: [],
      }),
    ).toThrowError(RuntimeError);
  });

  it('validates BlockTask Reason before mutating Task, Lease, or checkpoints', () => {
    const { runtime } = createRuntime();
    const { agent, session } = createWorker(runtime);
    const { task, claim } = createRunningTask(runtime, session.id);

    const invalid = executeFuture<BlockTaskResult>(runtime, {
      protocolVersion: '0.1',
      command: 'BlockTask',
      commandId: 'cmd-block-invalid-reason',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      taskId: task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedTaskRevision: claim.task.revision,
      reason: { code: 'task.blocked', summary: 'x'.repeat(1001) },
      evidence: [],
    });

    expectFailure(invalid, 'INVALID_INPUT');
    expect(runtime.getTask('ws-1', task.id).status).toBe('running');
    expect(runtime.getLease('ws-1', claim.lease.id).status).toBe('active');
    expect(runtime.listTaskCheckpoints('ws-1', task.id)).toHaveLength(0);
  });

  it('resumes a blocked Task to ready when dependencies are satisfied without minting a Lease', () => {
    const { runtime } = createRuntime();
    const { agent, session } = createWorker(runtime);
    const { task, claim } = createRunningTask(runtime, session.id);
    const blocked = expectSuccess<BlockTaskResult>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'BlockTask',
        commandId: 'cmd-block-before-resume',
        workspaceId: 'ws-1',
        actor: { type: 'agent', id: agent.id },
        taskId: task.id,
        sessionId: session.id,
        leaseId: claim.lease.id,
        fencingToken: claim.lease.fencingToken,
        expectedTaskRevision: claim.task.revision,
        reason: { code: 'task.blocked', summary: 'Pause before resume.' },
        evidence: [],
      }),
    );

    const resumed = expectSuccess<Task>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'ResumeTask',
        commandId: 'cmd-resume-ready',
        workspaceId: 'ws-1',
        actor: { type: 'human', id: 'human-1' },
        taskId: task.id,
        expectedTaskRevision: blocked.task.revision,
      }),
    );

    expect(resumed.status).toBe('ready');
    expect(resumed.statusReason).toBeUndefined();
    expect(runtime.getLease('ws-1', claim.lease.id).status).toBe('released');
  });

  it('resumes a canonical blocked Task to pending when dependencies remain unsatisfied', () => {
    const { runtime } = createRuntime();
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Pending resume',
      objective: 'Resume must re-evaluate dependency satisfaction.',
      successCriteria: ['Blocked dependent returns to pending.'],
    });
    const dependency = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Dependency',
      objective: 'Remain incomplete.',
      acceptanceCriteria: ['Remain ready.'],
      requiredCapabilities: [],
      dependencyTaskIds: [],
    });
    const dependent = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Dependent',
      objective: 'Wait for dependency.',
      acceptanceCriteria: ['Resume remains pending.'],
      requiredCapabilities: [],
      dependencyTaskIds: [dependency.id],
    });
    expect(dependent.status).toBe('pending');
    const blocked = seedBlockedTask(runtime, dependent);

    const resumed = expectSuccess<Task>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'ResumeTask',
        commandId: 'cmd-resume-pending',
        workspaceId: 'ws-1',
        actor: { type: 'system', id: 'system-1' },
        taskId: dependent.id,
        expectedTaskRevision: blocked.revision,
      }),
    );

    expect(resumed.status).toBe('pending');
    expect(resumed.statusReason).toBeUndefined();
  });

  it('rejects agent authority for ResumeTask and leaves the Task blocked', () => {
    const { runtime } = createRuntime();
    const { agent } = createWorker(runtime);
    const goal = runtime.createGoal({
      workspaceId: 'ws-1',
      title: 'Controller resume',
      objective: 'Only a controller may resume blocked work.',
      successCriteria: ['Agent resume is rejected.'],
    });
    const task = runtime.createTask({
      workspaceId: 'ws-1',
      goalId: goal.id,
      title: 'Blocked task',
      objective: 'Remain blocked after unauthorized resume.',
      acceptanceCriteria: ['Controller boundary is preserved.'],
      requiredCapabilities: [],
      dependencyTaskIds: [],
    });
    const blocked = seedBlockedTask(runtime, task);

    const unauthorized = executeFuture<Task>(runtime, {
      protocolVersion: '0.1',
      command: 'ResumeTask',
      commandId: 'cmd-resume-agent',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      taskId: task.id,
      expectedTaskRevision: blocked.revision,
    });

    expectFailure(unauthorized, 'ACTOR_NOT_AUTHORIZED');
    expect(runtime.getTask('ws-1', task.id).status).toBe('blocked');
  });

  it('keeps BlockTask protocol retries idempotent across tracing changes', () => {
    const { runtime } = createRuntime();
    const { agent, session } = createWorker(runtime);
    const { task, claim } = createRunningTask(runtime, session.id);
    const command = {
      protocolVersion: '0.1',
      command: 'BlockTask',
      commandId: 'cmd-block-idempotent',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      correlationId: 'corr-1',
      causationId: 'cause-1',
      taskId: task.id,
      sessionId: session.id,
      leaseId: claim.lease.id,
      fencingToken: claim.lease.fencingToken,
      expectedTaskRevision: claim.task.revision,
      reason: { code: 'task.blocked', summary: 'Idempotent pause.' },
      evidence: [],
    };

    const first = executeFuture<BlockTaskResult>(runtime, command);
    const firstResult = expectSuccess(first);
    expect(first.replayed).toBe(false);

    const replay = executeFuture<BlockTaskResult>(runtime, {
      ...command,
      correlationId: 'corr-2',
      causationId: 'cause-2',
    });
    const replayResult = expectSuccess(replay);
    expect(replay.replayed).toBe(true);
    expect(replayResult.task).toEqual(firstResult.task);
    expect(replayResult.lease).toEqual(firstResult.lease);
    expect(replayResult.checkpoint).toEqual(firstResult.checkpoint);
    expect(runtime.listTaskCheckpoints('ws-1', task.id)).toHaveLength(1);

    const conflict = executeFuture<BlockTaskResult>(runtime, {
      ...command,
      reason: { code: 'task.blocked', summary: 'Different semantic pause.' },
    });
    expectFailure(conflict, 'IDEMPOTENCY_CONFLICT');
  });

  it('pre-admits new command shapes before reserving their command id', () => {
    const { runtime } = createRuntime();
    const { agent, session } = createWorker(runtime);

    const malformed = executeFuture<Session>(runtime, {
      protocolVersion: '0.1',
      command: 'HeartbeatSession',
      commandId: 'cmd-heartbeat-pre-admission',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      sessionId: session.id,
      expectedSessionRevision: 0,
    });
    expectFailure(malformed, 'INVALID_INPUT');
    expect(malformed.replayed).toBe(false);

    const admitted = executeFuture<Session>(runtime, {
      protocolVersion: '0.1',
      command: 'HeartbeatSession',
      commandId: 'cmd-heartbeat-pre-admission',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: agent.id },
      sessionId: session.id,
      expectedSessionRevision: session.revision,
    });
    expectSuccess(admitted);
    expect(admitted.replayed).toBe(false);
  });
});
