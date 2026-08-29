import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const base = '87fbfcf2ed738071f648a3b94bfff1df1f235dba';
const source = 'origin/feature/permission-engine-v0-1';

execFileSync('git', ['fetch', 'origin', 'feature/permission-engine-v0-1'], { stdio: 'inherit' });
const cleanPatch = execFileSync(
  'git',
  [
    'diff',
    '--binary',
    `${base}..${source}`,
    '--',
    '.',
    ':(exclude)docs/CURRENT_STATE.md',
    ':(exclude)src/runtime/in-memory-control-plane.ts',
    ':(exclude)src/runtime/protocol-validation.ts',
    ':(exclude)src/runtime/protocol.ts',
  ],
  { encoding: 'utf8' },
);
writeFileSync('/tmp/permission-clean.patch', cleanPatch);
execFileSync('git', ['apply', '--index', '/tmp/permission-clean.patch'], { stdio: 'inherit' });

function patchFile(path, patches) {
  let text = readFileSync(path, 'utf8');
  for (const [label, from, to] of patches) {
    if (!text.includes(from)) {
      throw new Error(`${path}: missing anchor ${label}`);
    }
    text = text.replace(from, to);
  }
  writeFileSync(path, text);
}

patchFile('src/runtime/protocol.ts', [
  [
    'ResourceRef import',
    "import type { ActorRef, EvidenceRef, Reason } from '@mindrail/contracts';",
    "import type { ActorRef, EvidenceRef, Reason, ResourceRef } from '@mindrail/contracts';",
  ],
  [
    'permission command interfaces',
    'export interface BlockTaskCommand extends CommandEnvelope {',
    `export interface RequestPermissionCommand extends CommandEnvelope {
  command: 'RequestPermission';
  taskId: string;
  sessionId: string;
  leaseId: string;
  fencingToken: number;
  permission: string;
  justification: string;
  resource?: ResourceRef;
}

export interface RecordPermissionDecisionCommand extends CommandEnvelope {
  command: 'RecordPermissionDecision';
  requestId: string;
  outcome: 'ALLOW' | 'DENY';
  expectedPreviousDecisionId: string;
  reasonCode: string;
  reason?: string;
}

export interface BlockTaskCommand extends CommandEnvelope {`,
  ],
  [
    'permission command union',
    '  | FailTaskCommand\n  | BlockTaskCommand',
    '  | FailTaskCommand\n  | RequestPermissionCommand\n  | RecordPermissionDecisionCommand\n  | BlockTaskCommand',
  ],
]);

patchFile('src/runtime/protocol-validation.ts', [
  [
    'NamespacedName validator',
    'const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;\n',
    "const ENTITY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;\nconst NAMESPACED_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;\n",
  ],
  [
    'permission command names',
    "  'FailTask',\n  'BlockTask',",
    "  'FailTask',\n  'RequestPermission',\n  'RecordPermissionDecision',\n  'BlockTask',",
  ],
  [
    'permission validation cases',
    "    case 'RetryTask':\n",
    `    case 'RequestPermission':
      validateExecutorFields(command, errors);
      requireNamespacedName(command, 'permission', errors);
      requireString(command, 'justification', errors);
      optionalResource(command, 'resource', errors);
      return;
    case 'RecordPermissionDecision':
      requireEntityId(command, 'requestId', errors);
      if (command.outcome !== 'ALLOW' && command.outcome !== 'DENY') {
        errors.push('outcome must be ALLOW or DENY');
      }
      requireEntityId(command, 'expectedPreviousDecisionId', errors);
      requireNamespacedName(command, 'reasonCode', errors);
      optionalString(command, 'reason', errors);
      return;
    case 'RetryTask':
`,
  ],
  [
    'NamespacedName helpers',
    "function requireStringArray(record: Record<string, unknown>, key: string, errors: string[]): void {",
    `function optionalString(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    errors.push(\`${'${key}'} must be a string when present\`);
  }
}

function requireNamespacedName(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length > 128 || !NAMESPACED_NAME_PATTERN.test(value)) {
    errors.push(\`${'${key}'} must be a NamespacedName\`);
  }
}

function requireStringArray(record: Record<string, unknown>, key: string, errors: string[]): void {`,
  ],
  [
    'ResourceRef helper',
    "function isRecord(value: unknown): value is Record<string, unknown> {",
    `function optionalResource(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    errors.push(\`${'${key}'} must be a ResourceRef-shaped object when present\`);
    return;
  }
  if (
    typeof value.type !== 'string' ||
    value.type.length > 128 ||
    !NAMESPACED_NAME_PATTERN.test(value.type) ||
    !isProtocolEntityId(value.id)
  ) {
    errors.push(\`${'${key}'} must be a ResourceRef-shaped object when present\`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {`,
  ],
]);

patchFile('src/runtime/in-memory-control-plane.ts', [
  [
    'permission contract imports',
    '  Lease,\n  Reason,',
    '  Lease,\n  PermissionDecision,\n  PermissionRequest,\n  Reason,',
  ],
  [
    'permission service imports',
    "import type { CanonicalDomainTarget, CanonicalDomainValidator } from './domain-validation.ts';",
    `import type { PermissionPolicy } from '../policy/permission-policy.ts';
import { permissionPolicyV01 } from '../policy/permission-policy.ts';
import type { CanonicalDomainTarget, CanonicalDomainValidator } from './domain-validation.ts';`,
  ],
  [
    'permission runtime service',
    "import { RuntimeError } from './errors.ts';\nimport {",
    `import { RuntimeError } from './errors.ts';
import {
  InMemoryPermissionService,
  type PermissionGrantAuthority,
  type RecordPermissionDecisionInput,
  type RequestPermissionInput,
  type RequestPermissionResult,
} from './permission-service.ts';
import {`,
  ],
  [
    'permission protocol imports',
    '  type ProtocolSuccess,\n  type RecordCheckpointCommand,',
    '  type ProtocolSuccess,\n  type RecordPermissionDecisionCommand,\n  type RecordCheckpointCommand,',
  ],
  [
    'request permission protocol import',
    '  type ResumeTaskCommand,\n  type RetryTaskCommand,',
    '  type ResumeTaskCommand,\n  type RequestPermissionCommand,\n  type RetryTaskCommand,',
  ],
  [
    'policy option',
    '  validateCanonicalDomainRecord: CanonicalDomainValidator;\n}',
    '  validateCanonicalDomainRecord: CanonicalDomainValidator;\n  permissionPolicy?: PermissionPolicy;\n}',
  ],
  [
    'permission service field',
    '  private readonly validateCanonicalDomainRecord: CanonicalDomainValidator;\n\n  private readonly agents',
    '  private readonly validateCanonicalDomainRecord: CanonicalDomainValidator;\n  private readonly permissionService: InMemoryPermissionService;\n\n  private readonly agents',
  ],
  [
    'permission service construction',
    '    this.validateCanonicalDomainRecord = options.validateCanonicalDomainRecord;\n    const timestamp = this.timestamp();',
    `    this.validateCanonicalDomainRecord = options.validateCanonicalDomainRecord;
    this.permissionService = new InMemoryPermissionService({
      now: this.now,
      idFactory: this.idFactory,
      validateCanonicalDomainRecord: this.validateCanonicalDomainRecord,
      policy: options.permissionPolicy ?? permissionPolicyV01,
      assertExecutionAuthority: (authority) => {
        this.requireExecutorAuthority(authority);
      },
    });
    const timestamp = this.timestamp();`,
  ],
  [
    'permission execute overloads',
    '  execute(command: ResumeTaskCommand): ProtocolResponse<Task>;\n  execute(command: RetryTaskCommand): ProtocolResponse<Task>;',
    '  execute(command: ResumeTaskCommand): ProtocolResponse<Task>;\n  execute(command: RequestPermissionCommand): ProtocolResponse<RequestPermissionResult>;\n  execute(command: RecordPermissionDecisionCommand): ProtocolResponse<PermissionDecision>;\n  execute(command: RetryTaskCommand): ProtocolResponse<Task>;',
  ],
  [
    'permission public methods',
    '  getGoal(workspaceId: string, goalId: string): Goal {',
    `  requestPermission(input: RequestPermissionInput): RequestPermissionResult {
    this.assertWorkspace(input.workspaceId);
    return this.permissionService.requestPermission(input);
  }

  recordPermissionDecision(input: RecordPermissionDecisionInput): PermissionDecision {
    this.assertWorkspace(input.workspaceId);
    return this.permissionService.recordPermissionDecision(input);
  }

  getPermissionRequest(workspaceId: string, requestId: string): PermissionRequest {
    this.assertWorkspace(workspaceId);
    return this.permissionService.getPermissionRequest(workspaceId, requestId);
  }

  listPermissionDecisions(workspaceId: string, requestId: string): PermissionDecision[] {
    this.assertWorkspace(workspaceId);
    return this.permissionService.listPermissionDecisions(workspaceId, requestId);
  }

  isPermissionGrantEffective(input: PermissionGrantAuthority): boolean {
    this.assertWorkspace(input.workspaceId);
    return this.permissionService.isPermissionGrantEffective(input);
  }

  getGoal(workspaceId: string, goalId: string): Goal {`,
  ],
  [
    'permission dispatch cases',
    "      case 'RetryTask':\n",
    `      case 'RequestPermission':
        return this.requestPermission({
          workspaceId: command.workspaceId,
          taskId: command.taskId,
          sessionId: command.sessionId,
          leaseId: command.leaseId,
          fencingToken: command.fencingToken,
          permission: command.permission,
          justification: command.justification,
          ...(command.resource === undefined ? {} : { resource: command.resource }),
        });
      case 'RecordPermissionDecision':
        return this.recordPermissionDecision({
          workspaceId: command.workspaceId,
          requestId: command.requestId,
          actor: command.actor,
          outcome: command.outcome,
          expectedPreviousDecisionId: command.expectedPreviousDecisionId,
          reasonCode: command.reasonCode,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        });
      case 'RetryTask':
`,
  ],
]);
