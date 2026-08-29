PRAGMA foreign_keys = ON;

CREATE TRIGGER IF NOT EXISTS leases_fencing_must_match_counter
BEFORE INSERT ON leases
WHEN NEW.status = 'active'
BEGIN
  SELECT CASE
    WHEN (
      SELECT last_fencing_token
      FROM task_fencing_counters
      WHERE workspace_id = NEW.workspace_id AND task_id = NEW.task_id
    ) IS NULL
      THEN RAISE(ABORT, 'active lease requires fencing allocation state')
  END;
  SELECT CASE
    WHEN (
      SELECT last_fencing_token
      FROM task_fencing_counters
      WHERE workspace_id = NEW.workspace_id AND task_id = NEW.task_id
    ) <> NEW.fencing_token
      THEN RAISE(ABORT, 'active lease fencing token must match allocated counter')
  END;
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM leases
      WHERE workspace_id = NEW.workspace_id
        AND task_id = NEW.task_id
        AND fencing_token >= NEW.fencing_token
    )
      THEN RAISE(ABORT, 'lease fencing token must strictly increase')
  END;
END;

INSERT OR IGNORE INTO schema_migrations(version, applied_at)
VALUES ('0002_lease_fencing_guards', datetime('now'));
