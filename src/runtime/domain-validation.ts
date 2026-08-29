export type CanonicalDomainTarget =
  | 'Workspace'
  | 'Agent'
  | 'Session'
  | 'Goal'
  | 'Task'
  | 'Lease'
  | 'Checkpoint'
  | 'PermissionRequest'
  | 'PermissionDecision'
  | 'Reason';

export interface CanonicalDomainValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly string[];
}

export type CanonicalDomainValidator = (
  target: CanonicalDomainTarget,
  value: unknown,
) => CanonicalDomainValidationResult;
