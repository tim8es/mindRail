from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)


d1 = Path("src/persistence/cloudflare/d1-runtime-persistence.ts")
text = d1.read_text()
for name in ["getWorkspace", "getGoal", "getTask", "getAgent", "getSession", "getLease"]:
    text = replace_once(text, f"  private async {name}(", f"  async {name}(", name)

text = replace_once(
    text,
    "  async loadWorkspaceState(workspaceId: string): Promise<WorkspaceStateSnapshot | undefined> {\n",
    """  async getPermissionRequest(
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
""",
    "getPermissionRequest",
)

text = replace_once(
    text,
    """  async listTaskCheckpoints(workspaceId: string, taskId: string): Promise<Checkpoint[]> {
    return this.readRecords<Checkpoint>(
      `SELECT record_json FROM checkpoints
       WHERE workspace_id = ? AND task_id = ? ORDER BY created_at_ms, id`,
      workspaceId,
      taskId,
    );
  }
""",
    """  async listClaimableTasks(
    workspaceId: string,
    sessionId: string,
    limit: number,
    offset = 0,
  ): Promise<Task[]> {
    const session = await this.getSession(workspaceId, sessionId);
    if (!session) throw new PersistenceError('NOT_FOUND', `Session ${sessionId} was not found.`);
    if (session.status !== 'active') {
      throw new PersistenceError('CONFLICT', `Session ${sessionId} is not active.`);
    }
    const agent = await this.getAgent(workspaceId, session.agentId);
    if (!agent || agent.status !== 'active') {
      throw new PersistenceError('CONFLICT', `Agent ${session.agentId} is not active.`);
    }
    return this.readRecords<Task>(
      `SELECT t.record_json
       FROM tasks t
       WHERE t.workspace_id = ? AND t.status = 'ready'
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
""",
    "listTaskCheckpoints",
)

text = replace_once(
    text,
    """  async listPermissionDecisions(
    workspaceId: string,
    requestId: string,
  ): Promise<PermissionDecision[]> {
    return this.readRecords<PermissionDecision>(
      `SELECT record_json FROM permission_decisions
       WHERE workspace_id = ? AND request_id = ? ORDER BY sequence, created_at_ms, id`,
      workspaceId,
      requestId,
    );
  }
""",
    """  async listPermissionDecisions(
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
""",
    "listPermissionDecisions",
)

text = replace_once(
    text,
    """  async listPendingHumanPermissions(
    workspaceId: string,
    limit: number,
  ): Promise<PendingHumanPermission[]> {
""",
    """  async listPendingHumanPermissions(
    workspaceId: string,
    limit: number,
    offset = 0,
  ): Promise<PendingHumanPermission[]> {
""",
    "pending signature",
)
text = replace_once(
    text,
    """       ORDER BY pr.created_at_ms, pr.id
       LIMIT ?`,
      workspaceId,
      boundedLimit(limit),
""",
    """       ORDER BY pr.created_at_ms, pr.id
       LIMIT ? OFFSET ?`,
      workspaceId,
      boundedLimit(limit),
      boundedOffset(offset),
""",
    "pending pagination",
)
text = replace_once(
    text,
    "function changes(result: D1ResultLike): number {\n",
    """function boundedOffset(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new PersistenceError(
      'INVALID_RECORD',
      'Query offset must be a bounded non-negative integer.',
    );
  }
  return offset;
}

function changes(result: D1ResultLike): number {
""",
    "boundedOffset",
)
d1.write_text(text)


dispatcher = Path("src/application/durable-dispatcher.ts")
text = dispatcher.read_text()
text = replace_once(
    text,
    """  QueryFailure,
} from './protocol.ts';
""",
    """  QueryFailure,
  QueryResponse,
} from './protocol.ts';
""",
    "QueryResponse import",
)
text = replace_once(
    text,
    """    dispatchQuery(query) {
      return unsupportedQuery(query);
    },
""",
    """    dispatchQuery(query) {
      return dispatchDurableQuery(options, query);
    },
""",
    "dispatchQuery",
)

query_impl = r'''async function dispatchDurableQuery(
  options: DurableApplicationDispatcherOptions,
  query: ApplicationQuery,
): Promise<QueryResponse> {
  try {
    switch (query.query) {
      case 'GetWorkspace':
        return durableResourceQuery(query, await options.persistence.getWorkspace(query.workspaceId));
      case 'GetGoal':
        return durableResourceQuery(
          query,
          await options.persistence.getGoal(query.workspaceId, query.goalId),
        );
      case 'GetTask':
        return durableResourceQuery(
          query,
          await options.persistence.getTask(query.workspaceId, query.taskId),
        );
      case 'GetAgent':
        return durableResourceQuery(
          query,
          await options.persistence.getAgent(query.workspaceId, query.agentId),
        );
      case 'GetSession':
        return durableResourceQuery(
          query,
          await options.persistence.getSession(query.workspaceId, query.sessionId),
        );
      case 'GetLease':
        return durableResourceQuery(
          query,
          await options.persistence.getLease(query.workspaceId, query.leaseId),
        );
      case 'GetPermissionRequest':
        return durableResourceQuery(
          query,
          await options.persistence.getPermissionRequest(query.workspaceId, query.requestId),
        );
      case 'ListTaskCheckpoints': {
        if (!(await options.persistence.getTask(query.workspaceId, query.taskId))) {
          return queryFailure(query, 'NOT_FOUND', 'Durable Task was not found.');
        }
        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listTaskCheckpoints(
          query.workspaceId,
          query.taskId,
          window.limit + 1,
          window.offset,
        );
        return querySuccess(query, pageRows(rows, window.limit, window.offset));
      }
      case 'ListPermissionDecisions': {
        if (!(await options.persistence.getPermissionRequest(query.workspaceId, query.requestId))) {
          return queryFailure(query, 'NOT_FOUND', 'Durable PermissionRequest was not found.');
        }
        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listPermissionDecisions(
          query.workspaceId,
          query.requestId,
          window.limit + 1,
          window.offset,
        );
        return querySuccess(query, pageRows(rows, window.limit, window.offset));
      }
      case 'ListPendingHumanPermissions': {
        if (!(await options.persistence.getWorkspace(query.workspaceId))) {
          return queryFailure(query, 'NOT_FOUND', 'Durable Workspace was not found.');
        }
        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listPendingHumanPermissions(
          query.workspaceId,
          window.limit + 1,
          window.offset,
        );
        return querySuccess(query, pageRows(rows, window.limit, window.offset));
      }
      case 'ListClaimableTasks': {
        if (!(await options.persistence.getWorkspace(query.workspaceId))) {
          return queryFailure(query, 'NOT_FOUND', 'Durable Workspace was not found.');
        }
        const session = await options.persistence.getSession(query.workspaceId, query.sessionId);
        if (!session) return queryFailure(query, 'NOT_FOUND', 'Durable Session was not found.');
        const staleAt = Date.parse(session.lastSeenAt) + options.sessionTimeoutMs;
        if (session.status !== 'active' || options.now().getTime() >= staleAt) {
          return queryFailure(query, 'SESSION_NOT_ACTIVE', 'Session is not active for work acquisition.');
        }
        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listClaimableTasks(
          query.workspaceId,
          query.sessionId,
          window.limit + 1,
          window.offset,
        );
        return querySuccess(query, pageRows(rows, window.limit, window.offset));
      }
      case 'ListGoals':
      case 'ListGoalTasks':
      case 'GetTaskExecutionView':
        return unsupportedQuery(query);
    }
  } catch (error) {
    if (error instanceof PersistenceError) return persistenceQueryFailure(query, error);
    return queryFailure(query, 'INTERNAL_ERROR', 'Durable query execution failed.');
  }
}

'''
text = replace_once(
    text,
    "function isFirstDurableLoopCommand(command: ProtocolCommand): boolean {\n",
    query_impl + "function isFirstDurableLoopCommand(command: ProtocolCommand): boolean {\n",
    "query implementation",
)

old_helpers = r'''function unsupportedQuery(query: ApplicationQuery): QueryFailure {
  return {
    protocolVersion: '0.1',
    ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    error: {
      code: 'UNSUPPORTED_OPERATION',
      message: `${query.query} is not yet integrated in the durable application composition.`,
      retryable: false,
    },
  };
}
'''
new_helpers = r'''function unsupportedQuery(query: ApplicationQuery): QueryFailure {
  return queryFailure(
    query,
    'UNSUPPORTED_OPERATION',
    `${query.query} is not yet integrated in the durable application composition.`,
  );
}

function querySuccess<T>(query: ApplicationQuery, result: T): QueryResponse<T> {
  return {
    protocolVersion: '0.1',
    ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    result: structuredClone(result),
  };
}

function queryFailure(
  query: ApplicationQuery,
  code: ApplicationErrorCode,
  message: string,
): QueryFailure {
  return {
    protocolVersion: '0.1',
    ...(query.correlationId === undefined ? {} : { correlationId: query.correlationId }),
    error: { code, message, retryable: false },
  };
}

function durableResourceQuery<T>(query: ApplicationQuery, value: T | undefined): QueryResponse<T> {
  return value === undefined
    ? queryFailure(query, 'NOT_FOUND', 'Durable resource was not found.')
    : querySuccess(query, value);
}

function persistenceQueryFailure(query: ApplicationQuery, error: PersistenceError): QueryFailure {
  switch (error.code) {
    case 'NOT_FOUND':
      return queryFailure(query, 'NOT_FOUND', 'Durable resource was not found.');
    case 'CONFLICT':
      return queryFailure(query, 'CONFLICT', 'Durable state conflicts with this query.');
    case 'REVISION_MISMATCH':
      return queryFailure(query, 'REVISION_MISMATCH', 'Durable revision changed.');
    case 'STALE_AUTHORITY':
      return queryFailure(query, 'STALE_FENCING_TOKEN', 'Durable execution authority is stale.');
    case 'IDEMPOTENCY_CONFLICT':
      return queryFailure(query, 'IDEMPOTENCY_CONFLICT', 'Durable command identity conflicts.');
    case 'INVALID_STATE_TRANSITION':
      return queryFailure(query, 'INVALID_STATE_TRANSITION', 'Durable state transition is invalid.');
    case 'INVALID_RECORD':
      return queryFailure(query, 'INVALID_INPUT', 'Durable query bounds are invalid.');
    case 'INTEGRITY_ERROR':
      return queryFailure(query, 'INTERNAL_ERROR', 'Durable state integrity check failed.');
  }
}

function listWindow(
  limit: number,
  cursor: string | undefined,
): { limit: number; offset: number } | undefined {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return undefined;
  if (cursor === undefined) return { limit, offset: 0 };
  const match = /^c([0-9]+)$/.exec(cursor);
  if (match?.[1] === undefined) return undefined;
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) return undefined;
  return { limit, offset };
}

function invalidListWindow(query: ApplicationQuery): QueryFailure {
  return queryFailure(query, 'INVALID_INPUT', 'List limit or cursor is invalid.');
}

function pageRows<T>(
  rows: T[],
  limit: number,
  offset: number,
): { items: T[]; nextCursor?: string } {
  const items = rows.slice(0, limit);
  return {
    items,
    ...(rows.length > limit ? { nextCursor: `c${offset + limit}` } : {}),
  };
}
'''
text = replace_once(text, old_helpers, new_helpers, "query helpers")
dispatcher.write_text(text)
