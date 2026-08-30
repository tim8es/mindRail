CREATE TABLE IF NOT EXISTS mutation_batch_guards (
  workspace_id TEXT NOT NULL,
  ok INTEGER NOT NULL,
  CONSTRAINT mutation_batch_guard_ok CHECK (ok = 1)
);
