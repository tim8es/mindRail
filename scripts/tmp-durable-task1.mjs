import { readFileSync, writeFileSync } from 'node:fs';

function replaceRegex(path, pattern, replacement, label) {
  const text = readFileSync(path, 'utf8');
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`${path}: missing ${label}`);
  writeFileSync(path, next);
}

replaceRegex(
  'src/persistence/ports.ts',
  /  createAgent\(input: \{ agent: Agent \}\): Promise<void>;\n  createSession\(input: \{ session: Session \}\): Promise<void>;/,
  `  createAgent(input: {
    agent: Agent;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Agent>>;
  createSession(input: {
    session: Session;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Session>>;`,
  'Agent/Session receipt-aware port methods',
);

replaceRegex(
  'src/persistence/ports.ts',
  /  appendCheckpoint\(input: \{ checkpoint: Checkpoint; now: string \}\): Promise<Checkpoint>;/,
  `  appendCheckpoint(input: {
    checkpoint: Checkpoint;
    now: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Checkpoint>>;`,
  'Checkpoint receipt-aware port method',
);

replaceRegex(
  'src/persistence/ports.ts',
  /  appendPermissionDecision\(input: \{\n    decision: PermissionDecision;\n    expectedPreviousDecisionId: string;\n  \}\): Promise<PermissionDecision>;/,
  `  appendPermissionDecision(input: {
    decision: PermissionDecision;
    expectedPreviousDecisionId: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<PermissionDecision>>;`,
  'PermissionDecision receipt-aware port method',
);

replaceRegex(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  /  async createAgent\([\s\S]*?\n  async createSession/,
  `  async createAgent(input: {
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
            \`INSERT INTO agents(
              workspace_id, id, revision, status, created_at_ms, updated_at_ms, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)\`,
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
              \`INSERT INTO agent_capabilities(workspace_id, agent_id, capability)
               VALUES (?, ?, ?)\`,
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

  async createSession`,
  'createAgent implementation',
);

replaceRegex(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  /  async createSession\([\s\S]*?\n  async createGoal/,
  `  async createSession(input: {
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
        throw new PersistenceError('NOT_FOUND', \`Agent \${session.agentId} was not found.\`);
      }
      const statements: D1PreparedStatementLike[] = [
        this.database
          .prepare(
            \`INSERT INTO sessions(
              workspace_id, id, agent_id, revision, status, created_at_ms, updated_at_ms,
              last_seen_at_ms, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\`,
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

  async createGoal`,
  'createSession implementation',
);

replaceRegex(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  /  async appendCheckpoint\([\s\S]*?\n  async completeTask/,
  `  async appendCheckpoint(input: {
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

  async completeTask`,
  'appendCheckpoint implementation',
);

replaceRegex(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  /  async appendPermissionDecision\([\s\S]*?\n  async getCommandReceipt/,
  `  async appendPermissionDecision(input: {
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
        \`SELECT latest_decision_id, latest_sequence, latest_outcome
         FROM permission_heads
         WHERE workspace_id = ? AND request_id = ?\`,
        input.decision.workspaceId,
        input.decision.requestId,
      );
      if (!head) {
        throw new PersistenceError(
          'NOT_FOUND',
          \`PermissionRequest \${input.decision.requestId} has no decision head.\`,
        );
      }
      if (head.latest_decision_id !== input.expectedPreviousDecisionId) {
        throw new PersistenceError(
          'REVISION_MISMATCH',
          \`Permission decision head changed from \${input.expectedPreviousDecisionId}.\`,
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
            \`UPDATE permission_heads
             SET latest_decision_id = ?, latest_sequence = ?, latest_outcome = ?
             WHERE workspace_id = ? AND request_id = ?
               AND latest_decision_id = ? AND latest_sequence = ?\`,
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

  async getCommandReceipt`,
  'appendPermissionDecision implementation',
);
