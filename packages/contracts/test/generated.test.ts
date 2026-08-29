import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const generatedDirectory = 'packages/contracts/src/generated/v1';
const generatedNames = [
  'agent.ts',
  'audit-event.ts',
  'checkpoint.ts',
  'common.ts',
  'goal.ts',
  'lease.ts',
  'permission-decision.ts',
  'permission-request.ts',
  'session.ts',
  'task.ts',
  'workspace.ts',
];

describe('generated TypeScript contracts', () => {
  it('commits every expected generated file with a generated warning', async () => {
    for (const name of generatedNames) {
      const path = join(generatedDirectory, name);
      await expect(access(path)).resolves.toBeUndefined();
      const content = await readFile(path, 'utf8');
      expect(content).toContain('GENERATED FILE — DO NOT EDIT');
    }
  });

  it('matches deterministic generation from canonical schemas', () => {
    const result = spawnSync(process.execPath, ['scripts/contracts/generate.ts', '--check'], {
      encoding: 'utf8',
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
