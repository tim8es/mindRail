from pathlib import Path

path = Path('src/persistence/cloudflare/d1-runtime-persistence.ts')
text = path.read_text()

old = r'''      if (activeLease) {
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
'''
new = r'''      if (activeLease) {
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
          this.mutationChangesGuardStatement(input.workspaceId),
        );
      }

      statements.push(
        this.database
          .prepare(
            `UPDATE task_fencing_counters
             SET last_fencing_token = ?
             WHERE workspace_id = ? AND task_id = ? AND last_fencing_token = ?
               AND EXISTS (
                 SELECT 1 FROM tasks
                 WHERE workspace_id = ? AND id = ? AND revision = ? AND status = ?
               )`,
          )
          .bind(
            nextFence,
            input.workspaceId,
            input.taskId,
            counter,
            input.workspaceId,
            input.taskId,
            task.revision,
            task.status,
          ),
        this.mutationChangesGuardStatement(input.workspaceId),
      );
'''
if text.count(old) != 1:
    raise RuntimeError('claim counter marker mismatch')
text = text.replace(old, new, 1)

old = r'''        statements.push(
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
'''
new = r'''        statements.push(
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
          this.mutationChangesGuardStatement(input.workspaceId),
        );
      }

      statements.push(this.insertLeaseStatement(lease));
      this.pushAuditStatement(statements, input.auditEvent);
      const value = { task: clone(nextTask), lease: clone(lease) };
      const finalReceipt = this.materializeReceipt(input.receipt, input.deferredReceipt, value);
      this.pushReceiptStatement(statements, finalReceipt);
      statements.push(this.clearMutationBatchGuardsStatement(input.workspaceId));
      await this.batch(statements, 'claim Task');
'''
if text.count(old) != 1:
    raise RuntimeError('claim receipt marker mismatch')
text = text.replace(old, new, 1)

old = r'''      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            `UPDATE tasks
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = ?`,
          )
'''
new = r'''      const fencingCounter = await this.getFencingCounter(input.workspaceId, current.id);
      if (fencingCounter === undefined) {
        throw new PersistenceError('INTEGRITY_ERROR', `Task ${current.id} has no fencing counter.`);
      }

      const statements: D1PreparedStatementLike[] = [
        this.fencingCounterGuardStatement(input.workspaceId, current.id, fencingCounter),
        this.database
          .prepare(
            `UPDATE tasks
             SET revision = ?, status = ?, updated_at_ms = ?, record_json = ?
             WHERE workspace_id = ? AND id = ? AND revision = ? AND status = ?`,
          )
'''
# This marker appears only in cancelTask after latest transaction patch.
if text.count(old) != 1:
    raise RuntimeError(f'cancelTask statements marker mismatch: {text.count(old)}')
text = text.replace(old, new, 1)

old = r'''      const currentTasks = await this.listGoalTasks(input.workspaceId, currentGoal.id);
      const cancellable = currentTasks.filter((task) => isCancellableTaskStatus(task.status));
      const outputTasks = new Map(input.tasks.map((task) => [task.id, task]));
'''
new = r'''      const currentTasks = await this.listGoalTasks(input.workspaceId, currentGoal.id);
      const cancellable = currentTasks.filter((task) => isCancellableTaskStatus(task.status));
      const fencingCounters = new Map<string, number>();
      for (const currentTask of cancellable) {
        const counter = await this.getFencingCounter(input.workspaceId, currentTask.id);
        if (counter === undefined) {
          throw new PersistenceError(
            'INTEGRITY_ERROR',
            `Task ${currentTask.id} has no fencing counter.`,
          );
        }
        fencingCounters.set(currentTask.id, counter);
      }
      const outputTasks = new Map(input.tasks.map((task) => [task.id, task]));
'''
if text.count(old) != 1:
    raise RuntimeError('cancelGoal counter snapshot marker mismatch')
text = text.replace(old, new, 1)

old = r'''      const statements: D1PreparedStatementLike[] = [];
      for (const currentTask of cancellable) {
        const output = outputTasks.get(currentTask.id)!;
        statements.push(
          this.database
'''
new = r'''      const statements: D1PreparedStatementLike[] = [];
      for (const currentTask of cancellable) {
        const output = outputTasks.get(currentTask.id)!;
        statements.push(
          this.fencingCounterGuardStatement(
            input.workspaceId,
            currentTask.id,
            fencingCounters.get(currentTask.id)!,
          ),
          this.database
'''
if text.count(old) != 1:
    raise RuntimeError('cancelGoal statements marker mismatch')
text = text.replace(old, new, 1)

marker = r'''  private mutationChangesGuardStatement(workspaceId: string): D1PreparedStatementLike {
'''
helper = r'''  private fencingCounterGuardStatement(
    workspaceId: string,
    taskId: string,
    expectedCounter: number,
  ): D1PreparedStatementLike {
    return this.database
      .prepare(
        `INSERT INTO mutation_batch_guards(workspace_id, ok)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM task_fencing_counters
           WHERE workspace_id = ? AND task_id = ? AND last_fencing_token = ?
         ) THEN 1 ELSE 0 END`,
      )
      .bind(workspaceId, workspaceId, taskId, expectedCounter);
  }

'''
if text.count(marker) != 1:
    raise RuntimeError('mutation guard helper marker mismatch')
text = text.replace(marker, helper + marker, 1)

path.write_text(text)
