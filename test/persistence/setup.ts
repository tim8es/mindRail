import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { D1RuntimePersistence } from '../../src/persistence/cloudflare/d1-runtime-persistence.ts';
import type { WorkspaceMutationCoordinator } from '../../src/persistence/ports.ts';
import { WorkspaceDurableObjectCoordinator } from '../../src/persistence/cloudflare/workspace-durable-object-coordinator.ts';
import { persistenceCanonicalValidator } from './canonical-domain-validator.ts';
import { SqliteD1Database } from './d1-sqlite-harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = join(here, '../../migrations');
const migrations = readdirSync(migrationDirectory)
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(join(migrationDirectory, name), 'utf8'));

export async function openPersistence(
  path: string,
  coordinator: WorkspaceMutationCoordinator = new WorkspaceDurableObjectCoordinator(),
): Promise<{
  database: SqliteD1Database;
  persistence: D1RuntimePersistence;
}> {
  const database = new SqliteD1Database(path);
  for (const migration of migrations) {
    await database.exec(migration);
  }
  const persistence = new D1RuntimePersistence({
    database,
    coordinator,
    validateCanonicalDomainRecord: persistenceCanonicalValidator,
  });
  return { database, persistence };
}
