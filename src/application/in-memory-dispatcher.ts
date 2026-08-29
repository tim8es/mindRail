import type { Checkpoint } from '@mindrail/contracts';

import { RuntimeError } from '../runtime/errors.ts';
import { InMemoryControlPlane } from '../runtime/in-memory-control-plane.ts';
import type { ProtocolCommand } from '../runtime/protocol.ts';
import type { ApplicationDispatcher } from './ports.ts';
import type {
  ApplicationCommand,
  ApplicationCommandName,
  ApplicationQuery,
  ApplicationQueryName,
  CommandFailure,
  CommandResponse,
  QueryFailure,
  QueryResponse,
} from './protocol.ts';

export const IN_MEMORY_UNSUPPORTED_COMMANDS = [
  'RegisterAgent',
  'StartSession',
] as const satisfies readonly ApplicationCommandName[];

export const IN_MEMORY_UNSUPPORTED_QUERIES = [
  'ListGoals',
  'ListGoalTasks',
  'ListClaimableTasks',
  'GetTaskExecutionView',
  'GetAgent',
  'GetSession',
  'GetPermissionRequest',
  'ListPendingHumanPermissions',
  'ListPermissionDecisions',
] as const satisfies readonly ApplicationQueryName[];

export function createInMemoryApplicationDispatcher(
  controlPlane: InMemoryControlPlane,
): ApplicationDispatcher {
  return {
    dispatchCommand(command) {
      if (isCurrentRuntimeCommand(command)) {
        return controlPlane.execute(command);
      }
      return unsupportedCommand(command);
    },

    dispatchQuery(query) {
      try {
        switch (query.query) {
          case 'GetWorkspace':
            return querySuccess(query, controlPlane.getWorkspace(query.workspaceId));
          case 'GetGoal':
            return querySuccess(query, controlPlane.getGoal(query.workspaceId, query.goalId));
          case 'GetTask':
            return querySuccess(query, controlPlane.getTask(query.workspaceId, query.taskId));
          case 'GetLease':
            return querySuccess(query, controlPlane.getLease(query.workspaceId, query.leaseId));
          case 'ListTaskCheckpoints':
            return querySuccess(
              query,
              pageCheckpoints(
                controlPlane.listTaskCheckpoints(query.workspaceId, query.taskId),
                query.limit,
                query.cursor,
              ),
            );
          case 'ListGoals':
          case 'ListGoalTasks':
          case 'ListClaimableTasks':
          case 'GetTaskExecutionView':
          case 'GetAgent':
          case 'GetSession':
          case 'GetPermissionRequest':
          case 'ListPendingHumanPermissions':
          case 'ListPermissionDecisions':
            return unsupportedQuery(query);
        }
      } catch (error) {
        if (error instanceof RuntimeError) {
          return queryFailure(query, error.code, error.message);
        }
        return queryFailure(query, 'INTERNAL_ERROR', 'Application query failed.');
      }
    },
  };
}

function isCurrentRuntimeCommand(command: ApplicationCommand): command is ProtocolCommand {
  return !IN_MEMORY_UNSUPPORTED_COMMANDS.includes(
    command.command as (typeof IN_MEMORY_UNSUPPORTED_COMMANDS)[number],
  );
}

function unsupportedCommand(command: ApplicationCommand): CommandFailure {
  return {
    protocolVersion: '0.1',
    commandId: command.commandId,
    ...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
    replayed: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: `${command.command} is not integrated in this runtime composition.`,
      retryable: false,
    },
  };
}

function unsupportedQuery(query: ApplicationQuery): QueryFailure {
  return queryFailure(
    query,
    'UNSUPPORTED_OPERATION',
    `${query.query} is not integrated in this runtime composition.`,
  );
}

function querySuccess(query: ApplicationQuery, result: unknown): QueryResponse {
  return {
    protocolVersion: '0.1',
    ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    result,
  };
}

function queryFailure(
  query: ApplicationQuery,
  code: QueryFailure['error']['code'],
  message: string,
): QueryFailure {
  return {
    protocolVersion: '0.1',
    ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    error: { code, message, retryable: false },
  };
}

function pageCheckpoints(
  checkpoints: Checkpoint[],
  limit: number,
  cursor: string | undefined,
): { items: Checkpoint[]; nextCursor?: string } {
  const offset = decodeCursor(cursor);
  const items = checkpoints.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    items,
    ...(nextOffset < checkpoints.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
  };
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^c([0-9]+)$/.exec(cursor);
  if (match?.[1] === undefined) {
    throw new RuntimeError('INVALID_INPUT', 'Cursor is invalid for this query.');
  }
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RuntimeError('INVALID_INPUT', 'Cursor is invalid for this query.');
  }
  return offset;
}

function encodeCursor(offset: number): string {
  return `c${offset}`;
}

export type InMemoryCommandResponse = CommandResponse;
