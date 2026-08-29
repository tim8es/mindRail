import { describe, expect, it } from 'vitest';

import { createDomainAjv, loadDomainSchemas } from '../../../scripts/contracts/schema-registry.ts';

describe('domain schema registry', () => {
  it('loads the complete v1 schema set with unique ids', async () => {
    const schemas = await loadDomainSchemas();

    expect(schemas).toHaveLength(11);

    const ids = schemas.map((schema) => schema.$id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('compiles every schema under strict Draft 2020-12 validation', async () => {
    const { ajv, schemas } = await createDomainAjv();

    for (const schema of schemas) {
      expect(() => ajv.getSchema(String(schema.$id)) ?? ajv.compile(schema)).not.toThrow();
    }
  });
});
