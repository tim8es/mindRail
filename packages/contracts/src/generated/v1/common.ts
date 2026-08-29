/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

/**
 * This interface was referenced by `MindRailCommonDefinitions`'s JSON-Schema
 * via the `definition` "EntityId".
 */
export type EntityId = string;
/**
 * This interface was referenced by `MindRailCommonDefinitions`'s JSON-Schema
 * via the `definition` "UtcDateTime".
 */
export type UtcDateTime = string;
/**
 * This interface was referenced by `MindRailCommonDefinitions`'s JSON-Schema
 * via the `definition` "NamespacedName".
 */
export type NamespacedName = string;

export interface MindRailCommonDefinitions {}
/**
 * This interface was referenced by `MindRailCommonDefinitions`'s JSON-Schema
 * via the `definition` "ActorRef".
 */
export interface ActorRef {
  type: 'system' | 'human' | 'agent';
  id: EntityId;
}
/**
 * This interface was referenced by `MindRailCommonDefinitions`'s JSON-Schema
 * via the `definition` "ResourceRef".
 */
export interface ResourceRef {
  type: NamespacedName;
  id: EntityId;
}
/**
 * This interface was referenced by `MindRailCommonDefinitions`'s JSON-Schema
 * via the `definition` "EvidenceRef".
 */
export interface EvidenceRef {
  uri: string;
  mediaType?: string;
  sha256?: string;
  sizeBytes?: number;
}
/**
 * This interface was referenced by `MindRailCommonDefinitions`'s JSON-Schema
 * via the `definition` "PolicyRef".
 */
export interface PolicyRef {
  id: EntityId;
  version: string;
}
/**
 * This interface was referenced by `MindRailCommonDefinitions`'s JSON-Schema
 * via the `definition` "Reason".
 */
export interface Reason {
  code: NamespacedName;
  summary: string;
}
