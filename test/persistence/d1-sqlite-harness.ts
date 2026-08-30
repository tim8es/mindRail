import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type {
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
} from '../../src/persistence/cloudflare/d1-types.ts';

export class SqliteD1Database implements D1DatabaseLike {
  private readonly database: DatabaseSync;
  private failNextBatchAfterStatementCount: number | undefined;
  private beforeNextBatchHook: (() => Promise<void>) | undefined;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec('PRAGMA foreign_keys = ON;');
  }

  prepare(sql: string): D1PreparedStatementLike {
    return new SqliteD1PreparedStatement(this.database, sql);
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    const beforeBatch = this.beforeNextBatchHook;
    this.beforeNextBatchHook = undefined;
    if (beforeBatch) await beforeBatch();
    this.database.exec('BEGIN IMMEDIATE;');
    try {
      const results: D1ResultLike[] = [];
      for (const statement of statements) {
        if (!(statement instanceof SqliteD1PreparedStatement)) {
          throw new TypeError('SqliteD1Database can only batch its own prepared statements.');
        }
        if (
          this.failNextBatchAfterStatementCount !== undefined &&
          results.length === this.failNextBatchAfterStatementCount
        ) {
          throw new Error('Injected D1-like batch failure.');
        }
        results.push(statement.runSync());
      }
      this.failNextBatchAfterStatementCount = undefined;
      this.database.exec('COMMIT;');
      return results;
    } catch (error) {
      this.failNextBatchAfterStatementCount = undefined;
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  failNextBatchAfterStatements(statementCount: number): void {
    if (!Number.isSafeInteger(statementCount) || statementCount < 0) {
      throw new TypeError('statementCount must be a non-negative safe integer.');
    }
    this.failNextBatchAfterStatementCount = statementCount;
  }

  beforeNextBatch(hook: () => Promise<void>): void {
    this.beforeNextBatchHook = hook;
  }

  async exec(sql: string): Promise<void> {
    this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }
}

class SqliteD1PreparedStatement implements D1PreparedStatementLike {
  constructor(
    private readonly database: DatabaseSync,
    private readonly sql: string,
    private readonly parameters: readonly SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    return new SqliteD1PreparedStatement(this.database, this.sql, values.map(toSqlInputValue));
  }

  async first<T>(): Promise<T | null> {
    const row = this.database.prepare(this.sql).get(...this.parameters);
    return (row as T | undefined) ?? null;
  }

  async all<T>(): Promise<D1ResultLike<T>> {
    const results = this.database.prepare(this.sql).all(...this.parameters) as T[];
    return { success: true, results, meta: { changes: 0 } };
  }

  async run<T>(): Promise<D1ResultLike<T>> {
    return this.runSync() as D1ResultLike<T>;
  }

  runSync(): D1ResultLike {
    const result = this.database.prepare(this.sql).run(...this.parameters);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

function toSqlInputValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  throw new TypeError(`Unsupported SQLite bind value: ${String(value)}`);
}
