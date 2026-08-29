from pathlib import Path


def replace_once(path: str, before: str, after: str) -> None:
    file = Path(path)
    text = file.read_text()
    if text.count(before) != 1:
        raise RuntimeError(f"expected one marker in {path}, found {text.count(before)}")
    file.write_text(text.replace(before, after, 1))


replace_once(
    "src/persistence/ports.ts",
    """export interface CompleteTaskCommitValue {
  task: Task;
  lease: Lease;
  checkpoint: Checkpoint;
  goal?: Goal;
}

export interface DurableRuntimePersistence {""",
    """export interface CompleteTaskCommitValue {
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

export interface DurableRuntimePersistence {""",
)

replace_once(
    "src/persistence/ports.ts",
    """  completeTask(
    input: CompleteTaskCommitInput,
  ): Promise<MutationCommitResult<CompleteTaskCommitValue>>;
  appendAuditEvent(input: { auditEvent: AuditEvent }): Promise<void>;""",
    """  completeTask(
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
  appendAuditEvent(input: { auditEvent: AuditEvent }): Promise<void>;""",
)

replace_once(
    "src/persistence/cloudflare/d1-runtime-persistence.ts",
    """  type StoredCommandReceipt,
  type WorkspaceMutationCoordinator,""",
    """  type StoredCommandReceipt,
  type TaskOutcomeCommitInput,
  type TaskOutcomeCommitValue,
  type WorkspaceMutationCoordinator,""",
)

outcome_methods = r'''  async failTask(
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
        JSON.stringify(task.requiredCapabilities) !== JSON.stringify(current.requiredCapabilities) ||
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

'''
replace_once(
    "src/persistence/cloudflare/d1-runtime-persistence.ts",
    "  async appendAuditEvent(input: { auditEvent: AuditEvent }): Promise<void> {",
    outcome_methods + "  async appendAuditEvent(input: { auditEvent: AuditEvent }): Promise<void> {",
)

replace_once(
    "src/application/durable-dispatcher.ts",
    """  type ClaimTaskResult,
  type CompleteTaskResult,
  type EndSessionResult,""",
    """  type BlockTaskResult,
  type ClaimTaskResult,
  type CompleteTaskResult,
  type EndSessionResult,
  type FailTaskResult,""",
)

replace_once(
    "src/application/durable-dispatcher.ts",
    """    command.command === 'RecordPermissionDecision' ||
    command.command === 'CompleteTask'
  );""",
    """    command.command === 'RecordPermissionDecision' ||
    command.command === 'CompleteTask' ||
    command.command === 'FailTask' ||
    command.command === 'BlockTask' ||
    command.command === 'ResumeTask'
  );""",
)

replace_once(
    "src/application/durable-dispatcher.ts",
    """    case 'CompleteTask': {
      const result = semanticResponse.result as CompleteTaskResult;
      const committed = await options.persistence.completeTask({
        workspaceId: command.workspaceId,
        task: result.task,
        lease: result.lease,
        checkpoint: result.checkpoint,
        expectedTaskRevision: command.expectedTaskRevision,
        now: options.now().toISOString(),
        receipt: receiptFor(command, fingerprint, successResponse(command, result), options.now()),
      });
      if (committed.kind === 'replayed')
        return replayStoredReceipt(command, fingerprint, committed.receipt);
      return successResponse(command, {
        task: committed.value.task,
        lease: committed.value.lease,
        checkpoint: committed.value.checkpoint,
      });
    }
    default:""",
    """    case 'CompleteTask': {
      const result = semanticResponse.result as CompleteTaskResult;
      const committed = await options.persistence.completeTask({
        workspaceId: command.workspaceId,
        task: result.task,
        lease: result.lease,
        checkpoint: result.checkpoint,
        expectedTaskRevision: command.expectedTaskRevision,
        now: options.now().toISOString(),
        receipt: receiptFor(command, fingerprint, successResponse(command, result), options.now()),
      });
      if (committed.kind === 'replayed')
        return replayStoredReceipt(command, fingerprint, committed.receipt);
      return successResponse(command, {
        task: committed.value.task,
        lease: committed.value.lease,
        checkpoint: committed.value.checkpoint,
      });
    }
    case 'FailTask': {
      const result = semanticResponse.result as FailTaskResult;
      return resolveMutationResult(
        command,
        await options.persistence.failTask({
          workspaceId: command.workspaceId,
          task: result.task,
          lease: result.lease,
          checkpoint: result.checkpoint,
          expectedTaskRevision: command.expectedTaskRevision,
          now: result.task.updatedAt,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'BlockTask': {
      const result = semanticResponse.result as BlockTaskResult;
      return resolveMutationResult(
        command,
        await options.persistence.blockTask({
          workspaceId: command.workspaceId,
          task: result.task,
          lease: result.lease,
          checkpoint: result.checkpoint,
          expectedTaskRevision: command.expectedTaskRevision,
          now: result.task.updatedAt,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'ResumeTask': {
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
    default:""",
)
