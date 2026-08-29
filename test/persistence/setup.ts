import { readFileSync } from 'node:fs';

import { D1RuntimePersistence } from '../../src/persistence/cloudflare/d1-runtime-persistence.ts';
import { WorkspaceDurableObjectCoordinator } from '../../src/persistence/cloudflare/workspace-durable-object-coordinator.ts';
import { persistenceCanonicalValidator } from './canonical-domain-validator.ts';
import { SqliteD1Database } from './d1-sqlite-harness.ts';

const migrationUrl = new URL('../../migrations/0001_runtime_persistence.sql', import.meta.url);
const migrationSql = readFileSync(migrationUrl, 'utf8');

export async function openPersistence(path: string): Promise<{
  database: SqliteD1Database;
  persistence: D1RuntimePersistence;
}> {
  const database = new SqliteD1Database(path);
  await database.exec(migrationSql);
  const persistence = new D1RuntimePersistence({
    database,
    coordinator: new WorkspaceDurableObjectCoordinator(),
    validateCanonicalDomainRecord: persistenceCanonicalValidator,
  });
  return { database, persistence };
}
