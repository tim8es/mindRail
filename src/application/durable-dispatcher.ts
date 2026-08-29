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
  type BlockTaskResult,
  type ClaimTaskResult,
  type CompleteTaskResult,
  type EndSessionResult,
  type FailTaskResult,
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
  QueryResponse,
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
      return dispatchDurableQuery(options, query);
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
    if ('error' in semanticResponse) {
      const committed = await options.persistence.commitCommandReceipt(
        errorReceiptFor(command, fingerprint, semanticResponse as CommandFailure, options.now()),
      );
      if (committed.kind === 'replayed') {
        return replayStoredReceipt(command, fingerprint, committed.receipt);
      }
      return semanticResponse;
    }

    return await commitDurableSuccess(options, command, fingerprint, semanticResponse);
  } catch (error) {
    if (error instanceof PersistenceError) return persistenceFailure(command, error);
    return commandFailure(command, 'INTERNAL_ERROR', 'Durable command execution failed.');
  }
}

async function dispatchDurableQuery(
  options: DurableApplicationDispatcherOptions,
  query: ApplicationQuery,
): Promise<QueryResponse> {
  try {
    switch (query.query) {
      case 'GetWorkspace':
        return durableResourceQuery(
          query,
          await options.persistence.getWorkspace(query.workspaceId),
        );
      case 'GetGoal':
        return durableResourceQuery(
          query,
          await options.persistence.getGoal(query.workspaceId, query.goalId),
        );
      case 'GetTask':
        return durableResourceQuery(
          query,
          await options.persistence.getTask(query.workspaceId, query.taskId),
        );
      case 'GetAgent':
        return durableResourceQuery(
          query,
          await options.persistence.getAgent(query.workspaceId, query.agentId),
        );
      case 'GetSession':
        return durableResourceQuery(
          query,
          await options.persistence.getSession(query.workspaceId, query.sessionId),
        );
      case 'GetLease':
        return durableResourceQuery(
          query,
          await options.persistence.getLease(query.workspaceId, query.leaseId),
        );
      case 'GetPermissionRequest':
        return durableResourceQuery(
          query,
          await options.persistence.getPermissionRequest(query.workspaceId, query.requestId),
        );
      case 'ListTaskCheckpoints': {
        if (!(await options.persistence.getTask(query.workspaceId, query.taskId))) {
          return queryFailure(query, 'NOT_FOUND', 'Durable Task was not found.');
        }
        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listTaskCheckpoints(
          query.workspaceId,
          query.taskId,
          window.limit + 1,
          window.offset,
        );
        return querySuccess(query, pageRows(rows, window.limit, window.offset));
      }
      case 'ListPermissionDecisions': {
        if (!(await options.persistence.getPermissionRequest(query.workspaceId, query.requestId))) {
          return queryFailure(query, 'NOT_FOUND', 'Durable PermissionRequest was not found.');
        }
        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listPermissionDecisions(
          query.workspaceId,
          query.requestId,
          window.limit + 1,
          window.offset,
        );
        return querySuccess(query, pageRows(rows, window.limit, window.offset));
      }
      case 'ListPendingHumanPermissions': {
        if (!(await options.persistence.getWorkspace(query.workspaceId))) {
          return queryFailure(query, 'NOT_FOUND', 'Durable Workspace was not found.');
        }
        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listPendingHumanPermissions(
          query.workspaceId,
          window.limit + 1,
          window.offset,
        );
        return querySuccess(query, pageRows(rows, window.limit, window.offset));
      }
      case 'ListClaimableTasks': {
        if (!(await options.persistence.getWorkspace(query.workspaceId))) {
          return queryFailure(query, 'NOT_FOUND', 'Durable Workspace was not found.');
        }
        const session = await options.persistence.getSession(query.workspaceId, query.sessionId);
        if (!session) return queryFailure(query, 'NOT_FOUND', 'Durable Session was not found.');
        const now = options.now();
        const staleAt = Date.parse(session.lastSeenAt) + options.sessionTimeoutMs;
        if (session.status !== 'active' || now.getTime() >= staleAt) {
          return queryFailure(
            query,
            'SESSION_NOT_ACTIVE',
            'Session is not active for work acquisition.',
          );
        }
        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listClaimableTasks(
          query.workspaceId,
          query.sessionId,
          now.toISOString(),
          new Date(now.getTime() - options.sessionTimeoutMs).toISOString(),
          window.limit + 1,
          window.offset,
        );
        return querySuccess(query, pageRows(rows, window.limit, window.offset));
      }
      case 'ListGoals':
      case 'ListGoalTasks':
      case 'GetTaskExecutionView':
        return unsupportedQuery(query);
    }
  } catch (error) {
    if (error instanceof PersistenceError) return persistenceQueryFailure(query, error);
    return queryFailure(query, 'INTERNAL_ERROR', 'Durable query execution failed.');
  }
}

function isFirstDurableLoopCommand(command: ProtocolCommand): boolean {
  return (
    command.command === 'RegisterAgent' ||
    command.command === 'StartSession' ||
    command.command === 'HeartbeatSession' ||
    command.command === 'EndSession' ||
    command.command === 'CreateGoal' ||
    command.command === 'CreateTask' ||
    command.command === 'ClaimTask' ||
    command.command === 'RenewLease' ||
    command.command === 'ReleaseLease' ||
    command.command === 'RecordCheckpoint' ||
    command.command === 'RequestPermission' ||
    command.command === 'RecordPermissionDecision' ||
    command.command === 'CompleteTask' ||
    command.command === 'FailTask' ||
    command.command === 'BlockTask' ||
    command.command === 'ResumeTask'
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
    case 'HeartbeatSession': {
      const result = semanticResponse.result as Session;
      return resolveMutationResult(
        command,
        await options.persistence.heartbeatSession({
          session: result,
          expectedRevision: command.expectedSessionRevision,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'EndSession': {
      const result = semanticResponse.result as EndSessionResult;
      return resolveMutationResult(
        command,
        await options.persistence.endSession({
          session: result.session,
          leases: result.leases,
          expectedSessionRevision: command.expectedSessionRevision,
          now: result.session.updatedAt,
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
    case 'RenewLease': {
      const result = semanticResponse.result as Lease;
      const now = result.updatedAt;
      return resolveMutationResult(
        command,
        await options.persistence.renewLease({
          lease: result,
          expectedRevision: command.expectedLeaseRevision,
          now,
          sessionCutoff: new Date(Date.parse(now) - options.sessionTimeoutMs).toISOString(),
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'ReleaseLease': {
      const result = semanticResponse.result as Lease;
      const now = result.updatedAt;
      return resolveMutationResult(
        command,
        await options.persistence.releaseLease({
          lease: result,
          expectedRevision: command.expectedLeaseRevision,
          now,
          sessionCutoff: new Date(Date.parse(now) - options.sessionTimeoutMs).toISOString(),
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
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
    case 'FailTask': {
      const result = semanticResponse.result as FailTaskResult;
      return resolveMutationResult(
        command,
        await options.persistence.failTask({
          workspaceId: command.workspaceId,
          task: result.task,
          lease: result.lease,
          checkpoint: result.checkpoint,
          expectedTaskRevision: command.expectedTaskRevision,
          now: result.task.updatedAt,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'BlockTask': {
      const result = semanticResponse.result as BlockTaskResult;
      return resolveMutationResult(
        command,
        await options.persistence.blockTask({
          workspaceId: command.workspaceId,
          task: result.task,
          lease: result.lease,
          checkpoint: result.checkpoint,
          expectedTaskRevision: command.expectedTaskRevision,
          now: result.task.updatedAt,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'ResumeTask': {
      const result = semanticResponse.result as Task;
      return resolveMutationResult(
        command,
        await options.persistence.resumeTask({
          task: result,
          expectedRevision: command.expectedTaskRevision,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
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

function errorReceiptFor(
  command: ApplicationCommand,
  fingerprint: string,
  responseSnapshot: CommandFailure,
  now: Date,
): CommandReceiptInput {
  return {
    workspaceId: command.workspaceId,
    commandId: command.commandId,
    command: command.command,
    semanticFingerprint: fingerprint,
    outcomeKind: 'error',
    responseSnapshot: structuredClone(responseSnapshot),
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
  return queryFailure(
    query,
    'UNSUPPORTED_OPERATION',
    `${query.query} is not yet integrated in the durable application composition.`,
  );
}

function querySuccess<T>(query: ApplicationQuery, result: T): QueryResponse<T> {
  return {
    protocolVersion: '0.1',
    ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    result: structuredClone(result),
  };
}

function queryFailure(
  query: ApplicationQuery,
  code: ApplicationErrorCode,
  message: string,
): QueryFailure {
  return {
    protocolVersion: '0.1',
    ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    error: { code, message, retryable: false },
  };
}

function durableResourceQuery<T>(query: ApplicationQuery, value: T | undefined): QueryResponse<T> {
  return value === undefined
    ? queryFailure(query, 'NOT_FOUND', 'Durable resource was not found.')
    : querySuccess(query, value);
}

function persistenceQueryFailure(query: ApplicationQuery, error: PersistenceError): QueryFailure {
  switch (error.code) {
    case 'NOT_FOUND':
      return queryFailure(query, 'NOT_FOUND', 'Durable resource was not found.');
    case 'CONFLICT':
      return queryFailure(query, 'CONFLICT', 'Durable state conflicts with this query.');
    case 'REVISION_MISMATCH':
      return queryFailure(query, 'REVISION_MISMATCH', 'Durable revision changed.');
    case 'STALE_AUTHORITY':
      return queryFailure(query, 'STALE_FENCING_TOKEN', 'Durable execution authority is stale.');
    case 'IDEMPOTENCY_CONFLICT':
      return queryFailure(query, 'IDEMPOTENCY_CONFLICT', 'Durable command identity conflicts.');
    case 'INVALID_STATE_TRANSITION':
      return queryFailure(
        query,
        'INVALID_STATE_TRANSITION',
        'Durable state transition is invalid.',
      );
    case 'INVALID_RECORD':
      return queryFailure(query, 'INVALID_INPUT', 'Durable query bounds are invalid.');
    case 'INTEGRITY_ERROR':
      return queryFailure(query, 'INTERNAL_ERROR', 'Durable state integrity check failed.');
  }
}

function listWindow(
  limit: number,
  cursor: string | undefined,
): { limit: number; offset: number } | undefined {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return undefined;
  if (cursor === undefined) return { limit, offset: 0 };
  const match = /^c([0-9]+)$/.exec(cursor);
  if (match?.[1] === undefined) return undefined;
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return undefined;
  return { limit, offset };
}

function invalidListWindow(query: ApplicationQuery): QueryFailure {
  return queryFailure(query, 'INVALID_INPUT', 'List limit or cursor is invalid.');
}

function pageRows<T>(
  rows: T[],
  limit: number,
  offset: number,
): { items: T[]; nextCursor?: string } {
  const items = rows.slice(0, limit);
  return {
    items,
    ...(rows.length > limit ? { nextCursor: `c${offset + limit}` } : {}),
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
