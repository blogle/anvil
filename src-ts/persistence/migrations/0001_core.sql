CREATE TABLE commissions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  repository TEXT NOT NULL,
  integration_target TEXT NOT NULL,
  specification_generation INTEGER NOT NULL CHECK (specification_generation > 0),
  independent_review_required INTEGER NOT NULL CHECK (independent_review_required IN (0, 1)),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('proposed', 'admitted', 'active', 'held', 'concluded')),
  hold_reason TEXT,
  owner_controller_id TEXT,
  owner_epoch INTEGER,
  version INTEGER NOT NULL CHECK (version >= 0),
  active_attempt_id TEXT,
  max_attempts INTEGER NOT NULL,
  max_instructions INTEGER NOT NULL,
  max_repairs INTEGER NOT NULL,
  max_cost_micros INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  attempts_used INTEGER NOT NULL,
  instructions_used INTEGER NOT NULL,
  repairs_used INTEGER NOT NULL,
  cost_used_micros INTEGER NOT NULL,
  candidate_revision TEXT,
  candidate_observed_at INTEGER,
  candidate_expires_at INTEGER,
  candidate_source TEXT,
  delivered_revision TEXT,
  delivered_provider_identity TEXT,
  delivered_source TEXT,
  delivered_observed_at INTEGER,
  delivered_expires_at INTEGER,
  delivered_check_run_id TEXT,
  delivered_specification_generation INTEGER,
  CHECK ((owner_controller_id IS NULL) = (owner_epoch IS NULL)),
  CHECK ((candidate_revision IS NULL) = (candidate_observed_at IS NULL)),
  CHECK ((candidate_revision IS NULL) = (candidate_expires_at IS NULL)),
  CHECK ((candidate_revision IS NULL) = (candidate_source IS NULL)),
  CHECK ((delivered_revision IS NULL) = (delivered_provider_identity IS NULL)),
  CHECK ((delivered_revision IS NULL) = (delivered_source IS NULL)),
  CHECK ((delivered_revision IS NULL) = (delivered_observed_at IS NULL)),
  CHECK ((delivered_revision IS NULL) = (delivered_expires_at IS NULL)),
  CHECK ((delivered_revision IS NULL) = (delivered_check_run_id IS NULL)),
  CHECK ((delivered_revision IS NULL) = (delivered_specification_generation IS NULL))
);

CREATE TABLE obligations (
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  specification_generation INTEGER NOT NULL,
  id TEXT NOT NULL,
  description TEXT NOT NULL,
  independent_review_required INTEGER NOT NULL CHECK (independent_review_required IN (0, 1)),
  PRIMARY KEY (commission_id, specification_generation, id)
);

CREATE TABLE attempts (
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  id TEXT NOT NULL,
  assignment_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  strategy TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'superseded', 'completed')),
  next_instruction_sequence INTEGER NOT NULL,
  PRIMARY KEY (commission_id, id),
  UNIQUE (commission_id, assignment_id, ordinal)
);

CREATE TABLE evidence (
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  id TEXT NOT NULL,
  obligation_id TEXT NOT NULL,
  specification_generation INTEGER NOT NULL,
  candidate_revision TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('worker', 'independent')),
  source_identity TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('submitted', 'accepted', 'challenged')),
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claim TEXT NOT NULL,
  check_run_id TEXT,
  PRIMARY KEY (commission_id, id)
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  logical_key TEXT NOT NULL UNIQUE,
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  kind TEXT NOT NULL CHECK (kind IN ('continue', 'repair', 'refresh_context', 'change_strategy', 'verify', 'integrate')),
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
  outcome_reason TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1))
);

CREATE INDEX operations_by_commission_state ON operations(commission_id, outcome_kind, created_at);
CREATE INDEX evidence_by_criterion ON evidence(commission_id, specification_generation, obligation_id, candidate_revision);

CREATE TABLE operation_findings (
  operation_id TEXT NOT NULL REFERENCES operations(id),
  finding_id TEXT NOT NULL,
  PRIMARY KEY (operation_id, finding_id)
);
