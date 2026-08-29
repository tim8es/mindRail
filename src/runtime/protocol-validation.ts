import type { ProtocolCommand } from './protocol.ts';

export interface ProtocolValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly string[];
}

const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAMESPACED_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const COMMANDS = new Set([
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
  'RequestPermission',
  'RecordPermissionDecision',
  'BlockTask',
  'ResumeTask',
  'RetryTask',
  'CancelTask',
  'CancelGoal',
]);
const ACTOR_TYPES = new Set(['system', 'human', 'agent']);

export function isProtocolEntityId(value: unknown): value is string {
  return typeof value === 'string' && ENTITY_ID_PATTERN.test(value);
}

export function validateProtocolCommand(command: unknown): ProtocolValidationResult {
  const errors: string[] = [];
  if (!isRecord(command)) {
    return { valid: false, errors: ['command must be an object'] };
  }

  if (command.protocolVersion !== '0.1') errors.push('protocolVersion must equal 0.1');
  if (typeof command.command !== 'string' || !COMMANDS.has(command.command)) {
    errors.push('command discriminator is unsupported');
  }
  requireEntityId(command, 'commandId', errors);
  requireEntityId(command, 'workspaceId', errors);
  optionalEntityId(command, 'correlationId', errors);
  optionalEntityId(command, 'causationId', errors);
  validateActor(command.actor, errors);

  if (typeof command.command === 'string' && COMMANDS.has(command.command)) {
    validateCommandFields(command.command, command, errors);
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

function validateCommandFields(
  discriminator: string,
  command: Record<string, unknown>,
  errors: string[],
): void {
  switch (discriminator as ProtocolCommand['command']) {
    case 'HeartbeatSession':
    case 'EndSession':
      requireEntityId(command, 'sessionId', errors);
      requirePositiveInteger(command, 'expectedSessionRevision', errors);
      return;
    case 'CreateGoal':
      requireString(command, 'title', errors);
      requireString(command, 'objective', errors);
      requireStringArray(command, 'successCriteria', errors);
      return;
    case 'CreateTask':
      requireEntityId(command, 'goalId', errors);
      requireString(command, 'title', errors);
      requireString(command, 'objective', errors);
      requireStringArray(command, 'acceptanceCriteria', errors);
      requireStringArray(command, 'requiredCapabilities', errors);
      requireEntityIdArray(command, 'dependencyTaskIds', errors);
      return;
    case 'ClaimTask':
      requireEntityId(command, 'taskId', errors);
      requireEntityId(command, 'sessionId', errors);
      requirePositiveInteger(command, 'expectedTaskRevision', errors);
      return;
    case 'RenewLease':
    case 'ReleaseLease':
      validateExecutorFields(command, errors);
      requirePositiveInteger(command, 'expectedLeaseRevision', errors);
      return;
    case 'RecordCheckpoint':
      validateExecutorFields(command, errors);
      if (command.kind !== 'progress' && command.kind !== 'handoff') {
        errors.push('kind must be progress or handoff');
      }
      requireString(command, 'summary', errors);
      requireEvidenceArray(command, 'evidence', errors);
      optionalPercent(command, 'progressPercent', errors);
      return;
    case 'CompleteTask':
      validateExecutorFields(command, errors);
      requirePositiveInteger(command, 'expectedTaskRevision', errors);
      requireString(command, 'summary', errors);
      requireEvidenceArray(command, 'evidence', errors);
      return;
    case 'FailTask':
      validateExecutorFields(command, errors);
      requirePositiveInteger(command, 'expectedTaskRevision', errors);
      requireReason(command, 'reason', errors);
      requireString(command, 'summary', errors);
      requireEvidenceArray(command, 'evidence', errors);
      return;
    case 'BlockTask':
      validateExecutorFields(command, errors);
      requirePositiveInteger(command, 'expectedTaskRevision', errors);
      requireReason(command, 'reason', errors);
      requireEvidenceArray(command, 'evidence', errors);
      return;
    case 'RequestPermission':
      validateExecutorFields(command, errors);
      requireNamespacedName(command, 'permission', errors);
      requireBoundedString(command, 'justification', 1, 2000, errors);
      optionalResource(command, 'resource', errors);
      return;
    case 'RecordPermissionDecision':
      requireEntityId(command, 'requestId', errors);
      if (command.outcome !== 'ALLOW' && command.outcome !== 'DENY') {
        errors.push('outcome must be ALLOW or DENY');
      }
      requireEntityId(command, 'expectedPreviousDecisionId', errors);
      requireNamespacedName(command, 'reasonCode', errors);
      optionalBoundedString(command, 'reason', 1, 1000, errors);
      return;
    case 'ResumeTask':
    case 'RetryTask':
      requireEntityId(command, 'taskId', errors);
      requirePositiveInteger(command, 'expectedTaskRevision', errors);
      return;
    case 'CancelTask':
      requireEntityId(command, 'taskId', errors);
      requirePositiveInteger(command, 'expectedTaskRevision', errors);
      requireReason(command, 'reason', errors);
      return;
    case 'CancelGoal':
      requireEntityId(command, 'goalId', errors);
      requirePositiveInteger(command, 'expectedGoalRevision', errors);
      requireReason(command, 'reason', errors);
      return;
  }
}

function validateExecutorFields(command: Record<string, unknown>, errors: string[]): void {
  requireEntityId(command, 'taskId', errors);
  requireEntityId(command, 'sessionId', errors);
  requireEntityId(command, 'leaseId', errors);
  requirePositiveInteger(command, 'fencingToken', errors);
}

function validateActor(value: unknown, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push('actor must be an object');
    return;
  }
  if (typeof value.type !== 'string' || !ACTOR_TYPES.has(value.type)) {
    errors.push('actor.type is invalid');
  }
  if (!isProtocolEntityId(value.id)) errors.push('actor.id must be an EntityId');
}

function requireEntityId(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (!isProtocolEntityId(record[key])) errors.push(`${key} must be an EntityId`);
}

function optionalEntityId(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (record[key] !== undefined && !isProtocolEntityId(record[key])) {
    errors.push(`${key} must be an EntityId when present`);
  }
}

function requireEntityIdArray(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => !isProtocolEntityId(entry))) {
    errors.push(`${key} must be an array of EntityIds`);
  }
}

function requireString(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (typeof record[key] !== 'string') errors.push(`${key} must be a string`);
}

function requireBoundedString(
  record: Record<string, unknown>,
  key: string,
  minLength: number,
  maxLength: number,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    errors.push(`${key} must be a string from ${minLength} to ${maxLength} characters`);
  }
}

function optionalBoundedString(
  record: Record<string, unknown>,
  key: string,
  minLength: number,
  maxLength: number,
  errors: string[],
): void {
  if (record[key] !== undefined) requireBoundedString(record, key, minLength, maxLength, errors);
}

function requireNamespacedName(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length > 128 || !NAMESPACED_NAME_PATTERN.test(value)) {
    errors.push(`${key} must be a NamespacedName`);
  }
}

function requireStringArray(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    errors.push(`${key} must be an array of strings`);
  }
}

function requirePositiveInteger(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    errors.push(`${key} must be an integer >= 1`);
  }
}

function optionalPercent(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
  ) {
    errors.push(`${key} must be a number between 0 and 100 when present`);
  }
}

function requireReason(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['code', 'summary']) ||
    typeof value.code !== 'string' ||
    value.code.length > 128 ||
    !NAMESPACED_NAME_PATTERN.test(value.code) ||
    typeof value.summary !== 'string' ||
    value.summary.length < 1 ||
    value.summary.length > 1000
  ) {
    errors.push(`${key} must be a bounded canonical Reason`);
  }
}

function requireEvidenceArray(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = record[key];
  if (!Array.isArray(value) || value.length > 32 || value.some((entry) => !isEvidenceRef(entry))) {
    errors.push(`${key} must be an array of at most 32 canonical EvidenceRef objects`);
  }
}

function isEvidenceRef(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['uri', 'mediaType', 'sha256', 'sizeBytes']))
    return false;
  if (
    typeof value.uri !== 'string' ||
    value.uri.length > 2048 ||
    /\s/u.test(value.uri) ||
    hasControlCharacters(value.uri)
  )
    return false;
  if (/%(?![0-9A-Fa-f]{2})/u.test(value.uri)) return false;
  if (
    value.mediaType !== undefined &&
    (typeof value.mediaType !== 'string' ||
      value.mediaType.length < 1 ||
      value.mediaType.length > 255)
  )
    return false;
  if (
    value.sha256 !== undefined &&
    (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256))
  )
    return false;
  if (
    value.sizeBytes !== undefined &&
    (typeof value.sizeBytes !== 'number' ||
      !Number.isInteger(value.sizeBytes) ||
      value.sizeBytes < 0)
  )
    return false;
  return true;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function optionalResource(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(`${key} must be a ResourceRef-shaped object when present`);
    return;
  }
  if (
    !hasOnlyKeys(value, ['type', 'id']) ||
    typeof value.type !== 'string' ||
    value.type.length > 128 ||
    !NAMESPACED_NAME_PATTERN.test(value.type) ||
    !isProtocolEntityId(value.id)
  ) {
    errors.push(`${key} must be a ResourceRef-shaped object when present`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
