import type { PermissionDecision, PolicyRef, ResourceRef } from '@mindrail/contracts';

export interface PermissionPolicyInput {
  permission: string;
  resource?: ResourceRef;
}

export interface PermissionPolicyEvaluation {
  outcome: PermissionDecision['outcome'];
  reasonCode: string;
}

export interface PermissionPolicy {
  readonly ref: PolicyRef;
  evaluate(input: Readonly<PermissionPolicyInput>): PermissionPolicyEvaluation;
}

export const PERMISSION_POLICY_V0_1_REF = {
  id: 'mindrail.permission',
  version: '0.1.0',
} as const satisfies PolicyRef;

const DEFAULT_DENY: PermissionPolicyEvaluation = {
  outcome: 'DENY',
  reasonCode: 'policy.no_matching_rule',
};

const RULES: Readonly<Record<string, PermissionPolicyEvaluation>> = {
  'workspace.read': {
    outcome: 'ALLOW',
    reasonCode: 'policy.automatic_allow',
  },
  'external.publish': {
    outcome: 'DENY',
    reasonCode: 'policy.denied',
  },
  'repository.write': {
    outcome: 'HUMAN_REQUIRED',
    reasonCode: 'policy.human_required',
  },
};

export const permissionPolicyV01: PermissionPolicy = {
  ref: PERMISSION_POLICY_V0_1_REF,
  evaluate(input) {
    return { ...(RULES[input.permission] ?? DEFAULT_DENY) };
  },
};
