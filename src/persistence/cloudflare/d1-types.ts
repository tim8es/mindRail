export interface D1ResultLike<T = Record<string, unknown>> {
  readonly success: boolean;
  readonly results?: readonly T[];
  readonly meta?: {
    readonly changes?: number;
  };
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<D1ResultLike<T>>;
  run<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]>;
  exec?(sql: string): Promise<unknown>;
}
