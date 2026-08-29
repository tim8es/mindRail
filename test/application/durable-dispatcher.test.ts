import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Session } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import type { ApplicationDispatcher } from '../../src/application/ports.ts';
import type { DurableRuntimePersistence } from '../../src/persistence/ports.ts';
import { agent, workspace } from '../persistence/fixtures.ts';
import { openPersistence } from '../persistence/setup.ts';
import { canonicalDomainValidator } from '../runtime/canonical-domain-validator.ts';

interface DurableDispatcherOptions {
  persistence: DurableRuntimePersistence;
  now: () => Date;
  idFactory: (kind: string) => string;
  leaseDurationMs: number;
  sessionTimeoutMs: number;
  validateCanonicalDomainRecord: typeof canonicalDomainValidator;
}

type DurableDispatcherFactory = (options: DurableDispatcherOptions) => ApplicationDispatcher;

async function loadFactory(): Promise<DurableDispatcherFactory> {
  const modulePath = '../../src/application/durable-dispatcher.ts';
  const module = (await import(modulePath)) as {
    createDurableApplicationDispatcher: DurableDispatcherFactory;
  };
  return module.createDurableApplicationDispatcher;
}

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-durable-dispatcher-')), 'runtime.sqlite');
}

function factoryOptions(
  persistence: DurableRuntimePersistence,
  prefix: string,
): DurableDispatcherOptions {
  let sequence = 0;
  return {
    persistence,
    now: () => new Date('2026-08-29T18:00:00.000Z'),
    idFactory: (kind) => `${prefix}-${kind}-${++sequence}`,
    leaseDurationMs: 120_000,
    sessionTimeoutMs: 60_000,
    validateCanonicalDomainRecord: canonicalDomainValidator,
  };
}

function registerAgentCommand(correlationId = 'corr-register', displayName = 'Durable worker') {
  return {
    protocolVersion: '0.1' as const,
    command: 'RegisterAgent' as const,
    commandId: 'cmd-register',
    workspaceId: 'ws-a',
    actor: { type: 'system' as const, id: 'system-1' },
    correlationId,
    displayName,
    capabilities: ['code.execute'],
  };
}

function successResult<T>(
  response: Awaited<ReturnType<ApplicationDispatcher['dispatchCommand']>>,
): T {
  expect('error' in response).toBe(false);
  if ('error' in response) throw new Error(`Expected success, got ${response.error.code}.`);
  return response.result as T;
}

describe('durable application dispatcher', () => {
  it('persists RegisterAgent and reloads authoritative state for the next command', async () => {
    const path = databasePath();
    const opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const createDispatcher = await loadFactory();
    const dispatcher = createDispatcher(factoryOptions(opened.persistence, 'a'));

    const registered = await dispatcher.dispatchCommand(registerAgentCommand());
    const registeredAgent = successResult<Agent>(registered);
    expect(registeredAgent.displayName).toBe('Durable worker');

    const externallyPersisted = agent('ws-a', 'agent-external');
    await opened.persistence.createAgent({ agent: externallyPersisted });
    const started = await dispatcher.dispatchCommand({
      protocolVersion: '0.1',
      command: 'StartSession',
      commandId: 'cmd-start-external',
      workspaceId: 'ws-a',
      actor: { type: 'system', id: 'system-1' },
      agentId: externallyPersisted.id,
    });
    const session = successResult<Session>(started);
    expect(session.agentId).toBe(externallyPersisted.id);

    const snapshot = await opened.persistence.loadWorkspaceState('ws-a');
    expect(snapshot?.agents).toHaveLength(2);
    expect(snapshot?.sessions).toHaveLength(1);
    opened.database.close();
  });

  it('replays an immutable durable receipt after application restart', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const createDispatcher = await loadFactory();
    const firstDispatcher = createDispatcher(factoryOptions(opened.persistence, 'first'));
    const first = await firstDispatcher.dispatchCommand(registerAgentCommand('corr-first'));
    const firstAgent = successResult<Agent>(first);
    expect(first.replayed).toBe(false);

    opened.database.close();
    opened = await openPersistence(path);
    const secondDispatcher = createDispatcher(factoryOptions(opened.persistence, 'second'));
    const replay = await secondDispatcher.dispatchCommand(registerAgentCommand('corr-second'));
    const replayedAgent = successResult<Agent>(replay);
    expect(replay.replayed).toBe(true);
    expect(replay.correlationId).toBe('corr-second');
    expect(replayedAgent).toEqual(firstAgent);
    expect((await opened.persistence.loadWorkspaceState('ws-a'))?.agents).toHaveLength(1);
    opened.database.close();
  });

  it('rejects semantic command-id drift from the durable receipt', async () => {
    const path = databasePath();
    const opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const createDispatcher = await loadFactory();
    const dispatcher = createDispatcher(factoryOptions(opened.persistence, 'drift'));
    successResult<Agent>(await dispatcher.dispatchCommand(registerAgentCommand()));

    const conflict = await dispatcher.dispatchCommand(
      registerAgentCommand('corr-drift', 'Different semantic intent'),
    );
    expect('error' in conflict && conflict.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await opened.persistence.loadWorkspaceState('ws-a'))?.agents).toHaveLength(1);
    opened.database.close();
  });

  it('returns a bounded NOT_FOUND envelope for an unknown durable Workspace', async () => {
    const path = databasePath();
    const opened = await openPersistence(path);
    const createDispatcher = await loadFactory();
    const dispatcher = createDispatcher(factoryOptions(opened.persistence, 'missing'));

    const response = await dispatcher.dispatchCommand(registerAgentCommand());
    expect('error' in response && response.error).toEqual(
      expect.objectContaining({ code: 'NOT_FOUND', retryable: false }),
    );
    opened.database.close();
  });
});
