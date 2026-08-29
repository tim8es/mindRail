import type {
  Agent,
  Checkpoint,
  Goal,
  Lease,
  PermissionDecision,
  Session,
  Task,
} from '@mindrail/contracts';

import type { PermissionPolicy } from '../policy/permission-policy.ts';
import {
  PersistenceError,
  type ClaimTaskCommitValue,
  type CommandReceiptInput,
  type DeferredCommandReceiptInput,
  type DurableRuntimePersistence,
  type MutationCommitResult,
  type StoredCommandReceipt,
} from '../persistence/ports.ts';
import type { CanonicalDomainValidator } from '../runtime/domain-validation.ts';
import {
  InMemoryControlPlane,
  type ClaimTaskResult,
  type CompleteTaskResult,
} from '../runtime/in-memory-control-plane.ts';
import type { RequestPermissionResult } from '../runtime/permission-service.ts';
import {
  semanticFingerprint,
  type ProtocolCommand,
  type ProtocolResponse,
} from '../runtime/protocol.ts';
import type { ApplicationDispatcher } from './ports.ts';
import type {
  ApplicationCommand,
  ApplicationErrorCode,
  ApplicationQuery,
  CommandFailure,
  CommandResponse,
  QueryFailure,
} from './protocol.ts';

export interface DurableApplicationDispatcherOptions {
  persistence: DurableRuntimePersistence;
  now: () => Date;
  idFactory: (kind: string) => string;
  leaseDurationMs: number;
  sessionTimeoutMs: number;
  validateCanonicalDomainRecord: CanonicalDomainValidator;
  permissionPolicy?: PermissionPolicy;
}

export function createDurableApplicationDispatcher(
  options: DurableApplicationDispatcherOptions,
): ApplicationDispatcher {
  return {
    dispatchCommand(command) {
      return dispatchDurableCommand(options, command);
    },
    dispatchQuery(query) {
      return unsupportedQuery(query);
    },
  };
}

async function dispatchDurableCommand(
  options: DurableApplicationDispatcherOptions,
  command: ApplicationCommand,
): Promise<CommandResponse> {
  try {
    const fingerprint = semanticFingerprint(command);
    const stored = await options.persistence.getCommandReceipt(
      command.workspaceId,
      command.commandId,
    );
    if (stored) return replayStoredReceipt(command, fingerprint, stored);

    const snapshot = await options.persistence.loadWorkspaceState(command.workspaceId);
    if (!snapshot) {
      return commandFailure(command, 'NOT_FOUND', 'Workspace was not found in durable state.');
    }

    if (!isFirstDurableLoopCommand(command)) {
      return commandFailure(
        command,
        'UNSUPPORTED_OPERATION',
        `${command.command} is not yet integrated in the durable application composition.`,
      );
    }

    const runtime = InMemoryControlPlane.rehydrate({
      snapshot,
      now: options.now,
      idFactory: options.idFactory,
      leaseDurationMs: options.leaseDurationMs,
      sessionTimeoutMs: options.sessionTimeoutMs,
      validateCanonicalDomainRecord: options.validateCanonicalDomainRecord,
      ...(options.permissionPolicy === undefined
        ? {}
        : { permissionPolicy: options.permissionPolicy }),
    });
    const semanticResponse = runtime.execute(command);
    if ('error' in semanticResponse) return semanticResponse;

    return await commitDurableSuccess(options, command, fingerprint, semanticResponse);
  } catch (error) {
    if (error instanceof PersistenceError) return persistenceFailure(command, error);
    return commandFailure(command, 'INTERNAL_ERROR', 'Durable command execution failed.');
  }
}

function isFirstDurableLoopCommand(command: ProtocolCommand): boolean {
  return (
    command.command === 'RegisterAgent' ||
    command.command === 'StartSession' ||
    command.command === 'CreateGoal' ||
    command.command === 'CreateTask' ||
    command.command === 'ClaimTask' ||
    command.command === 'RecordCheckpoint' ||
    command.command === 'RequestPermission' ||
    command.command === 'RecordPermissionDecision' ||
    command.command === 'CompleteTask'
  );
}

async function commitDurableSuccess(
  options: DurableApplicationDispatcherOptions,
  command: ApplicationCommand,
  fingerprint: string,
  semanticResponse: Exclude<ProtocolResponse, ProtocolResponse & { error: unknown }>,
): Promise<CommandResponse> {
  switch (command.command) {
    case 'RegisterAgent': {
      const result = semanticResponse.result as Agent;
      return resolveMutationResult(
        command,
        await options.persistence.createAgent({
          agent: result,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'StartSession': {
      const result = semanticResponse.result as Session;
      return resolveMutationResult(
        command,
        await options.persistence.createSession({
          session: result,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'CreateGoal': {
      const result = semanticResponse.result as Goal;
      return resolveMutationResult(
        command,
        await options.persistence.createGoal({
          goal: result,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'CreateTask': {
      const result = semanticResponse.result as Task;
      return resolveMutationResult(
        command,
        await options.persistence.createTask({
          task: result,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'ClaimTask': {
      const speculative = semanticResponse.result as ClaimTaskResult;
      const deferredReceipt = deferredReceiptFor<ClaimTaskCommitValue>(
        command,
        fingerprint,
        (value) => successResponse(command, value),
        options.now(),
      );
      const committed = await options.persistence.claimTask({
        workspaceId: command.workspaceId,
        taskId: command.taskId,
        sessionId: command.sessionId,
        expectedTaskRevision: command.expectedTaskRevision,
        lease: leaseWithoutFence(speculative.lease),
        now: options.now().toISOString(),
        deferredReceipt,
      });
      return resolveMutationResult(command, committed);
    }
    case 'RecordCheckpoint': {
      const result = semanticResponse.result as Checkpoint;
      return resolveMutationResult(
        command,
        await options.persistence.appendCheckpoint({
          checkpoint: result,
          now: options.now().toISOString(),
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'RequestPermission': {
      const result = semanticResponse.result as RequestPermissionResult;
      return resolveMutationResult(
        command,
        await options.persistence.appendPermissionRequestWithInitialDecision({
          request: result.request,
          decision: result.decision,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'RecordPermissionDecision': {
      const result = semanticResponse.result as PermissionDecision;
      return resolveMutationResult(
        command,
        await options.persistence.appendPermissionDecision({
          decision: result,
          expectedPreviousDecisionId: command.expectedPreviousDecisionId,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'CompleteTask': {
      const result = semanticResponse.result as CompleteTaskResult;
      const committed = await options.persistence.completeTask({
        workspaceId: command.workspaceId,
        task: result.task,
        lease: result.lease,
        checkpoint: result.checkpoint,
        expectedTaskRevision: command.expectedTaskRevision,
        now: options.now().toISOString(),
        receipt: receiptFor(command, fingerprint, successResponse(command, result), options.now()),
      });
      if (committed.kind === 'replayed')
        return replayStoredReceipt(command, fingerprint, committed.receipt);
      return successResponse(command, {
        task: committed.value.task,
        lease: committed.value.lease,
        checkpoint: committed.value.checkpoint,
      });
    }
    default:
      return commandFailure(command, 'UNSUPPORTED_OPERATION', 'Command is not durable yet.');
  }
}

function resolveMutationResult<T>(
  command: ApplicationCommand,
  committed: MutationCommitResult<T>,
): CommandResponse<T> {
  if (committed.kind === 'replayed') {
    return replayStoredReceipt(
      command,
      semanticFingerprint(command),
      committed.receipt,
    ) as CommandResponse<T>;
  }
  return successResponse(command, committed.value);
}

function receiptFor(
  command: ApplicationCommand,
  fingerprint: string,
  responseSnapshot: CommandResponse,
  now: Date,
): CommandReceiptInput {
  return {
    workspaceId: command.workspaceId,
    commandId: command.commandId,
    command: command.command,
    semanticFingerprint: fingerprint,
    outcomeKind: 'result',
    responseSnapshot,
    createdAt: now.toISOString(),
  };
}

function deferredReceiptFor<T>(
  command: ApplicationCommand,
  fingerprint: string,
  buildResponseSnapshot: (value: T) => CommandResponse,
  now: Date,
): DeferredCommandReceiptInput<T> {
  return {
    workspaceId: command.workspaceId,
    commandId: command.commandId,
    command: command.command,
    semanticFingerprint: fingerprint,
    outcomeKind: 'result',
    createdAt: now.toISOString(),
    buildResponseSnapshot,
  };
}

function replayStoredReceipt(
  command: ApplicationCommand,
  fingerprint: string,
  stored: StoredCommandReceipt,
): CommandResponse {
  if (stored.command !== command.command || stored.semanticFingerprint !== fingerprint) {
    return commandFailure(
      command,
      'IDEMPOTENCY_CONFLICT',
      `Command ${command.commandId} was already admitted with different semantics.`,
    );
  }
  if (!isCommandResponse(stored.responseSnapshot, command.commandId)) {
    return commandFailure(command, 'INTERNAL_ERROR', 'Durable command receipt is invalid.');
  }
  const response = structuredClone(stored.responseSnapshot);
  response.replayed = true;
  if (command.correlationId === undefined) delete response.correlationId;
  else response.correlationId = command.correlationId;
  return response;
}

function successResponse<T>(command: ApplicationCommand, result: T): CommandResponse<T> {
  return {
    protocolVersion: '0.1',
    commandId: command.commandId,
    ...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
    replayed: false,
    result: structuredClone(result),
  };
}

function commandFailure(
  command: ApplicationCommand,
  code: ApplicationErrorCode,
  message: string,
): CommandFailure {
  return {
    protocolVersion: '0.1',
    commandId: command.commandId,
    ...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
    replayed: false,
    error: { code, message, retryable: false },
  };
}

function persistenceFailure(command: ApplicationCommand, error: PersistenceError): CommandFailure {
  switch (error.code) {
    case 'NOT_FOUND':
      return commandFailure(command, 'NOT_FOUND', 'Durable resource was not found.');
    case 'CONFLICT':
      return commandFailure(command, 'CONFLICT', 'Durable state conflicts with this command.');
    case 'REVISION_MISMATCH':
      return commandFailure(command, 'REVISION_MISMATCH', 'Durable revision changed.');
    case 'STALE_AUTHORITY':
      return commandFailure(
        command,
        'STALE_FENCING_TOKEN',
        'Durable execution authority is stale.',
      );
    case 'IDEMPOTENCY_CONFLICT':
      return commandFailure(
        command,
        'IDEMPOTENCY_CONFLICT',
        'Command id has different durable semantics.',
      );
    case 'INVALID_STATE_TRANSITION':
      return commandFailure(
        command,
        'INVALID_STATE_TRANSITION',
        'Durable state transition is invalid.',
      );
    case 'INVALID_RECORD':
    case 'INTEGRITY_ERROR':
      return commandFailure(command, 'INTERNAL_ERROR', 'Durable state integrity check failed.');
  }
}

function unsupportedQuery(query: ApplicationQuery): QueryFailure {
  return {
    protocolVersion: '0.1',
    ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: `${query.query} is not yet integrated in the durable application composition.`,
      retryable: false,
    },
  };
}

function leaseWithoutFence(lease: Lease): Omit<Lease, 'fencingToken'> {
  return {
    id: lease.id,
    workspaceId: lease.workspaceId,
    taskId: lease.taskId,
    sessionId: lease.sessionId,
    revision: lease.revision,
    status: lease.status,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
    expiresAt: lease.expiresAt,
  };
}

function isCommandResponse(value: unknown, commandId: string): value is CommandResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocolVersion === '0.1' &&
    record.commandId === commandId &&
    typeof record.replayed === 'boolean' &&
    (Object.hasOwn(record, 'result') || Object.hasOwn(record, 'error'))
  );
}
