CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS commissions (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL,
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operations (
  id TEXT PRIMARY KEY,
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  document TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS operations_by_commission ON operations(commission_id, state);
