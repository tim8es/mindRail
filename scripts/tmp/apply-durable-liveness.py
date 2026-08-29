from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"missing anchor: {label}")
    return text.replace(old, new, 1)


ports = Path('src/persistence/ports.ts')
text = ports.read_text()
text = replace_once(
    text,
    """  createSession(input: {
    session: Session;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Session>>;
  createGoal(input: {
""",
    """  createSession(input: {
    session: Session;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Session>>;
  heartbeatSession(input: {
    session: Session;
    expectedRevision: number;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Session>>;
  endSession(input: {
    session: Session;
    leases: Lease[];
    expectedSessionRevision: number;
    now: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<{ session: Session; leases: Lease[] }>>;
  renewLease(input: {
    lease: Lease;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Lease>>;
  releaseLease(input: {
    lease: Lease;
    expectedRevision: number;
    now: string;
    sessionCutoff: string;
    receipt?: CommandReceiptInput;
    auditEvent?: AuditEvent;
  }): Promise<MutationCommitResult<Lease>>;
  createGoal(input: {
""",
    'persistence liveness ports',
)
ports.write_text(text)


d1 = Path('src/persistence/cloudflare/d1-runtime-persistence.ts')
text = d1.read_text()
anchor = """  async createGoal(input: {
"""
methods = r'''  async heartbeatSession(input: {
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
        throw new PersistenceError('REVISION_MISMATCH', `Session ${session.id} lost its revision race.`);
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
          throw new PersistenceError('INVALID_RECORD', `Lease ${nextLease.id} revocation is invalid.`);
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
        throw new PersistenceError('REVISION_MISMATCH', `Session ${ended.id} lost its revision race.`);
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

'''
text = replace_once(text, anchor, methods + anchor, 'D1 liveness methods')

private_anchor = """  private async getActiveLease(workspaceId: string, taskId: string): Promise<Lease | undefined> {
"""
private_method = r'''  private async commitLeaseLivenessMutation(input: {
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

'''
text = replace_once(text, private_anchor, private_method + private_anchor, 'D1 lease helper')
d1.write_text(text)


dispatcher = Path('src/application/durable-dispatcher.ts')
text = dispatcher.read_text()
text = replace_once(
    text,
    """  InMemoryControlPlane,
  type ClaimTaskResult,
  type CompleteTaskResult,
""",
    """  InMemoryControlPlane,
  type ClaimTaskResult,
  type CompleteTaskResult,
  type EndSessionResult,
""",
    'dispatcher EndSessionResult import',
)
text = replace_once(
    text,
    """    command.command === 'RegisterAgent' ||
    command.command === 'StartSession' ||
    command.command === 'CreateGoal' ||
""",
    """    command.command === 'RegisterAgent' ||
    command.command === 'StartSession' ||
    command.command === 'HeartbeatSession' ||
    command.command === 'EndSession' ||
    command.command === 'CreateGoal' ||
""",
    'dispatcher session durable admission',
)
text = replace_once(
    text,
    """    command.command === 'ClaimTask' ||
    command.command === 'RecordCheckpoint' ||
""",
    """    command.command === 'ClaimTask' ||
    command.command === 'RenewLease' ||
    command.command === 'ReleaseLease' ||
    command.command === 'RecordCheckpoint' ||
""",
    'dispatcher lease durable admission',
)
text = replace_once(
    text,
    """    case 'CreateGoal': {
""",
    """    case 'HeartbeatSession': {
      const result = semanticResponse.result as Session;
      return resolveMutationResult(
        command,
        await options.persistence.heartbeatSession({
          session: result,
          expectedRevision: command.expectedSessionRevision,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'EndSession': {
      const result = semanticResponse.result as EndSessionResult;
      return resolveMutationResult(
        command,
        await options.persistence.endSession({
          session: result.session,
          leases: result.leases,
          expectedSessionRevision: command.expectedSessionRevision,
          now: result.session.updatedAt,
          receipt: receiptFor(
            command,
            fingerprint,
            successResponse(command, result),
            options.now(),
          ),
        }),
      );
    }
    case 'CreateGoal': {
""",
    'dispatcher session commit cases',
)
text = replace_once(
    text,
    """    case 'RecordCheckpoint': {
""",
    """    case 'RenewLease': {
      const result = semanticResponse.result as Lease;
      const now = result.updatedAt;
      return resolveMutationResult(
        command,
        await options.persistence.renewLease({
          lease: result,
          expectedRevision: command.expectedLeaseRevision,
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
    case 'ReleaseLease': {
      const result = semanticResponse.result as Lease;
      const now = result.updatedAt;
      return resolveMutationResult(
        command,
        await options.persistence.releaseLease({
          lease: result,
          expectedRevision: command.expectedLeaseRevision,
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
    case 'RecordCheckpoint': {
""",
    'dispatcher lease commit cases',
)
dispatcher.write_text(text)
