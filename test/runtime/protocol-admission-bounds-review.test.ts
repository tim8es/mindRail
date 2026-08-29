import { describe, expect, it } from 'vitest';
import { validateProtocolCommand } from '../../src/runtime/protocol-validation.ts';

const base = {
  protocolVersion: '0.1',
  commandId: 'cmd-1',
  workspaceId: 'ws-1',
  actor: { type: 'agent', id: 'agent-1' },
  taskId: 'task-1',
  sessionId: 'session-1',
  leaseId: 'lease-1',
  fencingToken: 1,
};

describe('protocol structural bounds', () => {
  it('rejects malformed and oversized EvidenceRef arrays', () => {
    expect(
      validateProtocolCommand({
        ...base,
        command: 'BlockTask',
        expectedTaskRevision: 1,
        reason: { code: 'task.blocked', summary: 'blocked' },
        evidence: [{ uri: 123 }],
      }).valid,
    ).toBe(false);
    expect(
      validateProtocolCommand({
        ...base,
        command: 'BlockTask',
        expectedTaskRevision: 1,
        reason: { code: 'task.blocked', summary: 'blocked' },
        evidence: Array.from({ length: 33 }, (_, i) => ({ uri: `e-${i}` })),
      }).valid,
    ).toBe(false);
  });
  it('rejects PermissionRequest justification beyond 2000 characters', () => {
    expect(
      validateProtocolCommand({
        ...base,
        command: 'RequestPermission',
        permission: 'repository.write',
        justification: 'x'.repeat(2001),
      }).valid,
    ).toBe(false);
  });
});
