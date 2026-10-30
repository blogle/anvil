-- Derived operational records never authorize domain mutations. The Operation
-- journal remains the sole source of truth for external effects.
CREATE TABLE reconciliation_views (
  commission_id TEXT PRIMARY KEY REFERENCES commissions(id),
  commission_version INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE decision_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  commission_version INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  result TEXT NOT NULL
);
CREATE INDEX decision_history_commission ON decision_history(commission_id, sequence);
