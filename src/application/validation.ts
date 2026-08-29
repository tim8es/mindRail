import type { ActorRef } from '@mindrail/contracts';

import { isProtocolEntityId, validateProtocolCommand } from '../runtime/protocol-validation.ts';
import type {
  ApplicationCommand,
  ApplicationCommandName,
  ApplicationQuery,
  ApplicationQueryName,
} from './protocol.ts';

interface Shape {
  required: readonly string[];
  optional?: readonly string[];
}

const COMMAND_COMMON = [
  'protocolVersion',
  'command',
  'commandId',
  'workspaceId',
  'actor',
  'correlationId',
  'causationId',
] as const;

const QUERY_COMMON = ['protocolVersion', 'query', 'workspaceId', 'actor', 'correlationId'] as const;

export const COMMAND_SHAPES: Readonly<Record<ApplicationCommandName, Shape>> = {
  RegisterAgent: { required: ['displayName', 'capabilities'] },
  StartSession: { required: ['agentId'] },
  HeartbeatSession: { required: ['sessionId', 'expectedSessionRevision'] },
  EndSession: { required: ['sessionId', 'expectedSessionRevision'] },
  CreateGoal: { required: ['title', 'objective', 'successCriteria'] },
  CreateTask: {
    required: [
      'goalId',
      'title',
      'objective',
      'acceptanceCriteria',
      'requiredCapabilities',
      'dependencyTaskIds',
    ],
  },
  ClaimTask: { required: ['taskId', 'sessionId', 'expectedTaskRevision'] },
  RenewLease: {
    required: ['taskId', 'sessionId', 'leaseId', 'fencingToken', 'expectedLeaseRevision'],
  },
  ReleaseLease: {
    required: ['taskId', 'sessionId', 'leaseId', 'fencingToken', 'expectedLeaseRevision'],
  },
  RecordCheckpoint: {
    required: ['taskId', 'sessionId', 'leaseId', 'fencingToken', 'kind', 'summary', 'evidence'],
    optional: ['progressPercent'],
  },
  CompleteTask: {
    required: [
      'taskId',
      'sessionId',
      'leaseId',
      'fencingToken',
      'expectedTaskRevision',
      'summary',
      'evidence',
    ],
  },
  FailTask: {
    required: [
      'taskId',
      'sessionId',
      'leaseId',
      'fencingToken',
      'expectedTaskRevision',
      'reason',
      'summary',
      'evidence',
    ],
  },
  BlockTask: {
    required: [
      'taskId',
      'sessionId',
      'leaseId',
      'fencingToken',
      'expectedTaskRevision',
      'reason',
      'summary',
      'evidence',
    ],
  },
  ResumeTask: { required: ['taskId', 'expectedTaskRevision'] },
  RetryTask: { required: ['taskId', 'expectedTaskRevision'] },
  CancelTask: { required: ['taskId', 'expectedTaskRevision', 'reason'] },
  CancelGoal: { required: ['goalId', 'expectedGoalRevision', 'reason'] },
  RequestPermission: {
    required: ['taskId', 'sessionId', 'leaseId', 'fencingToken', 'permission', 'justification'],
    optional: ['resource'],
  },
  RecordPermissionDecision: {
    required: ['requestId', 'outcome', 'expectedPreviousDecisionId', 'reasonCode'],
    optional: ['reason'],
  },
};

export const QUERY_SHAPES: Readonly<Record<ApplicationQueryName, Shape>> = {
  GetWorkspace: { required: [] },
  GetGoal: { required: ['goalId'] },
  ListGoals: { required: ['limit'], optional: ['cursor'] },
  GetTask: { required: ['taskId'] },
  ListGoalTasks: { required: ['goalId', 'limit'], optional: ['cursor'] },
  ListClaimableTasks: { required: ['sessionId', 'limit'], optional: ['cursor'] },
  GetTaskExecutionView: { required: ['taskId'] },
  ListTaskCheckpoints: { required: ['taskId', 'limit'], optional: ['cursor'] },
  GetAgent: { required: ['agentId'] },
  GetSession: { required: ['sessionId'] },
  GetLease: { required: ['leaseId'] },
  GetPermissionRequest: { required: ['requestId'] },
  ListPendingHumanPermissions: { required: ['limit'], optional: ['cursor'] },
  ListPermissionDecisions: { required: ['requestId', 'limit'], optional: ['cursor'] },
};

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export function parseApplicationCommand(
  commandName: ApplicationCommandName,
  input: unknown,
): ValidationResult<ApplicationCommand> {
  if (!isRecord(input)) return invalid('command body must be an object');
  const record = { ...input };
  if (record.command !== undefined && record.command !== commandName) {
    return invalid('route command and body command must agree');
  }
  record.command = commandName;

  const commonError = validateEnvelope(record, 'command');
  if (commonError !== undefined) return invalid(commonError);
  const shapeError = validateClosedShape(record, COMMAND_COMMON, COMMAND_SHAPES[commandName]);
  if (shapeError !== undefined) return invalid(shapeError);

  if (isRuntimeProtocolCommand(commandName)) {
    const validation = validateProtocolCommand(record);
    if (!validation.valid) return invalid(validation.errors?.[0] ?? 'command is invalid');
    return { ok: true, value: record as unknown as ApplicationCommand };
  }

  const fieldError = validateParallelCommand(commandName, record);
  if (fieldError !== undefined) return invalid(fieldError);
  return { ok: true, value: record as unknown as ApplicationCommand };
}

export function parseApplicationQuery(
  queryName: ApplicationQueryName,
  input: unknown,
): ValidationResult<ApplicationQuery> {
  if (!isRecord(input)) return invalid('query body must be an object');
  const record = { ...input };
  if (record.query !== undefined && record.query !== queryName) {
    return invalid('route query and body query must agree');
  }
  record.query = queryName;

  const commonError = validateEnvelope(record, 'query');
  if (commonError !== undefined) return invalid(commonError);
  const shapeError = validateClosedShape(record, QUERY_COMMON, QUERY_SHAPES[queryName]);
  if (shapeError !== undefined) return invalid(shapeError);

  for (const key of entityFieldsForQuery(queryName)) {
    if (!isProtocolEntityId(record[key])) return invalid(`${key} must be an EntityId`);
  }
  if (isListQuery(queryName)) {
    if (!isBoundedLimit(record.limit)) return invalid('limit must be an integer from 1 to 100');
    if (record.cursor !== undefined && !isOpaqueCursor(record.cursor)) {
      return invalid('cursor must be a bounded opaque string');
    }
  }

  return { ok: true, value: record as unknown as ApplicationQuery };
}

function validateEnvelope(
  record: Record<string, unknown>,
  kind: 'command' | 'query',
): string | undefined {
  if (record.protocolVersion !== '0.1') return 'protocolVersion must equal 0.1';
  if (!isProtocolEntityId(record.workspaceId)) return 'workspaceId must be an EntityId';
  if (!isActorRef(record.actor)) return 'actor must be a valid ActorRef';
  if (record.correlationId !== undefined && !isProtocolEntityId(record.correlationId)) {
    return 'correlationId must be an EntityId when present';
  }
  if (kind === 'command') {
    if (!isProtocolEntityId(record.commandId)) return 'commandId must be an EntityId';
    if (record.causationId !== undefined && !isProtocolEntityId(record.causationId)) {
      return 'causationId must be an EntityId when present';
    }
  }
  return undefined;
}

function validateClosedShape(
  record: Record<string, unknown>,
  common: readonly string[],
  shape: Shape,
): string | undefined {
  const allowed = new Set([...common, ...shape.required, ...(shape.optional ?? [])]);
  const unexpected = Object.keys(record).find((key) => !allowed.has(key));
  if (unexpected !== undefined) return `unexpected field: ${unexpected}`;
  const missing = shape.required.find((key) => record[key] === undefined);
  return missing === undefined ? undefined : `missing required field: ${missing}`;
}

function validateParallelCommand(
  commandName: Exclude<ApplicationCommandName, ReturnType<typeof runtimeCommandName>>,
  record: Record<string, unknown>,
): string | undefined {
  switch (commandName) {
    case 'RegisterAgent':
      if (!isBoundedString(record.displayName, 1, 200))
        return 'displayName must be a bounded string';
      if (!isStringArray(record.capabilities)) return 'capabilities must be an array of strings';
      return undefined;
    case 'StartSession':
      return requireEntityFields(record, ['agentId']);
    case 'HeartbeatSession':
    case 'EndSession': {
      const entityError = requireEntityFields(record, ['sessionId']);
      if (entityError !== undefined) return entityError;
      return isPositiveInteger(record.expectedSessionRevision)
        ? undefined
        : 'expectedSessionRevision must be an integer >= 1';
    }
    case 'RenewLease':
    case 'ReleaseLease': {
      const entityError = requireEntityFields(record, ['taskId', 'sessionId', 'leaseId']);
      if (entityError !== undefined) return entityError;
      if (!isPositiveInteger(record.fencingToken)) return 'fencingToken must be an integer >= 1';
      return isPositiveInteger(record.expectedLeaseRevision)
        ? undefined
        : 'expectedLeaseRevision must be an integer >= 1';
    }
    case 'BlockTask': {
      const entityError = requireEntityFields(record, ['taskId', 'sessionId', 'leaseId']);
      if (entityError !== undefined) return entityError;
      if (!isPositiveInteger(record.fencingToken)) return 'fencingToken must be an integer >= 1';
      if (!isPositiveInteger(record.expectedTaskRevision)) {
        return 'expectedTaskRevision must be an integer >= 1';
      }
      if (!isReason(record.reason)) return 'reason must be a bounded Reason';
      if (!isBoundedString(record.summary, 1, 4000)) return 'summary must be a bounded string';
      if (!Array.isArray(record.evidence)) return 'evidence must be an array';
      return undefined;
    }
    case 'ResumeTask': {
      const entityError = requireEntityFields(record, ['taskId']);
      if (entityError !== undefined) return entityError;
      return isPositiveInteger(record.expectedTaskRevision)
        ? undefined
        : 'expectedTaskRevision must be an integer >= 1';
    }
    case 'RequestPermission': {
      const entityError = requireEntityFields(record, ['taskId', 'sessionId', 'leaseId']);
      if (entityError !== undefined) return entityError;
      if (!isPositiveInteger(record.fencingToken)) return 'fencingToken must be an integer >= 1';
      if (!isBoundedString(record.permission, 1, 128)) return 'permission must be a bounded string';
      if (!isBoundedString(record.justification, 1, 4000)) {
        return 'justification must be a bounded string';
      }
      if (record.resource !== undefined && !isResourceRef(record.resource)) {
        return 'resource must be a ResourceRef when present';
      }
      return undefined;
    }
    case 'RecordPermissionDecision': {
      const entityError = requireEntityFields(record, ['requestId', 'expectedPreviousDecisionId']);
      if (entityError !== undefined) return entityError;
      if (record.outcome !== 'ALLOW' && record.outcome !== 'DENY') {
        return 'outcome must be ALLOW or DENY';
      }
      if (!isBoundedString(record.reasonCode, 1, 128)) return 'reasonCode must be a bounded string';
      if (record.reason !== undefined && !isBoundedString(record.reason, 1, 1000)) {
        return 'reason must be a bounded string when present';
      }
      return undefined;
    }
  }
}

function runtimeCommandName() {
  return '' as
    | 'CreateGoal'
    | 'CreateTask'
    | 'ClaimTask'
    | 'RecordCheckpoint'
    | 'CompleteTask'
    | 'FailTask'
    | 'RetryTask'
    | 'CancelTask'
    | 'CancelGoal';
}

function isRuntimeProtocolCommand(
  name: ApplicationCommandName,
): name is ReturnType<typeof runtimeCommandName> {
  return [
    'CreateGoal',
    'CreateTask',
    'ClaimTask',
    'RecordCheckpoint',
    'CompleteTask',
    'FailTask',
    'RetryTask',
    'CancelTask',
    'CancelGoal',
  ].includes(name);
}

function entityFieldsForQuery(queryName: ApplicationQueryName): readonly string[] {
  switch (queryName) {
    case 'GetGoal':
    case 'ListGoalTasks':
      return ['goalId'];
    case 'GetTask':
    case 'GetTaskExecutionView':
    case 'ListTaskCheckpoints':
      return ['taskId'];
    case 'ListClaimableTasks':
    case 'GetSession':
      return ['sessionId'];
    case 'GetAgent':
      return ['agentId'];
    case 'GetLease':
      return ['leaseId'];
    case 'GetPermissionRequest':
    case 'ListPermissionDecisions':
      return ['requestId'];
    case 'GetWorkspace':
    case 'ListGoals':
    case 'ListPendingHumanPermissions':
      return [];
  }
}

function isListQuery(queryName: ApplicationQueryName): boolean {
  return queryName.startsWith('List');
}

function requireEntityFields(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | undefined {
  const invalidField = fields.find((field) => !isProtocolEntityId(record[field]));
  return invalidField === undefined ? undefined : `${invalidField} must be an EntityId`;
}

function isActorRef(value: unknown): value is ActorRef {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== 'type' && key !== 'id')) return false;
  return (
    (value.type === 'system' || value.type === 'human' || value.type === 'agent') &&
    isProtocolEntityId(value.id)
  );
}

function isReason(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== 'code' && key !== 'summary')) return false;
  return isBoundedString(value.code, 1, 128) && isBoundedString(value.summary, 1, 1000);
}

function isResourceRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((key) => key !== 'type' && key !== 'id')) return false;
  return isBoundedString(value.type, 1, 128) && isProtocolEntityId(value.id);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isBoundedLimit(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 100;
}

function isOpaqueCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 512;
}

function isBoundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => isBoundedString(entry, 1, 128));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid<T>(message: string): ValidationResult<T> {
  return { ok: false, message };
}
