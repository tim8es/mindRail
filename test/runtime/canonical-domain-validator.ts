import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Ajv, AnySchemaObject, ErrorObject, Options, ValidateFunction } from 'ajv';
import type { FormatsPlugin } from 'ajv-formats';

import type {
  CanonicalDomainTarget,
  CanonicalDomainValidator,
} from '../../src/runtime/domain-validation.ts';

const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020.js') as new (options?: Options) => Ajv;
const addFormats = require('ajv-formats') as FormatsPlugin;
const here = dirname(fileURLToPath(import.meta.url));
const schemaDirectory = join(here, '../../schemas/domain/v1');

const schemaRefs: Record<CanonicalDomainTarget, string> = {
  Workspace: 'urn:mindrail:schema:domain:v1:workspace',
  Agent: 'urn:mindrail:schema:domain:v1:agent',
  Session: 'urn:mindrail:schema:domain:v1:session',
  Goal: 'urn:mindrail:schema:domain:v1:goal',
  Task: 'urn:mindrail:schema:domain:v1:task',
  Lease: 'urn:mindrail:schema:domain:v1:lease',
  Checkpoint: 'urn:mindrail:schema:domain:v1:checkpoint',
  PermissionRequest: 'urn:mindrail:schema:domain:v1:permission-request',
  PermissionDecision: 'urn:mindrail:schema:domain:v1:permission-decision',
  Reason: 'urn:mindrail:schema:domain:v1:common#/$defs/Reason',
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormats(ajv);

for (const name of readdirSync(schemaDirectory)
  .filter((entry) => entry.endsWith('.schema.json'))
  .sort()) {
  const schema = JSON.parse(readFileSync(join(schemaDirectory, name), 'utf8')) as AnySchemaObject;
  ajv.addSchema(schema);
}

const validators = new Map<CanonicalDomainTarget, ValidateFunction>();
for (const [target, ref] of Object.entries(schemaRefs) as [CanonicalDomainTarget, string][]) {
  validators.set(target, ajv.getSchema(ref) ?? ajv.compile({ $ref: ref }));
}

export const canonicalDomainValidator: CanonicalDomainValidator = (target, value) => {
  const validate = validators.get(target);
  if (!validate) {
    throw new Error(`Canonical validator for ${target} was not configured.`);
  }
  if (validate(value)) {
    return { valid: true };
  }
  return {
    valid: false,
    errors: (validate.errors ?? []).map(formatValidationError),
  };
};

function formatValidationError(error: ErrorObject): string {
  const location = error.instancePath.length === 0 ? '/' : error.instancePath;
  return `${location} ${error.keyword}${error.message === undefined ? '' : ` ${error.message}`}`;
}
