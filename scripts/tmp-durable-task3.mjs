import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, before, after, label) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(before)) throw new Error(`${path}: missing ${label}`);
  writeFileSync(path, text.replace(before, after));
}

replaceOnce(
  'src/persistence/ports.ts',
  `export type StoredCommandReceipt = Readonly<CommandReceiptInput>;

export type MutationCommitResult<T> =`,
  `export type StoredCommandReceipt = Readonly<CommandReceiptInput>;

export interface DeferredCommandReceiptInput<T> {
  workspaceId: string;
  commandId: string;
  command: string;
  semanticFingerprint: string;
  outcomeKind: 'result' | 'error';
  createdAt: string;
  expiresAt?: string;
  buildResponseSnapshot(value: T): unknown;
}

export type MutationCommitResult<T> =`,
  'deferred receipt interface',
);

replaceOnce(
  'src/persistence/ports.ts',
  `  receipt?: CommandReceiptInput;
  auditEvent?: AuditEvent;
}

export interface ClaimTaskCommitValue`,
  `  receipt?: CommandReceiptInput;
  deferredReceipt?: DeferredCommandReceiptInput<ClaimTaskCommitValue>;
  auditEvent?: AuditEvent;
}

export interface ClaimTaskCommitValue`,
  'claim deferred receipt field',
);

replaceOnce(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  `  type CompleteTaskCommitValue,
  type DurableRuntimePersistence,`,
  `  type CompleteTaskCommitValue,
  type DeferredCommandReceiptInput,
  type DurableRuntimePersistence,`,
  'deferred receipt import',
);

replaceOnce(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  `  async claimTask(
    input: ClaimTaskCommitInput,
  ): Promise<MutationCommitResult<ClaimTaskCommitValue>> {
    this.assertReceipt(input.workspaceId, input.receipt);
    this.assertRelatedAudit(input.workspaceId, input.auditEvent);`,
  `  async claimTask(
    input: ClaimTaskCommitInput,
  ): Promise<MutationCommitResult<ClaimTaskCommitValue>> {
    if (input.receipt !== undefined && input.deferredReceipt !== undefined) {
      throw new PersistenceError('INVALID_RECORD', 'ClaimTask cannot supply two receipt sources.');
    }
    this.assertReceipt(input.workspaceId, input.receipt);
    this.assertDeferredReceipt(input.workspaceId, input.deferredReceipt);
    this.assertRelatedAudit(input.workspaceId, input.auditEvent);`,
  'claim receipt admission',
);

replaceOnce(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  `      const replay = await this.resolveReceipt(input.receipt);
      if (replay) return replay;
      await this.requireWorkspace(input.workspaceId);`,
  `      const replay = await this.resolveReceiptSource(input.receipt, input.deferredReceipt);
      if (replay) return replay;
      await this.requireWorkspace(input.workspaceId);`,
  'claim resolve receipt source',
);

replaceOnce(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  `          this.pushReceiptStatement(statements, input.receipt);
          if (statements.length > 0) await this.batch(statements, 'record duplicate claim receipt');
          return {
            kind: 'committed',
            value: { task: clone(task), lease: clone(activeLease) },
          };`,
  `          const value = { task: clone(task), lease: clone(activeLease) };
          const finalReceipt = this.materializeReceipt(input.receipt, input.deferredReceipt, value);
          this.pushReceiptStatement(statements, finalReceipt);
          if (statements.length > 0) await this.batch(statements, 'record duplicate claim receipt');
          return { kind: 'committed', value };`,
  'duplicate claim final receipt',
);

replaceOnce(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  `      statements.push(this.insertLeaseStatement(lease));
      this.pushAuditStatement(statements, input.auditEvent);
      this.pushReceiptStatement(statements, input.receipt);
      await this.batch(statements, 'claim Task');
      return { kind: 'committed', value: { task: clone(nextTask), lease: clone(lease) } };`,
  `      statements.push(this.insertLeaseStatement(lease));
      this.pushAuditStatement(statements, input.auditEvent);
      const value = { task: clone(nextTask), lease: clone(lease) };
      const finalReceipt = this.materializeReceipt(input.receipt, input.deferredReceipt, value);
      this.pushReceiptStatement(statements, finalReceipt);
      await this.batch(statements, 'claim Task');
      return { kind: 'committed', value };`,
  'new claim final receipt',
);

replaceOnce(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  `  private async resolveReceipt(
    receipt: CommandReceiptInput | undefined,
  ): Promise<{ kind: 'replayed'; receipt: StoredCommandReceipt } | undefined> {`,
  `  private async resolveReceiptSource<T>(
    receipt: CommandReceiptInput | undefined,
    deferredReceipt: DeferredCommandReceiptInput<T> | undefined,
  ): Promise<{ kind: 'replayed'; receipt: StoredCommandReceipt } | undefined> {
    if (receipt) return this.resolveReceipt(receipt);
    if (!deferredReceipt) return undefined;
    const stored = await this.getCommandReceipt(deferredReceipt.workspaceId, deferredReceipt.commandId);
    if (!stored) return undefined;
    if (
      stored.command !== deferredReceipt.command ||
      stored.semanticFingerprint !== deferredReceipt.semanticFingerprint
    ) {
      throw new PersistenceError(
        'IDEMPOTENCY_CONFLICT',
        \`Command \${deferredReceipt.commandId} was already admitted with different semantics.\`,
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
  ): Promise<{ kind: 'replayed'; receipt: StoredCommandReceipt } | undefined> {`,
  'deferred receipt helpers before resolveReceipt',
);

replaceOnce(
  'src/persistence/cloudflare/d1-runtime-persistence.ts',
  `  private pushReceiptStatement(
    statements: D1PreparedStatementLike[],`,
  `  private assertDeferredReceipt<T>(
    workspaceId: string,
    receipt: DeferredCommandReceiptInput<T> | undefined,
  ): void {
    if (!receipt) return;
    if (receipt.workspaceId !== workspaceId) {
      throw new PersistenceError('INVALID_RECORD', 'Deferred receipt Workspace does not match mutation.');
    }
    if (!receipt.commandId || !receipt.command || !receipt.semanticFingerprint) {
      throw new PersistenceError('INVALID_RECORD', 'Deferred receipt identity fields must be non-empty.');
    }
    timestampMs(receipt.createdAt, 'DeferredCommandReceipt.createdAt');
    if (receipt.expiresAt !== undefined) {
      timestampMs(receipt.expiresAt, 'DeferredCommandReceipt.expiresAt');
    }
  }

  private pushReceiptStatement(
    statements: D1PreparedStatementLike[],`,
  'assertDeferredReceipt helper',
);
