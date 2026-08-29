import type {
  ApplicationDispatcher,
  AuthenticatedPrincipal,
  PrincipalAuthorizer,
  PrincipalClaim,
} from '../../application/ports.ts';
import {
  isApplicationCommandName,
  isApplicationQueryName,
  type ApplicationErrorCode,
  type ApplicationCommand,
  type ApplicationCommandName,
  type ApplicationQuery,
  type ApplicationQueryName,
  type CommandFailure,
  type CommandResponse,
  type QueryFailure,
  type QueryResponse,
} from '../../application/protocol.ts';
import {
  parseApplicationCommand,
  parseApplicationQuery,
} from '../../application/validation.ts';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

export interface HttpTransportDependencies {
  dispatcher: ApplicationDispatcher;
  authorizer: PrincipalAuthorizer;
  maxBodyBytes?: number;
}

export interface HttpTransport {
  handle(request: Request, principal: AuthenticatedPrincipal): Promise<Response>;
}

interface Route {
  kind: 'command' | 'query';
  name: ApplicationCommandName | ApplicationQueryName;
}

export function createHttpTransport(dependencies: HttpTransportDependencies): HttpTransport {
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError('maxBodyBytes must be a positive integer');
  }

  return {
    async handle(request, principal) {
      if (request.method !== 'POST') {
        return jsonResponse(queryFailure('INVALID_INPUT', 'Only POST is supported.'), 405);
      }

      const route = parseRoute(new URL(request.url).pathname);
      if (route === undefined) {
        return jsonResponse(queryFailure('INVALID_INPUT', 'Unknown protocol route.'), 404);
      }

      if (!isJsonContentType(request.headers.get('content-type'))) {
        return jsonResponse(queryFailure('INVALID_INPUT', 'Content-Type must be application/json.'), 415);
      }

      const bodyResult = await readBoundedJson(request, maxBodyBytes);
      if (!bodyResult.ok) {
        const status = bodyResult.oversized ? 413 : 400;
        return jsonResponse(queryFailure('INVALID_INPUT', bodyResult.message), status);
      }

      if (route.kind === 'command') {
        const parsed = parseApplicationCommand(route.name as ApplicationCommandName, bodyResult.value);
        if (!parsed.ok) {
          return jsonResponse(commandFailureFromInput(bodyResult.value, parsed.message), 400);
        }
        if (!(await isAuthorized(dependencies.authorizer, principal, claimForCommand(parsed.value)))) {
          return jsonResponse(
            commandFailure(parsed.value, 'ACTOR_NOT_AUTHORIZED', 'Principal is not authorized.'),
            403,
          );
        }
        try {
          const response = await dependencies.dispatcher.dispatchCommand(parsed.value);
          return jsonResponse(response, statusForResponse(response));
        } catch {
          return jsonResponse(
            commandFailure(parsed.value, 'INTERNAL_ERROR', 'Application dispatch failed.'),
            500,
          );
        }
      }

      const parsed = parseApplicationQuery(route.name as ApplicationQueryName, bodyResult.value);
      if (!parsed.ok) {
        return jsonResponse(queryFailureFromInput(bodyResult.value, parsed.message), 400);
      }
      if (!(await isAuthorized(dependencies.authorizer, principal, claimForQuery(parsed.value)))) {
        return jsonResponse(
          queryFailure('ACTOR_NOT_AUTHORIZED', 'Principal is not authorized.', parsed.value.correlationId),
          403,
        );
      }
      try {
        const response = await dependencies.dispatcher.dispatchQuery(parsed.value);
        return jsonResponse(response, statusForResponse(response));
      } catch {
        return jsonResponse(
          queryFailure('INTERNAL_ERROR', 'Application dispatch failed.', parsed.value.correlationId),
          500,
        );
      }
    },
  };
}

function parseRoute(pathname: string): Route | undefined {
  const parts = pathname.split('/').filter((part) => part.length > 0);
  if (parts.length !== 3 || parts[0] !== 'v0.1') return undefined;
  const name = parts[2];
  if (name === undefined) return undefined;
  if (parts[1] === 'commands' && isApplicationCommandName(name)) {
    return { kind: 'command', name };
  }
  if (parts[1] === 'queries' && isApplicationQueryName(name)) {
    return { kind: 'query', name };
  }
  return undefined;
}

async function readBoundedJson(
  request: Request,
  maxBodyBytes: number,
): Promise<
  | { ok: true; value: unknown }
  | { ok: false; message: string; oversized: boolean }
> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBodyBytes) {
      return { ok: false, message: 'Request body exceeds the configured limit.', oversized: true };
    }
  }

  const reader = request.body?.getReader();
  if (reader === undefined) return { ok: false, message: 'Request body is required.', oversized: false };
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBodyBytes) {
        await reader.cancel();
        return { ok: false, message: 'Request body exceeds the configured limit.', oversized: true };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, message: 'Request body is not valid UTF-8 JSON.', oversized: false };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, message: 'Request body is malformed JSON.', oversized: false };
  }
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  return value.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

function claimForCommand(command: ApplicationCommand): PrincipalClaim {
  return {
    workspaceId: command.workspaceId,
    actor: command.actor,
    ...(hasSessionId(command) ? { sessionId: command.sessionId } : {}),
    operation: { kind: 'command', name: command.command },
  };
}

function claimForQuery(query: ApplicationQuery): PrincipalClaim {
  return {
    workspaceId: query.workspaceId,
    actor: query.actor,
    ...(hasSessionId(query) ? { sessionId: query.sessionId } : {}),
    operation: { kind: 'query', name: query.query },
  };
}

function hasSessionId(value: ApplicationCommand | ApplicationQuery): value is (
  | ApplicationCommand
  | ApplicationQuery
) & { sessionId: string } {
  return 'sessionId' in value && typeof value.sessionId === 'string';
}

async function isAuthorized(
  authorizer: PrincipalAuthorizer,
  principal: AuthenticatedPrincipal,
  claim: PrincipalClaim,
): Promise<boolean> {
  try {
    return (await authorizer.authorize(principal, claim)) === true;
  } catch {
    return false;
  }
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

function commandFailureFromInput(input: unknown, message: string): CommandFailure {
  const record = isRecord(input) ? input : {};
  return {
    protocolVersion: '0.1',
    ...(typeof record.commandId === 'string' ? { commandId: record.commandId } : {}),
    ...(typeof record.correlationId === 'string' ? { correlationId: record.correlationId } : {}),
    replayed: false,
    error: { code: 'INVALID_INPUT', message, retryable: false },
  };
}

function queryFailure(
  code: ApplicationErrorCode,
  message: string,
  correlationId?: string,
): QueryFailure {
  return {
    protocolVersion: '0.1',
    ...(correlationId === undefined ? {} : { correlationId }),
    error: { code, message, retryable: false },
  };
}

function queryFailureFromInput(input: unknown, message: string): QueryFailure {
  const record = isRecord(input) ? input : {};
  return queryFailure(
    'INVALID_INPUT',
    message,
    typeof record.correlationId === 'string' ? record.correlationId : undefined,
  );
}

function statusForResponse(response: CommandResponse | QueryResponse): number {
  if (!('error' in response)) return 200;
  return statusForErrorCode(response.error.code);
}

function statusForErrorCode(code: ApplicationErrorCode): number {
  switch (code) {
    case 'INVALID_INPUT':
      return 400;
    case 'NOT_FOUND':
      return 404;
    case 'ACTOR_NOT_AUTHORIZED':
    case 'PERMISSION_DENIED':
      return 403;
    case 'POLICY_UNAVAILABLE':
      return 503;
    case 'UNSUPPORTED_OPERATION':
      return 501;
    case 'INTERNAL_ERROR':
      return 500;
    case 'CONFLICT':
    case 'REVISION_MISMATCH':
    case 'LEASE_NOT_ACTIVE':
    case 'LEASE_EXPIRED':
    case 'STALE_FENCING_TOKEN':
    case 'INVALID_STATE_TRANSITION':
    case 'IDEMPOTENCY_CONFLICT':
    case 'SESSION_NOT_ACTIVE':
    case 'CAPABILITY_MISMATCH':
    case 'DEPENDENCY_UNSATISFIED':
    case 'HUMAN_DECISION_REQUIRED':
      return 409;
  }
}

function jsonResponse(body: CommandResponse | QueryResponse, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
