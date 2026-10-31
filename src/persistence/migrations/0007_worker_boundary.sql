ALTER TABLE commissions ADD COLUMN workspace_writer TEXT;
UPDATE commissions SET workspace_writer = (
  SELECT json_object('kind','owned','controllerId',controller_id,'epoch',owner_epoch,'operationId',id,
    'assignmentId', assignment_id,
    'workspaceId', (SELECT external_identity FROM operations p WHERE p.commission_id = commissions.id AND p.kind = 'provision_sandbox' AND p.outcome_kind = 'observed' AND p.outcome_result = 'applied' LIMIT 1),
    'sessionId', (SELECT external_identity FROM operations s WHERE s.commission_id = commissions.id AND s.kind = 'create_session' AND s.outcome_kind = 'observed' AND s.outcome_result = 'applied' LIMIT 1))
  FROM operations WHERE commission_id = commissions.id
    AND kind NOT IN ('verify','integrate') AND outcome_kind NOT IN ('prepared','rejected')
  ORDER BY created_at, id LIMIT 1
);
UPDATE commissions SET workspace_writer = json_set(workspace_writer, '$.kind', 'unresolved') WHERE (
  SELECT COUNT(DISTINCT external_identity) FROM operations WHERE commission_id = commissions.id AND kind = 'create_session' AND outcome_kind = 'observed' AND outcome_result = 'applied'
) > 1 OR (
  SELECT COUNT(DISTINCT external_identity) FROM operations WHERE commission_id = commissions.id AND kind = 'provision_sandbox' AND outcome_kind = 'observed' AND outcome_result = 'applied'
) > 1 OR (
  SELECT COUNT(DISTINCT assignment_id) FROM operations WHERE commission_id = commissions.id
    AND kind NOT IN ('verify','integrate') AND outcome_kind NOT IN ('prepared','rejected')
) > 1;
DROP INDEX operations_by_commission_state;
CREATE TABLE operations_v7 (
  id TEXT PRIMARY KEY, logical_key TEXT NOT NULL UNIQUE,
  commission_id TEXT NOT NULL REFERENCES commissions(id),
  kind TEXT NOT NULL CHECK (kind IN ('bootstrap_worker','steer','provision_sandbox','create_session','interrupt','continue','repair','refresh_context','change_strategy','verify','integrate')),
  target TEXT NOT NULL, controller_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL,
  specification_generation INTEGER NOT NULL, assignment_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
  instruction_sequence INTEGER NOT NULL, candidate_revision TEXT, directive TEXT NOT NULL, created_at INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count BETWEEN 0 AND 1),
  outcome_kind TEXT NOT NULL CHECK (outcome_kind IN ('prepared','submitted','ambiguous','observed','retry_authorized','rejected')),
  outcome_at INTEGER, retry_authorized_at INTEGER, outcome_source TEXT, outcome_result TEXT,
  external_identity TEXT, outcome_reason TEXT, retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0,1)),
  steering_request TEXT,
  CHECK ((kind = 'steer' AND steering_request IS NOT NULL AND json_valid(steering_request)) OR (kind != 'steer' AND steering_request IS NULL))
);
INSERT INTO operations_v7 SELECT * FROM operations;
CREATE TABLE operation_findings_v7 (operation_id TEXT NOT NULL REFERENCES operations_v7(id), finding_id TEXT NOT NULL, PRIMARY KEY(operation_id,finding_id));
INSERT INTO operation_findings_v7 SELECT * FROM operation_findings;
DROP TABLE operation_findings;
DROP TABLE operations;
ALTER TABLE operations_v7 RENAME TO operations;
ALTER TABLE operation_findings_v7 RENAME TO operation_findings;
CREATE INDEX operations_by_commission_state ON operations(commission_id,outcome_kind,created_at);
