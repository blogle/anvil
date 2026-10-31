DROP INDEX operations_by_commission_state;

CREATE TABLE operations_v6 (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  kind TEXT NOT NULL CHECK (kind IN ('steer', 'provision_sandbox', 'create_session', 'interrupt', 'continue', 'repair', 'refresh_context', 'change_strategy', 'verify', 'integrate')),
  target TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL,
  specification_generation INTEGER NOT NULL,
  assignment_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  instruction_sequence INTEGER NOT NULL,
  candidate_revision TEXT,
  directive TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('prepared', 'submitted', 'ambiguous', 'observed', 'retry_authorized', 'rejected')),
  outcome_at INTEGER,
  retry_authorized_at INTEGER,
  outcome_source TEXT,
  outcome_result TEXT,
  external_identity TEXT,
  outcome_reason TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1)),
  steering_request TEXT,
  CHECK ((kind = 'steer' AND steering_request IS NOT NULL AND json_valid(steering_request)) OR
    (kind != 'steer' AND steering_request IS NULL))
);

INSERT INTO operations_v6 SELECT *, NULL FROM operations;
CREATE TABLE operation_findings_v6 (
  operation_id TEXT NOT NULL REFERENCES operations_v6(id),
  finding_id TEXT NOT NULL,
  PRIMARY KEY (operation_id, finding_id)
);
INSERT INTO operation_findings_v6 SELECT * FROM operation_findings;
DROP TABLE operation_findings;
DROP TABLE operations;
ALTER TABLE operations_v6 RENAME TO operations;
ALTER TABLE operation_findings_v6 RENAME TO operation_findings;
CREATE INDEX operations_by_commission_state ON operations(commission_id, outcome_kind, created_at);
