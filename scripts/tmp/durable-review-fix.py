from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing patch anchor: {label}")
    return text.replace(old, new, 1)


ports = Path('src/persistence/ports.ts')
text = ports.read_text()
text = replace_once(
    text,
    """  appendPermissionDecision(input: {
    decision: PermissionDecision;
    expectedPreviousDecisionId: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<PermissionDecision>>;
  getCommandReceipt(
""",
    """  appendPermissionDecision(input: {
    decision: PermissionDecision;
    expectedPreviousDecisionId: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<PermissionDecision>>;
  commitCommandReceipt(
    receipt: CommandReceiptInput,
  ): Promise<MutationCommitResult<undefined>>;
  getCommandReceipt(
""",
    'command receipt port',
)
text = replace_once(
    text,
    """  listClaimableTasks(
    workspaceId: string,
    sessionId: string,
    limit: number,
    offset?: number,
  ): Promise<Task[]>;
""",
    """  listClaimableTasks(
    workspaceId: string,
    sessionId: string,
    now: string,
    sessionCutoff: string,
    limit: number,
    offset?: number,
  ): Promise<Task[]>;
""",
    'claimable port',
)
ports.write_text(text)


d1 = Path('src/persistence/cloudflare/d1-runtime-persistence.ts')
text = d1.read_text()
text = replace_once(
    text,
    """  async getCommandReceipt(
    workspaceId: string,
    commandId: string,
  ): Promise<StoredCommandReceipt | undefined> {
""",
    """  async commitCommandReceipt(
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
""",
    'commitCommandReceipt',
)
old_claimable = """  async listClaimableTasks(
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
"""
new_claimable = """  async listClaimableTasks(
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
"""
text = replace_once(text, old_claimable, new_claimable, 'claimable recovery query')
d1.write_text(text)


dispatcher = Path('src/application/durable-dispatcher.ts')
text = dispatcher.read_text()
text = replace_once(
    text,
    """    const semanticResponse = runtime.execute(command);
    if ('error' in semanticResponse) return semanticResponse;

    return await commitDurableSuccess(options, command, fingerprint, semanticResponse);
""",
    """    const semanticResponse = runtime.execute(command);
    if ('error' in semanticResponse) {
      const committed = await options.persistence.commitCommandReceipt(
        errorReceiptFor(command, fingerprint, semanticResponse as CommandFailure, options.now()),
      );
      if (committed.kind === 'replayed') {
        return replayStoredReceipt(command, fingerprint, committed.receipt);
      }
      return semanticResponse;
    }

    return await commitDurableSuccess(options, command, fingerprint, semanticResponse);
""",
    'terminal error receipt',
)
text = replace_once(
    text,
    """        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const rows = await options.persistence.listClaimableTasks(
          query.workspaceId,
          query.sessionId,
          window.limit + 1,
          window.offset,
        );
""",
    """        const window = listWindow(query.limit, query.cursor);
        if (!window) return invalidListWindow(query);
        const now = options.now();
        const rows = await options.persistence.listClaimableTasks(
          query.workspaceId,
          query.sessionId,
          now.toISOString(),
          new Date(now.getTime() - options.sessionTimeoutMs).toISOString(),
          window.limit + 1,
          window.offset,
        );
""",
    'claimable query call',
)
text = replace_once(
    text,
    """function deferredReceiptFor<T>(
""",
    """function errorReceiptFor(
  command: ApplicationCommand,
  fingerprint: string,
  responseSnapshot: CommandFailure,
  now: Date,
): CommandReceiptInput {
  return {
    workspaceId: command.workspaceId,
    commandId: command.commandId,
    command: command.command,
    semanticFingerprint: fingerprint,
    outcomeKind: 'error',
    responseSnapshot: structuredClone(responseSnapshot),
    createdAt: now.toISOString(),
  };
}

function deferredReceiptFor<T>(
""",
    'errorReceiptFor helper',
)
dispatcher.write_text(text)
