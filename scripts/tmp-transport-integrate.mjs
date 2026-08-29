import { readFileSync, writeFileSync } from 'node:fs';

function patch(path, transform) {
  const before = readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`${path}: patch made no change`);
  writeFileSync(path, after);
}

function replaceOnce(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`missing anchor: ${label}`);
  return text.replace(from, to);
}

patch('src/application/protocol.ts', (text) => {
  text = replaceOnce(
    text,
    "import type { ActorRef, EvidenceRef, Reason, ResourceRef } from '@mindrail/contracts';",
    "import type { ActorRef } from '@mindrail/contracts';",
    'application protocol import',
  );
  const pattern = /export interface HeartbeatSessionCommand extends CommandEnvelope \{[\s\S]*?export type ParallelCommand =[\s\S]*?;\n\nexport type ApplicationCommand = ProtocolCommand \| ParallelCommand;/;
  if (!pattern.test(text)) throw new Error('missing duplicate runtime command block');
  return text.replace(
    pattern,
    'export type ParallelCommand = RegisterAgentCommand | StartSessionCommand;\n\nexport type ApplicationCommand = ProtocolCommand | ParallelCommand;',
  );
});

patch('src/application/validation.ts', (text) => {
  const blockPattern = /(  BlockTask: \{\n    required: \[\n[\s\S]*?      'reason',\n)      'summary',\n(      'evidence',\n    \],\n  \},)/;
  if (!blockPattern.test(text)) throw new Error('missing scoped BlockTask shape');
  text = text.replace(blockPattern, '$1$2');
  const validatorPattern = /function validateParallelCommand\([\s\S]*?\nfunction entityFieldsForQuery/;
  if (!validatorPattern.test(text)) throw new Error('missing parallel validator block');
  return text.replace(
    validatorPattern,
    `function validateParallelCommand(
  commandName: 'RegisterAgent' | 'StartSession',
  record: Record<string, unknown>,
): string | undefined {
  switch (commandName) {
    case 'RegisterAgent':
      if (!isBoundedString(record.displayName, 1, 200)) {
        return 'displayName must be a bounded string';
      }
      if (!isStringArray(record.capabilities)) return 'capabilities must be an array of strings';
      return undefined;
    case 'StartSession':
      return requireEntityFields(record, ['agentId']);
  }
}

type RuntimeProtocolCommandName = Exclude<ApplicationCommandName, 'RegisterAgent' | 'StartSession'>;

function isRuntimeProtocolCommand(name: ApplicationCommandName): name is RuntimeProtocolCommandName {
  return name !== 'RegisterAgent' && name !== 'StartSession';
}

function entityFieldsForQuery`,
  );
});

patch('src/application/in-memory-dispatcher.ts', (text) => {
  const pattern = /export const IN_MEMORY_UNSUPPORTED_COMMANDS = \[[\s\S]*?\] as const satisfies readonly ApplicationCommandName\[\];/;
  if (!pattern.test(text)) throw new Error('missing unsupported command list');
  return text.replace(
    pattern,
    `export const IN_MEMORY_UNSUPPORTED_COMMANDS = [
  'RegisterAgent',
  'StartSession',
] as const satisfies readonly ApplicationCommandName[];`,
  );
});

patch('src/runtime/protocol-validation.ts', (text) => {
  text = replaceOnce(
    text,
    "      requireNamespacedName(command, 'permission', errors);\n      requireString(command, 'justification', errors);",
    "      requireNamespacedName(command, 'permission', errors);\n      requireBoundedString(command, 'justification', 1, 2000, errors);",
    'permission justification bound',
  );
  text = replaceOnce(
    text,
    "      optionalString(command, 'reason', errors);",
    "      optionalBoundedString(command, 'reason', 1, 1000, errors);",
    'permission decision reason bound',
  );
  text = replaceOnce(
    text,
    `function optionalString(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    errors.push(\`${'${key}'} must be a string when present\`);
  }
}
`,
    `function optionalString(record: Record<string, unknown>, key: string, errors: string[]): void {
  if (record[key] !== undefined && typeof record[key] !== 'string') {
    errors.push(\`${'${key}'} must be a string when present\`);
  }
}

function requireBoundedString(
  record: Record<string, unknown>,
  key: string,
  minLength: number,
  maxLength: number,
  errors: string[],
): void {
  const value = record[key];
  if (typeof value !== 'string' || value.length < minLength || value.length > maxLength) {
    errors.push(\`${'${key}'} must be a string from ${'${minLength}'} to ${'${maxLength}'} characters\`);
  }
}

function optionalBoundedString(
  record: Record<string, unknown>,
  key: string,
  minLength: number,
  maxLength: number,
  errors: string[],
): void {
  if (record[key] !== undefined) requireBoundedString(record, key, minLength, maxLength, errors);
}
`,
    'bounded string helpers',
  );
  text = replaceOnce(
    text,
    `function requireReason(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (!isRecord(value) || typeof value.code !== 'string' || typeof value.summary !== 'string') {
    errors.push(\`${'${key}'} must be a Reason-shaped object\`);
  }
}

function requireEvidenceArray(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    errors.push(\`${'${key}'} must be an array of EvidenceRef-shaped objects\`);
  }
}
`,
    `function requireReason(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['code', 'summary']) ||
    typeof value.code !== 'string' ||
    value.code.length > 128 ||
    !NAMESPACED_NAME_PATTERN.test(value.code) ||
    typeof value.summary !== 'string' ||
    value.summary.length < 1 ||
    value.summary.length > 1000
  ) {
    errors.push(\`${'${key}'} must be a bounded canonical Reason\`);
  }
}

function requireEvidenceArray(
  record: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  const value = record[key];
  if (!Array.isArray(value) || value.length > 32 || value.some((entry) => !isEvidenceRef(entry))) {
    errors.push(\`${'${key}'} must be an array of at most 32 canonical EvidenceRef objects\`);
  }
}

function isEvidenceRef(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ['uri', 'mediaType', 'sha256', 'sizeBytes'])) return false;
  if (typeof value.uri !== 'string' || value.uri.length > 2048 || /[\\s\\u0000-\\u001f]/u.test(value.uri)) return false;
  if (/%(?![0-9A-Fa-f]{2})/u.test(value.uri)) return false;
  if (value.mediaType !== undefined && (typeof value.mediaType !== 'string' || value.mediaType.length < 1 || value.mediaType.length > 255)) return false;
  if (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256))) return false;
  if (value.sizeBytes !== undefined && (!Number.isInteger(value.sizeBytes) || value.sizeBytes < 0)) return false;
  return true;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}
`,
    'Reason and EvidenceRef helpers',
  );
  return replaceOnce(
    text,
    `  if (
    typeof value.type !== 'string' ||
    value.type.length > 128 ||
    !NAMESPACED_NAME_PATTERN.test(value.type) ||
    !isProtocolEntityId(value.id)
  ) {`,
    `  if (
    !hasOnlyKeys(value, ['type', 'id']) ||
    typeof value.type !== 'string' ||
    value.type.length > 128 ||
    !NAMESPACED_NAME_PATTERN.test(value.type) ||
    !isProtocolEntityId(value.id)
  ) {`,
    'ResourceRef exact shape',
  );
});

patch('test/transports/mcp-adapter.test.ts', (text) => {
  text = replaceOnce(
    text,
    `    expect(names).not.toEqual(
      expect.arrayContaining([
        'execute_action',
        'update_entity',
        'patch_object',
        'shell',
        'filesystem',
        'browser',
      ]),
    );`,
    `    for (const forbidden of [
      'execute_action',
      'update_entity',
      'patch_object',
      'shell',
      'filesystem',
      'browser',
    ]) {
      expect(names).not.toContain(forbidden);
    }`,
    'MCP forbidden tool assertion',
  );
  return text.replace(
    "      commandId: '',\n      unexpectedAuthority: 'allow',",
    "      unexpectedAuthority: 'allow',",
  );
});

writeFileSync(
  'test/runtime/protocol-admission-bounds-review.test.ts',
  `import { describe, expect, it } from 'vitest';
import { validateProtocolCommand } from '../../src/runtime/protocol-validation.ts';

const base = { protocolVersion: '0.1', commandId: 'cmd-1', workspaceId: 'ws-1', actor: { type: 'agent', id: 'agent-1' }, taskId: 'task-1', sessionId: 'session-1', leaseId: 'lease-1', fencingToken: 1 };

describe('protocol structural bounds', () => {
  it('rejects malformed and oversized EvidenceRef arrays', () => {
    expect(validateProtocolCommand({ ...base, command: 'BlockTask', expectedTaskRevision: 1, reason: { code: 'task.blocked', summary: 'blocked' }, evidence: [{ uri: 123 }] }).valid).toBe(false);
    expect(validateProtocolCommand({ ...base, command: 'BlockTask', expectedTaskRevision: 1, reason: { code: 'task.blocked', summary: 'blocked' }, evidence: Array.from({ length: 33 }, (_, i) => ({ uri: \`e-\${i}\` })) }).valid).toBe(false);
  });
  it('rejects PermissionRequest justification beyond 2000 characters', () => {
    expect(validateProtocolCommand({ ...base, command: 'RequestPermission', permission: 'repository.write', justification: 'x'.repeat(2001) }).valid).toBe(false);
  });
});
`,
);

writeFileSync(
  'test/transports/review-regressions.test.ts',
  `import { describe, expect, it } from 'vitest';
import { IN_MEMORY_UNSUPPORTED_COMMANDS } from '../../src/application/in-memory-dispatcher.ts';
import { parseApplicationCommand } from '../../src/application/validation.ts';

const envelope = { protocolVersion: '0.1', workspaceId: 'ws-1', actor: { type: 'agent', id: 'agent-1' } } as const;
const executor = { taskId: 'task-1', sessionId: 'session-1', leaseId: 'lease-1', fencingToken: 1 };

describe('transport integration regressions', () => {
  it('accepts canonical BlockTask without a duplicate summary field', () => {
    expect(parseApplicationCommand('BlockTask', { ...envelope, ...executor, commandId: 'cmd-block', expectedTaskRevision: 2, reason: { code: 'task.blocked', summary: 'Need input.' }, evidence: [] }).ok).toBe(true);
  });
  it('preserves the canonical FailTask summary requirement', () => {
    const fail = { ...envelope, ...executor, commandId: 'cmd-fail', expectedTaskRevision: 2, reason: { code: 'task.failed', summary: 'Failed.' }, evidence: [] };
    expect(parseApplicationCommand('FailTask', fail).ok).toBe(false);
    expect(parseApplicationCommand('FailTask', { ...fail, summary: 'Execution failed.' }).ok).toBe(true);
  });
  it('delegates every currently implemented runtime mutation', () => {
    expect(IN_MEMORY_UNSUPPORTED_COMMANDS).toEqual(['RegisterAgent', 'StartSession']);
  });
  it('rejects noncanonical permission input before dispatch', () => {
    const base = { ...envelope, ...executor, commandId: 'cmd-permission', justification: 'Need repository write.' };
    expect(parseApplicationCommand('RequestPermission', { ...base, permission: 'NOT VALID' }).ok).toBe(false);
    expect(parseApplicationCommand('RequestPermission', { ...base, commandId: 'cmd-long', permission: 'repository.write', justification: 'x'.repeat(2001) }).ok).toBe(false);
  });
});
`,
);
