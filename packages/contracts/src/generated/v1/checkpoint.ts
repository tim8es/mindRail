/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type EntityId = string;
export type UtcDateTime = string;

export interface Checkpoint {
  id: EntityId;
  workspaceId: EntityId;
  taskId: EntityId;
  sessionId: EntityId;
  leaseId: EntityId;
  fencingToken: number;
  createdAt: UtcDateTime;
  kind: 'progress' | 'handoff' | 'blocked' | 'result';
  summary: string;
  /**
   * @maxItems 32
   */
  evidence: EvidenceRef[];
  progressPercent?: number;
}
export interface EvidenceRef {
  uri: string;
  mediaType?: string;
  sha256?: string;
  sizeBytes?: number;
}
