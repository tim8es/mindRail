import type {
  Agent,
  AuditEvent,
  Checkpoint,
  Goal,
  Lease,
  PermissionDecision,
  PermissionRequest,
  Session,
  Task,
  Workspace,
} from '@mindrail/contracts';

import type { CommandReceiptInput } from '../../src/persistence/ports.ts';

export const T0 = '2026-08-29T12:00:00.000Z';
export const T1 = '2026-08-29T12:05:00.000Z';
export const T2 = '2026-08-29T12:10:00.000Z';
export const T3 = '2026-08-29T12:15:00.000Z';

export function workspace(id = 'ws-a'): Workspace {
  return {
    id,
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    name: `Workspace ${id}`,
    status: 'active',
  };
}

export function goal(workspaceId = 'ws-a', id = 'goal-a'): Goal {
  return {
    id,
    workspaceId,
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    title: `Goal ${id}`,
    objective: 'Prove durable persistence semantics.',
    successCriteria: ['Persistence state is durable.'],
    status: 'active',
  };
}

export function task(workspaceId = 'ws-a', goalId = 'goal-a', id = 'task-a'): Task {
  return {
    id,
    workspaceId,
    goalId,
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    title: `Task ${id}`,
    objective: 'Execute one durable task.',
    acceptanceCriteria: ['The task can be recovered safely.'],
    requiredCapabilities: ['repo.write'],
    dependencyTaskIds: [],
    status: 'ready',
  };
}

export function agent(workspaceId = 'ws-a', id = 'agent-a'): Agent {
  return {
    id,
    workspaceId,
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    displayName: `Agent ${id}`,
    status: 'active',
    capabilities: ['repo.write'],
  };
}

export function session(workspaceId = 'ws-a', agentId = 'agent-a', id = 'session-a'): Session {
  return {
    id,
    workspaceId,
    agentId,
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    status: 'active',
    lastSeenAt: T0,
  };
}

export function leaseCandidate(
  workspaceId = 'ws-a',
  taskId = 'task-a',
  sessionId = 'session-a',
  id = 'lease-a',
  expiresAt = T2,
): Omit<Lease, 'fencingToken'> {
  return {
    id,
    workspaceId,
    taskId,
    sessionId,
    revision: 1,
    createdAt: T0,
    updatedAt: T0,
    status: 'active',
    expiresAt,
  };
}

export function checkpoint(
  workspaceId = 'ws-a',
  taskId = 'task-a',
  sessionId = 'session-a',
  leaseId = 'lease-a',
  fencingToken = 1,
  id = 'checkpoint-a',
  createdAt = T1,
): Checkpoint {
  return {
    id,
    workspaceId,
    taskId,
    sessionId,
    leaseId,
    fencingToken,
    createdAt,
    kind: 'progress',
    summary: `Checkpoint ${id}`,
    evidence: [],
    progressPercent: 50,
  };
}

export function auditEvent(
  workspaceId = 'ws-a',
  id = 'audit-a',
  createdAt = T1,
  subjectId = 'task-a',
): AuditEvent {
  return {
    id,
    workspaceId,
    createdAt,
    eventType: 'task.claimed',
    actor: { type: 'system', id: 'system-runtime' },
    subject: { type: 'task', id: subjectId },
    correlationId: `corr-${id}`,
  };
}

export function permissionRequest(
  workspaceId = 'ws-a',
  taskId = 'task-a',
  sessionId = 'session-a',
  leaseId = 'lease-a',
  fencingToken = 1,
  id = 'permission-request-a',
): PermissionRequest {
  return {
    id,
    workspaceId,
    taskId,
    sessionId,
    leaseId,
    fencingToken,
    createdAt: T1,
    permission: 'repo.write',
    justification: 'The task requires a repository write.',
  };
}

export function policyDecision(
  workspaceId = 'ws-a',
  requestId = 'permission-request-a',
  id = 'permission-decision-a',
): PermissionDecision {
  return {
    id,
    workspaceId,
    requestId,
    createdAt: T1,
    sequence: 1,
    outcome: 'HUMAN_REQUIRED',
    basis: 'policy',
    decidedBy: { type: 'system', id: 'system-policy' },
    reasonCode: 'policy.human_required',
    policyRef: { id: 'policy-default', version: '1' },
  };
}

export function humanDecision(
  workspaceId = 'ws-a',
  requestId = 'permission-request-a',
  supersedesDecisionId = 'permission-decision-a',
  id = 'permission-decision-b',
): PermissionDecision {
  return {
    id,
    workspaceId,
    requestId,
    createdAt: T2,
    sequence: 2,
    outcome: 'ALLOW',
    basis: 'human',
    decidedBy: { type: 'human', id: 'human-reviewer' },
    reasonCode: 'human.approved',
    supersedesDecisionId,
  };
}

export function receipt(
  commandId: string,
  semanticFingerprint: string,
  responseSnapshot: unknown,
  workspaceId = 'ws-a',
  command = 'TestCommand',
): CommandReceiptInput {
  return {
    workspaceId,
    commandId,
    command,
    semanticFingerprint,
    outcomeKind: 'result',
    responseSnapshot,
    createdAt: T1,
  };
}
