export type RuntimeErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REVISION_MISMATCH'
  | 'LEASE_NOT_ACTIVE'
  | 'LEASE_EXPIRED'
  | 'STALE_FENCING_TOKEN'
  | 'INVALID_STATE_TRANSITION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'ACTOR_NOT_AUTHORIZED'
  | 'SESSION_NOT_ACTIVE'
  | 'CAPABILITY_MISMATCH';

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}
