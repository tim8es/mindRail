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

import type { CanonicalDomainTarget, CanonicalDomainValidator } from './domain-validation.ts';
import { RuntimeError } from './errors.ts';

export interface RuntimeStateSnapshot {
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

export interface PreparedRuntimeState {
  snapshot: RuntimeStateSnapshot;
  effectiveLeaseByTask: Map<string, string>;
}

export function prepareRuntimeStateSnapshot(input: {
  snapshot: RuntimeStateSnapshot;
  validateCanonicalDomainRecord: CanonicalDomainValidator;
  nowMs: number;
  sessionTimeoutMs: number;
}): PreparedRuntimeState {
  const snapshot = clone(input.snapshot);
  assertCanonical(input.validateCanonicalDomainRecord, 'Workspace', snapshot.workspace);

  const agents = indexRecords(snapshot.agents, 'Agent', snapshot.workspace.id, input.validateCanonicalDomainRecord);
  const sessions = indexRecords(
    snapshot.sessions,
    'Session',
    snapshot.workspace.id,
    input.validateCanonicalDomainRecord,
  );
  const goals = indexRecords(snapshot.goals, 'Goal', snapshot.workspace.id, input.validateCanonicalDomainRecord);
  const tasks = indexRecords(snapshot.tasks, 'Task', snapshot.workspace.id, input.validateCanonicalDomainRecord);
  const leases = indexRecords(snapshot.leases, 'Lease', snapshot.workspace.id, input.validateCanonicalDomainRecord);
  indexRecords(
    snapshot.checkpoints,
    'Checkpoint',
    snapshot.workspace.id,
    input.validateCanonicalDomainRecord,
  );
  const requests = indexRecords(
    snapshot.permissionRequests,
    'PermissionRequest',
    snapshot.workspace.id,
    input.validateCanonicalDomainRecord,
  );
  indexRecords(
    snapshot.permissionDecisions,
    'PermissionDecision',
    snapshot.workspace.id,
    input.validateCanonicalDomainRecord,
  );

  for (const session of snapshot.sessions) {
    if (!agents.has(session.agentId)) {
      conflict(`Session ${session.id} references missing Agent ${session.agentId}.`);
    }
  }

  for (const task of snapshot.tasks) {
    const goal = goals.get(task.goalId);
    if (!goal) conflict(`Task ${task.id} references missing Goal ${task.goalId}.`);
    for (const dependencyId of task.dependencyTaskIds) {
      const dependency = tasks.get(dependencyId);
      if (!dependency || dependency.goalId !== task.goalId) {
        conflict(`Task ${task.id} has an invalid dependency ${dependencyId}.`);
      }
    }
  }

  const maximumFenceByTask = new Map<string, number>();
  for (const lease of snapshot.leases) {
    if (!tasks.has(lease.taskId)) {
      conflict(`Lease ${lease.id} references missing Task ${lease.taskId}.`);
    }
    if (!sessions.has(lease.sessionId)) {
      conflict(`Lease ${lease.id} references missing Session ${lease.sessionId}.`);
    }
    maximumFenceByTask.set(
      lease.taskId,
      Math.max(maximumFenceByTask.get(lease.taskId) ?? 0, lease.fencingToken),
    );
  }

  for (const checkpoint of snapshot.checkpoints) {
    const lease = leases.get(checkpoint.leaseId);
    if (
      !tasks.has(checkpoint.taskId) ||
      !sessions.has(checkpoint.sessionId) ||
      !lease ||
      lease.taskId !== checkpoint.taskId ||
      lease.sessionId !== checkpoint.sessionId ||
      lease.fencingToken !== checkpoint.fencingToken
    ) {
      conflict(`Checkpoint ${checkpoint.id} has inconsistent execution references.`);
    }
  }

  for (const request of snapshot.permissionRequests) {
    const lease = leases.get(request.leaseId);
    if (
      !tasks.has(request.taskId) ||
      !sessions.has(request.sessionId) ||
      !lease ||
      lease.taskId !== request.taskId ||
      lease.sessionId !== request.sessionId ||
      lease.fencingToken !== request.fencingToken
    ) {
      conflict(`PermissionRequest ${request.id} has inconsistent execution references.`);
    }
  }
  for (const decision of snapshot.permissionDecisions) {
    if (!requests.has(decision.requestId)) {
      conflict(`PermissionDecision ${decision.id} references missing request ${decision.requestId}.`);
    }
  }

  const counterKeys = new Set(Object.keys(snapshot.fencingCounters));
  for (const task of snapshot.tasks) {
    const counter = snapshot.fencingCounters[task.id];
    if (!Number.isSafeInteger(counter) || counter === undefined || counter < 0) {
      conflict(`Task ${task.id} has no valid durable fencing counter.`);
    }
    if (counter < (maximumFenceByTask.get(task.id) ?? 0)) {
      conflict(`Task ${task.id} fencing counter is behind persisted Lease history.`);
    }
    counterKeys.delete(task.id);
  }
  if (counterKeys.size > 0) {
    conflict(`Fencing counters reference unknown Tasks: ${[...counterKeys].join(', ')}.`);
  }

  const effectiveLeaseByTask = new Map<string, string>();
  for (const lease of snapshot.leases) {
    if (lease.status !== 'active' || Date.parse(lease.expiresAt) <= input.nowMs) continue;
    const session = sessions.get(lease.sessionId)!;
    const sessionEffective =
      session.status === 'active' &&
      Date.parse(session.lastSeenAt) + input.sessionTimeoutMs > input.nowMs;
    if (!sessionEffective) continue;
    if (effectiveLeaseByTask.has(lease.taskId)) {
      conflict(`Task ${lease.taskId} has more than one effective Lease.`);
    }
    effectiveLeaseByTask.set(lease.taskId, lease.id);
  }

  return { snapshot, effectiveLeaseByTask };
}

function indexRecords<T extends { id: string; workspaceId: string }>(
  records: T[],
  target: CanonicalDomainTarget,
  workspaceId: string,
  validator: CanonicalDomainValidator,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    assertCanonical(validator, target, record);
    if (record.workspaceId !== workspaceId) {
      conflict(`${target} ${record.id} belongs to a different Workspace.`);
    }
    if (result.has(record.id)) {
      conflict(`${target} ${record.id} appears more than once in the snapshot.`);
    }
    result.set(record.id, record);
  }
  return result;
}

function assertCanonical(
  validator: CanonicalDomainValidator,
  target: CanonicalDomainTarget,
  value: unknown,
): void {
  const validation = validator(target, value);
  if (validation.valid) return;
  const details = validation.errors?.slice(0, 3).join('; ');
  throw new RuntimeError(
    'INVALID_INPUT',
    details ? `${target} violates canonical domain schema. ${details}` : `${target} violates canonical domain schema.`,
  );
}

function conflict(message: string): never {
  throw new RuntimeError('CONFLICT', message);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
