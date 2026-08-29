import type { Agent, Session } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import { InMemoryControlPlane } from '../../src/runtime/in-memory-control-plane.ts';
import type { ProtocolCommand, ProtocolResponse } from '../../src/runtime/protocol.ts';
import { canonicalDomainValidator } from './canonical-domain-validator.ts';

function createRuntime() {
  let sequence = 0;
  const now = new Date('2026-08-29T18:00:00.000Z');
  return new InMemoryControlPlane({
    workspaceId: 'ws-1',
    workspaceName: 'Bootstrap E2E',
    now: () => new Date(now),
    idFactory: (kind) => `${kind}-${++sequence}`,
    leaseDurationMs: 120_000,
    sessionTimeoutMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  });
}

function executeFuture<T>(
  runtime: InMemoryControlPlane,
  command: Record<string, unknown>,
): ProtocolResponse<T> {
  return runtime.execute(command as unknown as ProtocolCommand) as ProtocolResponse<T>;
}

function expectSuccess<T>(response: ProtocolResponse<T>): T {
  expect('error' in response).toBe(false);
  if ('error' in response) throw new Error(`Expected success, received ${response.error.code}.`);
  return response.result;
}

function expectFailure(response: ProtocolResponse, code: string): void {
  expect('error' in response && response.error.code).toBe(code);
}

describe('bootstrap protocol commands', () => {
  it('registers an Agent through the canonical command boundary and replays immutably', () => {
    const runtime = createRuntime();
    const command = {
      protocolVersion: '0.1',
      command: 'RegisterAgent',
      commandId: 'cmd-register-agent',
      workspaceId: 'ws-1',
      actor: { type: 'system', id: 'system-1' },
      correlationId: 'corr-register-1',
      displayName: 'Coding worker',
      capabilities: ['code.execute'],
    };

    const first = executeFuture<Agent>(runtime, command);
    const agent = expectSuccess(first);
    expect(agent).toMatchObject({
      workspaceId: 'ws-1',
      revision: 1,
      displayName: 'Coding worker',
      status: 'active',
      capabilities: ['code.execute'],
    });
    expect(first.replayed).toBe(false);

    agent.displayName = 'caller mutation';
    const replay = executeFuture<Agent>(runtime, {
      ...command,
      correlationId: 'corr-register-2',
    });
    const replayedAgent = expectSuccess(replay);
    expect(replay.replayed).toBe(true);
    expect(replay.correlationId).toBe('corr-register-2');
    expect(replayedAgent.displayName).toBe('Coding worker');
  });

  it('starts a Session through the canonical command boundary and rejects command-id semantic drift', () => {
    const runtime = createRuntime();
    const agent = expectSuccess<Agent>(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'RegisterAgent',
        commandId: 'cmd-register-for-session',
        workspaceId: 'ws-1',
        actor: { type: 'system', id: 'system-1' },
        displayName: 'Session worker',
        capabilities: ['code.execute'],
      }),
    );

    const start = executeFuture<Session>(runtime, {
      protocolVersion: '0.1',
      command: 'StartSession',
      commandId: 'cmd-start-session',
      workspaceId: 'ws-1',
      actor: { type: 'system', id: 'system-1' },
      agentId: agent.id,
    });
    const session = expectSuccess(start);
    expect(session).toMatchObject({
      workspaceId: 'ws-1',
      agentId: agent.id,
      revision: 1,
      status: 'active',
    });

    const conflict = executeFuture(runtime, {
      protocolVersion: '0.1',
      command: 'StartSession',
      commandId: 'cmd-start-session',
      workspaceId: 'ws-1',
      actor: { type: 'system', id: 'system-1' },
      agentId: 'agent-different',
    });
    expectFailure(conflict, 'IDEMPOTENCY_CONFLICT');
  });

  it('fails closed for invalid capabilities and unknown session Agent references', () => {
    const runtime = createRuntime();

    expectFailure(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'RegisterAgent',
        commandId: 'cmd-register-invalid-capability',
        workspaceId: 'ws-1',
        actor: { type: 'system', id: 'system-1' },
        displayName: 'Invalid worker',
        capabilities: ['CODE EXECUTE'],
      }),
      'INVALID_INPUT',
    );

    expectFailure(
      executeFuture(runtime, {
        protocolVersion: '0.1',
        command: 'StartSession',
        commandId: 'cmd-start-missing-agent',
        workspaceId: 'ws-1',
        actor: { type: 'system', id: 'system-1' },
        agentId: 'agent-missing',
      }),
      'NOT_FOUND',
    );
  });
});
