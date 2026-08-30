from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'target not found in {path}: {old[:80]!r}')
    file.write_text(text.replace(old, new, 1))


replace_once(
    'src/persistence/ports.ts',
    '''export interface PendingHumanPermission {\n  request: PermissionRequest;\n  latestDecision: PermissionDecision;\n}\n''',
    '''export interface PendingHumanPermission {\n  request: PermissionRequest;\n  latestDecision: PermissionDecision;\n}\n\nexport interface TaskExecutionView {\n  task: Task;\n  lease?: Lease;\n  latestCheckpoint?: Checkpoint;\n}\n''',
)

replace_once(
    'src/persistence/ports.ts',
    '''  getPermissionRequest(\n    workspaceId: string,\n    requestId: string,\n  ): Promise<PermissionRequest | undefined>;\n  loadWorkspaceState(workspaceId: string): Promise<WorkspaceStateSnapshot | undefined>;\n''',
    '''  getPermissionRequest(\n    workspaceId: string,\n    requestId: string,\n  ): Promise<PermissionRequest | undefined>;\n  listGoals(workspaceId: string, limit: number, offset?: number): Promise<Goal[]>;\n  listGoalTasks(\n    workspaceId: string,\n    goalId: string,\n    limit?: number,\n    offset?: number,\n  ): Promise<Task[]>;\n  getTaskExecutionView(\n    workspaceId: string,\n    taskId: string,\n    now: string,\n    sessionCutoff: string,\n  ): Promise<TaskExecutionView | undefined>;\n  loadWorkspaceState(workspaceId: string): Promise<WorkspaceStateSnapshot | undefined>;\n''',
)

replace_once(
    'src/persistence/cloudflare/d1-runtime-persistence.ts',
    '''  type StoredCommandReceipt,\n  type TaskOutcomeCommitInput,\n''',
    '''  type StoredCommandReceipt,\n  type TaskExecutionView,\n  type TaskOutcomeCommitInput,\n''',
)

replace_once(
    'src/persistence/cloudflare/d1-runtime-persistence.ts',
    '''  async loadWorkspaceState(workspaceId: string): Promise<WorkspaceStateSnapshot | undefined> {\n''',
    '''  async listGoals(workspaceId: string, limit: number, offset = 0): Promise<Goal[]> {\n    return this.readRecords<Goal>(\n      `SELECT record_json FROM goals\n       WHERE workspace_id = ? ORDER BY created_at_ms, id LIMIT ? OFFSET ?`,\n      workspaceId,\n      boundedLimit(limit),\n      boundedOffset(offset),\n    );\n  }\n\n  async getTaskExecutionView(\n    workspaceId: string,\n    taskId: string,\n    now: string,\n    sessionCutoff: string,\n  ): Promise<TaskExecutionView | undefined> {\n    const task = await this.getTask(workspaceId, taskId);\n    if (!task) return undefined;\n    const nowMs = timestampMs(now, 'Task execution view now');\n    const cutoffMs = timestampMs(sessionCutoff, 'Task execution view session cutoff');\n    const lease =\n      task.status === 'running'\n        ? await this.getEffectiveActiveLease(workspaceId, taskId, nowMs, cutoffMs)\n        : undefined;\n    const latestCheckpoint = await this.readRecord<Checkpoint>(\n      `SELECT record_json FROM checkpoints\n       WHERE workspace_id = ? AND task_id = ?\n       ORDER BY created_at_ms DESC, id DESC LIMIT 1`,\n      workspaceId,\n      taskId,\n    );\n    return {\n      task: clone(task),\n      ...(lease === undefined ? {} : { lease: clone(lease) }),\n      ...(latestCheckpoint === undefined\n        ? {}\n        : { latestCheckpoint: clone(latestCheckpoint) }),\n    };\n  }\n\n  async loadWorkspaceState(workspaceId: string): Promise<WorkspaceStateSnapshot | undefined> {\n''',
)

replace_once(
    'src/persistence/cloudflare/d1-runtime-persistence.ts',
    '''  private async listGoalTasks(workspaceId: string, goalId: string): Promise<Task[]> {\n    return this.readRecords<Task>(\n      `SELECT record_json FROM tasks\n       WHERE workspace_id = ? AND goal_id = ? ORDER BY created_at_ms, id`,\n      workspaceId,\n      goalId,\n    );\n  }\n''',
    '''  async listGoalTasks(\n    workspaceId: string,\n    goalId: string,\n    limit?: number,\n    offset = 0,\n  ): Promise<Task[]> {\n    if (limit === undefined) {\n      return this.readRecords<Task>(\n        `SELECT record_json FROM tasks\n         WHERE workspace_id = ? AND goal_id = ? ORDER BY created_at_ms, id`,\n        workspaceId,\n        goalId,\n      );\n    }\n    return this.readRecords<Task>(\n      `SELECT record_json FROM tasks\n       WHERE workspace_id = ? AND goal_id = ?\n       ORDER BY created_at_ms, id LIMIT ? OFFSET ?`,\n      workspaceId,\n      goalId,\n      boundedLimit(limit),\n      boundedOffset(offset),\n    );\n  }\n''',
)

replace_once(
    'src/application/durable-dispatcher.ts',
    '''      case 'ListGoals':\n      case 'ListGoalTasks':\n      case 'GetTaskExecutionView':\n        return unsupportedQuery(query);\n''',
    '''      case 'ListGoals': {\n        if (!(await options.persistence.getWorkspace(query.workspaceId))) {\n          return queryFailure(query, 'NOT_FOUND', 'Durable Workspace was not found.');\n        }\n        const window = listWindow(query.limit, query.cursor);\n        if (!window) return invalidListWindow(query);\n        const rows = await options.persistence.listGoals(\n          query.workspaceId,\n          window.limit + 1,\n          window.offset,\n        );\n        return querySuccess(query, pageRows(rows, window.limit, window.offset));\n      }\n      case 'ListGoalTasks': {\n        if (!(await options.persistence.getGoal(query.workspaceId, query.goalId))) {\n          return queryFailure(query, 'NOT_FOUND', 'Durable Goal was not found.');\n        }\n        const window = listWindow(query.limit, query.cursor);\n        if (!window) return invalidListWindow(query);\n        const rows = await options.persistence.listGoalTasks(\n          query.workspaceId,\n          query.goalId,\n          window.limit + 1,\n          window.offset,\n        );\n        return querySuccess(query, pageRows(rows, window.limit, window.offset));\n      }\n      case 'GetTaskExecutionView': {\n        const now = options.now();\n        return durableResourceQuery(\n          query,\n          await options.persistence.getTaskExecutionView(\n            query.workspaceId,\n            query.taskId,\n            now.toISOString(),\n            new Date(now.getTime() - options.sessionTimeoutMs).toISOString(),\n          ),\n        );\n      }\n''',
)
