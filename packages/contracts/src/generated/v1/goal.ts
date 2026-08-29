/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type EntityId = string;
export type UtcDateTime = string;

export interface Goal {
  id: EntityId;
  workspaceId: EntityId;
  revision: number;
  createdAt: UtcDateTime;
  updatedAt: UtcDateTime;
  title: string;
  objective: string;
  /**
   * @minItems 1
   * @maxItems 32
   */
  successCriteria: [string, ...string[]];
  status: 'active' | 'succeeded' | 'failed' | 'cancelled';
}
