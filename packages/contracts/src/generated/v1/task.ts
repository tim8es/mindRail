/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type EntityId = string;
export type UtcDateTime = string;
export type NamespacedName = string;

export interface Task {
  id: EntityId;
  workspaceId: EntityId;
  goalId: EntityId;
  revision: number;
  createdAt: UtcDateTime;
  updatedAt: UtcDateTime;
  title: string;
  objective: string;
  /**
   * @minItems 1
   * @maxItems 32
   */
  acceptanceCriteria: [string, ...string[]];
  /**
   * @maxItems 64
   */
  requiredCapabilities: NamespacedName[];
  /**
   * @maxItems 128
   */
  dependencyTaskIds: EntityId[];
  status: 'pending' | 'ready' | 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled';
  statusReason?: Reason;
}
export interface Reason {
  code: NamespacedName;
  summary: string;
}
