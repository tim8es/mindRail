import type {
  Agent,
  Checkpoint,
  Goal,
  Lease,
  PermissionDecision,
  PermissionRequest,
  Session,
  Task,
  Workspace,
} from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import type { CanonicalDomainValidator } from '../../src/runtime/domain-validation.ts';
import { RuntimeError } from '../../src/runtime/errors.ts';
import { canonicalDomainValidator } from './canonical-domain-validator.ts';

interface RuntimeSnapshot {
  workspace: Workspace;
  goals: Goal[];
  tasks: Task[];
  agents: Agent[];
  sessions: Session[];
  leases: Lease[];
  checkpoints: Checkpoint[];
  permissionRequests: PermissionRequest[];
  permissionDecisions: PermissionDecision[];
  fencingCounters: Record<string, number>;
}

interface RehydrateOptions {
  snapshot: RuntimeSnapshot;
  now: () => Date;
  idFactory: (kind: string) => string;
  leaseDurationMs: number;
  sessionTimeoutMs: number;
  validateCanonicalDomainRecord: CanonicalDomainValidator;
}

type RehydratableControlPlane = typeof InMemoryControlPlane & {
  rehydrate(options: RehydrateOptions): InMemoryControlPlane;
};

function createSource(now = new Date('2026-08-29T18:00:00.000Z')) {
  let sequence = 0;
  const runtime = new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'Rehydration test',
    now: () => new Date(now),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: 120_000,
    sessionTimeoutMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
  return runtime;
}

function buildSnapshot(): {
  snapshot: RuntimeSnapshot;
  task: Task;
  lease: Lease;
  session: Session;
  permissionRequest: PermissionRequest;
  permissionDecision: PermissionDecision;
} {
  const runtime = createSource();
  const agent = runtime.registerAgent({
    workspaceId: 'ws-1',
    displayName: 'Worker',
    capabilities: ['code.execute'],
  });
  const session = runtime.startSession({ workspaceId: 'ws-1', agentId: agent.id });
  const goal = runtime.createGoal({
    workspaceId: 'ws-1',
    title: 'Durable goal',
    objective: 'Prove runtime state can be reconstructed.',
    successCriteria: ['State survives reconstruction.'],
  });
  const task = runtime.createTask({
    workspaceId: 'ws-1',
    goalId: goal.id,
    title: 'Durable task',
    objective: 'Continue execution after reconstruction.',
    acceptanceCriteria: ['Execution authority remains correct.'],
    requiredCapabilities: ['code.execute'],
    dependencyTaskIds: [],
  });
  const claim = runtime.claimTask({
    workspaceId: 'ws-1',
    taskId: task.id,
    sessionId: session.id,
    expectedTaskRevision: task.revision,
  });
  const checkpoint = runtime.recordCheckpoint({
    workspaceId: 'ws-1',
    taskId: task.id,
    sessionId: session.id,
    leaseId: claim.lease.id,
    fencingToken: claim.lease.fencingToken,
    kind: 'progress',
    summary: 'Before restart.',
    evidence: [],
    progressPercent: 40,
  });
  const permission = runtime.requestPermission({
    workspaceId: 'ws-1',
    taskId: task.id,
    sessionId: session.id,
    leaseId: claim.lease.id,
    fencingToken: claim.lease.fencingToken,
    permission: 'repository.write',
    justification: 'Need approval before continuing.',
  });

  return {
    snapshot: {
      workspace: runtime.getWorkspace('ws-1'),
      goals: [goal],
      tasks: [claim.task],
      agents: [agent],
      sessions: [session],
      leases: [claim.lease],
      checkpoints: [checkpoint],
      permissionRequests: [permission.request],
      permissionDecisions: [permission.decision],
      fencingCounters: { [task.id]: claim.lease.fencingToken },
    },
    task: claim.task,
    lease: claim.lease,
    session,
    permissionRequest: permission.request,
    permissionDecision: permission.decision,
  };
}

function rehydrate(snapshot: RuntimeSnapshot, now = '2026-08-29T18:00:30.000Z') {
  let sequence = 0;
  return (InMemoryControlPlane as RehydratableControlPlane).rehydrate({
    snapshot,
    now: () => new Date(now),
    idFactory: (kind) => `rehydrated-${kind}-${++sequence}`,
    leaseDurationMs: 120_000,
    sessionTimeoutMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
}

describe('runtime canonical snapshot rehydration', () => {
  it('restores execution, checkpoint, permission, and fencing state without replaying commands', () => {
    const { snapshot, task, lease, session, permissionRequest, permissionDecision } = buildSnapshot();
    const runtime = rehydrate(snapshot);

    expect(runtime.getTask('ws-1', task.id)).toEqual(task);
    expect(runtime.getLease('ws-1', lease.id)).toEqual(lease);
    expect(runtime.listTaskCheckpoints('ws-1', task.id)).toEqual(snapshot.checkpoints);
    expect(runtime.getPermissionRequest('ws-1', permissionRequest.id)).toEqual(permissionRequest);
    expect(runtime.listPermissionDecisions('ws-1', permissionRequest.id)).toEqual([
      permissionDecision,
    ]);

    const duplicate = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision - 1,
    });
    expect(duplicate.task).toEqual(task);
    expect(duplicate.lease).toEqual(lease);

    const afterRestart = runtime.recordCheckpoint({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      leaseId: lease.id,
      fencingToken: lease.fencingToken,
      kind: 'progress',
      summary: 'After restart.',
      evidence: [],
      progressPercent: 60,
    });
    expect(afterRestart.id).toBe('rehydrated-checkpoint-1');
    expect(runtime.listTaskCheckpoints('ws-1', task.id)).toHaveLength(2);
  });

  it('restores the durable fencing counter so later recovery grants a strictly higher fence', () => {
    const { snapshot, task, lease, session } = buildSnapshot();
    const released: Lease = {
      ...lease,
      revision: lease.revision + 1,
      updatedAt: '2026-08-29T18:00:20.000Z',
      status: 'released',
    };
    const runtime = rehydrate({
      ...snapshot,
      leases: [released],
      fencingCounters: { [task.id]: 7 },
    });

    const recovered = runtime.claimTask({
      workspaceId: 'ws-1',
      taskId: task.id,
      sessionId: session.id,
      expectedTaskRevision: task.revision,
    });
    expect(recovered.lease.fencingToken).toBe(8);
  });

  it('re-evaluates Session liveness at the new authoritative clock', () => {
    const { snapshot, task, session } = buildSnapshot();
    const runtime = rehydrate(snapshot, '2026-08-29T18:01:00.000Z');

    expect(() =>
      runtime.claimTask({
        workspaceId: 'ws-1',
        taskId: task.id,
        sessionId: session.id,
        expectedTaskRevision: task.revision,
      }),
    ).toThrowError(expect.objectContaining({ code: 'SESSION_NOT_ACTIVE' }));
  });

  it('fails closed when snapshot relationships are inconsistent', () => {
    const { snapshot } = buildSnapshot();
    const invalidTask: Task = { ...snapshot.tasks[0]!, goalId: 'goal-missing' };

    expect(() => rehydrate({ ...snapshot, tasks: [invalidTask] })).toThrowError(
      expect.objectContaining<Partial<RuntimeError>>({ code: 'CONFLICT' }),
    );
  });
});
