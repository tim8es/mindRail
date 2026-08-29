import { describe, expect, it, vi } from 'vitest';

import { createHttpTransport } from '../../src/transports/http/adapter.ts';

const principal = { subject: 'principal-1' };

function commandBody(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: '0.1',
    commandId: 'cmd-1',
    workspaceId: 'ws-1',
    actor: { type: 'human', id: 'human-1' },
    correlationId: 'corr-1',
    title: 'Transport goal',
    objective: 'Prove the HTTP adapter is only a protocol mapping boundary.',
    successCriteria: ['The dispatcher owns semantic execution.'],
    ...overrides,
  };
}

function jsonRequest(path: string, body: unknown, headers: HeadersInit = {}) {
  return new Request(`https://mindrail.invalid${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

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

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('HTTP v0.1 transport adapter', () => {
  it('fails closed principal binding before application dispatch', async () => {
    const deps = createDependencies();
    deps.authorize.mockResolvedValue(false);
    const transport = createHttpTransport(deps);

    const response = await transport.handle(
      jsonRequest('/v0.1/commands/CreateGoal', commandBody()),
      principal,
    );

    expect(response.status).toBe(403);
    expect((await json(response)).error).toEqual(
      expect.objectContaining({ code: 'ACTOR_NOT_AUTHORIZED' }),
    );
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
    expect(deps.dispatchQuery).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON before application dispatch', async () => {
    const deps = createDependencies();
    const transport = createHttpTransport(deps);
    const response = await transport.handle(
      new Request('https://mindrail.invalid/v0.1/commands/CreateGoal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      }),
      principal,
    );

    expect(response.status).toBe(400);
    expect((await json(response)).error).toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before application dispatch', async () => {
    const deps = createDependencies();
    const transport = createHttpTransport({ ...deps, maxBodyBytes: 32 });
    const response = await transport.handle(
      jsonRequest('/v0.1/commands/CreateGoal', commandBody()),
      principal,
    );

    expect(response.status).toBe(413);
    expect((await json(response)).error).toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(deps.authorize).not.toHaveBeenCalled();
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });

  it('rejects unknown routes and discriminator mismatches deterministically', async () => {
    const deps = createDependencies();
    const transport = createHttpTransport(deps);

    const unknown = await transport.handle(
      jsonRequest('/v0.1/commands/DeleteEverything', commandBody()),
      principal,
    );
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).error).toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));

    const mismatch = await transport.handle(
      jsonRequest('/v0.1/commands/CreateGoal', commandBody({ command: 'CancelGoal' })),
      principal,
    );
    expect(mismatch.status).toBe(400);
    expect((await json(mismatch)).error).toEqual(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });

  it.each([
    ['INVALID_INPUT', 400],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['ACTOR_NOT_AUTHORIZED', 403],
    ['HUMAN_DECISION_REQUIRED', 409],
  ] as const)('preserves canonical error code %s while mapping HTTP status %i', async (code, status) => {
    const deps = createDependencies();
    deps.dispatchCommand.mockResolvedValueOnce({
      protocolVersion: '0.1',
      commandId: 'cmd-1',
      correlationId: 'corr-1',
      replayed: false,
      error: { code, message: 'bounded protocol failure', retryable: false },
    });
    const transport = createHttpTransport(deps);

    const response = await transport.handle(
      jsonRequest('/v0.1/commands/CreateGoal', commandBody()),
      principal,
    );
    const body = await json(response);

    expect(response.status).toBe(status);
    expect(body).toEqual({
      protocolVersion: '0.1',
      commandId: 'cmd-1',
      correlationId: 'corr-1',
      replayed: false,
      error: { code, message: 'bounded protocol failure', retryable: false },
    });
  });

  it('preserves success envelopes and tracing/idempotency fields without minting transport state', async () => {
    const deps = createDependencies();
    const transport = createHttpTransport(deps);

    const response = await transport.handle(
      jsonRequest('/v0.1/commands/CreateGoal', commandBody({ causationId: 'cause-1' })),
      principal,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
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

  it('maps bounded current queries through the same authorization and application seams', async () => {
    const deps = createDependencies();
    const transport = createHttpTransport(deps);
    const response = await transport.handle(
      jsonRequest('/v0.1/queries/GetWorkspace', {
        protocolVersion: '0.1',
        workspaceId: 'ws-1',
        actor: { type: 'human', id: 'human-1' },
        correlationId: 'corr-1',
      }),
      principal,
    );

    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      protocolVersion: '0.1',
      correlationId: 'corr-1',
      result: { id: 'ws-1' },
    });
    expect(deps.dispatchQuery).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'GetWorkspace', workspaceId: 'ws-1' }),
    );
  });

  it('never exposes an authorization exception, credential, or stack trace', async () => {
    const deps = createDependencies();
    deps.authorize.mockRejectedValue(new Error('Bearer super-secret-credential'));
    const transport = createHttpTransport(deps);

    const response = await transport.handle(
      jsonRequest('/v0.1/commands/CreateGoal', commandBody()),
      { subject: 'principal-secret-do-not-echo' },
    );
    const text = await response.text();

    expect(response.status).toBe(403);
    expect(text).toContain('ACTOR_NOT_AUTHORIZED');
    expect(text).not.toContain('super-secret-credential');
    expect(text).not.toContain('principal-secret-do-not-echo');
    expect(text).not.toContain('Error:');
    expect(deps.dispatchCommand).not.toHaveBeenCalled();
  });
});
