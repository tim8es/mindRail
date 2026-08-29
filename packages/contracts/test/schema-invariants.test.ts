import { describe, expect, it } from 'vitest';

import { createDomainAjv } from '../../../scripts/contracts/schema-registry.ts';

const now = '2026-08-29T00:00:00Z';

async function validator(schemaId: string) {
  const { ajv } = await createDomainAjv();
  const validate = ajv.getSchema(schemaId);
  if (!validate) {
    throw new Error(`Missing validator for ${schemaId}`);
  }
  return validate;
}

describe('domain schema invariants', () => {
  it('rejects namespaced names that start with a digit', async () => {
    const validate = await validator('urn:mindrail:schema:domain:v1:task');

    expect(
      validate({
        id: 'task_1',
        workspaceId: 'ws_1',
        goalId: 'goal_1',
        revision: 1,
        createdAt: now,
        updatedAt: now,
        title: 'Define schemas',
        objective: 'Define canonical schemas.',
        acceptanceCriteria: ['Schemas match ADR-0003.'],
        requiredCapabilities: ['1repository.read'],
        dependencyTaskIds: [],
        status: 'ready',
      }),
    ).toBe(false);
  });

  it('requires a superseded decision id when sequence is greater than one', async () => {
    const validate = await validator('urn:mindrail:schema:domain:v1:permission-decision');

    expect(
      validate({
        id: 'decision_2',
        workspaceId: 'ws_1',
        requestId: 'permission_request_1',
        createdAt: now,
        sequence: 2,
        outcome: 'ALLOW',
        basis: 'human',
        decidedBy: { type: 'human', id: 'human_1' },
        reasonCode: 'human.approved',
      }),
    ).toBe(false);
  });

  it('forbids a superseded decision id on the first decision', async () => {
    const validate = await validator('urn:mindrail:schema:domain:v1:permission-decision');

    expect(
      validate({
        id: 'decision_1',
        workspaceId: 'ws_1',
        requestId: 'permission_request_1',
        createdAt: now,
        sequence: 1,
        outcome: 'ALLOW',
        basis: 'human',
        decidedBy: { type: 'human', id: 'human_1' },
        reasonCode: 'human.approved',
        supersedesDecisionId: 'decision_0',
      }),
    ).toBe(false);
  });
});
