from pathlib import Path


def replace_once(path: str, before: str, after: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f'{path}: expected one marker, found {count}')
    file.write_text(text.replace(before, after, 1))


replace_once(
    'src/persistence/ports.ts',
    '''export interface TaskOutcomeCommitValue {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
}

export interface DurableRuntimePersistence {''',
    '''export interface TaskOutcomeCommitValue {
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

export interface DurableRuntimePersistence {''',
)

replace_once(
    'src/persistence/ports.ts',
    '''  resumeTask(input: {
    task: Task;
    expectedRevision: number;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Task>>;
  appendAuditEvent(input: { auditEvent: AuditEvent }): Promise<void>;''',
    '''  resumeTask(input: {
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
  appendAuditEvent(input: { auditEvent: AuditEvent }): Promise<void>;''',
)

replace_once(
    'src/persistence/cloudflare/d1-runtime-persistence.ts',
    '''  type ClaimTaskCommitInput,
  type ClaimTaskCommitValue,
  type CommandReceiptInput,''',
    '''  type CancelGoalCommitInput,
  type CancelGoalCommitValue,
  type CancelTaskCommitInput,
  type CancelTaskCommitValue,
  type ClaimTaskCommitInput,
  type ClaimTaskCommitValue,
  type CommandReceiptInput,''',
)

methods = r'''  async retryTask(input: {
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
      if (
        await this.getEffectiveActiveLease(task.workspaceId, task.id, nowMs, cutoffMs)
      ) {
        throw new PersistenceError('CONFLICT', `Task ${task.id} still has active execution authority.`);
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
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'failed'`,
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
      const results = await this.batch(statements, 'retry Task');
      if (changes(results[0]!) !== 1) {
        throw new PersistenceError('REVISION_MISMATCH', `Task ${task.id} lost its retry race.`);
      }
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
        );
      }
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      const results = await this.batch(statements, 'cancel Task');
      if (changes(results[0]!) !== 1) {
        throw new PersistenceError('REVISION_MISMATCH', `Task ${current.id} lost its cancel race.`);
      }
      if (effectiveLease && changes(results[1]!) !== 1) {
        throw new PersistenceError('STALE_AUTHORITY', `Task ${current.id} Lease lost its cancel race.`);
      }
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
      if (outputLeases.size !== input.leases.length || input.leases.length !== effectiveLeases.length) {
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
          serializeJson(output, 'Lease') !== serializeJson(expectedLease, 'expected CancelGoal Lease')
        ) {
          throw new PersistenceError('INVALID_RECORD', 'CancelGoal Lease replacement is invalid.');
        }
      }

      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `UPDATE goals
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'active'`,
          )
          .bind(
            input.goal.revision,
            input.goal.status,
            timestampMs(input.goal.updatedAt, 'Goal.updatedAt'),
            serializeJson(input.goal, 'Goal'),
            input.workspaceId,
            input.goal.id,
            input.expectedGoalRevision,
          ),
      ];
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
        );
      }
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      const results = await this.batch(statements, 'cancel Goal');
      const mutationCount = 1 + cancellable.length + effectiveLeases.length;
      for (let index = 0; index < mutationCount; index += 1) {
        if (changes(results[index]!) !== 1) {
          throw new PersistenceError('CONFLICT', `Goal ${currentGoal.id} lost its cancel race.`);
        }
      }
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

'''
replace_once(
    'src/persistence/cloudflare/d1-runtime-persistence.ts',
    '  private async commitTaskOutcome(',
    methods + '  private async commitTaskOutcome(',
)

replace_once(
    'src/persistence/cloudflare/d1-runtime-persistence.ts',
    '''  private async getActiveLease(workspaceId: string, taskId: string): Promise<Lease | undefined> {
    return this.readRecord<Lease>(''',
    '''  private async getEffectiveActiveLease(
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
    return this.readRecord<Lease>(''',
)

replace_once(
    'src/persistence/cloudflare/d1-runtime-persistence.ts',
    '''function serializeJson(value: unknown, label: string, maxBytes?: number): string {''',
    '''function isCancellableTaskStatus(status: Task['status']): boolean {
  return status === 'pending' || status === 'ready' || status === 'running' || status === 'blocked';
}

function serializeJson(value: unknown, label: string, maxBytes?: number): string {''',
)

replace_once(
    'src/application/durable-dispatcher.ts',
    '''  type BlockTaskResult,
  type ClaimTaskResult,
  type CompleteTaskResult,
  type EndSessionResult,
  type FailTaskResult,''',
    '''  type BlockTaskResult,
  type CancelGoalResult,
  type CancelTaskResult,
  type ClaimTaskResult,
  type CompleteTaskResult,
  type EndSessionResult,
  type FailTaskResult,''',
)

replace_once(
    'src/application/durable-dispatcher.ts',
    '''    command.command === 'FailTask' ||
    command.command === 'BlockTask' ||
    command.command === 'ResumeTask'
  );''',
    '''    command.command === 'FailTask' ||
    command.command === 'BlockTask' ||
    command.command === 'ResumeTask' ||
    command.command === 'RetryTask' ||
    command.command === 'CancelTask' ||
    command.command === 'CancelGoal'
  );''',
)

replace_once(
    'src/application/durable-dispatcher.ts',
    '''    case 'ResumeTask': {
      const result = semanticResponse.result as Task;
      return resolveMutationResult(
        command,
        await options.persistence.resumeTask({
          task: result,
          expectedRevision: command.expectedTaskRevision,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    default:''',
    '''    case 'ResumeTask': {
      const result = semanticResponse.result as Task;
      return resolveMutationResult(
        command,
        await options.persistence.resumeTask({
          task: result,
          expectedRevision: command.expectedTaskRevision,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'RetryTask': {
      const result = semanticResponse.result as Task;
      const now = result.updatedAt;
      return resolveMutationResult(
        command,
        await options.persistence.retryTask({
          task: result,
          expectedRevision: command.expectedTaskRevision,
          now,
          sessionCutoff: new Date(Date.parse(now) - options.sessionTimeoutMs).toISOString(),
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'CancelTask': {
      const result = semanticResponse.result as CancelTaskResult;
      const now = result.task.updatedAt;
      return resolveMutationResult(
        command,
        await options.persistence.cancelTask({
          workspaceId: command.workspaceId,
          task: result.task,
          ...(result.lease === undefined ? {} : { lease: result.lease }),
          expectedTaskRevision: command.expectedTaskRevision,
          now,
          sessionCutoff: new Date(Date.parse(now) - options.sessionTimeoutMs).toISOString(),
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'CancelGoal': {
      const result = semanticResponse.result as CancelGoalResult;
      const now = result.goal.updatedAt;
      return resolveMutationResult(
        command,
        await options.persistence.cancelGoal({
          workspaceId: command.workspaceId,
          goal: result.goal,
          tasks: result.tasks,
          leases: result.leases,
          expectedGoalRevision: command.expectedGoalRevision,
          now,
          sessionCutoff: new Date(Date.parse(now) - options.sessionTimeoutMs).toISOString(),
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    default:''',
)
