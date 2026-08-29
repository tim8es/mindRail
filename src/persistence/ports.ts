import type {
  Agent,
  AuditEvent,
  Checkpoint,
  Goal,
  Lease,
  PermissionDecision,
  PermissionRequest,
  Session,
  Task,
  Workspace,
} from '@mindrail/contracts';

export type PersistenceDomainTarget =
  | 'Workspace'
  | 'Agent'
  | 'Session'
  | 'Goal'
  | 'Task'
  | 'Lease'
  | 'Checkpoint'
  | 'PermissionRequest'
  | 'PermissionDecision'
  | 'AuditEvent';

export interface PersistenceDomainValidationResult {
  readonly valid: boolean;
  readonly errors?: readonly string[];
}

export type PersistenceDomainValidator = (
  target: PersistenceDomainTarget,
  value: unknown,
) => PersistenceDomainValidationResult;

export type PersistenceErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'REVISION_MISMATCH'
  | 'STALE_AUTHORITY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_STATE_TRANSITION'
  | 'INVALID_RECORD'
  | 'INTEGRITY_ERROR';

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

export interface CommandReceiptInput {
  workspaceId: string;
  commandId: string;
  command: string;
  semanticFingerprint: string;
  outcomeKind: 'result' | 'error';
  responseSnapshot: unknown;
  createdAt: string;
  expiresAt?: string;
}

export type StoredCommandReceipt = Readonly<CommandReceiptInput>;

export type MutationCommitResult<T> =
  | {
      kind: 'committed';
      value: T;
    }
  | {
      kind: 'replayed';
      receipt: StoredCommandReceipt;
    };

export interface WorkspaceStateSnapshot {
  workspace: Workspace;
  goals: Goal[];
  tasks: Task[];
  agents: Agent[];
  sessions: Session[];
  leases: Lease[];
  checkpoints: Checkpoint[];
  permissionRequests: PermissionRequest[];
  permissionDecisions: PermissionDecision[];
  auditEvents: AuditEvent[];
  fencingCounters: Record<string, number>;
}

export interface PendingHumanPermission {
  request: PermissionRequest;
  latestDecision: PermissionDecision;
}

export interface WorkspaceMutationCoordinator {
  runSerialized<T>(workspaceId: string, operation: () => Promise<T>): Promise<T>;
}

export interface ClaimTaskCommitInput {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  expectedTaskRevision: number;
  lease: Omit<Lease, 'fencingToken'>;
  now: string;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}

export interface ClaimTaskCommitValue {
  task: Task;
  lease: Lease;
}

export interface CompleteTaskCommitInput {
  workspaceId: string;
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
  expectedTaskRevision: number;
  now: string;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}

export interface CompleteTaskCommitValue {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
  goal?: Goal;
}

export interface DurableRuntimePersistence {
  bootstrapWorkspace(workspace: Workspace): Promise<void>;
  createAgent(input: {
    agent: Agent;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Agent>>;
  createSession(input: {
    session: Session;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Session>>;
  createGoal(input: {
    goal: Goal;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Goal>>;
  createTask(input: {
    task: Task;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Task>>;
  claimTask(input: ClaimTaskCommitInput): Promise<MutationCommitResult<ClaimTaskCommitValue>>;
  updateTask(input: { task: Task; expectedRevision: number }): Promise<Task>;
  updateGoal(input: { goal: Goal; expectedRevision: number }): Promise<Goal>;
  appendCheckpoint(input: {
    checkpoint: Checkpoint;
    now: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Checkpoint>>;
  completeTask(
    input: CompleteTaskCommitInput,
  ): Promise<MutationCommitResult<CompleteTaskCommitValue>>;
  appendAuditEvent(input: { auditEvent: AuditEvent }): Promise<void>;
  appendPermissionRequestWithInitialDecision(input: {
    request: PermissionRequest;
    decision: PermissionDecision;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<{ request: PermissionRequest; decision: PermissionDecision }>>;
  appendPermissionDecision(input: {
    decision: PermissionDecision;
    expectedPreviousDecisionId: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<PermissionDecision>>;
  getCommandReceipt(
    workspaceId: string,
    commandId: string,
  ): Promise<StoredCommandReceipt | undefined>;
  loadWorkspaceState(workspaceId: string): Promise<WorkspaceStateSnapshot | undefined>;
  listTaskCheckpoints(workspaceId: string, taskId: string): Promise<Checkpoint[]>;
  listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]>;
  listPermissionDecisions(workspaceId: string, requestId: string): Promise<PermissionDecision[]>;
  listPendingHumanPermissions(
    workspaceId: string,
    limit: number,
  ): Promise<PendingHumanPermission[]>;
  listExpiredActiveLeases(workspaceId: string, now: string, limit: number): Promise<Lease[]>;
  listActiveSessionsLastSeenBefore(
    workspaceId: string,
    cutoff: string,
    limit: number,
  ): Promise<Session[]>;
}
