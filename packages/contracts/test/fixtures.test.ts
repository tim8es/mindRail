import { describe, expect, it } from 'vitest';

import { createDomainAjv } from '../../../scripts/contracts/schema-registry.ts';
import { invalidFixtures, validFixtures } from './fixtures/v1.ts';

describe('domain contract fixtures', () => {
  it('accepts representative valid records', async () => {
    const { ajv } = await createDomainAjv();

    for (const [schemaId, fixtures] of Object.entries(validFixtures)) {
      const validate = ajv.getSchema(schemaId);
      if (!validate) {
        throw new Error(`Missing validator for ${schemaId}`);
      }

      for (const fixture of fixtures) {
        const valid = validate(fixture);
        expect(valid, JSON.stringify(validate.errors)).toBe(true);
      }
    }
  });

  it('rejects representative invalid records', async () => {
    const { ajv } = await createDomainAjv();

    for (const [schemaId, fixtures] of Object.entries(invalidFixtures)) {
      const validate = ajv.getSchema(schemaId);
      if (!validate) {
        throw new Error(`Missing validator for ${schemaId}`);
      }

      for (const fixture of fixtures) {
        expect(validate(fixture)).toBe(false);
      }
    }
  });
});
