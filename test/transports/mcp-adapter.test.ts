import { describe, expect, it, vi } from 'vitest';

import { createMcpTransport } from '../../src/transports/mcp/adapter.ts';

const principal = { subject: 'principal-1' };

function createDependencies() {
  const dispatchCommand = vi.fn(async () => ({
    protocolVersion: '0.1' as const,
    commandId: 'cmd-1',
    correlationId: 'corr-1',
    replayed: false,
    result: { id: 'goal-1' },
  }));
  const dispatchQuery = vi.fn(async () => ({
    protocolVersion: '0.1' as const,
    correlationId: 'corr-1',
    result: { id: 'ws-1' },
  }));
  const authorize = vi.fn(async () => true);

  return {
    dispatcher: { dispatchCommand, dispatchQuery },
    authorizer: { authorize },
    dispatchCommand,
    dispatchQuery,
    authorize,
  };
}

function createGoalArgs(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: '0.1',
    commandId: 'cmd-1',
    workspaceId: 'ws-1',
    actor: { type: 'human', id: 'human-1' },
    correlationId: 'corr-1',
    title: 'MCP goal',
    objective: 'Keep MCP as a semantic adapter.',
    successCriteria: ['Only explicit MindRail operations are exposed.'],
    ...overrides,
  };
}

describe('MCP v0.1 semantic adapter', () => {
  it('exposes only explicit accepted MindRail command/query tools', () => {
    const transport = createMcpTransport(createDependencies());
    const tools = transport.listTools();
    const names = tools.map((tool) => tool.name);

    expect(names).toEqual([
      'mindrail_register_agent',
      'mindrail_start_session',
      'mindrail_heartbeat_session',
      'mindrail_end_session',
      'mindrail_create_goal',
      'mindrail_create_task',
      'mindrail_claim_task',
      'mindrail_renew_lease',
      'mindrail_release_lease',
      'mindrail_record_checkpoint',
      'mindrail_complete_task',
      'mindrail_fail_task',
      'mindrail_block_task',
      'mindrail_resume_task',
      'mindrail_retry_task',
      'mindrail_cancel_task',
      'mindrail_cancel_goal',
      'mindrail_request_permission',
      'mindrail_record_permission_decision',
      'mindrail_get_workspace',
      'mindrail_get_goal',
      'mindrail_list_goals',
      'mindrail_get_task',
      'mindrail_list_goal_tasks',
      'mindrail_list_claimable_tasks',
      'mindrail_get_task_execution_view',
      'mindrail_list_task_checkpoints',
      'mindrail_get_agent',
      'mindrail_get_session',
      'mindrail_get_lease',
      'mindrail_get_permission_request',
      'mindrail_list_pending_human_permissions',
      'mindrail_list_permission_decisions',
    ]);
    expect(names).not.toEqual(
      expect.arrayContaining([
        'execute_action',
        'update_entity',
        'patch_object',
        'shell',
        'filesystem',
        'browser',
      ]),
    );
    for (const tool of tools) {
      const expected = expect.objectContaining({ additionalProperties: false });
      expect(tool.inputSchema).toEqual(expected);
    }
  });

  it('rejects invalid MCP arguments before principal binding or dispatch', async () => {
    const deps = createDependencies();
    const transport = createMcpTransport(deps);
    const args = createGoalArgs({
      commandId: '',
      unexpectedAuthority: 'allow',
    });

    const response = await transport.callTool(
      'mindrail_create_goal',
      args,
      principal,
    );

    expect(response).toEqual(
      expect.objectContaining({
        protocolVersion: '0.1',
        error: expect.objectContaining({ code: 'INVALID_INPUT' }),
      }),
    );
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });

  it('fails closed principal binding before MCP dispatch', async () => {
    const deps = createDependencies();
    deps.authorize.mockResolvedValue(false);
    const transport = createMcpTransport(deps);

    const response = await transport.callTool(
      'mindrail_create_goal',
      createGoalArgs(),
      principal,
    );

    expect(response).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'ACTOR_NOT_AUTHORIZED' }),
      }),
    );
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });

  it('preserves command tracing/idempotency fields and delegates once', async () => {
    const deps = createDependencies();
    const transport = createMcpTransport(deps);
    const args = createGoalArgs({ causationId: 'cause-1' });

    const response = await transport.callTool(
      'mindrail_create_goal',
      args,
      principal,
    );

    expect(response).toEqual({
      protocolVersion: '0.1',
      commandId: 'cmd-1',
      correlationId: 'corr-1',
      replayed: false,
      result: { id: 'goal-1' },
    });
    expect(deps.dispatchCommand).toHaveBeenCalledTimes(1);
    expect(deps.dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'CreateGoal',
        commandId: 'cmd-1',
        correlationId: 'corr-1',
        causationId: 'cause-1',
      }),
    );
  });

  it('maps explicit read tools only to the query dispatcher', async () => {
    const deps = createDependencies();
    const transport = createMcpTransport(deps);
    const args = {
      protocolVersion: '0.1',
      workspaceId: 'ws-1',
      actor: { type: 'human', id: 'human-1' },
      correlationId: 'corr-1',
    };

    const response = await transport.callTool(
      'mindrail_get_workspace',
      args,
      principal,
    );

    expect(response).toEqual({
      protocolVersion: '0.1',
      correlationId: 'corr-1',
      result: { id: 'ws-1' },
    });
    expect(deps.dispatchQuery).toHaveBeenCalledTimes(1);
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });

  it('returns bounded unsupported results for accepted parallel operations', async () => {
    const deps = createDependencies();
    deps.dispatchCommand.mockResolvedValueOnce({
      protocolVersion: '0.1',
      commandId: 'cmd-heartbeat',
      replayed: false,
      error: {
        code: 'UNSUPPORTED_OPERATION',
        message: 'HeartbeatSession is not integrated in this runtime composition.',
        retryable: false,
      },
    });
    const transport = createMcpTransport(deps);
    const args = {
      protocolVersion: '0.1',
      commandId: 'cmd-heartbeat',
      workspaceId: 'ws-1',
      actor: { type: 'agent', id: 'agent-1' },
      sessionId: 'session-1',
      expectedSessionRevision: 1,
    };

    const response = await transport.callTool(
      'mindrail_heartbeat_session',
      args,
      principal,
    );

    expect(response).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'UNSUPPORTED_OPERATION' }),
      }),
    );
    expect(deps.dispatchCommand).toHaveBeenCalledTimes(1);
  });

  it('does not leak principal or authorization exception details', async () => {
    const deps = createDependencies();
    const error = new Error('Authorization: Bearer mcp-super-secret');
    deps.authorize.mockRejectedValue(error);
    const transport = createMcpTransport(deps);

    const response = await transport.callTool(
      'mindrail_create_goal',
      createGoalArgs(),
      { subject: 'mcp-principal-secret' },
    );
    const serialized = JSON.stringify(response);

    expect(serialized).toContain('ACTOR_NOT_AUTHORIZED');
    expect(serialized).not.toContain('mcp-super-secret');
    expect(serialized).not.toContain('mcp-principal-secret');
    expect(serialized).not.toContain('Error:');
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });
});
