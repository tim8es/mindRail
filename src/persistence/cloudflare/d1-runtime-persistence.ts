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

import {
  PersistenceError,
  type CancelGoalCommitInput,
  type CancelGoalCommitValue,
  type CancelTaskCommitInput,
  type CancelTaskCommitValue,
  type ClaimTaskCommitInput,
  type ClaimTaskCommitValue,
  type CommandReceiptInput,
  type CompleteTaskCommitInput,
  type CompleteTaskCommitValue,
  type DeferredCommandReceiptInput,
  type DurableRuntimePersistence,
  type MutationCommitResult,
  type PendingHumanPermission,
  type PersistenceDomainTarget,
  type PersistenceDomainValidator,
  type StoredCommandReceipt,
  type TaskOutcomeCommitInput,
  type TaskOutcomeCommitValue,
  type WorkspaceMutationCoordinator,
  type WorkspaceStateSnapshot,
} from '../ports.ts';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from './d1-types.ts';

const MAX_RECEIPT_SNAPSHOT_BYTES = 64 * 1024;

interface D1RuntimePersistenceOptions {
  database: D1DatabaseLike;
  coordinator: WorkspaceMutationCoordinator;
  validateCanonicalDomainRecord: PersistenceDomainValidator;
}

interface RecordRow {
  record_json: string;
}

interface CounterRow {
  task_id: string;
  last_fencing_token: number;
}

interface ReceiptRow {
  workspace_id: string;
  command_id: string;
  command_discriminator: string;
  semantic_fingerprint: string;
  outcome_kind: 'result' | 'error';
  response_snapshot_json: string;
  created_at_ms: number;
  expires_at_ms: number | null;
}

interface PermissionHeadRow {
  latest_decision_id: string;
  latest_sequence: number;
  latest_outcome: PermissionDecision['outcome'];
}

interface PendingPermissionRow {
  request_json: string;
  decision_json: string;
}

export class D1RuntimePersistence implements DurableRuntimePersistence {
  private readonly database: D1DatabaseLike;
  private readonly coordinator: WorkspaceMutationCoordinator;
  private readonly validateCanonicalDomainRecord: PersistenceDomainValidator;

  constructor(options: D1RuntimePersistenceOptions) {
    this.database = options.database;
    this.coordinator = options.coordinator;
    this.validateCanonicalDomainRecord = options.validateCanonicalDomainRecord;
  }

  async bootstrapWorkspace(workspace: Workspace): Promise<void> {
    this.assertCanonical('Workspace', workspace);
    await this.coordinator.runSerialized(workspace.id, async () => {
      await this.run(
        this.database
          .prepare(
            `INSERT INTO workspaces(
              id, revision, status, created_at_ms, updated_at_ms, record_json
            ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            workspace.id,
            workspace.revision,
            workspace.status,
            timestampMs(workspace.createdAt, 'Workspace.createdAt'),
            timestampMs(workspace.updatedAt, 'Workspace.updatedAt'),
            serializeJson(workspace, 'Workspace'),
          ),
        'bootstrap Workspace',
      );
    });
  }

  async createAgent(input: {
    agent: Agent;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Agent>> {
    const { agent } = input;
    this.assertCanonical('Agent', agent);
    this.assertRelatedAudit(agent.workspaceId, input.auditEvent);
    this.assertReceipt(agent.workspaceId, input.receipt);
    return this.coordinator.runSerialized(agent.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      await this.requireWorkspace(agent.workspaceId);
      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `INSERT INTO agents(
              workspace_id, id, revision, status, created_at_ms, updated_at_ms, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            agent.workspaceId,
            agent.id,
            agent.revision,
            agent.status,
            timestampMs(agent.createdAt, 'Agent.createdAt'),
            timestampMs(agent.updatedAt, 'Agent.updatedAt'),
            serializeJson(agent, 'Agent'),
          ),
        ...agent.capabilities.map((capability) =>
          this.database
            .prepare(
              `INSERT INTO agent_capabilities(workspace_id, agent_id, capability)
               VALUES (?, ?, ?)`,
            )
            .bind(agent.workspaceId, agent.id, capability),
        ),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'create Agent');
      return { kind: 'committed', value: clone(agent) };
    });
  }

  async createSession(input: {
    session: Session;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Session>> {
    const { session } = input;
    this.assertCanonical('Session', session);
    this.assertRelatedAudit(session.workspaceId, input.auditEvent);
    this.assertReceipt(session.workspaceId, input.receipt);
    return this.coordinator.runSerialized(session.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      await this.requireWorkspace(session.workspaceId);
      const agent = await this.getAgent(session.workspaceId, session.agentId);
      if (!agent) {
        throw new PersistenceError('NOT_FOUND', `Agent ${session.agentId} was not found.`);
      }
      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `INSERT INTO sessions(
              workspace_id, id, agent_id, revision, status, created_at_ms, updated_at_ms,
              last_seen_at_ms, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            session.workspaceId,
            session.id,
            session.agentId,
            session.revision,
            session.status,
            timestampMs(session.createdAt, 'Session.createdAt'),
            timestampMs(session.updatedAt, 'Session.updatedAt'),
            timestampMs(session.lastSeenAt, 'Session.lastSeenAt'),
            serializeJson(session, 'Session'),
          ),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'create Session');
      return { kind: 'committed', value: clone(session) };
    });
  }

  async heartbeatSession(input: {
    session: Session;
    expectedRevision: number;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Session>> {
    const { session } = input;
    this.assertCanonical('Session', session);
    this.assertRelatedAudit(session.workspaceId, input.auditEvent);
    this.assertReceipt(session.workspaceId, input.receipt);
    return this.coordinator.runSerialized(session.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const current = await this.getSession(session.workspaceId, session.id);
      if (!current) {
        throw new PersistenceError('NOT_FOUND', `Session ${session.id} was not found.`);
      }
      if (current.revision !== input.expectedRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Session ${session.id} revision ${current.revision} does not match ${input.expectedRevision}.`,
        );
      }
      if (current.status !== 'active') {
        throw new PersistenceError('CONFLICT', `Session ${session.id} is not active.`);
      }
      if (
        session.workspaceId !== current.workspaceId ||
        session.id !== current.id ||
        session.agentId !== current.agentId ||
        session.createdAt !== current.createdAt ||
        session.status !== 'active' ||
        session.revision !== input.expectedRevision + 1 ||
        session.updatedAt !== session.lastSeenAt ||
        timestampMs(session.lastSeenAt, 'Session.lastSeenAt') <
          timestampMs(current.lastSeenAt, 'Session.lastSeenAt')
      ) {
        throw new PersistenceError('INVALID_RECORD', 'HeartbeatSession replacement is invalid.');
      }

      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `UPDATE sessions
             SET revision = ?, status = ?, updated_at_ms = ?, last_seen_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'`,
          )
          .bind(
            session.revision,
            session.status,
            timestampMs(session.updatedAt, 'Session.updatedAt'),
            timestampMs(session.lastSeenAt, 'Session.lastSeenAt'),
            serializeJson(session, 'Session'),
            session.workspaceId,
            session.id,
            input.expectedRevision,
          ),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      const results = await this.batch(statements, 'heartbeat Session');
      if (changes(results[0]!) !== 1) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Session ${session.id} lost its revision race.`,
        );
      }
      return { kind: 'committed', value: clone(session) };
    });
  }

  async endSession(input: {
    session: Session;
    leases: Lease[];
    expectedSessionRevision: number;
    now: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<{ session: Session; leases: Lease[] }>> {
    this.assertCanonical('Session', input.session);
    for (const lease of input.leases) this.assertCanonical('Lease', lease);
    this.assertRelatedAudit(input.session.workspaceId, input.auditEvent);
    this.assertReceipt(input.session.workspaceId, input.receipt);
    const nowMs = timestampMs(input.now, 'end Session now');

    return this.coordinator.runSerialized(input.session.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const current = await this.getSession(input.session.workspaceId, input.session.id);
      if (!current) {
        throw new PersistenceError('NOT_FOUND', `Session ${input.session.id} was not found.`);
      }
      if (current.revision !== input.expectedSessionRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Session ${current.id} revision ${current.revision} does not match ${input.expectedSessionRevision}.`,
        );
      }
      if (current.status !== 'active') {
        throw new PersistenceError('CONFLICT', `Session ${current.id} is not active.`);
      }
      const ended = input.session;
      if (
        ended.workspaceId !== current.workspaceId ||
        ended.id !== current.id ||
        ended.agentId !== current.agentId ||
        ended.createdAt !== current.createdAt ||
        ended.lastSeenAt !== current.lastSeenAt ||
        ended.status !== 'ended' ||
        ended.revision !== input.expectedSessionRevision + 1 ||
        ended.endedAt === undefined ||
        ended.updatedAt !== ended.endedAt
      ) {
        throw new PersistenceError('INVALID_RECORD', 'EndSession replacement is invalid.');
      }

      const effectiveLeases = await this.readRecords<Lease>(
        `SELECT record_json FROM leases
         WHERE workspace_id = ? AND session_id = ? AND status = 'active' AND expires_at_ms > ?
         ORDER BY fencing_token, id`,
        ended.workspaceId,
        ended.id,
        nowMs,
      );
      const expectedLeaseIds = effectiveLeases.map((lease) => lease.id).sort();
      const suppliedLeaseIds = input.leases.map((lease) => lease.id).sort();
      if (JSON.stringify(expectedLeaseIds) !== JSON.stringify(suppliedLeaseIds)) {
        throw new PersistenceError(
          'STALE_AUTHORITY',
          `Session ${ended.id} active Lease set changed before durable end.`,
        );
      }

      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `UPDATE sessions
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'`,
          )
          .bind(
            ended.revision,
            ended.status,
            timestampMs(ended.updatedAt, 'Session.updatedAt'),
            serializeJson(ended, 'Session'),
            ended.workspaceId,
            ended.id,
            input.expectedSessionRevision,
          ),
      ];

      for (const nextLease of input.leases) {
        const currentLease = effectiveLeases.find((lease) => lease.id === nextLease.id);
        if (
          !currentLease ||
          nextLease.workspaceId !== currentLease.workspaceId ||
          nextLease.taskId !== currentLease.taskId ||
          nextLease.sessionId !== currentLease.sessionId ||
          nextLease.createdAt !== currentLease.createdAt ||
          nextLease.expiresAt !== currentLease.expiresAt ||
          nextLease.fencingToken !== currentLease.fencingToken ||
          nextLease.status !== 'revoked' ||
          nextLease.revision !== currentLease.revision + 1 ||
          nextLease.updatedAt !== ended.updatedAt
        ) {
          throw new PersistenceError(
            'INVALID_RECORD',
            `Lease ${nextLease.id} revocation is invalid.`,
          );
        }
        statements.push(
          this.database
            .prepare(
              `UPDATE leases
               SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
               WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
                 AND fencing_token = ?`,
            )
            .bind(
              nextLease.revision,
              nextLease.status,
              timestampMs(nextLease.updatedAt, 'Lease.updatedAt'),
              serializeJson(nextLease, 'Lease'),
              nextLease.workspaceId,
              nextLease.id,
              currentLease.revision,
              currentLease.fencingToken,
            ),
        );
      }
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      const results = await this.batch(statements, 'end Session');
      if (changes(results[0]!) !== 1) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Session ${ended.id} lost its revision race.`,
        );
      }
      for (let index = 0; index < input.leases.length; index += 1) {
        if (changes(results[index + 1]!) !== 1) {
          throw new PersistenceError(
            'STALE_AUTHORITY',
            `Session ${ended.id} Lease authority changed during durable end.`,
          );
        }
      }
      return {
        kind: 'committed',
        value: { session: clone(ended), leases: input.leases.map(clone) },
      };
    });
  }

  async renewLease(input: {
    lease: Lease;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Lease>> {
    return this.commitLeaseLivenessMutation({ ...input, operation: 'renew' });
  }

  async releaseLease(input: {
    lease: Lease;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Lease>> {
    return this.commitLeaseLivenessMutation({ ...input, operation: 'release' });
  }

  async createGoal(input: {
    goal: Goal;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Goal>> {
    const { goal } = input;
    this.assertCanonical('Goal', goal);
    this.assertRelatedAudit(goal.workspaceId, input.auditEvent);
    this.assertReceipt(goal.workspaceId, input.receipt);

    return this.coordinator.runSerialized(goal.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      await this.requireWorkspace(goal.workspaceId);

      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `INSERT INTO goals(
              workspace_id, id, revision, status, created_at_ms, updated_at_ms, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            goal.workspaceId,
            goal.id,
            goal.revision,
            goal.status,
            timestampMs(goal.createdAt, 'Goal.createdAt'),
            timestampMs(goal.updatedAt, 'Goal.updatedAt'),
            serializeJson(goal, 'Goal'),
          ),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'create Goal');
      return { kind: 'committed', value: clone(goal) };
    });
  }

  async createTask(input: {
    task: Task;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Task>> {
    const { task } = input;
    this.assertCanonical('Task', task);
    this.assertRelatedAudit(task.workspaceId, input.auditEvent);
    this.assertReceipt(task.workspaceId, input.receipt);

    return this.coordinator.runSerialized(task.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      await this.requireWorkspace(task.workspaceId);
      const parentGoal = await this.getGoal(task.workspaceId, task.goalId);
      if (!parentGoal) {
        throw new PersistenceError('NOT_FOUND', `Goal ${task.goalId} was not found.`);
      }
      if (parentGoal.status !== 'active') {
        throw new PersistenceError(
          'INVALID_STATE_TRANSITION',
          `Goal ${parentGoal.id} is terminal and cannot accept Task ${task.id}.`,
        );
      }
      await this.assertDependencies(task);

      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `INSERT INTO tasks(
              workspace_id, id, goal_id, revision, status, created_at_ms, updated_at_ms, record_json
            )
            SELECT ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM goals
              WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
            )`,
          )
          .bind(
            task.workspaceId,
            task.id,
            task.goalId,
            task.revision,
            task.status,
            timestampMs(task.createdAt, 'Task.createdAt'),
            timestampMs(task.updatedAt, 'Task.updatedAt'),
            serializeJson(task, 'Task'),
            task.workspaceId,
            task.goalId,
            parentGoal.revision,
          ),
        this.mutationChangesGuardStatement(task.workspaceId),
        ...task.requiredCapabilities.map((capability) =>
          this.database
            .prepare(
              `INSERT INTO task_required_capabilities(workspace_id, task_id, capability)
               VALUES (?, ?, ?)`,
            )
            .bind(task.workspaceId, task.id, capability),
        ),
        ...task.dependencyTaskIds.map((dependencyTaskId) =>
          this.database
            .prepare(
              `INSERT INTO task_dependencies(
                workspace_id, goal_id, task_id, dependency_task_id
              ) VALUES (?, ?, ?, ?)`,
            )
            .bind(task.workspaceId, task.goalId, task.id, dependencyTaskId),
        ),
        this.database
          .prepare(
            `INSERT INTO task_fencing_counters(workspace_id, task_id, last_fencing_token)
             VALUES (?, ?, 0)`,
          )
          .bind(task.workspaceId, task.id),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      statements.push(this.clearMutationBatchGuardsStatement(task.workspaceId));
      await this.batch(statements, 'create Task');
      return { kind: 'committed', value: clone(task) };
    });
  }

  async claimTask(
    input: ClaimTaskCommitInput,
  ): Promise<MutationCommitResult<ClaimTaskCommitValue>> {
    if (input.receipt !== undefined && input.deferredReceipt !== undefined) {
      throw new PersistenceError('INVALID_RECORD', 'ClaimTask cannot supply two receipt sources.');
    }
    this.assertReceipt(input.workspaceId, input.receipt);
    this.assertDeferredReceipt(input.workspaceId, input.deferredReceipt);
    this.assertRelatedAudit(input.workspaceId, input.auditEvent);
    const nowMs = timestampMs(input.now, 'claim now');

    return this.coordinator.runSerialized(input.workspaceId, async () => {
      const replay = await this.resolveReceiptSource(input.receipt, input.deferredReceipt);
      if (replay) return replay;
      await this.requireWorkspace(input.workspaceId);

      const task = await this.getTask(input.workspaceId, input.taskId);
      if (!task) throw new PersistenceError('NOT_FOUND', `Task ${input.taskId} was not found.`);
      const session = await this.getSession(input.workspaceId, input.sessionId);
      if (!session) {
        throw new PersistenceError('NOT_FOUND', `Session ${input.sessionId} was not found.`);
      }
      if (session.status !== 'active') {
        throw new PersistenceError('CONFLICT', `Session ${session.id} is not active.`);
      }
      const agent = await this.getAgent(input.workspaceId, session.agentId);
      if (!agent || agent.status !== 'active') {
        throw new PersistenceError('CONFLICT', `Agent ${session.agentId} is not active.`);
      }
      if (
        !task.requiredCapabilities.every((capability) => agent.capabilities.includes(capability))
      ) {
        throw new PersistenceError(
          'CONFLICT',
          `Session ${session.id} does not satisfy Task ${task.id} capabilities.`,
        );
      }

      const activeLease = await this.getActiveLease(input.workspaceId, input.taskId);
      const statements: D1PreparedStatementLike[] = [];
      if (activeLease && timestampMs(activeLease.expiresAt, 'Lease.expiresAt') > nowMs) {
        if (activeLease.sessionId === input.sessionId) {
          const value = { task: clone(task), lease: clone(activeLease) };
          const finalReceipt = this.materializeReceipt(input.receipt, input.deferredReceipt, value);
          this.pushReceiptStatement(statements, finalReceipt);
          if (statements.length > 0) await this.batch(statements, 'record duplicate claim receipt');
          return { kind: 'committed', value };
        }
        throw new PersistenceError(
          'CONFLICT',
          `Task ${task.id} already has an effective Lease ${activeLease.id}.`,
        );
      }

      if (task.revision !== input.expectedTaskRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Task ${task.id} revision ${task.revision} does not match ${input.expectedTaskRevision}.`,
        );
      }
      if (task.status !== 'ready' && task.status !== 'running') {
        throw new PersistenceError(
          'INVALID_STATE_TRANSITION',
          `Task ${task.id} cannot be claimed from ${task.status}.`,
        );
      }

      const counter = await this.getFencingCounter(input.workspaceId, input.taskId);
      if (counter === undefined) {
        throw new PersistenceError('INTEGRITY_ERROR', `Task ${task.id} has no fencing counter.`);
      }
      const nextFence = counter + 1;
      const lease: Lease = {
        ...input.lease,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        fencingToken: nextFence,
        createdAt: input.now,
        updatedAt: input.now,
        status: 'active',
      };
      if (timestampMs(lease.expiresAt, 'Lease.expiresAt') <= nowMs) {
        throw new PersistenceError(
          'INVALID_RECORD',
          'A newly granted Lease must expire in the future.',
        );
      }
      this.assertCanonical('Lease', lease);

      if (activeLease) {
        const expiredLease: Lease = {
          ...activeLease,
          revision: activeLease.revision + 1,
          updatedAt: input.now,
          status: 'expired',
        };
        this.assertCanonical('Lease', expiredLease);
        statements.push(
          this.database
            .prepare(
              `UPDATE leases
               SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
               WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'`,
            )
            .bind(
              expiredLease.revision,
              expiredLease.status,
              nowMs,
              serializeJson(expiredLease, 'Lease'),
              input.workspaceId,
              activeLease.id,
              activeLease.revision,
            ),
        );
      }

      statements.push(
        this.database
          .prepare(
            `UPDATE task_fencing_counters
             SET last_fencing_token = ?
             WHERE workspace_id = ? AND task_id = ? AND last_fencing_token = ?`,
          )
          .bind(nextFence, input.workspaceId, input.taskId, counter),
      );

      let nextTask = task;
      if (task.status === 'ready') {
        nextTask = {
          ...task,
          revision: task.revision + 1,
          updatedAt: input.now,
          status: 'running',
        };
        this.assertCanonical('Task', nextTask);
        statements.push(
          this.database
            .prepare(
              `UPDATE tasks
               SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
               WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'ready'`,
            )
            .bind(
              nextTask.revision,
              nextTask.status,
              nowMs,
              serializeJson(nextTask, 'Task'),
              input.workspaceId,
              input.taskId,
              task.revision,
            ),
        );
      }

      statements.push(this.insertLeaseStatement(lease));
      this.pushAuditStatement(statements, input.auditEvent);
      const value = { task: clone(nextTask), lease: clone(lease) };
      const finalReceipt = this.materializeReceipt(input.receipt, input.deferredReceipt, value);
      this.pushReceiptStatement(statements, finalReceipt);
      await this.batch(statements, 'claim Task');
      return { kind: 'committed', value };
    });
  }

  async updateTask(input: { task: Task; expectedRevision: number }): Promise<Task> {
    const { task } = input;
    this.assertCanonical('Task', task);
    return this.coordinator.runSerialized(task.workspaceId, async () => {
      const current = await this.getTask(task.workspaceId, task.id);
      if (!current) throw new PersistenceError('NOT_FOUND', `Task ${task.id} was not found.`);
      if (current.revision !== input.expectedRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Task ${task.id} revision ${current.revision} does not match ${input.expectedRevision}.`,
        );
      }
      if (task.revision !== input.expectedRevision + 1) {
        throw new PersistenceError(
          'INVALID_RECORD',
          `Task ${task.id} replacement revision must be ${input.expectedRevision + 1}.`,
        );
      }
      if (task.goalId !== current.goalId) {
        throw new PersistenceError(
          'INVALID_RECORD',
          `Task ${task.id} cannot change Goal ownership.`,
        );
      }
      const result = await this.run(
        this.database
          .prepare(
            `UPDATE tasks
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ?`,
          )
          .bind(
            task.revision,
            task.status,
            timestampMs(task.updatedAt, 'Task.updatedAt'),
            serializeJson(task, 'Task'),
            task.workspaceId,
            task.id,
            input.expectedRevision,
          ),
        'update Task revision',
      );
      if (changes(result) !== 1) {
        throw new PersistenceError('REVISION_MISMATCH', `Task ${task.id} lost its revision race.`);
      }
      return clone(task);
    });
  }

  async updateGoal(input: { goal: Goal; expectedRevision: number }): Promise<Goal> {
    const { goal } = input;
    this.assertCanonical('Goal', goal);
    return this.coordinator.runSerialized(goal.workspaceId, async () => {
      const current = await this.getGoal(goal.workspaceId, goal.id);
      if (!current) throw new PersistenceError('NOT_FOUND', `Goal ${goal.id} was not found.`);
      if (current.revision !== input.expectedRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Goal ${goal.id} revision ${current.revision} does not match ${input.expectedRevision}.`,
        );
      }
      if (goal.revision !== input.expectedRevision + 1) {
        throw new PersistenceError(
          'INVALID_RECORD',
          `Goal ${goal.id} replacement revision must be ${input.expectedRevision + 1}.`,
        );
      }
      const result = await this.run(
        this.database
          .prepare(
            `UPDATE goals
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ?`,
          )
          .bind(
            goal.revision,
            goal.status,
            timestampMs(goal.updatedAt, 'Goal.updatedAt'),
            serializeJson(goal, 'Goal'),
            goal.workspaceId,
            goal.id,
            input.expectedRevision,
          ),
        'update Goal revision',
      );
      if (changes(result) !== 1) {
        throw new PersistenceError('REVISION_MISMATCH', `Goal ${goal.id} lost its revision race.`);
      }
      return clone(goal);
    });
  }

  async appendCheckpoint(input: {
    checkpoint: Checkpoint;
    now: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Checkpoint>> {
    const { checkpoint } = input;
    this.assertCanonical('Checkpoint', checkpoint);
    this.assertRelatedAudit(checkpoint.workspaceId, input.auditEvent);
    this.assertReceipt(checkpoint.workspaceId, input.receipt);
    const nowMs = timestampMs(input.now, 'checkpoint now');
    return this.coordinator.runSerialized(checkpoint.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      await this.assertCheckpointAuthority(checkpoint, nowMs);
      const statements: D1PreparedStatementLike[] = [this.insertCheckpointStatement(checkpoint)];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'append Checkpoint');
      return { kind: 'committed', value: clone(checkpoint) };
    });
  }

  async completeTask(
    input: CompleteTaskCommitInput,
  ): Promise<MutationCommitResult<CompleteTaskCommitValue>> {
    this.assertCanonical('Task', input.task);
    this.assertCanonical('Lease', input.lease);
    this.assertCanonical('Checkpoint', input.checkpoint);
    this.assertRelatedAudit(input.workspaceId, input.auditEvent);
    this.assertReceipt(input.workspaceId, input.receipt);
    const nowMs = timestampMs(input.now, 'completion now');

    return this.coordinator.runSerialized(input.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const currentTask = await this.getTask(input.workspaceId, input.task.id);
      if (!currentTask) {
        throw new PersistenceError('NOT_FOUND', `Task ${input.task.id} was not found.`);
      }
      if (currentTask.revision !== input.expectedTaskRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Task ${currentTask.id} revision ${currentTask.revision} does not match ${input.expectedTaskRevision}.`,
        );
      }
      const currentLease = await this.getLease(input.workspaceId, input.lease.id);
      if (!currentLease) {
        throw new PersistenceError(
          'STALE_AUTHORITY',
          `Lease ${input.lease.id} is not authoritative.`,
        );
      }
      this.assertCompletionAuthority(input, currentTask, currentLease, nowMs);

      const currentGoal = await this.getGoal(input.workspaceId, currentTask.goalId);
      if (!currentGoal) {
        throw new PersistenceError('INTEGRITY_ERROR', `Goal ${currentTask.goalId} was not found.`);
      }
      const goalTasks = await this.listGoalTasks(input.workspaceId, currentTask.goalId);
      const shouldSucceedGoal =
        currentGoal.status === 'active' &&
        goalTasks.length > 0 &&
        goalTasks.every((task) => task.id === currentTask.id || task.status === 'succeeded');
      const succeededGoal = shouldSucceedGoal
        ? ({
            ...currentGoal,
            revision: currentGoal.revision + 1,
            updatedAt: input.now,
            status: 'succeeded',
          } satisfies Goal)
        : undefined;
      if (succeededGoal) this.assertCanonical('Goal', succeededGoal);

      const statements: D1PreparedStatementLike[] = [
        this.insertCheckpointStatement(input.checkpoint),
        this.database
          .prepare(
            `UPDATE tasks
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'running'`,
          )
          .bind(
            input.task.revision,
            input.task.status,
            timestampMs(input.task.updatedAt, 'Task.updatedAt'),
            serializeJson(input.task, 'Task'),
            input.workspaceId,
            input.task.id,
            input.expectedTaskRevision,
          ),
        this.database
          .prepare(
            `UPDATE leases
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
               AND fencing_token = ?`,
          )
          .bind(
            input.lease.revision,
            input.lease.status,
            timestampMs(input.lease.updatedAt, 'Lease.updatedAt'),
            serializeJson(input.lease, 'Lease'),
            input.workspaceId,
            input.lease.id,
            currentLease.revision,
            currentLease.fencingToken,
          ),
      ];
      if (succeededGoal) {
        statements.push(
          this.database
            .prepare(
              `UPDATE goals
               SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
               WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'`,
            )
            .bind(
              succeededGoal.revision,
              succeededGoal.status,
              nowMs,
              serializeJson(succeededGoal, 'Goal'),
              input.workspaceId,
              succeededGoal.id,
              currentGoal.revision,
            ),
        );
      }
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'complete Task');
      return {
        kind: 'committed',
        value: {
          task: clone(input.task),
          lease: clone(input.lease),
          checkpoint: clone(input.checkpoint),
          ...(succeededGoal === undefined ? {} : { goal: clone(succeededGoal) }),
        },
      };
    });
  }

  async failTask(
    input: TaskOutcomeCommitInput,
  ): Promise<MutationCommitResult<TaskOutcomeCommitValue>> {
    return this.commitTaskOutcome(input, 'failed', 'result', 'fail Task');
  }

  async blockTask(
    input: TaskOutcomeCommitInput,
  ): Promise<MutationCommitResult<TaskOutcomeCommitValue>> {
    return this.commitTaskOutcome(input, 'blocked', 'blocked', 'block Task');
  }

  async resumeTask(input: {
    task: Task;
    expectedRevision: number;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Task>> {
    const { task } = input;
    this.assertCanonical('Task', task);
    this.assertRelatedAudit(task.workspaceId, input.auditEvent);
    this.assertReceipt(task.workspaceId, input.receipt);

    return this.coordinator.runSerialized(task.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const current = await this.getTask(task.workspaceId, task.id);
      if (!current) throw new PersistenceError('NOT_FOUND', `Task ${task.id} was not found.`);
      if (current.revision !== input.expectedRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Task ${task.id} revision ${current.revision} does not match ${input.expectedRevision}.`,
        );
      }
      if (current.status !== 'blocked') {
        throw new PersistenceError(
          'INVALID_STATE_TRANSITION',
          `Task ${task.id} cannot resume from ${current.status}.`,
        );
      }

      let expectedStatus: Task['status'] = 'ready';
      for (const dependencyTaskId of current.dependencyTaskIds) {
        const dependency = await this.getTask(task.workspaceId, dependencyTaskId);
        if (!dependency || dependency.goalId !== current.goalId) {
          throw new PersistenceError(
            'INTEGRITY_ERROR',
            `Task ${task.id} dependency ${dependencyTaskId} is invalid.`,
          );
        }
        if (dependency.status !== 'succeeded') expectedStatus = 'pending';
      }

      if (
        task.workspaceId !== current.workspaceId ||
        task.id !== current.id ||
        task.goalId !== current.goalId ||
        task.createdAt !== current.createdAt ||
        task.revision !== input.expectedRevision + 1 ||
        task.status !== expectedStatus ||
        task.statusReason !== undefined ||
        JSON.stringify(task.requiredCapabilities) !==
          JSON.stringify(current.requiredCapabilities) ||
        JSON.stringify(task.dependencyTaskIds) !== JSON.stringify(current.dependencyTaskIds)
      ) {
        throw new PersistenceError('INVALID_RECORD', 'ResumeTask replacement is invalid.');
      }

      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `UPDATE tasks
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'blocked'`,
          )
          .bind(
            task.revision,
            task.status,
            timestampMs(task.updatedAt, 'Task.updatedAt'),
            serializeJson(task, 'Task'),
            task.workspaceId,
            task.id,
            input.expectedRevision,
          ),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'resume Task');
      return { kind: 'committed', value: clone(task) };
    });
  }

  async retryTask(input: {
    task: Task;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Task>> {
    const { task } = input;
    this.assertCanonical('Task', task);
    this.assertRelatedAudit(task.workspaceId, input.auditEvent);
    this.assertReceipt(task.workspaceId, input.receipt);
    const nowMs = timestampMs(input.now, 'retry Task now');
    const cutoffMs = timestampMs(input.sessionCutoff, 'retry Task session cutoff');

    return this.coordinator.runSerialized(task.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const current = await this.getTask(task.workspaceId, task.id);
      if (!current) throw new PersistenceError('NOT_FOUND', `Task ${task.id} was not found.`);
      if (current.revision !== input.expectedRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Task ${task.id} revision ${current.revision} does not match ${input.expectedRevision}.`,
        );
      }
      const goal = await this.getGoal(task.workspaceId, current.goalId);
      if (!goal) {
        throw new PersistenceError('INTEGRITY_ERROR', `Goal ${current.goalId} was not found.`);
      }
      if (goal.status !== 'active' || current.status !== 'failed') {
        throw new PersistenceError(
          'INVALID_STATE_TRANSITION',
          `Task ${task.id} cannot be retried from current durable state.`,
        );
      }
      if (await this.getEffectiveActiveLease(task.workspaceId, task.id, nowMs, cutoffMs)) {
        throw new PersistenceError(
          'CONFLICT',
          `Task ${task.id} still has active execution authority.`,
        );
      }

      const expected: Task = {
        ...clone(current),
        status: 'ready',
        revision: input.expectedRevision + 1,
        updatedAt: input.now,
      };
      delete expected.statusReason;
      if (serializeJson(task, 'Task') !== serializeJson(expected, 'expected RetryTask')) {
        throw new PersistenceError('INVALID_RECORD', 'RetryTask replacement is invalid.');
      }

      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `UPDATE tasks
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'failed'
               AND EXISTS (
                 SELECT 1 FROM goals
                 WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
               )`,
          )
          .bind(
            task.revision,
            task.status,
            timestampMs(task.updatedAt, 'Task.updatedAt'),
            serializeJson(task, 'Task'),
            task.workspaceId,
            task.id,
            input.expectedRevision,
            task.workspaceId,
            current.goalId,
            goal.revision,
          ),
        this.mutationChangesGuardStatement(task.workspaceId),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      statements.push(this.clearMutationBatchGuardsStatement(task.workspaceId));
      await this.batch(statements, 'retry Task');
      return { kind: 'committed', value: clone(task) };
    });
  }

  async cancelTask(
    input: CancelTaskCommitInput,
  ): Promise<MutationCommitResult<CancelTaskCommitValue>> {
    this.assertCanonical('Task', input.task);
    if (input.lease) this.assertCanonical('Lease', input.lease);
    this.assertRelatedAudit(input.workspaceId, input.auditEvent);
    this.assertReceipt(input.workspaceId, input.receipt);
    const nowMs = timestampMs(input.now, 'cancel Task now');
    const cutoffMs = timestampMs(input.sessionCutoff, 'cancel Task session cutoff');

    return this.coordinator.runSerialized(input.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const current = await this.getTask(input.workspaceId, input.task.id);
      if (!current) {
        throw new PersistenceError('NOT_FOUND', `Task ${input.task.id} was not found.`);
      }
      if (current.revision !== input.expectedTaskRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Task ${current.id} revision ${current.revision} does not match ${input.expectedTaskRevision}.`,
        );
      }
      if (!isCancellableTaskStatus(current.status)) {
        throw new PersistenceError(
          'INVALID_STATE_TRANSITION',
          `Task ${current.id} cannot be cancelled from ${current.status}.`,
        );
      }
      if (!input.task.statusReason) {
        throw new PersistenceError('INVALID_RECORD', 'Cancelled Task must include statusReason.');
      }
      const expectedTask: Task = {
        ...clone(current),
        status: 'cancelled',
        statusReason: clone(input.task.statusReason),
        revision: input.expectedTaskRevision + 1,
        updatedAt: input.now,
      };
      if (
        serializeJson(input.task, 'Task') !== serializeJson(expectedTask, 'expected CancelTask')
      ) {
        throw new PersistenceError('INVALID_RECORD', 'CancelTask replacement is invalid.');
      }

      const effectiveLease = await this.getEffectiveActiveLease(
        input.workspaceId,
        current.id,
        nowMs,
        cutoffMs,
      );
      if ((effectiveLease === undefined) !== (input.lease === undefined)) {
        throw new PersistenceError('STALE_AUTHORITY', 'CancelTask Lease view is stale.');
      }
      if (effectiveLease && input.lease) {
        const expectedLease: Lease = {
          ...clone(effectiveLease),
          status: 'revoked',
          revision: effectiveLease.revision + 1,
          updatedAt: input.now,
        };
        if (
          serializeJson(input.lease, 'Lease') !==
          serializeJson(expectedLease, 'expected CancelTask Lease')
        ) {
          throw new PersistenceError('INVALID_RECORD', 'CancelTask Lease replacement is invalid.');
        }
      }

      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `UPDATE tasks
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = ?`,
          )
          .bind(
            input.task.revision,
            input.task.status,
            timestampMs(input.task.updatedAt, 'Task.updatedAt'),
            serializeJson(input.task, 'Task'),
            input.workspaceId,
            input.task.id,
            input.expectedTaskRevision,
            current.status,
          ),
        this.mutationChangesGuardStatement(input.workspaceId),
      ];
      if (effectiveLease && input.lease) {
        statements.push(
          this.database
            .prepare(
              `UPDATE leases
               SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
               WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
                 AND fencing_token = ?`,
            )
            .bind(
              input.lease.revision,
              input.lease.status,
              timestampMs(input.lease.updatedAt, 'Lease.updatedAt'),
              serializeJson(input.lease, 'Lease'),
              input.workspaceId,
              input.lease.id,
              effectiveLease.revision,
              effectiveLease.fencingToken,
            ),
          this.mutationChangesGuardStatement(input.workspaceId),
        );
      }
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      statements.push(this.clearMutationBatchGuardsStatement(input.workspaceId));
      await this.batch(statements, 'cancel Task');
      return {
        kind: 'committed',
        value: {
          task: clone(input.task),
          ...(input.lease === undefined ? {} : { lease: clone(input.lease) }),
        },
      };
    });
  }

  async cancelGoal(
    input: CancelGoalCommitInput,
  ): Promise<MutationCommitResult<CancelGoalCommitValue>> {
    this.assertCanonical('Goal', input.goal);
    for (const task of input.tasks) this.assertCanonical('Task', task);
    for (const lease of input.leases) this.assertCanonical('Lease', lease);
    this.assertRelatedAudit(input.workspaceId, input.auditEvent);
    this.assertReceipt(input.workspaceId, input.receipt);
    const nowMs = timestampMs(input.now, 'cancel Goal now');
    const cutoffMs = timestampMs(input.sessionCutoff, 'cancel Goal session cutoff');

    return this.coordinator.runSerialized(input.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const currentGoal = await this.getGoal(input.workspaceId, input.goal.id);
      if (!currentGoal) {
        throw new PersistenceError('NOT_FOUND', `Goal ${input.goal.id} was not found.`);
      }
      if (currentGoal.revision !== input.expectedGoalRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Goal ${currentGoal.id} revision ${currentGoal.revision} does not match ${input.expectedGoalRevision}.`,
        );
      }
      if (currentGoal.status !== 'active') {
        throw new PersistenceError(
          'INVALID_STATE_TRANSITION',
          `Goal ${currentGoal.id} is already terminal.`,
        );
      }
      const expectedGoal: Goal = {
        ...clone(currentGoal),
        status: 'cancelled',
        revision: input.expectedGoalRevision + 1,
        updatedAt: input.now,
      };
      if (
        serializeJson(input.goal, 'Goal') !== serializeJson(expectedGoal, 'expected CancelGoal')
      ) {
        throw new PersistenceError('INVALID_RECORD', 'CancelGoal replacement is invalid.');
      }

      const currentTasks = await this.listGoalTasks(input.workspaceId, currentGoal.id);
      const cancellable = currentTasks.filter((task) => isCancellableTaskStatus(task.status));
      const outputTasks = new Map(input.tasks.map((task) => [task.id, task]));
      if (outputTasks.size !== input.tasks.length || input.tasks.length !== cancellable.length) {
        throw new PersistenceError('INVALID_RECORD', 'CancelGoal Task set is invalid.');
      }
      const effectiveLeases: Lease[] = [];
      for (const currentTask of cancellable) {
        const output = outputTasks.get(currentTask.id);
        if (!output || !output.statusReason) {
          throw new PersistenceError('INVALID_RECORD', 'CancelGoal Task replacement is missing.');
        }
        const expectedTask: Task = {
          ...clone(currentTask),
          status: 'cancelled',
          statusReason: clone(output.statusReason),
          revision: currentTask.revision + 1,
          updatedAt: input.now,
        };
        if (
          serializeJson(output, 'Task') !== serializeJson(expectedTask, 'expected CancelGoal Task')
        ) {
          throw new PersistenceError('INVALID_RECORD', 'CancelGoal Task replacement is invalid.');
        }
        const effective = await this.getEffectiveActiveLease(
          input.workspaceId,
          currentTask.id,
          nowMs,
          cutoffMs,
        );
        if (effective) effectiveLeases.push(effective);
      }

      const outputLeases = new Map(input.leases.map((lease) => [lease.id, lease]));
      if (
        outputLeases.size !== input.leases.length ||
        input.leases.length !== effectiveLeases.length
      ) {
        throw new PersistenceError('STALE_AUTHORITY', 'CancelGoal Lease set is stale.');
      }
      for (const effective of effectiveLeases) {
        const output = outputLeases.get(effective.id);
        if (!output) {
          throw new PersistenceError('STALE_AUTHORITY', 'CancelGoal effective Lease is missing.');
        }
        const expectedLease: Lease = {
          ...clone(effective),
          status: 'revoked',
          revision: effective.revision + 1,
          updatedAt: input.now,
        };
        if (
          serializeJson(output, 'Lease') !==
          serializeJson(expectedLease, 'expected CancelGoal Lease')
        ) {
          throw new PersistenceError('INVALID_RECORD', 'CancelGoal Lease replacement is invalid.');
        }
      }

      const statements: D1PreparedStatementLike[] = [];
      for (const currentTask of cancellable) {
        const output = outputTasks.get(currentTask.id)!;
        statements.push(
          this.database
            .prepare(
              `UPDATE tasks
               SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
               WHERE workspace_id = ? AND id = ? AND revision = ? AND status = ?`,
            )
            .bind(
              output.revision,
              output.status,
              timestampMs(output.updatedAt, 'Task.updatedAt'),
              serializeJson(output, 'Task'),
              input.workspaceId,
              output.id,
              currentTask.revision,
              currentTask.status,
            ),
          this.mutationChangesGuardStatement(input.workspaceId),
        );
      }
      for (const effective of effectiveLeases) {
        const output = outputLeases.get(effective.id)!;
        statements.push(
          this.database
            .prepare(
              `UPDATE leases
               SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
               WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
                 AND fencing_token = ?`,
            )
            .bind(
              output.revision,
              output.status,
              timestampMs(output.updatedAt, 'Lease.updatedAt'),
              serializeJson(output, 'Lease'),
              input.workspaceId,
              output.id,
              effective.revision,
              effective.fencingToken,
            ),
          this.mutationChangesGuardStatement(input.workspaceId),
        );
      }
      statements.push(
        this.database
          .prepare(
            `UPDATE goals
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
               AND NOT EXISTS (
                 SELECT 1 FROM tasks
                 WHERE workspace_id = ? AND goal_id = ?
                   AND status IN ('pending', 'ready', 'running', 'blocked')
               )`,
          )
          .bind(
            input.goal.revision,
            input.goal.status,
            timestampMs(input.goal.updatedAt, 'Goal.updatedAt'),
            serializeJson(input.goal, 'Goal'),
            input.workspaceId,
            input.goal.id,
            input.expectedGoalRevision,
            input.workspaceId,
            input.goal.id,
          ),
        this.mutationChangesGuardStatement(input.workspaceId),
      );
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      statements.push(this.clearMutationBatchGuardsStatement(input.workspaceId));
      await this.batch(statements, 'cancel Goal');
      return {
        kind: 'committed',
        value: {
          goal: clone(input.goal),
          tasks: clone(input.tasks),
          leases: clone(input.leases),
        },
      };
    });
  }

  private async commitTaskOutcome(
    input: TaskOutcomeCommitInput,
    expectedTaskStatus: 'failed' | 'blocked',
    expectedCheckpointKind: 'result' | 'blocked',
    operation: string,
  ): Promise<MutationCommitResult<TaskOutcomeCommitValue>> {
    this.assertCanonical('Task', input.task);
    this.assertCanonical('Lease', input.lease);
    this.assertCanonical('Checkpoint', input.checkpoint);
    this.assertRelatedAudit(input.workspaceId, input.auditEvent);
    this.assertReceipt(input.workspaceId, input.receipt);
    const nowMs = timestampMs(input.now, `${operation} now`);

    return this.coordinator.runSerialized(input.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const currentTask = await this.getTask(input.workspaceId, input.task.id);
      if (!currentTask) {
        throw new PersistenceError('NOT_FOUND', `Task ${input.task.id} was not found.`);
      }
      if (currentTask.revision !== input.expectedTaskRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Task ${currentTask.id} revision ${currentTask.revision} does not match ${input.expectedTaskRevision}.`,
        );
      }
      const currentLease = await this.getLease(input.workspaceId, input.lease.id);
      const currentSession = currentLease
        ? await this.getSession(input.workspaceId, currentLease.sessionId)
        : undefined;
      const effectiveLease = await this.getActiveLease(input.workspaceId, input.task.id);
      if (
        !currentLease ||
        !currentSession ||
        currentSession.status !== 'active' ||
        !effectiveLease ||
        effectiveLease.id !== currentLease.id ||
        effectiveLease.fencingToken !== currentLease.fencingToken ||
        currentLease.status !== 'active' ||
        timestampMs(currentLease.expiresAt, 'Lease.expiresAt') <= nowMs
      ) {
        throw new PersistenceError('STALE_AUTHORITY', 'Task outcome authority is stale.');
      }

      const checkpoint = input.checkpoint;
      if (
        currentTask.status !== 'running' ||
        input.task.workspaceId !== input.workspaceId ||
        input.task.id !== currentTask.id ||
        input.task.goalId !== currentTask.goalId ||
        input.task.createdAt !== currentTask.createdAt ||
        input.task.status !== expectedTaskStatus ||
        input.task.revision !== input.expectedTaskRevision + 1 ||
        input.lease.workspaceId !== input.workspaceId ||
        input.lease.id !== currentLease.id ||
        input.lease.taskId !== currentTask.id ||
        input.lease.sessionId !== currentLease.sessionId ||
        input.lease.fencingToken !== currentLease.fencingToken ||
        input.lease.createdAt !== currentLease.createdAt ||
        input.lease.expiresAt !== currentLease.expiresAt ||
        input.lease.status !== 'released' ||
        input.lease.revision !== currentLease.revision + 1 ||
        checkpoint.workspaceId !== input.workspaceId ||
        checkpoint.taskId !== currentTask.id ||
        checkpoint.sessionId !== currentLease.sessionId ||
        checkpoint.leaseId !== currentLease.id ||
        checkpoint.fencingToken !== currentLease.fencingToken ||
        checkpoint.kind !== expectedCheckpointKind
      ) {
        throw new PersistenceError('INVALID_RECORD', 'Task outcome replacement is invalid.');
      }

      const statements: D1PreparedStatementLike[] = [
        this.insertCheckpointStatement(checkpoint),
        this.database
          .prepare(
            `UPDATE tasks
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'running'`,
          )
          .bind(
            input.task.revision,
            input.task.status,
            timestampMs(input.task.updatedAt, 'Task.updatedAt'),
            serializeJson(input.task, 'Task'),
            input.workspaceId,
            input.task.id,
            input.expectedTaskRevision,
          ),
        this.database
          .prepare(
            `UPDATE leases
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
               AND fencing_token = ?`,
          )
          .bind(
            input.lease.revision,
            input.lease.status,
            timestampMs(input.lease.updatedAt, 'Lease.updatedAt'),
            serializeJson(input.lease, 'Lease'),
            input.workspaceId,
            input.lease.id,
            currentLease.revision,
            currentLease.fencingToken,
          ),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, operation);
      return {
        kind: 'committed',
        value: {
          task: clone(input.task),
          lease: clone(input.lease),
          checkpoint: clone(checkpoint),
        },
      };
    });
  }

  async appendAuditEvent(input: { auditEvent: AuditEvent }): Promise<void> {
    this.assertCanonical('AuditEvent', input.auditEvent);
    await this.coordinator.runSerialized(input.auditEvent.workspaceId, async () => {
      await this.requireWorkspace(input.auditEvent.workspaceId);
      await this.run(this.insertAuditStatement(input.auditEvent), 'append AuditEvent');
    });
  }

  async appendPermissionRequestWithInitialDecision(input: {
    request: PermissionRequest;
    decision: PermissionDecision;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<{ request: PermissionRequest; decision: PermissionDecision }>> {
    this.assertCanonical('PermissionRequest', input.request);
    this.assertCanonical('PermissionDecision', input.decision);
    this.assertRelatedAudit(input.request.workspaceId, input.auditEvent);
    this.assertReceipt(input.request.workspaceId, input.receipt);
    if (
      input.decision.workspaceId !== input.request.workspaceId ||
      input.decision.requestId !== input.request.id ||
      input.decision.sequence !== 1 ||
      input.decision.supersedesDecisionId !== undefined
    ) {
      throw new PersistenceError(
        'INVALID_RECORD',
        'Initial PermissionDecision must be sequence 1 for the same PermissionRequest.',
      );
    }

    return this.coordinator.runSerialized(input.request.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      await this.requireWorkspace(input.request.workspaceId);
      const statements: D1PreparedStatementLike[] = [
        this.insertPermissionRequestStatement(input.request),
        this.insertPermissionDecisionStatement(input.decision),
        this.database
          .prepare(
            `INSERT INTO permission_heads(
              workspace_id, request_id, latest_decision_id, latest_sequence, latest_outcome
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .bind(
            input.request.workspaceId,
            input.request.id,
            input.decision.id,
            input.decision.sequence,
            input.decision.outcome,
          ),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'append PermissionRequest and initial decision');
      return {
        kind: 'committed',
        value: { request: clone(input.request), decision: clone(input.decision) },
      };
    });
  }

  async appendPermissionDecision(input: {
    decision: PermissionDecision;
    expectedPreviousDecisionId: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<PermissionDecision>> {
    this.assertCanonical('PermissionDecision', input.decision);
    this.assertRelatedAudit(input.decision.workspaceId, input.auditEvent);
    this.assertReceipt(input.decision.workspaceId, input.receipt);
    return this.coordinator.runSerialized(input.decision.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const head = await this.first<PermissionHeadRow>(
        `SELECT latest_decision_id, latest_sequence, latest_outcome
         FROM permission_heads
         WHERE workspace_id = ? AND request_id = ?`,
        input.decision.workspaceId,
        input.decision.requestId,
      );
      if (!head) {
        throw new PersistenceError(
          'NOT_FOUND',
          `PermissionRequest ${input.decision.requestId} has no decision head.`,
        );
      }
      if (head.latest_decision_id !== input.expectedPreviousDecisionId) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Permission decision head changed from ${input.expectedPreviousDecisionId}.`,
        );
      }
      if (
        input.decision.sequence !== head.latest_sequence + 1 ||
        input.decision.supersedesDecisionId !== head.latest_decision_id
      ) {
        throw new PersistenceError(
          'INVALID_RECORD',
          'PermissionDecision sequence/supersession does not extend the current head.',
        );
      }

      const statements: D1PreparedStatementLike[] = [
        this.insertPermissionDecisionStatement(input.decision),
        this.database
          .prepare(
            `UPDATE permission_heads
             SET latest_decision_id = ?, latest_sequence = ?, latest_outcome = ?
             WHERE workspace_id = ? AND request_id = ?
               AND latest_decision_id = ? AND latest_sequence = ?`,
          )
          .bind(
            input.decision.id,
            input.decision.sequence,
            input.decision.outcome,
            input.decision.workspaceId,
            input.decision.requestId,
            head.latest_decision_id,
            head.latest_sequence,
          ),
      ];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'append PermissionDecision');
      return { kind: 'committed', value: clone(input.decision) };
    });
  }

  async commitCommandReceipt(
    receipt: CommandReceiptInput,
  ): Promise<MutationCommitResult<undefined>> {
    this.assertReceipt(receipt.workspaceId, receipt);
    return this.coordinator.runSerialized(receipt.workspaceId, async () => {
      const replay = await this.resolveReceipt(receipt);
      if (replay) return replay;
      await this.requireWorkspace(receipt.workspaceId);
      const statements: D1PreparedStatementLike[] = [];
      this.pushReceiptStatement(statements, receipt);
      await this.batch(statements, 'commit command receipt');
      return { kind: 'committed', value: undefined };
    });
  }

  async getCommandReceipt(
    workspaceId: string,
    commandId: string,
  ): Promise<StoredCommandReceipt | undefined> {
    const row = await this.first<ReceiptRow>(
      `SELECT workspace_id, command_id, command_discriminator, semantic_fingerprint,
              outcome_kind, response_snapshot_json, created_at_ms, expires_at_ms
       FROM command_receipts
       WHERE workspace_id = ? AND command_id = ?`,
      workspaceId,
      commandId,
    );
    if (!row) return undefined;
    return clone({
      workspaceId: row.workspace_id,
      commandId: row.command_id,
      command: row.command_discriminator,
      semanticFingerprint: row.semantic_fingerprint,
      outcomeKind: row.outcome_kind,
      responseSnapshot: parseJson(row.response_snapshot_json, 'command receipt response snapshot'),
      createdAt: new Date(row.created_at_ms).toISOString(),
      ...(row.expires_at_ms === null
        ? {}
        : { expiresAt: new Date(row.expires_at_ms).toISOString() }),
    });
  }

  async getPermissionRequest(
    workspaceId: string,
    requestId: string,
  ): Promise<PermissionRequest | undefined> {
    return this.readRecord<PermissionRequest>(
      `SELECT record_json FROM permission_requests WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      requestId,
    );
  }

  async loadWorkspaceState(workspaceId: string): Promise<WorkspaceStateSnapshot | undefined> {
    const workspaceRecord = await this.getWorkspace(workspaceId);
    if (!workspaceRecord) return undefined;
    const [goals, tasks, agents, sessions, leases, checkpoints, requests, decisions, auditEvents] =
      await Promise.all([
        this.readRecords<Goal>(
          `SELECT record_json FROM goals WHERE workspace_id = ? ORDER BY created_at_ms, id`,
          workspaceId,
        ),
        this.readRecords<Task>(
          `SELECT record_json FROM tasks WHERE workspace_id = ? ORDER BY created_at_ms, id`,
          workspaceId,
        ),
        this.readRecords<Agent>(
          `SELECT record_json FROM agents WHERE workspace_id = ? ORDER BY created_at_ms, id`,
          workspaceId,
        ),
        this.readRecords<Session>(
          `SELECT record_json FROM sessions WHERE workspace_id = ? ORDER BY created_at_ms, id`,
          workspaceId,
        ),
        this.readRecords<Lease>(
          `SELECT record_json FROM leases WHERE workspace_id = ? ORDER BY created_at_ms, id`,
          workspaceId,
        ),
        this.readRecords<Checkpoint>(
          `SELECT record_json FROM checkpoints WHERE workspace_id = ? ORDER BY created_at_ms, id`,
          workspaceId,
        ),
        this.readRecords<PermissionRequest>(
          `SELECT record_json FROM permission_requests
           WHERE workspace_id = ? ORDER BY created_at_ms, id`,
          workspaceId,
        ),
        this.readRecords<PermissionDecision>(
          `SELECT record_json FROM permission_decisions
           WHERE workspace_id = ? ORDER BY created_at_ms, request_id, sequence, id`,
          workspaceId,
        ),
        this.readRecords<AuditEvent>(
          `SELECT record_json FROM audit_events WHERE workspace_id = ? ORDER BY created_at_ms, id`,
          workspaceId,
        ),
      ]);
    const counterRows = await this.all<CounterRow>(
      `SELECT task_id, last_fencing_token
       FROM task_fencing_counters WHERE workspace_id = ? ORDER BY task_id`,
      workspaceId,
    );
    return {
      workspace: workspaceRecord,
      goals,
      tasks,
      agents,
      sessions,
      leases,
      checkpoints,
      permissionRequests: requests,
      permissionDecisions: decisions,
      auditEvents,
      fencingCounters: Object.fromEntries(
        counterRows.map((row) => [row.task_id, Number(row.last_fencing_token)]),
      ),
    };
  }

  async listClaimableTasks(
    workspaceId: string,
    sessionId: string,
    now: string,
    sessionCutoff: string,
    limit: number,
    offset = 0,
  ): Promise<Task[]> {
    const nowMs = timestampMs(now, 'claimable now');
    const cutoffMs = timestampMs(sessionCutoff, 'claimable session cutoff');
    const session = await this.getSession(workspaceId, sessionId);
    if (!session) throw new PersistenceError('NOT_FOUND', `Session ${sessionId} was not found.`);
    if (
      session.status !== 'active' ||
      timestampMs(session.lastSeenAt, 'Session.lastSeenAt') <= cutoffMs
    ) {
      throw new PersistenceError('CONFLICT', `Session ${sessionId} is not active.`);
    }
    const agent = await this.getAgent(workspaceId, session.agentId);
    if (!agent || agent.status !== 'active') {
      throw new PersistenceError('CONFLICT', `Agent ${session.agentId} is not active.`);
    }
    return this.readRecords<Task>(
      `SELECT t.record_json
       FROM tasks t
       WHERE t.workspace_id = ?
         AND (
           t.status = 'ready'
           OR (
             t.status = 'running'
             AND NOT EXISTS (
               SELECT 1
               FROM leases l
               JOIN sessions owner_session
                 ON owner_session.workspace_id = l.workspace_id
                AND owner_session.id = l.session_id
               WHERE l.workspace_id = t.workspace_id
                 AND l.task_id = t.id
                 AND l.status = 'active'
                 AND l.expires_at_ms > ?
                 AND owner_session.status = 'active'
                 AND owner_session.last_seen_at_ms > ?
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM task_required_capabilities trc
           WHERE trc.workspace_id = t.workspace_id AND trc.task_id = t.id
             AND NOT EXISTS (
               SELECT 1
               FROM agent_capabilities ac
               WHERE ac.workspace_id = t.workspace_id
                 AND ac.agent_id = ?
                 AND ac.capability = trc.capability
             )
         )
       ORDER BY t.created_at_ms, t.id
       LIMIT ? OFFSET ?`,
      workspaceId,
      nowMs,
      cutoffMs,
      agent.id,
      boundedLimit(limit),
      boundedOffset(offset),
    );
  }

  async listTaskCheckpoints(
    workspaceId: string,
    taskId: string,
    limit?: number,
    offset = 0,
  ): Promise<Checkpoint[]> {
    if (limit === undefined) {
      return this.readRecords<Checkpoint>(
        `SELECT record_json FROM checkpoints
         WHERE workspace_id = ? AND task_id = ? ORDER BY created_at_ms, id`,
        workspaceId,
        taskId,
      );
    }
    return this.readRecords<Checkpoint>(
      `SELECT record_json FROM checkpoints
       WHERE workspace_id = ? AND task_id = ? ORDER BY created_at_ms, id LIMIT ? OFFSET ?`,
      workspaceId,
      taskId,
      boundedLimit(limit),
      boundedOffset(offset),
    );
  }

  async listAuditEvents(workspaceId: string, limit: number): Promise<AuditEvent[]> {
    return this.readRecords<AuditEvent>(
      `SELECT record_json FROM audit_events
       WHERE workspace_id = ? ORDER BY created_at_ms, id LIMIT ?`,
      workspaceId,
      boundedLimit(limit),
    );
  }

  async listPermissionDecisions(
    workspaceId: string,
    requestId: string,
    limit?: number,
    offset = 0,
  ): Promise<PermissionDecision[]> {
    if (limit === undefined) {
      return this.readRecords<PermissionDecision>(
        `SELECT record_json FROM permission_decisions
         WHERE workspace_id = ? AND request_id = ? ORDER BY sequence, created_at_ms, id`,
        workspaceId,
        requestId,
      );
    }
    return this.readRecords<PermissionDecision>(
      `SELECT record_json FROM permission_decisions
       WHERE workspace_id = ? AND request_id = ?
       ORDER BY sequence, created_at_ms, id LIMIT ? OFFSET ?`,
      workspaceId,
      requestId,
      boundedLimit(limit),
      boundedOffset(offset),
    );
  }

  async listPendingHumanPermissions(
    workspaceId: string,
    limit: number,
    offset = 0,
  ): Promise<PendingHumanPermission[]> {
    const rows = await this.all<PendingPermissionRow>(
      `SELECT pr.record_json AS request_json, pd.record_json AS decision_json
       FROM permission_heads ph
       JOIN permission_requests pr
         ON pr.workspace_id = ph.workspace_id AND pr.id = ph.request_id
       JOIN permission_decisions pd
         ON pd.workspace_id = ph.workspace_id AND pd.id = ph.latest_decision_id
       WHERE ph.workspace_id = ? AND ph.latest_outcome = 'HUMAN_REQUIRED'
       ORDER BY pr.created_at_ms, pr.id
       LIMIT ? OFFSET ?`,
      workspaceId,
      boundedLimit(limit),
      boundedOffset(offset),
    );
    return rows.map((row) => ({
      request: parseJson<PermissionRequest>(row.request_json, 'PermissionRequest'),
      latestDecision: parseJson<PermissionDecision>(row.decision_json, 'PermissionDecision'),
    }));
  }

  async listExpiredActiveLeases(workspaceId: string, now: string, limit: number): Promise<Lease[]> {
    return this.readRecords<Lease>(
      `SELECT record_json FROM leases
       WHERE workspace_id = ? AND status = 'active' AND expires_at_ms <= ?
       ORDER BY expires_at_ms, id LIMIT ?`,
      workspaceId,
      timestampMs(now, 'lease recovery now'),
      boundedLimit(limit),
    );
  }

  async listActiveSessionsLastSeenBefore(
    workspaceId: string,
    cutoff: string,
    limit: number,
  ): Promise<Session[]> {
    return this.readRecords<Session>(
      `SELECT record_json FROM sessions
       WHERE workspace_id = ? AND status = 'active' AND last_seen_at_ms <= ?
       ORDER BY last_seen_at_ms, id LIMIT ?`,
      workspaceId,
      timestampMs(cutoff, 'session recovery cutoff'),
      boundedLimit(limit),
    );
  }

  private async resolveReceiptSource<T>(
    receipt: CommandReceiptInput | undefined,
    deferredReceipt: DeferredCommandReceiptInput<T> | undefined,
  ): Promise<{ kind: 'replayed'; receipt: StoredCommandReceipt } | undefined> {
    if (receipt) return this.resolveReceipt(receipt);
    if (!deferredReceipt) return undefined;
    const stored = await this.getCommandReceipt(
      deferredReceipt.workspaceId,
      deferredReceipt.commandId,
    );
    if (!stored) return undefined;
    if (
      stored.command !== deferredReceipt.command ||
      stored.semanticFingerprint !== deferredReceipt.semanticFingerprint
    ) {
      throw new PersistenceError(
        'IDEMPOTENCY_CONFLICT',
        `Command ${deferredReceipt.commandId} was already admitted with different semantics.`,
      );
    }
    return { kind: 'replayed', receipt: clone(stored) };
  }

  private materializeReceipt<T>(
    receipt: CommandReceiptInput | undefined,
    deferredReceipt: DeferredCommandReceiptInput<T> | undefined,
    value: T,
  ): CommandReceiptInput | undefined {
    if (receipt) return receipt;
    if (!deferredReceipt) return undefined;
    const materialized: CommandReceiptInput = {
      workspaceId: deferredReceipt.workspaceId,
      commandId: deferredReceipt.commandId,
      command: deferredReceipt.command,
      semanticFingerprint: deferredReceipt.semanticFingerprint,
      outcomeKind: deferredReceipt.outcomeKind,
      responseSnapshot: deferredReceipt.buildResponseSnapshot(clone(value)),
      createdAt: deferredReceipt.createdAt,
      ...(deferredReceipt.expiresAt === undefined ? {} : { expiresAt: deferredReceipt.expiresAt }),
    };
    this.assertReceipt(materialized.workspaceId, materialized);
    return materialized;
  }

  private async resolveReceipt(
    receipt: CommandReceiptInput | undefined,
  ): Promise<{ kind: 'replayed'; receipt: StoredCommandReceipt } | undefined> {
    if (!receipt) return undefined;
    const stored = await this.getCommandReceipt(receipt.workspaceId, receipt.commandId);
    if (!stored) return undefined;
    if (
      stored.command !== receipt.command ||
      stored.semanticFingerprint !== receipt.semanticFingerprint
    ) {
      throw new PersistenceError(
        'IDEMPOTENCY_CONFLICT',
        `Command ${receipt.commandId} was already admitted with different semantics.`,
      );
    }
    return { kind: 'replayed', receipt: clone(stored) };
  }

  private async assertDependencies(task: Task): Promise<void> {
    for (const dependencyId of task.dependencyTaskIds) {
      const dependency = await this.getTask(task.workspaceId, dependencyId);
      if (!dependency) {
        throw new PersistenceError('NOT_FOUND', `Dependency Task ${dependencyId} was not found.`);
      }
      if (dependency.goalId !== task.goalId) {
        throw new PersistenceError(
          'CONFLICT',
          `Dependency Task ${dependencyId} belongs to a different Goal.`,
        );
      }
    }
  }

  private async assertCheckpointAuthority(checkpoint: Checkpoint, nowMs: number): Promise<void> {
    const task = await this.getTask(checkpoint.workspaceId, checkpoint.taskId);
    const lease = await this.getLease(checkpoint.workspaceId, checkpoint.leaseId);
    const session = await this.getSession(checkpoint.workspaceId, checkpoint.sessionId);
    if (
      !task ||
      !lease ||
      !session ||
      task.status !== 'running' ||
      session.status !== 'active' ||
      lease.status !== 'active' ||
      lease.taskId !== task.id ||
      lease.sessionId !== session.id ||
      lease.fencingToken !== checkpoint.fencingToken ||
      timestampMs(lease.expiresAt, 'Lease.expiresAt') <= nowMs
    ) {
      throw new PersistenceError('STALE_AUTHORITY', 'Checkpoint authority is stale or inactive.');
    }
    const effective = await this.getActiveLease(checkpoint.workspaceId, checkpoint.taskId);
    if (
      !effective ||
      effective.id !== lease.id ||
      effective.fencingToken !== checkpoint.fencingToken
    ) {
      throw new PersistenceError('STALE_AUTHORITY', 'Checkpoint Lease is no longer effective.');
    }
  }

  private assertCompletionAuthority(
    input: CompleteTaskCommitInput,
    currentTask: Task,
    currentLease: Lease,
    nowMs: number,
  ): void {
    const checkpoint = input.checkpoint;
    if (
      currentTask.status !== 'running' ||
      input.task.status !== 'succeeded' ||
      input.task.revision !== input.expectedTaskRevision + 1 ||
      input.task.workspaceId !== input.workspaceId ||
      input.task.id !== currentTask.id ||
      input.task.goalId !== currentTask.goalId ||
      currentLease.status !== 'active' ||
      timestampMs(currentLease.expiresAt, 'Lease.expiresAt') <= nowMs ||
      currentLease.taskId !== currentTask.id ||
      input.lease.id !== currentLease.id ||
      input.lease.workspaceId !== input.workspaceId ||
      input.lease.taskId !== currentTask.id ||
      input.lease.sessionId !== currentLease.sessionId ||
      input.lease.fencingToken !== currentLease.fencingToken ||
      input.lease.status !== 'released' ||
      input.lease.revision !== currentLease.revision + 1 ||
      checkpoint.workspaceId !== input.workspaceId ||
      checkpoint.taskId !== currentTask.id ||
      checkpoint.leaseId !== currentLease.id ||
      checkpoint.sessionId !== currentLease.sessionId ||
      checkpoint.fencingToken !== currentLease.fencingToken ||
      checkpoint.kind !== 'result'
    ) {
      throw new PersistenceError(
        'STALE_AUTHORITY',
        'Task completion authority is stale or invalid.',
      );
    }
  }

  private assertCanonical(target: PersistenceDomainTarget, value: unknown): void {
    const validation = this.validateCanonicalDomainRecord(target, value);
    if (validation.valid) return;
    const details = validation.errors?.slice(0, 3).join('; ');
    throw new PersistenceError(
      'INVALID_RECORD',
      details ? `${target} violates canonical schema: ${details}` : `${target} is invalid.`,
    );
  }

  private assertRelatedAudit(workspaceId: string, auditEvent: AuditEvent | undefined): void {
    if (!auditEvent) return;
    this.assertCanonical('AuditEvent', auditEvent);
    if (auditEvent.workspaceId !== workspaceId) {
      throw new PersistenceError('INVALID_RECORD', 'AuditEvent Workspace does not match mutation.');
    }
  }

  private assertReceipt(workspaceId: string, receipt: CommandReceiptInput | undefined): void {
    if (!receipt) return;
    if (receipt.workspaceId !== workspaceId) {
      throw new PersistenceError(
        'INVALID_RECORD',
        'Command receipt Workspace does not match mutation.',
      );
    }
    if (!receipt.commandId || !receipt.command || !receipt.semanticFingerprint) {
      throw new PersistenceError(
        'INVALID_RECORD',
        'Command receipt identity fields must be non-empty.',
      );
    }
    timestampMs(receipt.createdAt, 'CommandReceipt.createdAt');
    if (receipt.expiresAt !== undefined) timestampMs(receipt.expiresAt, 'CommandReceipt.expiresAt');
    serializeJson(
      receipt.responseSnapshot,
      'CommandReceipt.responseSnapshot',
      MAX_RECEIPT_SNAPSHOT_BYTES,
    );
  }

  private assertDeferredReceipt<T>(
    workspaceId: string,
    receipt: DeferredCommandReceiptInput<T> | undefined,
  ): void {
    if (!receipt) return;
    if (receipt.workspaceId !== workspaceId) {
      throw new PersistenceError(
        'INVALID_RECORD',
        'Deferred receipt Workspace does not match mutation.',
      );
    }
    if (!receipt.commandId || !receipt.command || !receipt.semanticFingerprint) {
      throw new PersistenceError(
        'INVALID_RECORD',
        'Deferred receipt identity fields must be non-empty.',
      );
    }
    timestampMs(receipt.createdAt, 'DeferredCommandReceipt.createdAt');
    if (receipt.expiresAt !== undefined) {
      timestampMs(receipt.expiresAt, 'DeferredCommandReceipt.expiresAt');
    }
  }

  private pushReceiptStatement(
    statements: D1PreparedStatementLike[],
    receipt: CommandReceiptInput | undefined,
  ): void {
    if (!receipt) return;
    statements.push(
      this.database
        .prepare(
          `INSERT INTO command_receipts(
            workspace_id, command_id, command_discriminator, semantic_fingerprint, outcome_kind,
            response_snapshot_json, created_at_ms, expires_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          receipt.workspaceId,
          receipt.commandId,
          receipt.command,
          receipt.semanticFingerprint,
          receipt.outcomeKind,
          serializeJson(
            receipt.responseSnapshot,
            'CommandReceipt.responseSnapshot',
            MAX_RECEIPT_SNAPSHOT_BYTES,
          ),
          timestampMs(receipt.createdAt, 'CommandReceipt.createdAt'),
          receipt.expiresAt === undefined
            ? null
            : timestampMs(receipt.expiresAt, 'CommandReceipt.expiresAt'),
        ),
    );
  }

  private pushAuditStatement(
    statements: D1PreparedStatementLike[],
    auditEvent: AuditEvent | undefined,
  ): void {
    if (auditEvent) statements.push(this.insertAuditStatement(auditEvent));
  }

  private insertAuditStatement(auditEvent: AuditEvent): D1PreparedStatementLike {
    return this.database
      .prepare(
        `INSERT INTO audit_events(
          workspace_id, id, event_type, subject_type, subject_id, created_at_ms, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        auditEvent.workspaceId,
        auditEvent.id,
        auditEvent.eventType,
        auditEvent.subject.type,
        auditEvent.subject.id,
        timestampMs(auditEvent.createdAt, 'AuditEvent.createdAt'),
        serializeJson(auditEvent, 'AuditEvent'),
      );
  }

  private insertLeaseStatement(lease: Lease): D1PreparedStatementLike {
    return this.database
      .prepare(
        `INSERT INTO leases(
          workspace_id, id, task_id, session_id, revision, status, fencing_token, created_at_ms,
          updated_at_ms, expires_at_ms, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        lease.workspaceId,
        lease.id,
        lease.taskId,
        lease.sessionId,
        lease.revision,
        lease.status,
        lease.fencingToken,
        timestampMs(lease.createdAt, 'Lease.createdAt'),
        timestampMs(lease.updatedAt, 'Lease.updatedAt'),
        timestampMs(lease.expiresAt, 'Lease.expiresAt'),
        serializeJson(lease, 'Lease'),
      );
  }

  private insertCheckpointStatement(checkpoint: Checkpoint): D1PreparedStatementLike {
    return this.database
      .prepare(
        `INSERT INTO checkpoints(
          workspace_id, id, task_id, session_id, lease_id, fencing_token, created_at_ms, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        checkpoint.workspaceId,
        checkpoint.id,
        checkpoint.taskId,
        checkpoint.sessionId,
        checkpoint.leaseId,
        checkpoint.fencingToken,
        timestampMs(checkpoint.createdAt, 'Checkpoint.createdAt'),
        serializeJson(checkpoint, 'Checkpoint'),
      );
  }

  private insertPermissionRequestStatement(request: PermissionRequest): D1PreparedStatementLike {
    return this.database
      .prepare(
        `INSERT INTO permission_requests(
          workspace_id, id, task_id, session_id, lease_id, fencing_token, permission, created_at_ms,
          record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        request.workspaceId,
        request.id,
        request.taskId,
        request.sessionId,
        request.leaseId,
        request.fencingToken,
        request.permission,
        timestampMs(request.createdAt, 'PermissionRequest.createdAt'),
        serializeJson(request, 'PermissionRequest'),
      );
  }

  private insertPermissionDecisionStatement(decision: PermissionDecision): D1PreparedStatementLike {
    return this.database
      .prepare(
        `INSERT INTO permission_decisions(
          workspace_id, id, request_id, sequence, outcome, basis, supersedes_decision_id,
          created_at_ms, record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        decision.workspaceId,
        decision.id,
        decision.requestId,
        decision.sequence,
        decision.outcome,
        decision.basis,
        decision.supersedesDecisionId ?? null,
        timestampMs(decision.createdAt, 'PermissionDecision.createdAt'),
        serializeJson(decision, 'PermissionDecision'),
      );
  }

  private async requireWorkspace(workspaceId: string): Promise<Workspace> {
    const workspace = await this.getWorkspace(workspaceId);
    if (!workspace)
      throw new PersistenceError('NOT_FOUND', `Workspace ${workspaceId} was not found.`);
    if (workspace.status !== 'active') {
      throw new PersistenceError(
        'INVALID_STATE_TRANSITION',
        `Workspace ${workspaceId} is archived.`,
      );
    }
    return workspace;
  }

  async getWorkspace(workspaceId: string): Promise<Workspace | undefined> {
    return this.readRecord<Workspace>(
      `SELECT record_json FROM workspaces WHERE id = ?`,
      workspaceId,
    );
  }

  async getGoal(workspaceId: string, goalId: string): Promise<Goal | undefined> {
    return this.readRecord<Goal>(
      `SELECT record_json FROM goals WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      goalId,
    );
  }

  async getTask(workspaceId: string, taskId: string): Promise<Task | undefined> {
    return this.readRecord<Task>(
      `SELECT record_json FROM tasks WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      taskId,
    );
  }

  async getAgent(workspaceId: string, agentId: string): Promise<Agent | undefined> {
    return this.readRecord<Agent>(
      `SELECT record_json FROM agents WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      agentId,
    );
  }

  async getSession(workspaceId: string, sessionId: string): Promise<Session | undefined> {
    return this.readRecord<Session>(
      `SELECT record_json FROM sessions WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      sessionId,
    );
  }

  async getLease(workspaceId: string, leaseId: string): Promise<Lease | undefined> {
    return this.readRecord<Lease>(
      `SELECT record_json FROM leases WHERE workspace_id = ? AND id = ?`,
      workspaceId,
      leaseId,
    );
  }

  private async commitLeaseLivenessMutation(input: {
    lease: Lease;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
    operation: 'renew' | 'release';
  }): Promise<MutationCommitResult<Lease>> {
    const { lease } = input;
    this.assertCanonical('Lease', lease);
    this.assertRelatedAudit(lease.workspaceId, input.auditEvent);
    this.assertReceipt(lease.workspaceId, input.receipt);
    const nowMs = timestampMs(input.now, `${input.operation} Lease now`);
    const cutoffMs = timestampMs(input.sessionCutoff, `${input.operation} Session cutoff`);

    return this.coordinator.runSerialized(lease.workspaceId, async () => {
      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      const current = await this.getLease(lease.workspaceId, lease.id);
      if (!current) {
        throw new PersistenceError('NOT_FOUND', `Lease ${lease.id} was not found.`);
      }
      if (current.revision !== input.expectedRevision) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          `Lease ${lease.id} revision ${current.revision} does not match ${input.expectedRevision}.`,
        );
      }
      const task = await this.getTask(lease.workspaceId, current.taskId);
      const session = await this.getSession(lease.workspaceId, current.sessionId);
      const effective = await this.getActiveLease(lease.workspaceId, current.taskId);
      if (
        !task ||
        task.status !== 'running' ||
        !session ||
        session.status !== 'active' ||
        timestampMs(session.lastSeenAt, 'Session.lastSeenAt') <= cutoffMs ||
        current.status !== 'active' ||
        timestampMs(current.expiresAt, 'Lease.expiresAt') <= nowMs ||
        !effective ||
        effective.id !== current.id ||
        effective.fencingToken !== current.fencingToken
      ) {
        throw new PersistenceError('STALE_AUTHORITY', `Lease ${lease.id} is not effective.`);
      }
      const expectedStatus = input.operation === 'renew' ? 'active' : 'released';
      if (
        lease.workspaceId !== current.workspaceId ||
        lease.id !== current.id ||
        lease.taskId !== current.taskId ||
        lease.sessionId !== current.sessionId ||
        lease.createdAt !== current.createdAt ||
        lease.fencingToken !== current.fencingToken ||
        lease.revision !== input.expectedRevision + 1 ||
        lease.status !== expectedStatus ||
        lease.updatedAt !== input.now ||
        (input.operation === 'release' && lease.expiresAt !== current.expiresAt) ||
        (input.operation === 'renew' && timestampMs(lease.expiresAt, 'Lease.expiresAt') <= nowMs)
      ) {
        throw new PersistenceError(
          'INVALID_RECORD',
          `${input.operation === 'renew' ? 'RenewLease' : 'ReleaseLease'} replacement is invalid.`,
        );
      }

      const statement =
        input.operation === 'renew'
          ? this.database
              .prepare(
                `UPDATE leases
                 SET revision = ?, status = ?, updated_at_ms = ?, expires_at_ms = ?, record_json = ?
                 WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
                   AND fencing_token = ?`,
              )
              .bind(
                lease.revision,
                lease.status,
                timestampMs(lease.updatedAt, 'Lease.updatedAt'),
                timestampMs(lease.expiresAt, 'Lease.expiresAt'),
                serializeJson(lease, 'Lease'),
                lease.workspaceId,
                lease.id,
                input.expectedRevision,
                lease.fencingToken,
              )
          : this.database
              .prepare(
                `UPDATE leases
                 SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
                 WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'
                   AND fencing_token = ?`,
              )
              .bind(
                lease.revision,
                lease.status,
                timestampMs(lease.updatedAt, 'Lease.updatedAt'),
                serializeJson(lease, 'Lease'),
                lease.workspaceId,
                lease.id,
                input.expectedRevision,
                lease.fencingToken,
              );
      const statements: D1PreparedStatementLike[] = [statement];
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      const results = await this.batch(
        statements,
        input.operation === 'renew' ? 'renew Lease' : 'release Lease',
      );
      if (changes(results[0]!) !== 1) {
        throw new PersistenceError('STALE_AUTHORITY', `Lease ${lease.id} lost its authority race.`);
      }
      return { kind: 'committed', value: clone(lease) };
    });
  }

  private async getEffectiveActiveLease(
    workspaceId: string,
    taskId: string,
    nowMs: number,
    sessionCutoffMs: number,
  ): Promise<Lease | undefined> {
    const lease = await this.getActiveLease(workspaceId, taskId);
    if (!lease || timestampMs(lease.expiresAt, 'Lease.expiresAt') <= nowMs) return undefined;
    const session = await this.getSession(workspaceId, lease.sessionId);
    if (
      !session ||
      session.status !== 'active' ||
      timestampMs(session.lastSeenAt, 'Session.lastSeenAt') <= sessionCutoffMs
    ) {
      return undefined;
    }
    return lease;
  }

  private async getActiveLease(workspaceId: string, taskId: string): Promise<Lease | undefined> {
    return this.readRecord<Lease>(
      `SELECT record_json FROM leases
       WHERE workspace_id = ? AND task_id = ? AND status = 'active'
       ORDER BY fencing_token DESC LIMIT 1`,
      workspaceId,
      taskId,
    );
  }

  private async getFencingCounter(
    workspaceId: string,
    taskId: string,
  ): Promise<number | undefined> {
    const row = await this.first<{ last_fencing_token: number }>(
      `SELECT last_fencing_token FROM task_fencing_counters
       WHERE workspace_id = ? AND task_id = ?`,
      workspaceId,
      taskId,
    );
    return row ? Number(row.last_fencing_token) : undefined;
  }

  private async listGoalTasks(workspaceId: string, goalId: string): Promise<Task[]> {
    return this.readRecords<Task>(
      `SELECT record_json FROM tasks
       WHERE workspace_id = ? AND goal_id = ? ORDER BY created_at_ms, id`,
      workspaceId,
      goalId,
    );
  }

  private mutationChangesGuardStatement(workspaceId: string): D1PreparedStatementLike {
    return this.database
      .prepare(
        `INSERT INTO mutation_batch_guards(workspace_id, ok)
         VALUES (?, changes())`,
      )
      .bind(workspaceId);
  }

  private clearMutationBatchGuardsStatement(workspaceId: string): D1PreparedStatementLike {
    return this.database
      .prepare(`DELETE FROM mutation_batch_guards WHERE workspace_id = ?`)
      .bind(workspaceId);
  }

  private async readRecord<T>(sql: string, ...values: unknown[]): Promise<T | undefined> {
    const row = await this.first<RecordRow>(sql, ...values);
    return row ? parseJson<T>(row.record_json, 'canonical record') : undefined;
  }

  private async readRecords<T>(sql: string, ...values: unknown[]): Promise<T[]> {
    const rows = await this.all<RecordRow>(sql, ...values);
    return rows.map((row) => parseJson<T>(row.record_json, 'canonical record'));
  }

  private async first<T>(sql: string, ...values: unknown[]): Promise<T | undefined> {
    const row = await this.database
      .prepare(sql)
      .bind(...values)
      .first<T>();
    return row ?? undefined;
  }

  private async all<T>(sql: string, ...values: unknown[]): Promise<T[]> {
    const result = await this.database
      .prepare(sql)
      .bind(...values)
      .all<T>();
    return [...(result.results ?? [])];
  }

  private async run(statement: D1PreparedStatementLike, context: string): Promise<D1ResultLike> {
    try {
      return await statement.run();
    } catch (error) {
      throw wrapDatabaseError(context, error);
    }
  }

  private async batch(
    statements: D1PreparedStatementLike[],
    context: string,
  ): Promise<D1ResultLike[]> {
    try {
      return await this.database.batch(statements);
    } catch (error) {
      const message = errorMessage(error);
      if (message.includes('mutation_batch_guard_ok')) {
        const code = context === 'retry Task' ? 'REVISION_MISMATCH' : 'CONFLICT';
        throw new PersistenceError(code, `${context} lost its durable mutation race.`);
      }
      throw wrapDatabaseError(context, error);
    }
  }
}

function isCancellableTaskStatus(status: Task['status']): boolean {
  return status === 'pending' || status === 'ready' || status === 'running' || status === 'blocked';
}

function serializeJson(value: unknown, label: string, maxBytes?: number): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch (error) {
    throw new PersistenceError(
      'INVALID_RECORD',
      `${label} is not JSON serializable: ${errorMessage(error)}.`,
    );
  }
  if (json === undefined) {
    throw new PersistenceError('INVALID_RECORD', `${label} is not JSON serializable.`);
  }
  if (maxBytes !== undefined && new TextEncoder().encode(json).byteLength > maxBytes) {
    throw new PersistenceError(
      'INVALID_RECORD',
      `${label} exceeds the ${maxBytes}-byte durable snapshot limit.`,
    );
  }
  return json;
}

function parseJson<T = unknown>(json: string, label: string): T {
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    throw new PersistenceError('INTEGRITY_ERROR', `${label} is corrupt: ${errorMessage(error)}.`);
  }
}

function timestampMs(value: string, label: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new PersistenceError('INVALID_RECORD', `${label} must be a valid UTC timestamp.`);
  }
  return timestamp;
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new PersistenceError('INVALID_RECORD', 'Query limit must be a positive integer.');
  }
  return Math.min(limit, 1000);
}

function boundedOffset(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new PersistenceError(
      'INVALID_RECORD',
      'Query offset must be a bounded non-negative integer.',
    );
  }
  return offset;
}

function changes(result: D1ResultLike): number {
  return Number(result.meta?.changes ?? 0);
}

function wrapDatabaseError(context: string, error: unknown): PersistenceError {
  if (error instanceof PersistenceError) return error;
  return new PersistenceError('INTEGRITY_ERROR', `${context} failed: ${errorMessage(error)}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
