import type {
  ActorRef,
  PermissionDecision,
  PermissionRequest,
  ResourceRef,
} from '@mindrail/contracts';

import type { PermissionPolicy, PermissionPolicyEvaluation } from '../policy/permission-policy.ts';
import type { CanonicalDomainTarget, CanonicalDomainValidator } from './domain-validation.ts';
import { RuntimeError } from './errors.ts';

const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const NAMESPACED_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const POLICY_SYSTEM_ACTOR = { type: 'system', id: 'mindrail.permission-policy' } as const;

export interface PermissionExecutionAuthority {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
}

export interface RequestPermissionInput extends PermissionExecutionAuthority {
  permission: string;
  justification: string;
  resource?: ResourceRef;
}

export interface RequestPermissionResult {
  request: PermissionRequest;
  decision: PermissionDecision;
}

export interface RecordPermissionDecisionInput {
  workspaceId: string;
  requestId: string;
  actor: ActorRef;
  outcome: 'ALLOW' | 'DENY';
  expectedPreviousDecisionId: string;
  reasonCode: string;
  reason?: string;
}

export interface PermissionGrantAuthority extends PermissionExecutionAuthority {
  requestId: string;
}

export interface InMemoryPermissionServiceOptions {
  now: () => Date;
  idFactory: (kind: string) => string;
  validateCanonicalDomainRecord: CanonicalDomainValidator;
  policy: PermissionPolicy;
  assertExecutionAuthority: (authority: PermissionExecutionAuthority) => void;
}

export class InMemoryPermissionService {
  private readonly now: () => Date;
  private readonly idFactory: (kind: string) => string;
  private readonly validateCanonicalDomainRecord: CanonicalDomainValidator;
  private readonly policy: PermissionPolicy;
  private readonly assertExecutionAuthority: (authority: PermissionExecutionAuthority) => void;

  private readonly requests = new Map<string, PermissionRequest>();
  private readonly decisionsByRequest = new Map<string, PermissionDecision[]>();

  constructor(options: InMemoryPermissionServiceOptions) {
    this.now = options.now;
    this.idFactory = options.idFactory;
    this.validateCanonicalDomainRecord = options.validateCanonicalDomainRecord;
    this.policy = options.policy;
    this.assertExecutionAuthority = options.assertExecutionAuthority;
  }

  requestPermission(input: RequestPermissionInput): RequestPermissionResult {
    this.assertExecutionAuthority(input);

    const request: PermissionRequest = {
      id: this.idFactory('permission-request'),
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken,
      createdAt: this.timestamp(),
      permission: input.permission,
      justification: input.justification,
      ...(input.resource === undefined ? {} : { resource: clone(input.resource) }),
    };
    this.assertCanonical('PermissionRequest', request);

    const evaluation = this.evaluatePolicy(request);
    const decision: PermissionDecision = {
      id: this.idFactory('permission-decision'),
      workspaceId: request.workspaceId,
      requestId: request.id,
      createdAt: this.timestamp(),
      sequence: 1,
      outcome: evaluation.outcome,
      basis: 'policy',
      decidedBy: POLICY_SYSTEM_ACTOR,
      reasonCode: evaluation.reasonCode,
      policyRef: clone(this.policy.ref),
    };
    this.assertCanonical('PermissionDecision', decision);

    this.requests.set(request.id, request);
    this.decisionsByRequest.set(request.id, [decision]);
    return { request: clone(request), decision: clone(decision) };
  }

  recordPermissionDecision(input: RecordPermissionDecisionInput): PermissionDecision {
    const request = this.requireRequest(input.workspaceId, input.requestId);
    if (input.actor.type !== 'human') {
      throw new RuntimeError(
        'ACTOR_NOT_AUTHORIZED',
        `Actor ${input.actor.type}:${input.actor.id} cannot record a human permission decision.`,
      );
    }
    if (input.outcome !== 'ALLOW' && input.outcome !== 'DENY') {
      throw new RuntimeError('INVALID_INPUT', 'Human permission outcome must be ALLOW or DENY.');
    }

    const decisions = this.decisionsByRequest.get(request.id);
    const latest = decisions?.at(-1);
    if (!decisions || !latest) {
      throw new RuntimeError('CONFLICT', `PermissionRequest ${request.id} has no policy decision.`);
    }
    if (latest.id !== input.expectedPreviousDecisionId) {
      throw new RuntimeError(
        'CONFLICT',
        `PermissionDecision ${input.expectedPreviousDecisionId} is not the latest predecessor.`,
      );
    }
    if (latest.outcome !== 'HUMAN_REQUIRED') {
      throw new RuntimeError(
        'INVALID_STATE_TRANSITION',
        `PermissionRequest ${request.id} is not awaiting a human decision.`,
      );
    }

    const decision: PermissionDecision = {
      id: this.idFactory('permission-decision'),
      workspaceId: request.workspaceId,
      requestId: request.id,
      createdAt: this.timestamp(),
      sequence: latest.sequence + 1,
      outcome: input.outcome,
      basis: 'human',
      decidedBy: clone(input.actor),
      reasonCode: input.reasonCode,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      supersedesDecisionId: latest.id,
    };
    this.assertCanonical('PermissionDecision', decision);
    decisions.push(decision);
    return clone(decision);
  }

  getPermissionRequest(workspaceId: string, requestId: string): PermissionRequest {
    return clone(this.requireRequest(workspaceId, requestId));
  }

  listPermissionDecisions(workspaceId: string, requestId: string): PermissionDecision[] {
    const request = this.requireRequest(workspaceId, requestId);
    return clone(this.decisionsByRequest.get(request.id) ?? []);
  }

  isPermissionGrantEffective(input: PermissionGrantAuthority): boolean {
    const request = this.requireRequest(input.workspaceId, input.requestId);
    if (
      request.taskId !== input.taskId ||
      request.sessionId !== input.sessionId ||
      request.leaseId !== input.leaseId ||
      request.fencingToken !== input.fencingToken
    ) {
      return false;
    }

    const latest = this.decisionsByRequest.get(request.id)?.at(-1);
    if (latest?.outcome !== 'ALLOW') {
      return false;
    }

    try {
      this.assertExecutionAuthority(input);
      return true;
    } catch (error) {
      if (error instanceof RuntimeError) {
        return false;
      }
      throw error;
    }
  }

  private evaluatePolicy(request: PermissionRequest): PermissionPolicyEvaluation {
    try {
      if (!isPolicyRef(this.policy.ref)) {
        throw new Error('PolicyRef is invalid.');
      }
      const evaluation = this.policy.evaluate({
        permission: request.permission,
        ...(request.resource === undefined ? {} : { resource: clone(request.resource) }),
      });
      if (!isPolicyEvaluation(evaluation)) {
        throw new Error('Policy evaluation result is invalid.');
      }
      return { outcome: evaluation.outcome, reasonCode: evaluation.reasonCode };
    } catch {
      throw new RuntimeError(
        'POLICY_UNAVAILABLE',
        'Deterministic permission policy evaluation is unavailable or invalid.',
      );
    }
  }

  private requireRequest(workspaceId: string, requestId: string): PermissionRequest {
    const request = this.requests.get(requestId);
    if (!request || request.workspaceId !== workspaceId) {
      throw new RuntimeError('NOT_FOUND', `PermissionRequest ${requestId} was not found.`);
    }
    return request;
  }

  private assertCanonical(target: CanonicalDomainTarget, value: unknown): void {
    const validation = this.validateCanonicalDomainRecord(target, value);
    if (validation.valid) {
      return;
    }
    const details = validation.errors?.slice(0, 3).join('; ');
    const message =
      details === undefined || details.length === 0
        ? `${target} violates canonical domain schema.`
        : `${target} violates canonical domain schema. ${details}`;
    throw new RuntimeError('INVALID_INPUT', message);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function isPolicyRef(value: PermissionPolicy['ref']): boolean {
  return (
    ENTITY_ID_PATTERN.test(value.id) &&
    typeof value.version === 'string' &&
    value.version.length >= 1 &&
    value.version.length <= 128
  );
}

function isPolicyEvaluation(value: PermissionPolicyEvaluation): boolean {
  return (
    (value.outcome === 'ALLOW' ||
      value.outcome === 'DENY' ||
      value.outcome === 'HUMAN_REQUIRED') &&
    typeof value.reasonCode === 'string' &&
    NAMESPACED_NAME_PATTERN.test(value.reasonCode) &&
    value.reasonCode.length <= 128
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
