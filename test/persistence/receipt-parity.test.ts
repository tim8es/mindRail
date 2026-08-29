import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Agent, Checkpoint, PermissionDecision, Session } from '@mindrail/contracts';
import { describe, expect, it } from 'vitest';

import type {
  CommandReceiptInput,
  MutationCommitResult,
} from '../../src/persistence/ports.ts';
import {
  agent,
  checkpoint,
  humanDecision,
  leaseCandidate,
  permissionRequest,
  policyDecision,
  receipt,
  session,
  T0,
  T1,
  T2,
  task,
  goal,
  workspace,
} from './fixtures.ts';
import { openPersistence } from './setup.ts';

interface ReceiptAwarePersistence {
  createAgent(input: {
    agent: Agent;
    receipt?: CommandReceiptInput;
  }): Promise<MutationCommitResult<Agent>>;
  createSession(input: {
    session: Session;
    receipt?: CommandReceiptInput;
  }): Promise<MutationCommitResult<Session>>;
  appendCheckpoint(input: {
    checkpoint: Checkpoint;
    now: string;
    receipt?: CommandReceiptInput;
  }): Promise<MutationCommitResult<Checkpoint>>;
  appendPermissionDecision(input: {
    decision: PermissionDecision;
    expectedPreviousDecisionId: string;
    receipt?: CommandReceiptInput;
  }): Promise<MutationCommitResult<PermissionDecision>>;
}

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'mindrail-receipt-parity-')), 'runtime.sqlite');
}

function asReceiptAware(value: unknown): ReceiptAwarePersistence {
  return value as ReceiptAwarePersistence;
}

async function seedClaim(path: string) {
  const opened = await openPersistence(path);
  const persistence = asReceiptAware(opened.persistence);
  await opened.persistence.bootstrapWorkspace(workspace());
  await opened.persistence.createGoal({ goal: goal() });
  await opened.persistence.createTask({ task: task() });
  await opened.persistence.createAgent({ agent: agent() });
  await opened.persistence.createSession({ session: session() });
  const claim = await opened.persistence.claimTask({
    workspaceId: 'ws-a',
    taskId: 'task-a',
    sessionId: 'session-a',
    expectedTaskRevision: 1,
    lease: leaseCandidate('ws-a', 'task-a', 'session-a', 'lease-a', T2),
    now: T0,
  });
  if (claim.kind !== 'committed') throw new Error('expected committed claim');
  return { ...opened, receiptAware: persistence, lease: claim.value.lease };
}

describe('durable mutation receipt parity', () => {
  it('replays Agent creation without inserting a duplicate Agent', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    const commandReceipt = receipt(
      'cmd-agent',
      'fp-agent',
      { protocolVersion: '0.1', commandId: 'cmd-agent', replayed: false, result: agent() },
      'ws-a',
      'RegisterAgent',
    );

    const first = await asReceiptAware(opened.persistence).createAgent({
      agent: agent(),
      receipt: commandReceipt,
    });
    expect(first.kind).toBe('committed');

    opened.database.close();
    opened = await openPersistence(path);
    const replay = await asReceiptAware(opened.persistence).createAgent({
      agent: agent(),
      receipt: commandReceipt,
    });
    expect(replay.kind).toBe('replayed');
    expect((await opened.persistence.loadWorkspaceState('ws-a'))?.agents).toHaveLength(1);
    opened.database.close();
  });

  it('replays Session creation without inserting a duplicate Session', async () => {
    const path = databasePath();
    let opened = await openPersistence(path);
    await opened.persistence.bootstrapWorkspace(workspace());
    await opened.persistence.createAgent({ agent: agent() });
    const commandReceipt = receipt(
      'cmd-session',
      'fp-session',
      { protocolVersion: '0.1', commandId: 'cmd-session', replayed: false, result: session() },
      'ws-a',
      'StartSession',
    );

    const first = await asReceiptAware(opened.persistence).createSession({
      session: session(),
      receipt: commandReceipt,
    });
    expect(first.kind).toBe('committed');

    opened.database.close();
    opened = await openPersistence(path);
    const replay = await asReceiptAware(opened.persistence).createSession({
      session: session(),
      receipt: commandReceipt,
    });
    expect(replay.kind).toBe('replayed');
    expect((await opened.persistence.loadWorkspaceState('ws-a'))?.sessions).toHaveLength(1);
    opened.database.close();
  });

  it('replays Checkpoint append without duplicating history', async () => {
    const path = databasePath();
    let seeded = await seedClaim(path);
    const progress = checkpoint(
      'ws-a',
      'task-a',
      'session-a',
      seeded.lease.id,
      seeded.lease.fencingToken,
      'checkpoint-receipt',
      T1,
    );
    const commandReceipt = receipt(
      'cmd-checkpoint',
      'fp-checkpoint',
      { protocolVersion: '0.1', commandId: 'cmd-checkpoint', replayed: false, result: progress },
      'ws-a',
      'RecordCheckpoint',
    );

    const first = await seeded.receiptAware.appendCheckpoint({
      checkpoint: progress,
      now: T1,
      receipt: commandReceipt,
    });
    expect(first.kind).toBe('committed');

    seeded.database.close();
    const reopened = await openPersistence(path);
    const replay = await asReceiptAware(reopened.persistence).appendCheckpoint({
      checkpoint: progress,
      now: T1,
      receipt: commandReceipt,
    });
    expect(replay.kind).toBe('replayed');
    expect(await reopened.persistence.listTaskCheckpoints('ws-a', 'task-a')).toHaveLength(1);
    reopened.database.close();
  });

  it('replays a human PermissionDecision without forking immutable history', async () => {
    const path = databasePath();
    const seeded = await seedClaim(path);
    const request = permissionRequest(
      'ws-a',
      'task-a',
      'session-a',
      seeded.lease.id,
      seeded.lease.fencingToken,
    );
    const initial = policyDecision();
    await seeded.persistence.appendPermissionRequestWithInitialDecision({
      request,
      decision: initial,
    });
    const decision = humanDecision();
    const commandReceipt = receipt(
      'cmd-human-decision',
      'fp-human-decision',
      { protocolVersion: '0.1', commandId: 'cmd-human-decision', replayed: false, result: decision },
      'ws-a',
      'RecordPermissionDecision',
    );

    const first = await seeded.receiptAware.appendPermissionDecision({
      decision,
      expectedPreviousDecisionId: initial.id,
      receipt: commandReceipt,
    });
    expect(first.kind).toBe('committed');

    seeded.database.close();
    const reopened = await openPersistence(path);
    const replay = await asReceiptAware(reopened.persistence).appendPermissionDecision({
      decision,
      expectedPreviousDecisionId: initial.id,
      receipt: commandReceipt,
    });
    expect(replay.kind).toBe('replayed');
    expect(await reopened.persistence.listPermissionDecisions('ws-a', request.id)).toHaveLength(2);
    reopened.database.close();
  });
});
