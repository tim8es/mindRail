import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile, type JSONSchema } from 'json-schema-to-typescript';
import prettier from 'prettier';

import { schemaDirectory } from './schema-registry.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '../..');
const generatedDirectory = join(repositoryRoot, 'packages/contracts/src/generated/v1');
const commonSchemaUrn = 'urn:mindrail:schema:domain:v1:common';
const bannerComment = `/*
 * GENERATED FILE — DO NOT EDIT.
 * Source: schemas/domain/v1/*.schema.json
 * Regenerate with: pnpm contracts:generate
 */`;

function rewriteCommonRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteCommonRefs);
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => {
        if (key === '$ref' && typeof nested === 'string' && nested.startsWith(commonSchemaUrn)) {
          return [key, nested.replace(commonSchemaUrn, 'common.schema.json')];
        }

        return [key, rewriteCommonRefs(nested)];
      }),
    );
  }

  return value;
}

function outputName(schemaName: string): string {
  return schemaName.replace(/\.schema\.json$/, '.ts');
}

function typeName(schema: JSONSchema, schemaName: string): string {
  if (typeof schema.title === 'string') {
    const normalized = schema.title.replace(/[^A-Za-z0-9_$]/g, '');
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return basename(schemaName, '.schema.json')
    .split('-')
    .map((segment) => `${segment.slice(0, 1).toUpperCase()}${segment.slice(1)}`)
    .join('');
}

async function generateSources(): Promise<Map<string, string>> {
  const schemaNames = (await readdir(schemaDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort();
  const output = new Map<string, string>();

  for (const schemaName of schemaNames) {
    const rawSchema = JSON.parse(await readFile(join(schemaDirectory, schemaName), 'utf8')) as JSONSchema;
    const generatorSchema = rewriteCommonRefs(rawSchema) as JSONSchema;
    const generated = await compile(generatorSchema, typeName(rawSchema, schemaName), {
      bannerComment,
      cwd: schemaDirectory,
      declareExternallyReferenced: true,
      format: false,
      unreachableDefinitions: true,
    });
    const formatted = await prettier.format(generated, {
      parser: 'typescript',
      printWidth: 100,
      singleQuote: true,
      trailingComma: 'all',
    });

    output.set(outputName(schemaName), formatted);
  }

  return output;
}

async function checkGenerated(sources: Map<string, string>): Promise<string[]> {
  let committedNames: string[] = [];
  try {
    committedNames = (await readdir(generatedDirectory)).filter((name) => name.endsWith('.ts')).sort();
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  const expectedNames = [...sources.keys()].sort();
  const differences = new Set<string>();

  for (const name of new Set([...committedNames, ...expectedNames])) {
    if (!sources.has(name) || !committedNames.includes(name)) {
      differences.add(name);
      continue;
    }

    const committed = await readFile(join(generatedDirectory, name), 'utf8');
    if (committed !== sources.get(name)) {
      differences.add(name);
    }
  }

  return [...differences].sort();
}

async function main() {
  const sources = await generateSources();
  const checkOnly = process.argv.includes('--check');

  if (checkOnly) {
    const differences = await checkGenerated(sources);
    if (differences.length > 0) {
      console.error(`Generated contracts are stale: ${differences.join(', ')}`);
      process.exitCode = 1;
    }
    return;
  }

  await mkdir(generatedDirectory, { recursive: true });
  await Promise.all(
    [...sources.entries()].map(([name, content]) => writeFile(join(generatedDirectory, name), content)),
  );
}

await main();
