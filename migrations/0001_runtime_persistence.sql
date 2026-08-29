PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json))
);

CREATE TABLE IF NOT EXISTS goals (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'succeeded', 'failed', 'cancelled')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, status),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'ready', 'running', 'blocked', 'succeeded', 'failed', 'cancelled')
  ),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, goal_id),
  FOREIGN KEY (workspace_id, goal_id) REFERENCES goals(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  workspace_id TEXT NOT NULL,
  goal_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dependency_task_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id, dependency_task_id),
  CHECK (task_id <> dependency_task_id),
  FOREIGN KEY (workspace_id, task_id, goal_id)
    REFERENCES tasks(workspace_id, id, goal_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, dependency_task_id, goal_id)
    REFERENCES tasks(workspace_id, id, goal_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS task_required_capabilities (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id, capability),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_fencing_counters (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  last_fencing_token INTEGER NOT NULL CHECK (last_fencing_token >= 0),
  PRIMARY KEY (workspace_id, task_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agents (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_capabilities (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id, capability),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'ended', 'expired')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS leases (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'revoked')),
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, id, task_id, session_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leases_one_active_per_task
  ON leases(workspace_id, task_id)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS checkpoints (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  created_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, lease_id, task_id, session_id)
    REFERENCES leases(workspace_id, id, task_id, session_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS permission_requests (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL CHECK (fencing_token >= 1),
  permission TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES tasks(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, session_id) REFERENCES sessions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, lease_id, task_id, session_id)
    REFERENCES leases(workspace_id, id, task_id, session_id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS permission_decisions (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  outcome TEXT NOT NULL CHECK (outcome IN ('ALLOW', 'DENY', 'HUMAN_REQUIRED')),
  basis TEXT NOT NULL CHECK (basis IN ('policy', 'human')),
  supersedes_decision_id TEXT,
  created_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, request_id, sequence),
  FOREIGN KEY (workspace_id, request_id) REFERENCES permission_requests(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, supersedes_decision_id)
    REFERENCES permission_decisions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS permission_heads (
  workspace_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  latest_decision_id TEXT NOT NULL,
  latest_sequence INTEGER NOT NULL CHECK (latest_sequence >= 1),
  latest_outcome TEXT NOT NULL CHECK (latest_outcome IN ('ALLOW', 'DENY', 'HUMAN_REQUIRED')),
  PRIMARY KEY (workspace_id, request_id),
  FOREIGN KEY (workspace_id, request_id) REFERENCES permission_requests(workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, latest_decision_id)
    REFERENCES permission_decisions(workspace_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS audit_events (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS command_receipts (
  workspace_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  command_discriminator TEXT NOT NULL,
  semantic_fingerprint TEXT NOT NULL,
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('result', 'error')),
  response_snapshot_json TEXT NOT NULL CHECK (json_valid(response_snapshot_json)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER,
  PRIMARY KEY (workspace_id, command_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_goal_status
  ON tasks(workspace_id, goal_id, status, id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status
  ON tasks(workspace_id, status, updated_at_ms, id);
CREATE INDEX IF NOT EXISTS idx_sessions_workspace_status_last_seen
  ON sessions(workspace_id, status, last_seen_at_ms, id);
CREATE INDEX IF NOT EXISTS idx_leases_workspace_status_expiry
  ON leases(workspace_id, status, expires_at_ms, id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_task_order
  ON checkpoints(workspace_id, task_id, created_at_ms, id);
CREATE INDEX IF NOT EXISTS idx_permission_requests_task_order
  ON permission_requests(workspace_id, task_id, created_at_ms, id);
CREATE INDEX IF NOT EXISTS idx_permission_heads_pending
  ON permission_heads(workspace_id, latest_outcome, request_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_workspace_order
  ON audit_events(workspace_id, created_at_ms, id);
CREATE INDEX IF NOT EXISTS idx_receipts_workspace_created
  ON command_receipts(workspace_id, created_at_ms, command_id);

CREATE TRIGGER IF NOT EXISTS checkpoints_append_only_update
BEFORE UPDATE ON checkpoints
BEGIN
  SELECT RAISE(ABORT, 'checkpoints are append-only');
END;

CREATE TRIGGER IF NOT EXISTS checkpoints_append_only_delete
BEFORE DELETE ON checkpoints
BEGIN
  SELECT RAISE(ABORT, 'checkpoints are append-only');
END;

CREATE TRIGGER IF NOT EXISTS permission_requests_append_only_update
BEFORE UPDATE ON permission_requests
BEGIN
  SELECT RAISE(ABORT, 'permission requests are append-only');
END;

CREATE TRIGGER IF NOT EXISTS permission_requests_append_only_delete
BEFORE DELETE ON permission_requests
BEGIN
  SELECT RAISE(ABORT, 'permission requests are append-only');
END;

CREATE TRIGGER IF NOT EXISTS permission_decisions_append_only_update
BEFORE UPDATE ON permission_decisions
BEGIN
  SELECT RAISE(ABORT, 'permission decisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS permission_decisions_append_only_delete
BEFORE DELETE ON permission_decisions
BEGIN
  SELECT RAISE(ABORT, 'permission decisions are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_append_only_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_append_only_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS command_receipts_immutable_update
BEFORE UPDATE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command receipts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS command_receipts_immutable_delete
BEFORE DELETE ON command_receipts
BEGIN
  SELECT RAISE(ABORT, 'command receipts are immutable');
END;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES ('0001_runtime_persistence', datetime('now'));
