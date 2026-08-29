import type {
  Agent,
  Checkpoint,
  EvidenceRef,
  Goal,
  Lease,
  Reason,
  Session,
  Task,
  Workspace,
} from '@mindrail/contracts';

import type { CanonicalDomainTarget, CanonicalDomainValidator } from './domain-validation.ts';
import { RuntimeError } from './errors.ts';
import {
  semanticFingerprint,
  type BlockTaskCommand,
  type CancelGoalCommand,
  type CancelTaskCommand,
  type ClaimTaskCommand,
  type CompleteTaskCommand,
  type CreateGoalCommand,
  type CreateTaskCommand,
  type EndSessionCommand,
  type FailTaskCommand,
  type HeartbeatSessionCommand,
  type ProtocolCommand,
  type ProtocolFailure,
  type ProtocolResponse,
  type ProtocolSuccess,
  type RecordCheckpointCommand,
  type RenewLeaseCommand,
  type ResumeTaskCommand,
  type RetryTaskCommand,
} from './protocol.ts';
import { isProtocolEntityId, validateProtocolCommand } from './protocol-validation.ts';

export interface InMemoryControlPlaneOptions {
  workspaceId: string;
  workspaceName: string;
  now: () => Date;
  idFactory: (kind: string) => string;
  leaseDurationMs: number;
  sessionTimeoutMs: number;
  validateCanonicalDomainRecord: CanonicalDomainValidator;
}

export interface RegisterAgentInput {
  workspaceId: string;
  displayName: string;
  capabilities: string[];
}

export interface StartSessionInput {
  workspaceId: string;
  agentId: string;
}

export interface HeartbeatSessionInput {
  workspaceId: string;
  sessionId: string;
  expectedSessionRevision: number;
}

export interface EndSessionInput {
  workspaceId: string;
  sessionId: string;
  expectedSessionRevision: number;
}

export interface CreateGoalInput {
  workspaceId: string;
  title: string;
  objective: string;
  successCriteria: [string, ...string[]] | string[];
}

export interface CreateTaskInput {
  workspaceId: string;
  goalId: string;
  title: string;
  objective: string;
  acceptanceCriteria: [string, ...string[]] | string[];
  requiredCapabilities: string[];
  dependencyTaskIds: string[];
}

export interface ClaimTaskInput {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  expectedTaskRevision: number;
}

export interface RenewLeaseInput {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedLeaseRevision: number;
}

export interface ReleaseLeaseInput {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedLeaseRevision: number;
}

export interface RecordCheckpointInput {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  kind: 'progress' | 'handoff';
  summary: string;
  evidence: EvidenceRef[];
  progressPercent?: number;
}

export interface CompleteTaskInput {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedTaskRevision: number;
  summary: string;
  evidence: EvidenceRef[];
}

export interface FailTaskInput extends CompleteTaskInput {
  reason: Reason;
}

export interface BlockTaskInput {
  workspaceId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  expectedTaskRevision: number;
  reason: Reason;
  evidence: EvidenceRef[];
}

export interface ResumeTaskInput {
  workspaceId: string;
  taskId: string;
  expectedTaskRevision: number;
}

export interface RetryTaskInput {
  workspaceId: string;
  taskId: string;
  expectedTaskRevision: number;
}

export interface CancelTaskInput {
  workspaceId: string;
  taskId: string;
  expectedTaskRevision: number;
  reason: Reason;
}

export interface CancelGoalInput {
  workspaceId: string;
  goalId: string;
  expectedGoalRevision: number;
  reason: Reason;
}

export interface EndSessionResult {
  session: Session;
  leases: Lease[];
}

export interface ClaimTaskResult {
  task: Task;
  lease: Lease;
}

export interface CompleteTaskResult {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
}

export type FailTaskResult = CompleteTaskResult;
export type BlockTaskResult = CompleteTaskResult;

export interface CancelTaskResult {
  task: Task;
  lease?: Lease;
}

export interface CancelGoalResult {
  goal: Goal;
  tasks: Task[];
  leases: Lease[];
}

interface CommandReceipt {
  fingerprint: string;
  response: ProtocolResponse;
}

export class InMemoryControlPlane {
  private readonly workspace: Workspace;
  private readonly now: () => Date;
  private readonly idFactory: (kind: string) => string;
  private readonly leaseDurationMs: number;
  private readonly sessionTimeoutMs: number;
  private readonly validateCanonicalDomainRecord: CanonicalDomainValidator;

  private readonly agents = new Map<string, Agent>();
  private readonly sessions = new Map<string, Session>();
  private readonly goals = new Map<string, Goal>();
  private readonly tasks = new Map<string, Task>();
  private readonly leases = new Map<string, Lease>();
  private readonly effectiveLeaseByTask = new Map<string, string>();
  private readonly checkpointsByTask = new Map<string, Checkpoint[]>();
  private readonly fencingCounterByTask = new Map<string, number>();
  private readonly commandReceipts = new Map<string, CommandReceipt>();

  constructor(options: InMemoryControlPlaneOptions) {
    if (options.leaseDurationMs <= 0) {
      throw new RuntimeError('INVALID_INPUT', 'leaseDurationMs must be positive.');
    }
    if (options.sessionTimeoutMs <= 0) {
      throw new RuntimeError('INVALID_INPUT', 'sessionTimeoutMs must be positive.');
    }

    this.now = options.now;
    this.idFactory = options.idFactory;
    this.leaseDurationMs = options.leaseDurationMs;
    this.sessionTimeoutMs = options.sessionTimeoutMs;
    this.validateCanonicalDomainRecord = options.validateCanonicalDomainRecord;
    const timestamp = this.timestamp();
    const workspace: Workspace = {
      id: options.workspaceId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      name: options.workspaceName,
      status: 'active',
    };
    this.assertCanonical('Workspace', workspace);
    this.workspace = workspace;
  }

  execute(command: HeartbeatSessionCommand): ProtocolResponse<Session>;
  execute(command: EndSessionCommand): ProtocolResponse<EndSessionResult>;
  execute(command: CreateGoalCommand): ProtocolResponse<Goal>;
  execute(command: CreateTaskCommand): ProtocolResponse<Task>;
  execute(command: ClaimTaskCommand): ProtocolResponse<ClaimTaskResult>;
  execute(command: RenewLeaseCommand): ProtocolResponse<Lease>;
  execute(command: RecordCheckpointCommand): ProtocolResponse<Checkpoint>;
  execute(command: CompleteTaskCommand): ProtocolResponse<CompleteTaskResult>;
  execute(command: FailTaskCommand): ProtocolResponse<FailTaskResult>;
  execute(command: BlockTaskCommand): ProtocolResponse<BlockTaskResult>;
  execute(command: ResumeTaskCommand): ProtocolResponse<Task>;
  execute(command: RetryTaskCommand): ProtocolResponse<Task>;
  execute(command: CancelTaskCommand): ProtocolResponse<CancelTaskResult>;
  execute(command: CancelGoalCommand): ProtocolResponse<CancelGoalResult>;
  execute(command: ProtocolCommand): ProtocolResponse;
  execute(command: ProtocolCommand): ProtocolResponse {
    const validation = validateProtocolCommand(command);
    if (!validation.valid) {
      const details = validation.errors?.slice(0, 3).join('; ') ?? 'invalid command envelope';
      return this.protocolPreAdmissionFailure(command, 'INVALID_INPUT', details);
    }

    try {
      this.assertWorkspace(command.workspaceId);
    } catch (error) {
      if (!(error instanceof RuntimeError)) {
        throw error;
      }
      return this.protocolPreAdmissionFailure(command, error.code, error.message);
    }

    const receiptKey = `${command.workspaceId}\u0000${command.commandId}`;
    const fingerprint = semanticFingerprint(command);
    const existing = this.commandReceipts.get(receiptKey);

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return this.protocolFailure(
          command,
          'IDEMPOTENCY_CONFLICT',
          `Command id ${command.commandId} was already used for different semantic intent.`,
          false,
        );
      }
      const replay = clone(existing.response);
      replay.replayed = true;
      if (command.correlationId === undefined) {
        delete replay.correlationId;
      } else {
        replay.correlationId = command.correlationId;
      }
      return replay;
    }

    let response: ProtocolResponse;
    try {
      response = this.protocolSuccess(command, this.dispatchCommand(command), false);
    } catch (error) {
      if (!(error instanceof RuntimeError)) {
        throw error;
      }
      response = this.protocolFailure(command, error.code, error.message, false);
    }

    this.commandReceipts.set(receiptKey, {
      fingerprint,
      response: clone(response),
    });
    return clone(response);
  }

  getWorkspace(workspaceId: string): Workspace {
    this.assertWorkspace(workspaceId);
    return clone(this.workspace);
  }

  registerAgent(input: RegisterAgentInput): Agent {
    this.assertWorkspace(input.workspaceId);
    const timestamp = this.timestamp();
    const agent: Agent = {
      id: this.idFactory('agent'),
      workspaceId: input.workspaceId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      displayName: input.displayName,
      status: 'active',
      capabilities: [...input.capabilities],
    };
    this.assertCanonical('Agent', agent);
    this.agents.set(agent.id, agent);
    return clone(agent);
  }

  startSession(input: StartSessionInput): Session {
    this.assertWorkspace(input.workspaceId);
    const agent = this.requireAgent(input.workspaceId, input.agentId);
    if (agent.status !== 'active') {
      throw new RuntimeError('SESSION_NOT_ACTIVE', `Agent ${agent.id} is not active.`);
    }

    const timestamp = this.timestamp();
    const session: Session = {
      id: this.idFactory('session'),
      workspaceId: input.workspaceId,
      agentId: agent.id,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'active',
      lastSeenAt: timestamp,
    };
    this.assertCanonical('Session', session);
    this.sessions.set(session.id, session);
    return clone(session);
  }

  heartbeatSession(input: HeartbeatSessionInput): Session {
    this.assertWorkspace(input.workspaceId);
    const session = this.requireActiveSession(input.workspaceId, input.sessionId);
    this.assertRevision(session.revision, input.expectedSessionRevision, `Session ${session.id}`);

    const timestamp = this.timestamp();
    const updated: Session = {
      ...clone(session),
      revision: session.revision + 1,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    };
    this.assertCanonical('Session', updated);
    Object.assign(session, updated);
    return clone(session);
  }

  endSession(input: EndSessionInput): EndSessionResult {
    this.assertWorkspace(input.workspaceId);
    const session = this.requireActiveSession(input.workspaceId, input.sessionId);
    this.assertRevision(session.revision, input.expectedSessionRevision, `Session ${session.id}`);

    const timestamp = this.timestamp();
    const ended: Session = {
      ...clone(session),
      revision: session.revision + 1,
      updatedAt: timestamp,
      status: 'ended',
      endedAt: timestamp,
    };
    this.assertCanonical('Session', ended);

    const leasesToRevoke: Array<{ current: Lease; next: Lease }> = [];
    for (const lease of this.leases.values()) {
      if (lease.workspaceId !== input.workspaceId || lease.sessionId !== session.id) {
        continue;
      }
      this.materializeLeaseExpiry(lease);
      if (lease.status !== 'active') {
        continue;
      }
      const next: Lease = {
        ...clone(lease),
        status: 'revoked',
        revision: lease.revision + 1,
        updatedAt: timestamp,
      };
      this.assertCanonical('Lease', next);
      leasesToRevoke.push({ current: lease, next });
    }

    Object.assign(session, ended);
    const revokedLeases: Lease[] = [];
    for (const { current, next } of leasesToRevoke) {
      Object.assign(current, next);
      if (this.effectiveLeaseByTask.get(current.taskId) === current.id) {
        this.effectiveLeaseByTask.delete(current.taskId);
      }
      revokedLeases.push(clone(current));
    }

    return { session: clone(session), leases: revokedLeases };
  }

  createGoal(input: CreateGoalInput): Goal {
    this.assertWorkspace(input.workspaceId);
    if (input.successCriteria.length === 0) {
      throw new RuntimeError('INVALID_INPUT', 'Goal requires at least one success criterion.');
    }

    const timestamp = this.timestamp();
    const goal: Goal = {
      id: this.idFactory('goal'),
      workspaceId: input.workspaceId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      title: input.title,
      objective: input.objective,
      successCriteria: [...input.successCriteria] as [string, ...string[]],
      status: 'active',
    };
    this.assertCanonical('Goal', goal);
    this.goals.set(goal.id, goal);
    return clone(goal);
  }

  createTask(input: CreateTaskInput): Task {
    this.assertWorkspace(input.workspaceId);
    const goal = this.requireGoal(input.workspaceId, input.goalId);
    if (goal.status !== 'active') {
      throw new RuntimeError(
        'INVALID_STATE_TRANSITION',
        `Cannot create Task under terminal Goal ${goal.id}.`,
      );
    }
    if (input.acceptanceCriteria.length === 0) {
      throw new RuntimeError('INVALID_INPUT', 'Task requires at least one acceptance criterion.');
    }

    const dependencies = input.dependencyTaskIds.map((dependencyId) => {
      const dependency = this.requireTask(input.workspaceId, dependencyId);
      if (dependency.goalId !== goal.id) {
        throw new RuntimeError('INVALID_INPUT', 'Task dependencies must belong to the same Goal.');
      }
      return dependency;
    });

    const timestamp = this.timestamp();
    const task: Task = {
      id: this.idFactory('task'),
      workspaceId: input.workspaceId,
      goalId: goal.id,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      title: input.title,
      objective: input.objective,
      acceptanceCriteria: [...input.acceptanceCriteria] as [string, ...string[]],
      requiredCapabilities: [...input.requiredCapabilities],
      dependencyTaskIds: [...input.dependencyTaskIds],
      status: dependencies.every((dependency) => dependency.status === 'succeeded')
        ? 'ready'
        : 'pending',
    };
    this.assertCanonical('Task', task);
    this.tasks.set(task.id, task);
    this.checkpointsByTask.set(task.id, []);
    this.fencingCounterByTask.set(task.id, 0);
    return clone(task);
  }

  claimTask(input: ClaimTaskInput): ClaimTaskResult {
    this.assertWorkspace(input.workspaceId);
    const task = this.requireTask(input.workspaceId, input.taskId);

    const session = this.requireActiveSession(input.workspaceId, input.sessionId);
    const agent = this.requireAgent(input.workspaceId, session.agentId);
    if (!task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability))) {
      throw new RuntimeError(
        'CAPABILITY_MISMATCH',
        `Agent ${agent.id} lacks required capabilities.`,
      );
    }

    const existingLease = this.getEffectiveLease(task.id);
    if (existingLease) {
      if (existingLease.sessionId === session.id) {
        return { task: clone(task), lease: clone(existingLease) };
      }
      throw new RuntimeError('CONFLICT', `Task ${task.id} already has an active Lease.`);
    }

    this.assertRevision(task.revision, input.expectedTaskRevision, `Task ${task.id}`);

    if (task.status !== 'ready' && task.status !== 'running') {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Task ${task.id} is not claimable.`);
    }

    const timestamp = this.timestamp();
    const nextFence = (this.fencingCounterByTask.get(task.id) ?? 0) + 1;

    const lease: Lease = {
      id: this.idFactory('lease'),
      workspaceId: input.workspaceId,
      taskId: task.id,
      sessionId: session.id,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'active',
      fencingToken: nextFence,
      expiresAt: new Date(this.now().getTime() + this.leaseDurationMs).toISOString(),
    };
    this.assertCanonical('Lease', lease);
    this.fencingCounterByTask.set(task.id, nextFence);
    this.leases.set(lease.id, lease);
    this.effectiveLeaseByTask.set(task.id, lease.id);

    if (task.status === 'ready') {
      task.status = 'running';
      task.revision += 1;
      task.updatedAt = timestamp;
    }

    return { task: clone(task), lease: clone(lease) };
  }

  renewLease(input: RenewLeaseInput): Lease {
    this.assertWorkspace(input.workspaceId);
    const { lease } = this.requireExecutorAuthority(input);
    this.assertRevision(lease.revision, input.expectedLeaseRevision, `Lease ${lease.id}`);

    const timestamp = this.timestamp();
    const renewed: Lease = {
      ...clone(lease),
      revision: lease.revision + 1,
      updatedAt: timestamp,
      expiresAt: new Date(this.now().getTime() + this.leaseDurationMs).toISOString(),
    };
    this.assertCanonical('Lease', renewed);
    Object.assign(lease, renewed);
    return clone(lease);
  }

  releaseLease(input: ReleaseLeaseInput): Lease {
    this.assertWorkspace(input.workspaceId);
    const { lease } = this.requireExecutorAuthority(input);
    this.assertRevision(lease.revision, input.expectedLeaseRevision, `Lease ${lease.id}`);

    lease.status = 'released';
    lease.revision += 1;
    lease.updatedAt = this.timestamp();
    this.effectiveLeaseByTask.delete(input.taskId);
    return clone(lease);
  }

  recordCheckpoint(input: RecordCheckpointInput): Checkpoint {
    this.assertWorkspace(input.workspaceId);
    this.requireExecutorAuthority(input);

    const checkpoint = this.appendCheckpoint({
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      leaseId: input.leaseId,
      fencingToken: input.fencingToken,
      kind: input.kind,
      summary: input.summary,
      evidence: input.evidence,
      ...(input.progressPercent === undefined ? {} : { progressPercent: input.progressPercent }),
    });
    return clone(checkpoint);
  }

  completeTask(input: CompleteTaskInput): CompleteTaskResult {
    this.assertWorkspace(input.workspaceId);
    const { task, lease } = this.requireExecutorAuthority(input);
    this.assertRevision(task.revision, input.expectedTaskRevision, `Task ${task.id}`);

    const checkpoint = this.appendCheckpoint({
      workspaceId: input.workspaceId,
      taskId: task.id,
      sessionId: input.sessionId,
      leaseId: lease.id,
      fencingToken: input.fencingToken,
      kind: 'result',
      summary: input.summary,
      evidence: input.evidence,
    });

    const timestamp = this.timestamp();
    task.status = 'succeeded';
    delete task.statusReason;
    task.revision += 1;
    task.updatedAt = timestamp;

    lease.status = 'released';
    lease.revision += 1;
    lease.updatedAt = timestamp;
    this.effectiveLeaseByTask.delete(task.id);

    this.reconcileDependentTasks(task);
    this.reconcileGoal(task.goalId);

    return { task: clone(task), lease: clone(lease), checkpoint: clone(checkpoint) };
  }

  failTask(input: FailTaskInput): FailTaskResult {
    this.assertWorkspace(input.workspaceId);
    const { task, lease } = this.requireExecutorAuthority(input);
    this.assertRevision(task.revision, input.expectedTaskRevision, `Task ${task.id}`);
    this.assertCanonical('Reason', input.reason);

    const checkpoint = this.appendCheckpoint({
      workspaceId: input.workspaceId,
      taskId: task.id,
      sessionId: input.sessionId,
      leaseId: lease.id,
      fencingToken: input.fencingToken,
      kind: 'result',
      summary: input.summary,
      evidence: input.evidence,
    });

    const timestamp = this.timestamp();
    task.status = 'failed';
    task.statusReason = clone(input.reason);
    task.revision += 1;
    task.updatedAt = timestamp;

    lease.status = 'released';
    lease.revision += 1;
    lease.updatedAt = timestamp;
    this.effectiveLeaseByTask.delete(task.id);

    return { task: clone(task), lease: clone(lease), checkpoint: clone(checkpoint) };
  }

  blockTask(input: BlockTaskInput): BlockTaskResult {
    this.assertWorkspace(input.workspaceId);
    const { task, lease } = this.requireExecutorAuthority(input);
    this.assertRevision(task.revision, input.expectedTaskRevision, `Task ${task.id}`);
    this.assertCanonical('Reason', input.reason);

    const timestamp = this.timestamp();
    const blockedTask: Task = {
      ...clone(task),
      status: 'blocked',
      statusReason: clone(input.reason),
      revision: task.revision + 1,
      updatedAt: timestamp,
    };
    const releasedLease: Lease = {
      ...clone(lease),
      status: 'released',
      revision: lease.revision + 1,
      updatedAt: timestamp,
    };
    this.assertCanonical('Task', blockedTask);
    this.assertCanonical('Lease', releasedLease);

    const checkpoint = this.appendCheckpoint({
      workspaceId: input.workspaceId,
      taskId: task.id,
      sessionId: input.sessionId,
      leaseId: lease.id,
      fencingToken: input.fencingToken,
      kind: 'blocked',
      summary: input.reason.summary,
      evidence: input.evidence,
    });

    Object.assign(task, blockedTask);
    Object.assign(lease, releasedLease);
    this.effectiveLeaseByTask.delete(task.id);

    return { task: clone(task), lease: clone(lease), checkpoint: clone(checkpoint) };
  }

  resumeTask(input: ResumeTaskInput): Task {
    this.assertWorkspace(input.workspaceId);
    const task = this.requireTask(input.workspaceId, input.taskId);
    this.assertRevision(task.revision, input.expectedTaskRevision, `Task ${task.id}`);
    if (task.status !== 'blocked') {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Task ${task.id} is not blocked.`);
    }
    if (this.getEffectiveLease(task.id)) {
      throw new RuntimeError('CONFLICT', `Task ${task.id} still has an active Lease.`);
    }

    const timestamp = this.timestamp();
    const resumed: Task = {
      ...clone(task),
      status: this.dependenciesSatisfied(task) ? 'ready' : 'pending',
      revision: task.revision + 1,
      updatedAt: timestamp,
    };
    delete resumed.statusReason;
    this.assertCanonical('Task', resumed);
    Object.assign(task, resumed);
    delete task.statusReason;
    return clone(task);
  }

  retryTask(input: RetryTaskInput): Task {
    this.assertWorkspace(input.workspaceId);
    const task = this.requireTask(input.workspaceId, input.taskId);
    this.assertRevision(task.revision, input.expectedTaskRevision, `Task ${task.id}`);
    const goal = this.requireGoal(input.workspaceId, task.goalId);
    if (goal.status !== 'active') {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Goal ${goal.id} is terminal.`);
    }
    if (task.status !== 'failed') {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Task ${task.id} is not failed.`);
    }
    if (this.getEffectiveLease(task.id)) {
      throw new RuntimeError('CONFLICT', `Task ${task.id} still has an active Lease.`);
    }

    task.status = 'ready';
    delete task.statusReason;
    task.revision += 1;
    task.updatedAt = this.timestamp();
    return clone(task);
  }

  cancelTask(input: CancelTaskInput): CancelTaskResult {
    this.assertWorkspace(input.workspaceId);
    const task = this.requireTask(input.workspaceId, input.taskId);
    this.assertRevision(task.revision, input.expectedTaskRevision, `Task ${task.id}`);
    if (!isCancellableTaskStatus(task.status)) {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Task ${task.id} is terminal.`);
    }
    this.assertCanonical('Reason', input.reason);

    const timestamp = this.timestamp();
    const lease = this.getEffectiveLease(task.id);
    if (lease) {
      lease.status = 'revoked';
      lease.revision += 1;
      lease.updatedAt = timestamp;
      this.effectiveLeaseByTask.delete(task.id);
    }

    task.status = 'cancelled';
    task.statusReason = clone(input.reason);
    task.revision += 1;
    task.updatedAt = timestamp;

    return {
      task: clone(task),
      ...(lease === undefined ? {} : { lease: clone(lease) }),
    };
  }

  cancelGoal(input: CancelGoalInput): CancelGoalResult {
    this.assertWorkspace(input.workspaceId);
    const goal = this.requireGoal(input.workspaceId, input.goalId);
    this.assertRevision(goal.revision, input.expectedGoalRevision, `Goal ${goal.id}`);
    if (goal.status !== 'active') {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Goal ${goal.id} is terminal.`);
    }
    this.assertCanonical('Reason', input.reason);

    const timestamp = this.timestamp();
    goal.status = 'cancelled';
    goal.revision += 1;
    goal.updatedAt = timestamp;

    const cancelledTasks: Task[] = [];
    const revokedLeases: Lease[] = [];
    for (const task of this.tasks.values()) {
      if (task.workspaceId !== input.workspaceId || task.goalId !== goal.id) {
        continue;
      }
      if (!isCancellableTaskStatus(task.status)) {
        continue;
      }

      const lease = this.getEffectiveLease(task.id);
      if (lease) {
        lease.status = 'revoked';
        lease.revision += 1;
        lease.updatedAt = timestamp;
        this.effectiveLeaseByTask.delete(task.id);
        revokedLeases.push(clone(lease));
      }

      task.status = 'cancelled';
      task.statusReason = clone(input.reason);
      task.revision += 1;
      task.updatedAt = timestamp;
      cancelledTasks.push(clone(task));
    }

    return {
      goal: clone(goal),
      tasks: cancelledTasks,
      leases: revokedLeases,
    };
  }

  getGoal(workspaceId: string, goalId: string): Goal {
    return clone(this.requireGoal(workspaceId, goalId));
  }

  getTask(workspaceId: string, taskId: string): Task {
    return clone(this.requireTask(workspaceId, taskId));
  }

  getLease(workspaceId: string, leaseId: string): Lease {
    this.assertWorkspace(workspaceId);
    const lease = this.leases.get(leaseId);
    if (!lease || lease.workspaceId !== workspaceId) {
      throw new RuntimeError('NOT_FOUND', `Lease ${leaseId} was not found.`);
    }
    this.materializeLeaseAuthority(lease);
    return clone(lease);
  }

  listTaskCheckpoints(workspaceId: string, taskId: string): Checkpoint[] {
    this.requireTask(workspaceId, taskId);
    return clone(this.checkpointsByTask.get(taskId) ?? []);
  }

  private dispatchCommand(command: ProtocolCommand): unknown {
    switch (command.command) {
      case 'HeartbeatSession':
        return this.heartbeatSession({
          workspaceId: command.workspaceId,
          sessionId: command.sessionId,
          expectedSessionRevision: command.expectedSessionRevision,
        });
      case 'EndSession':
        return this.endSession({
          workspaceId: command.workspaceId,
          sessionId: command.sessionId,
          expectedSessionRevision: command.expectedSessionRevision,
        });
      case 'CreateGoal':
        return this.createGoal({
          workspaceId: command.workspaceId,
          title: command.title,
          objective: command.objective,
          successCriteria: command.successCriteria,
        });
      case 'CreateTask':
        return this.createTask({
          workspaceId: command.workspaceId,
          goalId: command.goalId,
          title: command.title,
          objective: command.objective,
          acceptanceCriteria: command.acceptanceCriteria,
          requiredCapabilities: command.requiredCapabilities,
          dependencyTaskIds: command.dependencyTaskIds,
        });
      case 'ClaimTask':
        return this.claimTask({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          sessionId: command.sessionId,
          expectedTaskRevision: command.expectedTaskRevision,
        });
      case 'RenewLease':
        return this.renewLease({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          sessionId: command.sessionId,
          leaseId: command.leaseId,
          fencingToken: command.fencingToken,
          expectedLeaseRevision: command.expectedLeaseRevision,
        });
      case 'RecordCheckpoint':
        return this.recordCheckpoint({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          sessionId: command.sessionId,
          leaseId: command.leaseId,
          fencingToken: command.fencingToken,
          kind: command.kind,
          summary: command.summary,
          evidence: command.evidence,
          ...(command.progressPercent === undefined
            ? {}
            : { progressPercent: command.progressPercent }),
        });
      case 'CompleteTask':
        return this.completeTask({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          sessionId: command.sessionId,
          leaseId: command.leaseId,
          fencingToken: command.fencingToken,
          expectedTaskRevision: command.expectedTaskRevision,
          summary: command.summary,
          evidence: command.evidence,
        });
      case 'FailTask':
        return this.failTask({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          sessionId: command.sessionId,
          leaseId: command.leaseId,
          fencingToken: command.fencingToken,
          expectedTaskRevision: command.expectedTaskRevision,
          reason: command.reason,
          summary: command.summary,
          evidence: command.evidence,
        });
      case 'BlockTask':
        return this.blockTask({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          sessionId: command.sessionId,
          leaseId: command.leaseId,
          fencingToken: command.fencingToken,
          expectedTaskRevision: command.expectedTaskRevision,
          reason: command.reason,
          evidence: command.evidence,
        });
      case 'ResumeTask':
        this.assertControllerActor(command);
        return this.resumeTask({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          expectedTaskRevision: command.expectedTaskRevision,
        });
      case 'RetryTask':
        this.assertControllerActor(command);
        return this.retryTask({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          expectedTaskRevision: command.expectedTaskRevision,
        });
      case 'CancelTask':
        this.assertControllerActor(command);
        return this.cancelTask({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          expectedTaskRevision: command.expectedTaskRevision,
          reason: command.reason,
        });
      case 'CancelGoal':
        this.assertControllerActor(command);
        return this.cancelGoal({
          workspaceId: command.workspaceId,
          goalId: command.goalId,
          expectedGoalRevision: command.expectedGoalRevision,
          reason: command.reason,
        });
    }
  }

  private assertCanonical(target: CanonicalDomainTarget, value: unknown): void {
    const validation = this.validateCanonicalDomainRecord(target, value);
    if (validation.valid) {
      return;
    }
    const details = validation.errors?.slice(0, 3).join('; ');
    const message =
      details === undefined || details.length === 0
        ? `${target} violates canonical domain schema.`
        : `${target} violates canonical domain schema. ${details}`;
    throw new RuntimeError('INVALID_INPUT', message);
  }

  private assertControllerActor(
    command: ResumeTaskCommand | RetryTaskCommand | CancelTaskCommand | CancelGoalCommand,
  ): void {
    if (command.actor.type === 'human' || command.actor.type === 'system') {
      return;
    }
    throw new RuntimeError(
      'ACTOR_NOT_AUTHORIZED',
      `Actor ${command.actor.type}:${command.actor.id} is not authorized for ${command.command}.`,
    );
  }

  private protocolSuccess(
    command: ProtocolCommand,
    result: unknown,
    replayed: boolean,
  ): ProtocolSuccess {
    return {
      protocolVersion: '0.1',
      commandId: command.commandId,
      ...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
      replayed,
      result: clone(result),
    };
  }

  private protocolPreAdmissionFailure(
    command: ProtocolCommand,
    code: RuntimeError['code'],
    message: string,
  ): ProtocolFailure {
    return {
      protocolVersion: '0.1',
      ...(isProtocolEntityId(command.commandId) ? { commandId: command.commandId } : {}),
      ...(isProtocolEntityId(command.correlationId)
        ? { correlationId: command.correlationId }
        : {}),
      replayed: false,
      error: {
        code,
        message,
        retryable: false,
      },
    };
  }

  private protocolFailure(
    command: ProtocolCommand,
    code: RuntimeError['code'],
    message: string,
    replayed: boolean,
  ): ProtocolFailure {
    return {
      protocolVersion: '0.1',
      commandId: command.commandId,
      ...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
      replayed,
      error: {
        code,
        message,
        retryable: false,
      },
    };
  }

  private requireExecutorAuthority(input: {
    workspaceId: string;
    taskId: string;
    sessionId: string;
    leaseId: string;
    fencingToken: number;
  }): { task: Task; lease: Lease } {
    const task = this.requireTask(input.workspaceId, input.taskId);
    if (task.status !== 'running') {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Task ${task.id} is not running.`);
    }

    const session = this.requireActiveSession(input.workspaceId, input.sessionId);
    const agent = this.requireAgent(input.workspaceId, session.agentId);
    if (agent.status !== 'active') {
      throw new RuntimeError('SESSION_NOT_ACTIVE', `Agent ${agent.id} is not active.`);
    }

    const lease = this.leases.get(input.leaseId);
    if (!lease || lease.workspaceId !== input.workspaceId || lease.taskId !== task.id) {
      throw new RuntimeError(
        'LEASE_NOT_ACTIVE',
        `Lease ${input.leaseId} is not active for Task ${task.id}.`,
      );
    }
    this.materializeLeaseExpiry(lease);
    if (lease.status === 'expired') {
      throw new RuntimeError('LEASE_EXPIRED', `Lease ${lease.id} has expired.`);
    }
    if (lease.status !== 'active') {
      throw new RuntimeError('LEASE_NOT_ACTIVE', `Lease ${lease.id} is ${lease.status}.`);
    }
    if (lease.sessionId !== session.id) {
      throw new RuntimeError('LEASE_NOT_ACTIVE', `Lease ${lease.id} belongs to another Session.`);
    }
    if (lease.fencingToken !== input.fencingToken) {
      throw new RuntimeError(
        'STALE_FENCING_TOKEN',
        `Fencing token ${input.fencingToken} is stale.`,
      );
    }
    if (this.effectiveLeaseByTask.get(task.id) !== lease.id) {
      throw new RuntimeError(
        'STALE_FENCING_TOKEN',
        `Lease ${lease.id} is no longer authoritative.`,
      );
    }

    return { task, lease };
  }

  private appendCheckpoint(input: Omit<Checkpoint, 'id' | 'createdAt'>): Checkpoint {
    const checkpoint: Checkpoint = {
      id: this.idFactory('checkpoint'),
      createdAt: this.timestamp(),
      ...input,
      evidence: clone(input.evidence),
    };
    this.assertCanonical('Checkpoint', checkpoint);
    const checkpoints = this.checkpointsByTask.get(input.taskId);
    if (!checkpoints) {
      throw new RuntimeError('NOT_FOUND', `Task ${input.taskId} was not found.`);
    }
    checkpoints.push(checkpoint);
    return checkpoint;
  }

  private dependenciesSatisfied(task: Task): boolean {
    return task.dependencyTaskIds.every(
      (dependencyId) => this.tasks.get(dependencyId)?.status === 'succeeded',
    );
  }

  private reconcileDependentTasks(completedTask: Task): void {
    const timestamp = this.timestamp();
    for (const task of this.tasks.values()) {
      if (
        task.workspaceId !== completedTask.workspaceId ||
        task.goalId !== completedTask.goalId ||
        task.status !== 'pending' ||
        !task.dependencyTaskIds.includes(completedTask.id)
      ) {
        continue;
      }

      if (this.dependenciesSatisfied(task)) {
        task.status = 'ready';
        task.revision += 1;
        task.updatedAt = timestamp;
      }
    }
  }

  private reconcileGoal(goalId: string): void {
    const goal = this.goals.get(goalId);
    if (!goal || goal.status !== 'active') {
      return;
    }

    const goalTasks = [...this.tasks.values()].filter(
      (task) => task.workspaceId === goal.workspaceId && task.goalId === goal.id,
    );
    if (goalTasks.length > 0 && goalTasks.every((task) => task.status === 'succeeded')) {
      goal.status = 'succeeded';
      goal.revision += 1;
      goal.updatedAt = this.timestamp();
    }
  }

  private getEffectiveLease(taskId: string): Lease | undefined {
    const leaseId = this.effectiveLeaseByTask.get(taskId);
    if (!leaseId) {
      return undefined;
    }
    const lease = this.leases.get(leaseId);
    if (!lease) {
      this.effectiveLeaseByTask.delete(taskId);
      return undefined;
    }
    this.materializeLeaseAuthority(lease);
    if (lease.status !== 'active') {
      this.effectiveLeaseByTask.delete(taskId);
      return undefined;
    }
    return lease;
  }

  private materializeLeaseAuthority(lease: Lease): void {
    this.materializeLeaseExpiry(lease);
    if (lease.status !== 'active') {
      return;
    }
    const session = this.sessions.get(lease.sessionId);
    if (!session || session.workspaceId !== lease.workspaceId) {
      this.revokeLease(lease);
      return;
    }
    this.materializeSessionStaleness(session);
    if (session.status !== 'active' && lease.status === 'active') {
      this.revokeLease(lease);
    }
  }

  private materializeLeaseExpiry(lease: Lease): void {
    if (lease.status !== 'active' || Date.parse(lease.expiresAt) > this.now().getTime()) {
      return;
    }
    lease.status = 'expired';
    lease.revision += 1;
    lease.updatedAt = this.timestamp();
    if (this.effectiveLeaseByTask.get(lease.taskId) === lease.id) {
      this.effectiveLeaseByTask.delete(lease.taskId);
    }
  }

  private materializeSessionStaleness(session: Session): void {
    if (session.status !== 'active') {
      return;
    }
    const staleAt = Date.parse(session.lastSeenAt) + this.sessionTimeoutMs;
    if (this.now().getTime() < staleAt) {
      return;
    }
    const timestamp = this.timestamp();
    session.status = 'expired';
    session.revision += 1;
    session.updatedAt = timestamp;
    for (const lease of this.leases.values()) {
      if (lease.sessionId === session.id && lease.status === 'active') {
        this.revokeLease(lease, timestamp);
      }
    }
  }

  private revokeLease(lease: Lease, timestamp = this.timestamp()): void {
    if (lease.status !== 'active') {
      return;
    }
    lease.status = 'revoked';
    lease.revision += 1;
    lease.updatedAt = timestamp;
    if (this.effectiveLeaseByTask.get(lease.taskId) === lease.id) {
      this.effectiveLeaseByTask.delete(lease.taskId);
    }
  }

  private requireActiveSession(workspaceId: string, sessionId: string): Session {
    this.assertWorkspace(workspaceId);
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) {
      throw new RuntimeError('NOT_FOUND', `Session ${sessionId} was not found.`);
    }
    this.materializeSessionStaleness(session);
    if (session.status !== 'active') {
      throw new RuntimeError('SESSION_NOT_ACTIVE', `Session ${sessionId} is not active.`);
    }
    return session;
  }

  private requireAgent(workspaceId: string, agentId: string): Agent {
    this.assertWorkspace(workspaceId);
    const agent = this.agents.get(agentId);
    if (!agent || agent.workspaceId !== workspaceId) {
      throw new RuntimeError('NOT_FOUND', `Agent ${agentId} was not found.`);
    }
    return agent;
  }

  private requireGoal(workspaceId: string, goalId: string): Goal {
    this.assertWorkspace(workspaceId);
    const goal = this.goals.get(goalId);
    if (!goal || goal.workspaceId !== workspaceId) {
      throw new RuntimeError('NOT_FOUND', `Goal ${goalId} was not found.`);
    }
    return goal;
  }

  private requireTask(workspaceId: string, taskId: string): Task {
    this.assertWorkspace(workspaceId);
    const task = this.tasks.get(taskId);
    if (!task || task.workspaceId !== workspaceId) {
      throw new RuntimeError('NOT_FOUND', `Task ${taskId} was not found.`);
    }
    return task;
  }

  private assertWorkspace(workspaceId: string): void {
    if (workspaceId !== this.workspace.id) {
      throw new RuntimeError('NOT_FOUND', `Workspace ${workspaceId} was not found.`);
    }
    if (this.workspace.status !== 'active') {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Workspace ${workspaceId} is archived.`);
    }
  }

  private assertRevision(actual: number, expected: number, subject: string): void {
    if (actual !== expected) {
      throw new RuntimeError(
        'REVISION_MISMATCH',
        `${subject} revision ${actual} does not match expected revision ${expected}.`,
      );
    }
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function isCancellableTaskStatus(status: Task['status']): boolean {
  return status === 'pending' || status === 'ready' || status === 'running' || status === 'blocked';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
