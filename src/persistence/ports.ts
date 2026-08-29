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

export interface DeferredCommandReceiptInput<T> {
  workspaceId: string;
  commandId: string;
  command: string;
  semanticFingerprint: string;
  outcomeKind: 'result' | 'error';
  createdAt: string;
  expiresAt?: string;
  buildResponseSnapshot(value: T): unknown;
}

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
  deferredReceipt?: DeferredCommandReceiptInput<ClaimTaskCommitValue>;
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

export interface TaskOutcomeCommitInput {
  workspaceId: string;
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
  expectedTaskRevision: number;
  now: string;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}

export interface TaskOutcomeCommitValue {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
}

export interface CancelTaskCommitInput {
  workspaceId: string;
  task: Task;
  lease?: Lease;
  expectedTaskRevision: number;
  now: string;
  sessionCutoff: string;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}

export interface CancelTaskCommitValue {
  task: Task;
  lease?: Lease;
}

export interface CancelGoalCommitInput {
  workspaceId: string;
  goal: Goal;
  tasks: Task[];
  leases: Lease[];
  expectedGoalRevision: number;
  now: string;
  sessionCutoff: string;
  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}

export interface CancelGoalCommitValue {
  goal: Goal;
  tasks: Task[];
  leases: Lease[];
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
  heartbeatSession(input: {
    session: Session;
    expectedRevision: number;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Session>>;
  endSession(input: {
    session: Session;
    leases: Lease[];
    expectedSessionRevision: number;
    now: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<{ session: Session; leases: Lease[] }>>;
  renewLease(input: {
    lease: Lease;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Lease>>;
  releaseLease(input: {
    lease: Lease;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Lease>>;
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
  failTask(input: TaskOutcomeCommitInput): Promise<MutationCommitResult<TaskOutcomeCommitValue>>;
  blockTask(input: TaskOutcomeCommitInput): Promise<MutationCommitResult<TaskOutcomeCommitValue>>;
  resumeTask(input: {
    task: Task;
    expectedRevision: number;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Task>>;
  retryTask(input: {
    task: Task;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Task>>;
  cancelTask(input: CancelTaskCommitInput): Promise<MutationCommitResult<CancelTaskCommitValue>>;
  cancelGoal(input: CancelGoalCommitInput): Promise<MutationCommitResult<CancelGoalCommitValue>>;
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
  commitCommandReceipt(receipt: CommandReceiptInput): Promise<MutationCommitResult<undefined>>;
  getCommandReceipt(
    workspaceId: string,
    commandId: string,
  ): Promise<StoredCommandReceipt | undefined>;
  getWorkspace(workspaceId: string): Promise<Workspace | undefined>;
  getGoal(workspaceId: string, goalId: string): Promise<Goal | undefined>;
  getTask(workspaceId: string, taskId: string): Promise<Task | undefined>;
  getAgent(workspaceId: string, agentId: string): Promise<Agent | undefined>;
  getSession(workspaceId: string, sessionId: string): Promise<Session | undefined>;
  getLease(workspaceId: string, leaseId: string): Promise<Lease | undefined>;
  getPermissionRequest(
    workspaceId: string,
    requestId: string,
  ): Promise<PermissionRequest | undefined>;
  loadWorkspaceState(workspaceId: string): Promise<WorkspaceStateSnapshot | undefined>;
  listClaimableTasks(
    workspaceId: string,
    sessionId: string,
    now: string,
    sessionCutoff: string,
    limit: number,
    offset?: number,
  ): Promise<Task[]>;
  listTaskCheckpoints(
    workspaceId: string,
    taskId: string,
    limit?: number,
    offset?: number,
  ): Promise<Checkpoint[]>;
  listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]>;
  listPermissionDecisions(
    workspaceId: string,
    requestId: string,
    limit?: number,
    offset?: number,
  ): Promise<PermissionDecision[]>;
  listPendingHumanPermissions(
    workspaceId: string,
    limit: number,
    offset?: number,
  ): Promise<PendingHumanPermission[]>;
  listExpiredActiveLeases(workspaceId: string, now: string, limit: number): Promise<Lease[]>;
  listActiveSessionsLastSeenBefore(
    workspaceId: string,
    cutoff: string,
    limit: number,
  ): Promise<Session[]>;
}
