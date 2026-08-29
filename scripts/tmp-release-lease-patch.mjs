import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src/runtime/in-memory-control-plane.ts';
let text = readFileSync(path, 'utf8');

function replaceOnce(oldText, newText, label) {
  if (!text.includes(oldText)) {
    throw new Error(`Missing patch anchor: ${label}`);
  }
  text = text.replace(oldText, newText);
}

replaceOnce(
  "  type RecordCheckpointCommand,\n  type RenewLeaseCommand,\n  type ResumeTaskCommand,",
  "  type RecordCheckpointCommand,\n  type ReleaseLeaseCommand,\n  type RenewLeaseCommand,\n  type ResumeTaskCommand,",
  'ReleaseLease import',
);

replaceOnce(
  "  execute(command: ClaimTaskCommand): ProtocolResponse<ClaimTaskResult>;\n  execute(command: RenewLeaseCommand): ProtocolResponse<Lease>;\n  execute(command: RecordCheckpointCommand): ProtocolResponse<Checkpoint>;",
  "  execute(command: ClaimTaskCommand): ProtocolResponse<ClaimTaskResult>;\n  execute(command: RenewLeaseCommand): ProtocolResponse<Lease>;\n  execute(command: ReleaseLeaseCommand): ProtocolResponse<Lease>;\n  execute(command: RecordCheckpointCommand): ProtocolResponse<Checkpoint>;",
  'ReleaseLease execute overload',
);

const recordCheckpointCase = "      case 'RecordCheckpoint':\n";
replaceOnce(
  recordCheckpointCase,
  `      case 'ReleaseLease':\n        return this.releaseLease({\n          workspaceId: command.workspaceId,\n          taskId: command.taskId,\n          sessionId: command.sessionId,\n          leaseId: command.leaseId,\n          fencingToken: command.fencingToken,\n          expectedLeaseRevision: command.expectedLeaseRevision,\n        });\n${recordCheckpointCase}`,
  'ReleaseLease dispatcher',
);

writeFileSync(path, text);
