/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type PermissionDecision = {
  [k: string]: unknown;
} & {
  id: EntityId;
  workspaceId: EntityId;
  requestId: EntityId;
  createdAt: UtcDateTime;
  sequence: number;
  outcome: 'ALLOW' | 'DENY' | 'HUMAN_REQUIRED';
  basis: 'policy' | 'human';
  decidedBy: ActorRef;
  reasonCode: NamespacedName;
  policyRef?: PolicyRef;
  reason?: string;
  supersedesDecisionId?: EntityId;
};
export type EntityId = string;
export type UtcDateTime = string;
export type NamespacedName = string;

export interface ActorRef {
  type: 'system' | 'human' | 'agent';
  id: EntityId;
}
export interface PolicyRef {
  id: EntityId;
  version: string;
}
