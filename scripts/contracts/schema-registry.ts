import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { AnySchemaObject } from 'ajv';

const here = dirname(fileURLToPath(import.meta.url));

export const schemaDirectory = join(here, '../../schemas/domain/v1');

export async function loadDomainSchemas(): Promise<AnySchemaObject[]> {
  const names = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const content = await readFile(join(schemaDirectory, name), 'utf8');
      return JSON.parse(content) as AnySchemaObject;
    }),
  );
}

export async function createDomainAjv() {
  const schemas = await loadDomainSchemas();
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    validateFormats: true,
  });

  addFormats(ajv);

  for (const schema of schemas) {
    ajv.addSchema(schema);
  }

  return { ajv, schemas };
}
