/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type EntityId = string;
export type UtcDateTime = string;

export interface Session {
  id: EntityId;
  workspaceId: EntityId;
  agentId: EntityId;
  revision: number;
  createdAt: UtcDateTime;
  updatedAt: UtcDateTime;
  status: 'active' | 'ended' | 'expired';
  lastSeenAt: UtcDateTime;
  endedAt?: UtcDateTime;
}
