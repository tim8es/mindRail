import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type Ajv from 'ajv';
import type { AnySchemaObject, Options } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js') as new (options?: Options) => Ajv;
const addFormats = require('ajv-formats') as FormatsPlugin;
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
