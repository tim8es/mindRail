/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */

export type EntityId = string;
export type UtcDateTime = string;
export type NamespacedName = string;

export interface AuditEvent {
  id: EntityId;
  workspaceId: EntityId;
  createdAt: UtcDateTime;
  eventType: NamespacedName;
  actor: ActorRef;
  subject: ResourceRef;
  correlationId: EntityId;
  /**
   * @maxItems 16
   */
  related?:
    | []
    | [ResourceRef]
    | [ResourceRef, ResourceRef]
    | [ResourceRef, ResourceRef, ResourceRef]
    | [ResourceRef, ResourceRef, ResourceRef, ResourceRef]
    | [ResourceRef, ResourceRef, ResourceRef, ResourceRef, ResourceRef]
    | [ResourceRef, ResourceRef, ResourceRef, ResourceRef, ResourceRef, ResourceRef]
    | [ResourceRef, ResourceRef, ResourceRef, ResourceRef, ResourceRef, ResourceRef, ResourceRef]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ]
    | [
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
        ResourceRef,
      ];
  transition?: {
    from: string;
    to: string;
  };
  attributes?: {
    [k: string]: string | number | boolean | null;
  };
}
export interface ActorRef {
  type: 'system' | 'human' | 'agent';
  id: EntityId;
}
export interface ResourceRef {
  type: NamespacedName;
  id: EntityId;
}
