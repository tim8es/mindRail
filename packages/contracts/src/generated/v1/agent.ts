/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type EntityId = string;
export type UtcDateTime = string;
export type NamespacedName = string;

export interface Agent {
  id: EntityId;
  workspaceId: EntityId;
  revision: number;
  createdAt: UtcDateTime;
  updatedAt: UtcDateTime;
  displayName: string;
  status: 'active' | 'disabled';
  /**
   * @maxItems 64
   */
  capabilities: NamespacedName[];
}
