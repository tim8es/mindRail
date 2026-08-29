import type {
  Agent,
  Checkpoint,
  EvidenceRef,
  Goal,
  Lease,
  Session,
  Task,
  Workspace,
} from '@mindrail/contracts';

import { RuntimeError } from './errors.ts';

export interface InMemoryControlPlaneOptions {
  workspaceId: string;
  workspaceName: string;
  now: () => Date;
  idFactory: (kind: string) => string;
  leaseDurationMs: number;
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

export interface ClaimTaskResult {
  task: Task;
  lease: Lease;
}

export interface CompleteTaskResult {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
}

export class InMemoryControlPlane {
  private readonly workspace: Workspace;
  private readonly now: () => Date;
  private readonly idFactory: (kind: string) => string;
  private readonly leaseDurationMs: number;

  private readonly agents = new Map<string, Agent>();
  private readonly sessions = new Map<string, Session>();
  private readonly goals = new Map<string, Goal>();
  private readonly tasks = new Map<string, Task>();
  private readonly leases = new Map<string, Lease>();
  private readonly effectiveLeaseByTask = new Map<string, string>();
  private readonly checkpointsByTask = new Map<string, Checkpoint[]>();
  private readonly fencingCounterByTask = new Map<string, number>();

  constructor(options: InMemoryControlPlaneOptions) {
    if (options.leaseDurationMs <= 0) {
      throw new RuntimeError('INVALID_INPUT', 'leaseDurationMs must be positive.');
    }

    this.now = options.now;
    this.idFactory = options.idFactory;
    this.leaseDurationMs = options.leaseDurationMs;
    const timestamp = this.timestamp();
    this.workspace = {
      id: options.workspaceId,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      name: options.workspaceName,
      status: 'active',
    };
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
    this.sessions.set(session.id, session);
    return clone(session);
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
      status: dependencies.every((dependency) => dependency.status === 'succeeded') ? 'ready' : 'pending',
    };
    this.tasks.set(task.id, task);
    this.checkpointsByTask.set(task.id, []);
    this.fencingCounterByTask.set(task.id, 0);
    return clone(task);
  }

  claimTask(input: ClaimTaskInput): ClaimTaskResult {
    this.assertWorkspace(input.workspaceId);
    const task = this.requireTask(input.workspaceId, input.taskId);
    this.assertRevision(task.revision, input.expectedTaskRevision, `Task ${task.id}`);
    if (task.status !== 'ready') {
      throw new RuntimeError('INVALID_STATE_TRANSITION', `Task ${task.id} is not claimable.`);
    }

    const session = this.requireActiveSession(input.workspaceId, input.sessionId);
    const agent = this.requireAgent(input.workspaceId, session.agentId);
    if (!task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability))) {
      throw new RuntimeError('CAPABILITY_MISMATCH', `Agent ${agent.id} lacks required capabilities.`);
    }

    const existingLease = this.getEffectiveLease(task.id);
    if (existingLease) {
      throw new RuntimeError('CONFLICT', `Task ${task.id} already has an active Lease.`);
    }

    const timestamp = this.timestamp();
    const nextFence = (this.fencingCounterByTask.get(task.id) ?? 0) + 1;
    this.fencingCounterByTask.set(task.id, nextFence);

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
    this.leases.set(lease.id, lease);
    this.effectiveLeaseByTask.set(task.id, lease.id);

    task.status = 'running';
    task.revision += 1;
    task.updatedAt = timestamp;

    return { task: clone(task), lease: clone(lease) };
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
    return clone(lease);
  }

  listTaskCheckpoints(workspaceId: string, taskId: string): Checkpoint[] {
    this.requireTask(workspaceId, taskId);
    return clone(this.checkpointsByTask.get(taskId) ?? []);
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
      throw new RuntimeError('LEASE_NOT_ACTIVE', `Lease ${input.leaseId} is not active for Task ${task.id}.`);
    }
    if (lease.status !== 'active') {
      throw new RuntimeError('LEASE_NOT_ACTIVE', `Lease ${lease.id} is ${lease.status}.`);
    }
    if (Date.parse(lease.expiresAt) <= this.now().getTime()) {
      throw new RuntimeError('LEASE_EXPIRED', `Lease ${lease.id} has expired.`);
    }
    if (lease.sessionId !== session.id) {
      throw new RuntimeError('LEASE_NOT_ACTIVE', `Lease ${lease.id} belongs to another Session.`);
    }
    if (lease.fencingToken !== input.fencingToken) {
      throw new RuntimeError('STALE_FENCING_TOKEN', `Fencing token ${input.fencingToken} is stale.`);
    }
    if (this.effectiveLeaseByTask.get(task.id) !== lease.id) {
      throw new RuntimeError('STALE_FENCING_TOKEN', `Lease ${lease.id} is no longer authoritative.`);
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
    const checkpoints = this.checkpointsByTask.get(input.taskId);
    if (!checkpoints) {
      throw new RuntimeError('NOT_FOUND', `Task ${input.taskId} was not found.`);
    }
    checkpoints.push(checkpoint);
    return checkpoint;
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

      const dependenciesSatisfied = task.dependencyTaskIds.every(
        (dependencyId) => this.tasks.get(dependencyId)?.status === 'succeeded',
      );
      if (dependenciesSatisfied) {
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
    if (!lease || lease.status !== 'active' || Date.parse(lease.expiresAt) <= this.now().getTime()) {
      this.effectiveLeaseByTask.delete(taskId);
      return undefined;
    }
    return lease;
  }

  private requireActiveSession(workspaceId: string, sessionId: string): Session {
    this.assertWorkspace(workspaceId);
    const session = this.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) {
      throw new RuntimeError('NOT_FOUND', `Session ${sessionId} was not found.`);
    }
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

function clone<T>(value: T): T {
  return structuredClone(value);
}
