/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type EntityId = string;
export type UtcDateTime = string;

export interface Lease {
  id: EntityId;
  workspaceId: EntityId;
  taskId: EntityId;
  sessionId: EntityId;
  revision: number;
  createdAt: UtcDateTime;
  updatedAt: UtcDateTime;
  status: 'active' | 'released' | 'expired' | 'revoked';
  fencingToken: number;
  expiresAt: UtcDateTime;
}
