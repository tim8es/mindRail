import type {
  ApplicationDispatcher,
  AuthenticatedPrincipal,
  PrincipalAuthorizer,
  PrincipalClaim,
} from '../../application/ports.ts';
import {
  type ApplicationCommand,
  type ApplicationCommandName,
  type ApplicationErrorCode,
  type ApplicationQuery,
  type ApplicationQueryName,
  type CommandFailure,
  type CommandResponse,
  type QueryFailure,
  type QueryResponse,
} from '../../application/protocol.ts';
import {
  COMMAND_SHAPES,
  parseApplicationCommand,
  parseApplicationQuery,
  QUERY_SHAPES,
} from '../../application/validation.ts';

export interface McpTransportDependencies {
  dispatcher: ApplicationDispatcher;
  authorizer: PrincipalAuthorizer;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpInputSchema;
}

export interface McpInputSchema {
  type: 'object';
  additionalProperties: false;
  required: readonly string[];
  properties: Readonly<Record<string, unknown>>;
}

export interface McpTransport {
  listTools(): readonly McpToolDefinition[];
  callTool(
    name: string,
    args: unknown,
    principal: AuthenticatedPrincipal,
  ): Promise<CommandResponse | QueryResponse>;
}

interface CommandBinding {
  tool: string;
  kind: 'command';
  operation: ApplicationCommandName;
  description: string;
}

interface QueryBinding {
  tool: string;
  kind: 'query';
  operation: ApplicationQueryName;
  description: string;
}

type ToolBinding = CommandBinding | QueryBinding;

const TOOL_BINDINGS: readonly ToolBinding[] = [
  command('mindrail_register_agent', 'RegisterAgent', 'Register a logical MindRail agent.'),
  command('mindrail_start_session', 'StartSession', 'Start an agent execution session.'),
  command('mindrail_heartbeat_session', 'HeartbeatSession', 'Refresh session liveness.'),
  command('mindrail_end_session', 'EndSession', 'End an execution session.'),
  command('mindrail_create_goal', 'CreateGoal', 'Create a MindRail goal.'),
  command('mindrail_create_task', 'CreateTask', 'Create a task under a goal.'),
  command('mindrail_claim_task', 'ClaimTask', 'Claim task execution authority.'),
  command('mindrail_renew_lease', 'RenewLease', 'Renew current task lease authority.'),
  command('mindrail_release_lease', 'ReleaseLease', 'Release current task lease authority.'),
  command('mindrail_record_checkpoint', 'RecordCheckpoint', 'Record task progress or handoff.'),
  command('mindrail_complete_task', 'CompleteTask', 'Complete a running task.'),
  command('mindrail_fail_task', 'FailTask', 'Fail a running task.'),
  command('mindrail_block_task', 'BlockTask', 'Block a running task.'),
  command('mindrail_resume_task', 'ResumeTask', 'Resume an explicitly blocked task.'),
  command('mindrail_retry_task', 'RetryTask', 'Retry a failed task explicitly.'),
  command('mindrail_cancel_task', 'CancelTask', 'Cancel a nonterminal task.'),
  command('mindrail_cancel_goal', 'CancelGoal', 'Cancel a goal and its nonterminal work.'),
  command(
    'mindrail_request_permission',
    'RequestPermission',
    'Request scoped MindRail permission.',
  ),
  command(
    'mindrail_record_permission_decision',
    'RecordPermissionDecision',
    'Record an authenticated human permission decision.',
  ),
  query('mindrail_get_workspace', 'GetWorkspace', 'Read one workspace.'),
  query('mindrail_get_goal', 'GetGoal', 'Read one goal.'),
  query('mindrail_list_goals', 'ListGoals', 'List goals with bounded pagination.'),
  query('mindrail_get_task', 'GetTask', 'Read one task.'),
  query('mindrail_list_goal_tasks', 'ListGoalTasks', 'List goal tasks with bounded pagination.'),
  query(
    'mindrail_list_claimable_tasks',
    'ListClaimableTasks',
    'List advisory claimable tasks with bounded pagination.',
  ),
  query(
    'mindrail_get_task_execution_view',
    'GetTaskExecutionView',
    'Read the bounded task execution view.',
  ),
  query(
    'mindrail_list_task_checkpoints',
    'ListTaskCheckpoints',
    'List task checkpoints with bounded pagination.',
  ),
  query('mindrail_get_agent', 'GetAgent', 'Read one agent.'),
  query('mindrail_get_session', 'GetSession', 'Read one session.'),
  query('mindrail_get_lease', 'GetLease', 'Read one lease.'),
  query('mindrail_get_permission_request', 'GetPermissionRequest', 'Read one permission request.'),
  query(
    'mindrail_list_pending_human_permissions',
    'ListPendingHumanPermissions',
    'List pending human permission requests with bounded pagination.',
  ),
  query(
    'mindrail_list_permission_decisions',
    'ListPermissionDecisions',
    'List permission decisions with bounded pagination.',
  ),
];

export function createMcpTransport(dependencies: McpTransportDependencies): McpTransport {
  const definitions = TOOL_BINDINGS.map(toToolDefinition);
  const bindings = new Map(TOOL_BINDINGS.map((binding) => [binding.tool, binding]));

  return {
    listTools() {
      return definitions;
    },

    async callTool(name, args, principal) {
      const binding = bindings.get(name);
      if (binding === undefined) {
        return queryFailure('INVALID_INPUT', 'Unknown MindRail MCP tool.');
      }

      if (binding.kind === 'command') {
        const parsed = parseApplicationCommand(binding.operation, args);
        if (!parsed.ok) return commandFailureFromInput(args, parsed.message);
        if (
          !(await isAuthorized(dependencies.authorizer, principal, claimForCommand(parsed.value)))
        ) {
          return commandFailure(
            parsed.value,
            'ACTOR_NOT_AUTHORIZED',
            'Principal is not authorized.',
          );
        }
        try {
          return await dependencies.dispatcher.dispatchCommand(parsed.value);
        } catch {
          return commandFailure(parsed.value, 'INTERNAL_ERROR', 'Application dispatch failed.');
        }
      }

      const parsed = parseApplicationQuery(binding.operation, args);
      if (!parsed.ok) return queryFailureFromInput(args, parsed.message);
      if (!(await isAuthorized(dependencies.authorizer, principal, claimForQuery(parsed.value)))) {
        return queryFailure(
          'ACTOR_NOT_AUTHORIZED',
          'Principal is not authorized.',
          parsed.value.correlationId,
        );
      }
      try {
        return await dependencies.dispatcher.dispatchQuery(parsed.value);
      } catch {
        return queryFailure(
          'INTERNAL_ERROR',
          'Application dispatch failed.',
          parsed.value.correlationId,
        );
      }
    },
  };
}

function command(
  tool: string,
  operation: ApplicationCommandName,
  description: string,
): CommandBinding {
  return { tool, kind: 'command', operation, description };
}

function query(tool: string, operation: ApplicationQueryName, description: string): QueryBinding {
  return { tool, kind: 'query', operation, description };
}

function toToolDefinition(binding: ToolBinding): McpToolDefinition {
  const commonRequired =
    binding.kind === 'command'
      ? ['protocolVersion', 'commandId', 'workspaceId', 'actor']
      : ['protocolVersion', 'workspaceId', 'actor'];
  const shape =
    binding.kind === 'command'
      ? COMMAND_SHAPES[binding.operation]
      : QUERY_SHAPES[binding.operation];
  const propertyNames = [
    ...commonRequired,
    'correlationId',
    ...(binding.kind === 'command' ? ['causationId'] : []),
    ...shape.required,
    ...(shape.optional ?? []),
  ];

  return {
    name: binding.tool,
    description: binding.description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [...commonRequired, ...shape.required],
      properties: Object.fromEntries(propertyNames.map((name) => [name, schemaForField(name)])),
    },
  };
}

function schemaForField(name: string): unknown {
  if (name === 'protocolVersion') return { type: 'string', const: '0.1' };
  if (name === 'actor') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['type', 'id'],
      properties: {
        type: { type: 'string', enum: ['system', 'human', 'agent'] },
        id: { type: 'string', minLength: 1, maxLength: 128 },
      },
    };
  }
  if (
    name.startsWith('expected') ||
    name === 'fencingToken' ||
    name === 'limit' ||
    name === 'progressPercent'
  ) {
    return { type: 'integer', minimum: name === 'progressPercent' ? 0 : 1 };
  }
  if (
    name === 'capabilities' ||
    name === 'successCriteria' ||
    name === 'acceptanceCriteria' ||
    name === 'requiredCapabilities' ||
    name === 'dependencyTaskIds'
  ) {
    return { type: 'array', items: { type: 'string' } };
  }
  if (name === 'evidence') return { type: 'array', items: { type: 'object' } };
  if (name === 'reason' || name === 'resource') return { type: ['object', 'string'] };
  if (name === 'outcome') return { type: 'string', enum: ['ALLOW', 'DENY'] };
  if (name === 'kind') return { type: 'string', enum: ['progress', 'handoff'] };
  return { type: 'string' };
}

function claimForCommand(command: ApplicationCommand): PrincipalClaim {
  return {
    workspaceId: command.workspaceId,
    actor: command.actor,
    ...(hasSessionId(command) ? { sessionId: command.sessionId } : {}),
    operation: { kind: 'command', name: command.command },
  };
}

function claimForQuery(queryValue: ApplicationQuery): PrincipalClaim {
  return {
    workspaceId: queryValue.workspaceId,
    actor: queryValue.actor,
    ...(hasSessionId(queryValue) ? { sessionId: queryValue.sessionId } : {}),
    operation: { kind: 'query', name: queryValue.query },
  };
}

function hasSessionId(
  value: ApplicationCommand | ApplicationQuery,
): value is (ApplicationCommand | ApplicationQuery) & { sessionId: string } {
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
  commandValue: ApplicationCommand,
  code: ApplicationErrorCode,
  message: string,
): CommandFailure {
  return {
    protocolVersion: '0.1',
    commandId: commandValue.commandId,
    ...(commandValue.correlationId === undefined
      ? {}
      : { correlationId: commandValue.correlationId }),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
