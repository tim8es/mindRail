import type { ActorRef, EvidenceRef, Reason, ResourceRef } from '@mindrail/contracts';

import type { ProtocolCommand } from '../runtime/protocol.ts';

export const APPLICATION_COMMAND_NAMES = [
  'RegisterAgent',
  'StartSession',
  'HeartbeatSession',
  'EndSession',
  'CreateGoal',
  'CreateTask',
  'ClaimTask',
  'RenewLease',
  'ReleaseLease',
  'RecordCheckpoint',
  'CompleteTask',
  'FailTask',
  'BlockTask',
  'ResumeTask',
  'RetryTask',
  'CancelTask',
  'CancelGoal',
  'RequestPermission',
  'RecordPermissionDecision',
] as const;

export const APPLICATION_QUERY_NAMES = [
  'GetWorkspace',
  'GetGoal',
  'ListGoals',
  'GetTask',
  'ListGoalTasks',
  'ListClaimableTasks',
  'GetTaskExecutionView',
  'ListTaskCheckpoints',
  'GetAgent',
  'GetSession',
  'GetLease',
  'GetPermissionRequest',
  'ListPendingHumanPermissions',
  'ListPermissionDecisions',
] as const;

export type ApplicationCommandName = (typeof APPLICATION_COMMAND_NAMES)[number];
export type ApplicationQueryName = (typeof APPLICATION_QUERY_NAMES)[number];

export type ApplicationErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REVISION_MISMATCH'
  | 'LEASE_NOT_ACTIVE'
  | 'LEASE_EXPIRED'
  | 'STALE_FENCING_TOKEN'
  | 'INVALID_STATE_TRANSITION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'SESSION_NOT_ACTIVE'
  | 'CAPABILITY_MISMATCH'
  | 'DEPENDENCY_UNSATISFIED'
  | 'ACTOR_NOT_AUTHORIZED'
  | 'PERMISSION_DENIED'
  | 'HUMAN_DECISION_REQUIRED'
  | 'POLICY_UNAVAILABLE'
  | 'UNSUPPORTED_OPERATION'
  | 'INTERNAL_ERROR';

interface CommandEnvelope {
  protocolVersion: '0.1';
  commandId: string;
  workspaceId: string;
  actor: ActorRef;
  correlationId?: string;
  causationId?: string;
}

export interface RegisterAgentCommand extends CommandEnvelope {
  command: 'RegisterAgent';
  displayName: string;
  capabilities: string[];
}

export interface StartSessionCommand extends CommandEnvelope {
  command: 'StartSession';
  agentId: string;
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

export interface BlockTaskCommand extends CommandEnvelope {
  command: 'BlockTask';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedTaskRevision: number;
  reason: Reason;
  summary: string;
  evidence: EvidenceRef[];
}

export interface ResumeTaskCommand extends CommandEnvelope {
  command: 'ResumeTask';
  taskId: string;
  expectedTaskRevision: number;
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

export type ParallelCommand =
  | RegisterAgentCommand
  | StartSessionCommand
  | HeartbeatSessionCommand
  | EndSessionCommand
  | RenewLeaseCommand
  | ReleaseLeaseCommand
  | BlockTaskCommand
  | ResumeTaskCommand
  | RequestPermissionCommand
  | RecordPermissionDecisionCommand;

export type ApplicationCommand = ProtocolCommand | ParallelCommand;

interface QueryEnvelope {
  protocolVersion: '0.1';
  workspaceId: string;
  actor: ActorRef;
  correlationId?: string;
}

export interface GetWorkspaceQuery extends QueryEnvelope {
  query: 'GetWorkspace';
}

export interface GetGoalQuery extends QueryEnvelope {
  query: 'GetGoal';
  goalId: string;
}

export interface ListGoalsQuery extends QueryEnvelope {
  query: 'ListGoals';
  limit: number;
  cursor?: string;
}

export interface GetTaskQuery extends QueryEnvelope {
  query: 'GetTask';
  taskId: string;
}

export interface ListGoalTasksQuery extends QueryEnvelope {
  query: 'ListGoalTasks';
  goalId: string;
  limit: number;
  cursor?: string;
}

export interface ListClaimableTasksQuery extends QueryEnvelope {
  query: 'ListClaimableTasks';
  sessionId: string;
  limit: number;
  cursor?: string;
}

export interface GetTaskExecutionViewQuery extends QueryEnvelope {
  query: 'GetTaskExecutionView';
  taskId: string;
}

export interface ListTaskCheckpointsQuery extends QueryEnvelope {
  query: 'ListTaskCheckpoints';
  taskId: string;
  limit: number;
  cursor?: string;
}

export interface GetAgentQuery extends QueryEnvelope {
  query: 'GetAgent';
  agentId: string;
}

export interface GetSessionQuery extends QueryEnvelope {
  query: 'GetSession';
  sessionId: string;
}

export interface GetLeaseQuery extends QueryEnvelope {
  query: 'GetLease';
  leaseId: string;
}

export interface GetPermissionRequestQuery extends QueryEnvelope {
  query: 'GetPermissionRequest';
  requestId: string;
}

export interface ListPendingHumanPermissionsQuery extends QueryEnvelope {
  query: 'ListPendingHumanPermissions';
  limit: number;
  cursor?: string;
}

export interface ListPermissionDecisionsQuery extends QueryEnvelope {
  query: 'ListPermissionDecisions';
  requestId: string;
  limit: number;
  cursor?: string;
}

export type ApplicationQuery =
  | GetWorkspaceQuery
  | GetGoalQuery
  | ListGoalsQuery
  | GetTaskQuery
  | ListGoalTasksQuery
  | ListClaimableTasksQuery
  | GetTaskExecutionViewQuery
  | ListTaskCheckpointsQuery
  | GetAgentQuery
  | GetSessionQuery
  | GetLeaseQuery
  | GetPermissionRequestQuery
  | ListPendingHumanPermissionsQuery
  | ListPermissionDecisionsQuery;

export interface ApplicationError {
  code: ApplicationErrorCode;
  message: string;
  retryable: boolean;
}

export interface CommandSuccess<T = unknown> {
  protocolVersion: '0.1';
  commandId: string;
  correlationId?: string;
  replayed: boolean;
  result: T;
}

export interface CommandFailure {
  protocolVersion: '0.1';
  commandId?: string;
  correlationId?: string;
  replayed: boolean;
  error: ApplicationError;
}

export type CommandResponse<T = unknown> = CommandSuccess<T> | CommandFailure;

export interface QuerySuccess<T = unknown> {
  protocolVersion: '0.1';
  correlationId?: string;
  result: T;
}

export interface QueryFailure {
  protocolVersion: '0.1';
  correlationId?: string;
  error: ApplicationError;
}

export type QueryResponse<T = unknown> = QuerySuccess<T> | QueryFailure;

export function isApplicationCommandName(value: string): value is ApplicationCommandName {
  return (APPLICATION_COMMAND_NAMES as readonly string[]).includes(value);
}

export function isApplicationQueryName(value: string): value is ApplicationQueryName {
  return (APPLICATION_QUERY_NAMES as readonly string[]).includes(value);
}
