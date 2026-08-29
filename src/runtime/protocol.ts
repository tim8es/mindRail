import type { ActorRef, EvidenceRef, Reason, ResourceRef } from '@mindrail/contracts';

import type { RuntimeErrorCode } from './errors.ts';

interface CommandEnvelope {
  protocolVersion: '0.1';
  commandId: string;
  workspaceId: string;
  actor: ActorRef;
  correlationId?: string;
  causationId?: string;
}

export interface HeartbeatSessionCommand extends CommandEnvelope {
  command: 'HeartbeatSession';
  sessionId: string;
  expectedSessionRevision: number;
}

export interface EndSessionCommand extends CommandEnvelope {
  command: 'EndSession';
  sessionId: string;
  expectedSessionRevision: number;
}

export interface CreateGoalCommand extends CommandEnvelope {
  command: 'CreateGoal';
  title: string;
  objective: string;
  successCriteria: [string, ...string[]] | string[];
}

export interface CreateTaskCommand extends CommandEnvelope {
  command: 'CreateTask';
  goalId: string;
  title: string;
  objective: string;
  acceptanceCriteria: [string, ...string[]] | string[];
  requiredCapabilities: string[];
  dependencyTaskIds: string[];
}

export interface ClaimTaskCommand extends CommandEnvelope {
  command: 'ClaimTask';
  taskId: string;
  sessionId: string;
  expectedTaskRevision: number;
}

export interface RenewLeaseCommand extends CommandEnvelope {
  command: 'RenewLease';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedLeaseRevision: number;
}

export interface ReleaseLeaseCommand extends CommandEnvelope {
  command: 'ReleaseLease';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedLeaseRevision: number;
}

export interface RecordCheckpointCommand extends CommandEnvelope {
  command: 'RecordCheckpoint';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  kind: 'progress' | 'handoff';
  summary: string;
  evidence: EvidenceRef[];
  progressPercent?: number;
}

export interface CompleteTaskCommand extends CommandEnvelope {
  command: 'CompleteTask';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedTaskRevision: number;
  summary: string;
  evidence: EvidenceRef[];
}

export interface FailTaskCommand extends CommandEnvelope {
  command: 'FailTask';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedTaskRevision: number;
  reason: Reason;
  summary: string;
  evidence: EvidenceRef[];
}

export interface RequestPermissionCommand extends CommandEnvelope {
  command: 'RequestPermission';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  permission: string;
  justification: string;
  resource?: ResourceRef;
}

export interface RecordPermissionDecisionCommand extends CommandEnvelope {
  command: 'RecordPermissionDecision';
  requestId: string;
  outcome: 'ALLOW' | 'DENY';
  expectedPreviousDecisionId: string;
  reasonCode: string;
  reason?: string;
}

export interface BlockTaskCommand extends CommandEnvelope {
  command: 'BlockTask';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedTaskRevision: number;
  reason: Reason;
  evidence: EvidenceRef[];
}

export interface ResumeTaskCommand extends CommandEnvelope {
  command: 'ResumeTask';
  taskId: string;
  expectedTaskRevision: number;
}

export interface RetryTaskCommand extends CommandEnvelope {
  command: 'RetryTask';
  taskId: string;
  expectedTaskRevision: number;
}

export interface CancelTaskCommand extends CommandEnvelope {
  command: 'CancelTask';
  taskId: string;
  expectedTaskRevision: number;
  reason: Reason;
}

export interface CancelGoalCommand extends CommandEnvelope {
  command: 'CancelGoal';
  goalId: string;
  expectedGoalRevision: number;
  reason: Reason;
}

export type ProtocolCommand =
  | HeartbeatSessionCommand
  | EndSessionCommand
  | CreateGoalCommand
  | CreateTaskCommand
  | ClaimTaskCommand
  | RenewLeaseCommand
  | ReleaseLeaseCommand
  | RecordCheckpointCommand
  | CompleteTaskCommand
  | FailTaskCommand
  | RequestPermissionCommand
  | RecordPermissionDecisionCommand
  | BlockTaskCommand
  | ResumeTaskCommand
  | RetryTaskCommand
  | CancelTaskCommand
  | CancelGoalCommand;

export interface ProtocolSuccess<T = unknown> {
  protocolVersion: '0.1';
  commandId: string;
  correlationId?: string;
  replayed: boolean;
  result: T;
}

export interface ProtocolFailure {
  protocolVersion: '0.1';
  commandId?: string;
  correlationId?: string;
  replayed: boolean;
  error: {
    code: RuntimeErrorCode;
    message: string;
    retryable: boolean;
  };
}

export type ProtocolResponse<T = unknown> = ProtocolSuccess<T> | ProtocolFailure;

export function semanticFingerprint(command: ProtocolCommand): string {
  const semantic = Object.fromEntries(
    Object.entries(command).filter(([key]) => key !== 'correlationId' && key !== 'causationId'),
  );
  return JSON.stringify(sortRecursively(semantic));
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecursively);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortRecursively(nested)]),
    );
  }
  return value;
}
