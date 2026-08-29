/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type EntityId = string;
export type UtcDateTime = string;
export type NamespacedName = string;

export interface PermissionRequest {
  id: EntityId;
  workspaceId: EntityId;
  taskId: EntityId;
  sessionId: EntityId;
  leaseId: EntityId;
  fencingToken: number;
  createdAt: UtcDateTime;
  permission: NamespacedName;
  justification: string;
  resource?: ResourceRef;
}
export interface ResourceRef {
  type: NamespacedName;
  id: EntityId;
}
