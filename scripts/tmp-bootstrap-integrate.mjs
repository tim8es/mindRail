import { readFileSync, writeFileSync } from 'node:fs';

function replaceOnce(path, before, after, label) {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(before)) throw new Error(`${path}: missing ${label}`);
  writeFileSync(path, text.replace(before, after));
}

function replaceRegex(path, pattern, replacement, label) {
  const text = readFileSync(path, 'utf8');
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`${path}: missing ${label}`);
  writeFileSync(path, next);
}

replaceOnce(
  'src/runtime/protocol.ts',
  `interface CommandEnvelope {
  protocolVersion: '0.1';
  commandId: string;
  workspaceId: string;
  actor: ActorRef;
  correlationId?: string;
  causationId?: string;
}

export interface HeartbeatSessionCommand`,
  `interface CommandEnvelope {
  protocolVersion: '0.1';
  commandId: string;
  workspaceId: string;
  actor: ActorRef;
  correlationId?: string;
  causationId?: string;
}

export interface RegisterAgentCommand extends CommandEnvelope {
  command: 'RegisterAgent';
  displayName: string;
  capabilities: string[];
}

export interface StartSessionCommand extends CommandEnvelope {
  command: 'StartSession';
  agentId: string;
}

export interface HeartbeatSessionCommand`,
  'bootstrap command interfaces',
);
replaceOnce(
  'src/runtime/protocol.ts',
  `export type ProtocolCommand =
  | HeartbeatSessionCommand`,
  `export type ProtocolCommand =
  | RegisterAgentCommand
  | StartSessionCommand
  | HeartbeatSessionCommand`,
  'bootstrap command union',
);

replaceOnce(
  'src/runtime/protocol-validation.ts',
  `const COMMANDS = new Set([
  'HeartbeatSession',`,
  `const COMMANDS = new Set([
  'RegisterAgent',
  'StartSession',
  'HeartbeatSession',`,
  'bootstrap command discriminators',
);
replaceOnce(
  'src/runtime/protocol-validation.ts',
  `  switch (discriminator as ProtocolCommand['command']) {
    case 'HeartbeatSession':`,
  `  switch (discriminator as ProtocolCommand['command']) {
    case 'RegisterAgent':
      requireBoundedString(command, 'displayName', 1, 160, errors);
      requireNamespacedNameArray(command, 'capabilities', 64, errors);
      return;
    case 'StartSession':
      requireEntityId(command, 'agentId', errors);
      return;
    case 'HeartbeatSession':`,
  'bootstrap validation cases',
);
replaceOnce(
  'src/runtime/protocol-validation.ts',
  `function requireStringArray(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    errors.push(\`${'${key}'} must be an array of strings\`);
  }
}

function requirePositiveInteger`,
  `function requireStringArray(record: Record<string, unknown>, key: string, errors: string[]): void {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    errors.push(\`${'${key}'} must be an array of strings\`);
  }
}

function requireNamespacedNameArray(
  record: Record<string, unknown>,
  key: string,
  maxItems: number,
  errors: string[],
): void {
  const value = record[key];
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    new Set(value).size !== value.length ||
    value.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length < 1 ||
        entry.length > 128 ||
        !NAMESPACED_NAME_PATTERN.test(entry),
    )
  ) {
    errors.push(\`${'${key}'} must be a unique array of at most ${'${maxItems}'} NamespacedNames\`);
  }
}

function requirePositiveInteger`,
  'namespaced capability array helper',
);

replaceOnce(
  'src/runtime/in-memory-control-plane.ts',
  `  type RecordPermissionDecisionCommand,
  type RecordCheckpointCommand,`,
  `  type RecordPermissionDecisionCommand,
  type RecordCheckpointCommand,
  type RegisterAgentCommand,`,
  'RegisterAgent command import',
);
replaceOnce(
  'src/runtime/in-memory-control-plane.ts',
  `  type ResumeTaskCommand,
  type RequestPermissionCommand,`,
  `  type ResumeTaskCommand,
  type RequestPermissionCommand,
  type StartSessionCommand,`,
  'StartSession command import',
);
replaceOnce(
  'src/runtime/in-memory-control-plane.ts',
  `  execute(command: HeartbeatSessionCommand): ProtocolResponse<Session>;`,
  `  execute(command: RegisterAgentCommand): ProtocolResponse<Agent>;
  execute(command: StartSessionCommand): ProtocolResponse<Session>;
  execute(command: HeartbeatSessionCommand): ProtocolResponse<Session>;`,
  'bootstrap execute overloads',
);
replaceOnce(
  'src/runtime/in-memory-control-plane.ts',
  `  private dispatchCommand(command: ProtocolCommand): unknown {
    switch (command.command) {
      case 'HeartbeatSession':`,
  `  private dispatchCommand(command: ProtocolCommand): unknown {
    switch (command.command) {
      case 'RegisterAgent':
        return this.registerAgent({
          workspaceId: command.workspaceId,
          displayName: command.displayName,
          capabilities: command.capabilities,
        });
      case 'StartSession':
        return this.startSession({
          workspaceId: command.workspaceId,
          agentId: command.agentId,
        });
      case 'HeartbeatSession':`,
  'bootstrap dispatch cases',
);

replaceRegex(
  'src/application/protocol.ts',
  /\ninterface CommandEnvelope \{[\s\S]*?export type ApplicationCommand = ProtocolCommand \| ParallelCommand;/,
  `\nexport type ApplicationCommand = ProtocolCommand;`,
  'parallel application command definitions',
);
replaceRegex(
  'src/application/validation.ts',
  /  if \(isRuntimeProtocolCommand\(commandName\)\) \{[\s\S]*?  return \{ ok: true, value: record as unknown as ApplicationCommand \};\n\}/,
  `  const validation = validateProtocolCommand(record);
  if (!validation.valid) return invalid(validation.errors?.[0] ?? 'command is invalid');
  return { ok: true, value: record as unknown as ApplicationCommand };
}`,
  'single protocol command validator path',
);
replaceRegex(
  'src/application/validation.ts',
  /\nfunction validateParallelCommand\([\s\S]*?function entityFieldsForQuery/,
  `\nfunction entityFieldsForQuery`,
  'parallel command validation helpers',
);
replaceRegex(
  'src/application/validation.ts',
  /\nfunction requireEntityFields\([\s\S]*?\n}\n\nfunction isActorRef/,
  `\nfunction isActorRef`,
  'obsolete requireEntityFields helper',
);
replaceRegex(
  'src/application/validation.ts',
  /\nfunction isBoundedString\([\s\S]*?function isRecord/,
  `\nfunction isRecord`,
  'obsolete application string validators',
);

replaceRegex(
  'src/application/in-memory-dispatcher.ts',
  /import type \{ ProtocolCommand \} from '\.\.\/runtime\/protocol\.ts';\n/,
  '',
  'obsolete ProtocolCommand import',
);
replaceOnce(
  'src/application/in-memory-dispatcher.ts',
  `  ApplicationCommand,
  ApplicationCommandName,`,
  `  ApplicationCommandName,`,
  'obsolete ApplicationCommand import',
);
replaceOnce(
  'src/application/in-memory-dispatcher.ts',
  `  CommandFailure,
  CommandResponse,`,
  `  CommandResponse,`,
  'obsolete CommandFailure import',
);
replaceRegex(
  'src/application/in-memory-dispatcher.ts',
  /export const IN_MEMORY_UNSUPPORTED_COMMANDS = \[[\s\S]*?\] as const satisfies readonly ApplicationCommandName\[\];/,
  `export const IN_MEMORY_UNSUPPORTED_COMMANDS = [] as const satisfies readonly ApplicationCommandName[];`,
  'unsupported bootstrap command list',
);
replaceRegex(
  'src/application/in-memory-dispatcher.ts',
  /    dispatchCommand\(command\) \{[\s\S]*?    \},\n\n    dispatchQuery/,
  `    dispatchCommand(command) {
      return controlPlane.execute(command);
    },

    dispatchQuery`,
  'unified command dispatch',
);
replaceRegex(
  'src/application/in-memory-dispatcher.ts',
  /\nfunction isCurrentRuntimeCommand\([\s\S]*?function unsupportedQuery/,
  `\nfunction unsupportedQuery`,
  'obsolete unsupported command helpers',
);

replaceOnce(
  'test/transports/review-regressions.test.ts',
  `    expect(IN_MEMORY_UNSUPPORTED_COMMANDS).toEqual(['RegisterAgent', 'StartSession']);`,
  `    expect(IN_MEMORY_UNSUPPORTED_COMMANDS).toEqual([]);`,
  'bootstrap command delegation expectation',
);
