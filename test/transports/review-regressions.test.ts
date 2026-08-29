import { describe, expect, it } from 'vitest';
import { IN_MEMORY_UNSUPPORTED_COMMANDS } from '../../src/application/in-memory-dispatcher.ts';
import { parseApplicationCommand } from '../../src/application/validation.ts';

const envelope = {
  protocolVersion: '0.1',
  workspaceId: 'ws-1',
  actor: { type: 'agent', id: 'agent-1' },
} as const;
const executor = { taskId: 'task-1', sessionId: 'session-1', leaseId: 'lease-1', fencingToken: 1 };

describe('transport integration regressions', () => {
  it('accepts canonical BlockTask without a duplicate summary field', () => {
    expect(
      parseApplicationCommand('BlockTask', {
        ...envelope,
        ...executor,
        commandId: 'cmd-block',
        expectedTaskRevision: 2,
        reason: { code: 'task.blocked', summary: 'Need input.' },
        evidence: [],
      }).ok,
    ).toBe(true);
  });
  it('preserves the canonical FailTask summary requirement', () => {
    const fail = {
      ...envelope,
      ...executor,
      commandId: 'cmd-fail',
      expectedTaskRevision: 2,
      reason: { code: 'task.failed', summary: 'Failed.' },
      evidence: [],
    };
    expect(parseApplicationCommand('FailTask', fail).ok).toBe(false);
    expect(parseApplicationCommand('FailTask', { ...fail, summary: 'Execution failed.' }).ok).toBe(
      true,
    );
  });
  it('delegates every currently implemented runtime mutation', () => {
    expect(IN_MEMORY_UNSUPPORTED_COMMANDS).toEqual(['RegisterAgent', 'StartSession']);
  });
  it('rejects noncanonical permission input before dispatch', () => {
    const base = {
      ...envelope,
      ...executor,
      commandId: 'cmd-permission',
      justification: 'Need repository write.',
    };
    expect(
      parseApplicationCommand('RequestPermission', { ...base, permission: 'NOT VALID' }).ok,
    ).toBe(false);
    expect(
      parseApplicationCommand('RequestPermission', {
        ...base,
        commandId: 'cmd-long',
        permission: 'repository.write',
        justification: 'x'.repeat(2001),
      }).ok,
    ).toBe(false);
  });
});
