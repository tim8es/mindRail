import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/runtime/in-memory-control-plane.ts';
let source = readFileSync(path, 'utf8');

function replaceOnce(before, after) {
  const first = source.indexOf(before);
  if (first < 0) {
    throw new Error(`Expected integration anchor not found:\n${before}`);
  }
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Integration anchor is not unique:\n${before}`);
  }
  source = `${source.slice(0, first)}${after}${source.slice(first + before.length)}`;
}

replaceOnce(
  `  Lease,\n  Reason,\n  Session,`,
  `  Lease,\n  PermissionDecision,\n  PermissionRequest,\n  Reason,\n  Session,`,
);

replaceOnce(
  `import type { CanonicalDomainTarget, CanonicalDomainValidator } from './domain-validation.ts';\nimport { RuntimeError } from './errors.ts';`,
  `import type { PermissionPolicy } from '../policy/permission-policy.ts';\nimport { permissionPolicyV01 } from '../policy/permission-policy.ts';\nimport type { CanonicalDomainTarget, CanonicalDomainValidator } from './domain-validation.ts';\nimport { RuntimeError } from './errors.ts';\nimport {\n  InMemoryPermissionService,\n  type PermissionGrantAuthority,\n  type RecordPermissionDecisionInput,\n  type RequestPermissionInput,\n  type RequestPermissionResult,\n} from './permission-service.ts';`,
);

replaceOnce(
  `  type ProtocolFailure,\n  type ProtocolResponse,\n  type ProtocolSuccess,\n  type RecordCheckpointCommand,`,
  `  type ProtocolFailure,\n  type ProtocolResponse,\n  type ProtocolSuccess,\n  type RecordPermissionDecisionCommand,\n  type RecordCheckpointCommand,\n  type RequestPermissionCommand,`,
);

replaceOnce(
  `  validateCanonicalDomainRecord: CanonicalDomainValidator;\n}`,
  `  validateCanonicalDomainRecord: CanonicalDomainValidator;\n  permissionPolicy?: PermissionPolicy;\n}`,
);

replaceOnce(
  `  private readonly sessionTimeoutMs: number;\n  private readonly validateCanonicalDomainRecord: CanonicalDomainValidator;`,
  `  private readonly sessionTimeoutMs: number;\n  private readonly validateCanonicalDomainRecord: CanonicalDomainValidator;\n  private readonly permissionService: InMemoryPermissionService;`,
);

replaceOnce(
  `    this.sessionTimeoutMs = options.sessionTimeoutMs;\n    this.validateCanonicalDomainRecord = options.validateCanonicalDomainRecord;\n    const timestamp = this.timestamp();`,
  `    this.sessionTimeoutMs = options.sessionTimeoutMs;\n    this.validateCanonicalDomainRecord = options.validateCanonicalDomainRecord;\n    this.permissionService = new InMemoryPermissionService({\n      now: this.now,\n      idFactory: this.idFactory,\n      validateCanonicalDomainRecord: this.validateCanonicalDomainRecord,\n      policy: options.permissionPolicy ?? permissionPolicyV01,\n      assertExecutionAuthority: (authority) => {\n        this.requireExecutorAuthority(authority);\n      },\n    });\n    const timestamp = this.timestamp();`,
);

replaceOnce(
  `  execute(command: FailTaskCommand): ProtocolResponse<FailTaskResult>;\n  execute(command: RetryTaskCommand): ProtocolResponse<Task>;`,
  `  execute(command: FailTaskCommand): ProtocolResponse<FailTaskResult>;\n  execute(command: RequestPermissionCommand): ProtocolResponse<RequestPermissionResult>;\n  execute(command: RecordPermissionDecisionCommand): ProtocolResponse<PermissionDecision>;\n  execute(command: RetryTaskCommand): ProtocolResponse<Task>;`,
);

replaceOnce(
  `  getGoal(workspaceId: string, goalId: string): Goal {`,
  `  requestPermission(input: RequestPermissionInput): RequestPermissionResult {\n    this.assertWorkspace(input.workspaceId);\n    return this.permissionService.requestPermission(input);\n  }\n\n  recordPermissionDecision(input: RecordPermissionDecisionInput): PermissionDecision {\n    this.assertWorkspace(input.workspaceId);\n    return this.permissionService.recordPermissionDecision(input);\n  }\n\n  getPermissionRequest(workspaceId: string, requestId: string): PermissionRequest {\n    this.assertWorkspace(workspaceId);\n    return this.permissionService.getPermissionRequest(workspaceId, requestId);\n  }\n\n  listPermissionDecisions(workspaceId: string, requestId: string): PermissionDecision[] {\n    this.assertWorkspace(workspaceId);\n    return this.permissionService.listPermissionDecisions(workspaceId, requestId);\n  }\n\n  isPermissionGrantEffective(input: PermissionGrantAuthority): boolean {\n    this.assertWorkspace(input.workspaceId);\n    return this.permissionService.isPermissionGrantEffective(input);\n  }\n\n  getGoal(workspaceId: string, goalId: string): Goal {`,
);

replaceOnce(
  `      case 'RetryTask':\n        this.assertControllerActor(command);`,
  `      case 'RequestPermission':\n        return this.requestPermission({\n          workspaceId: command.workspaceId,\n          taskId: command.taskId,\n          sessionId: command.sessionId,\n          leaseId: command.leaseId,\n          fencingToken: command.fencingToken,\n          permission: command.permission,\n          justification: command.justification,\n          ...(command.resource === undefined ? {} : { resource: command.resource }),\n        });\n      case 'RecordPermissionDecision':\n        return this.recordPermissionDecision({\n          workspaceId: command.workspaceId,\n          requestId: command.requestId,\n          actor: command.actor,\n          outcome: command.outcome,\n          expectedPreviousDecisionId: command.expectedPreviousDecisionId,\n          reasonCode: command.reasonCode,\n          ...(command.reason === undefined ? {} : { reason: command.reason }),\n        });\n      case 'RetryTask':\n        this.assertControllerActor(command);`,
);

writeFileSync(path, source);
