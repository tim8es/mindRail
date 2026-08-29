import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, before, after, label) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(before)) throw new Error(`${path}: missing ${label}`);
  writeFileSync(path, text.replace(before, after));
}

replaceOnce(
  'src/runtime/state-rehydration.ts',
  `    if (!Number.isSafeInteger(counter) || counter === undefined || counter < 0) {`,
  `    if (counter === undefined || !Number.isSafeInteger(counter) || counter < 0) {`,
  'fencing counter narrowing',
);

replaceOnce(
  'src/runtime/permission-service.ts',
  `  requestPermission(input: RequestPermissionInput): RequestPermissionResult {`,
  `  restoreState(requests: PermissionRequest[], decisions: PermissionDecision[]): void {
    if (this.requests.size > 0 || this.decisionsByRequest.size > 0) {
      throw new RuntimeError('CONFLICT', 'Permission service state is already initialized.');
    }

    for (const request of requests) {
      this.assertCanonical('PermissionRequest', request);
      if (this.requests.has(request.id)) {
        throw new RuntimeError('CONFLICT', \`PermissionRequest \${request.id} is duplicated.\`);
      }
      this.requests.set(request.id, clone(request));
      this.decisionsByRequest.set(request.id, []);
    }

    const decisionIds = new Set<string>();
    for (const decision of decisions) {
      this.assertCanonical('PermissionDecision', decision);
      if (decisionIds.has(decision.id)) {
        throw new RuntimeError('CONFLICT', \`PermissionDecision \${decision.id} is duplicated.\`);
      }
      decisionIds.add(decision.id);
      const request = this.requests.get(decision.requestId);
      if (!request || request.workspaceId !== decision.workspaceId) {
        throw new RuntimeError(
          'CONFLICT',
          \`PermissionDecision \${decision.id} does not belong to a restored request.\`,
        );
      }
      this.decisionsByRequest.get(request.id)!.push(clone(decision));
    }

    for (const [requestId, chain] of this.decisionsByRequest) {
      chain.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
      if (chain.length === 0) {
        throw new RuntimeError('CONFLICT', \`PermissionRequest \${requestId} has no decision.\`);
      }
      for (let index = 0; index < chain.length; index += 1) {
        const current = chain[index]!;
        if (current.sequence !== index + 1) {
          throw new RuntimeError('CONFLICT', \`PermissionRequest \${requestId} has a broken decision sequence.\`);
        }
        const previous = chain[index - 1];
        if (previous === undefined) {
          if (current.supersedesDecisionId !== undefined) {
            throw new RuntimeError('CONFLICT', \`PermissionRequest \${requestId} has an invalid first decision.\`);
          }
        } else if (current.supersedesDecisionId !== previous.id) {
          throw new RuntimeError('CONFLICT', \`PermissionRequest \${requestId} has a broken supersession chain.\`);
        }
      }
    }
  }

  requestPermission(input: RequestPermissionInput): RequestPermissionResult {`,
  'permission restoreState method',
);

replaceOnce(
  'src/runtime/in-memory-control-plane.ts',
  `import { isProtocolEntityId, validateProtocolCommand } from './protocol-validation.ts';`,
  `import { isProtocolEntityId, validateProtocolCommand } from './protocol-validation.ts';
import {
  prepareRuntimeStateSnapshot,
  type PreparedRuntimeState,
  type RuntimeStateSnapshot,
} from './state-rehydration.ts';`,
  'state rehydration import',
);

replaceOnce(
  'src/runtime/in-memory-control-plane.ts',
  `export interface RegisterAgentInput {`,
  `export interface InMemoryControlPlaneRehydrationOptions {
  snapshot: RuntimeStateSnapshot;
  now: () => Date;
  idFactory: (kind: string) => string;
  leaseDurationMs: number;
  sessionTimeoutMs: number;
  validateCanonicalDomainRecord: CanonicalDomainValidator;
  permissionPolicy?: PermissionPolicy;
}

export interface RegisterAgentInput {`,
  'rehydration options',
);

replaceOnce(
  'src/runtime/in-memory-control-plane.ts',
  `  constructor(options: InMemoryControlPlaneOptions) {`,
  `  static rehydrate(options: InMemoryControlPlaneRehydrationOptions): InMemoryControlPlane {
    const prepared = prepareRuntimeStateSnapshot({
      snapshot: options.snapshot,
      validateCanonicalDomainRecord: options.validateCanonicalDomainRecord,
      nowMs: options.now().getTime(),
      sessionTimeoutMs: options.sessionTimeoutMs,
    });
    const runtime = new InMemoryControlPlane({
      workspaceId: prepared.snapshot.workspace.id,
      workspaceName: prepared.snapshot.workspace.name,
      now: options.now,
      idFactory: options.idFactory,
      leaseDurationMs: options.leaseDurationMs,
      sessionTimeoutMs: options.sessionTimeoutMs,
      validateCanonicalDomainRecord: options.validateCanonicalDomainRecord,
      ...(options.permissionPolicy === undefined ? {} : { permissionPolicy: options.permissionPolicy }),
    });
    runtime.restorePreparedState(prepared);
    return runtime;
  }

  constructor(options: InMemoryControlPlaneOptions) {`,
  'static rehydrate',
);

replaceOnce(
  'src/runtime/in-memory-control-plane.ts',
  `  execute(command: RegisterAgentCommand): ProtocolResponse<Agent>;`,
  `  private restorePreparedState(prepared: PreparedRuntimeState): void {
    const snapshot = prepared.snapshot;
    Object.assign(this.workspace, clone(snapshot.workspace));

    for (const agent of snapshot.agents) this.agents.set(agent.id, clone(agent));
    for (const session of snapshot.sessions) this.sessions.set(session.id, clone(session));
    for (const goal of snapshot.goals) this.goals.set(goal.id, clone(goal));
    for (const task of snapshot.tasks) {
      this.tasks.set(task.id, clone(task));
      this.checkpointsByTask.set(task.id, []);
    }
    for (const lease of snapshot.leases) this.leases.set(lease.id, clone(lease));
    for (const checkpoint of snapshot.checkpoints) {
      this.checkpointsByTask.get(checkpoint.taskId)!.push(clone(checkpoint));
    }
    for (const [taskId, counter] of Object.entries(snapshot.fencingCounters)) {
      this.fencingCounterByTask.set(taskId, counter);
    }
    for (const [taskId, leaseId] of prepared.effectiveLeaseByTask) {
      this.effectiveLeaseByTask.set(taskId, leaseId);
    }
    this.permissionService.restoreState(snapshot.permissionRequests, snapshot.permissionDecisions);
  }

  execute(command: RegisterAgentCommand): ProtocolResponse<Agent>;`,
  'restorePreparedState',
);
