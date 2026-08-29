import type { PermissionPolicy } from '../../src/policy/permission-policy.ts';
import { InMemoryPermissionService } from '../../src/runtime/permission-service.ts';
import { RuntimeError } from '../../src/runtime/errors.ts';
import { describe, expect, it } from 'vitest';

import { canonicalDomainValidator } from './canonical-domain-validator.ts';

function createService(policy: PermissionPolicy) {
  let requestSequence = 0;
  let decisionSequence = 0;
  return new InMemoryPermissionService({
    now: () => new Date('2026-08-29T12:00:00.000Z'),
    idFactory: (kind) => {
      if (kind === 'permission-request') {
        requestSequence += 1;
        return `permission-request-${requestSequence}`;
      }
      decisionSequence += 1;
      return `permission-decision-${decisionSequence}`;
    },
    validateCanonicalDomainRecord: canonicalDomainValidator,
    policy,
    assertExecutionAuthority: () => undefined,
  });
}

function request(service: InMemoryPermissionService) {
  service.requestPermission({
    workspaceId: 'ws-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    leaseId: 'lease-1',
    fencingToken: 1,
    permission: 'workspace.read',
    justification: 'Invalid policy state must fail closed.',
  });
}

function expectPolicyUnavailable(operation: () => unknown): void {
  try {
    operation();
    throw new Error('Expected POLICY_UNAVAILABLE.');
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe('POLICY_UNAVAILABLE');
  }
}

describe('invalid permission policy state', () => {
  it('fails closed when PolicyRef is invalid and appends no request', () => {
    const service = createService({
      ref: { id: 'invalid policy ref', version: '' },
      evaluate: () => ({ outcome: 'ALLOW', reasonCode: 'policy.automatic_allow' }),
    } as unknown as PermissionPolicy);

    expectPolicyUnavailable(() => request(service));
    expect(() => service.getPermissionRequest('ws-1', 'permission-request-1')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });

  it('fails closed when policy evaluation returns an invalid decision shape', () => {
    const service = createService({
      ref: { id: 'mindrail.permission', version: '0.1.0' },
      evaluate: () => ({ outcome: 'ALLOW', reasonCode: 'INVALID REASON' }),
    } as unknown as PermissionPolicy);

    expectPolicyUnavailable(() => request(service));
    expect(() => service.getPermissionRequest('ws-1', 'permission-request-1')).toThrowError(
      expect.objectContaining({ code: 'NOT_FOUND' }),
    );
  });
});
