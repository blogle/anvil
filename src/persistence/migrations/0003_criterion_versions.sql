ALTER TABLE evidence ADD COLUMN criterion_version TEXT NOT NULL DEFAULT '';

CREATE INDEX evidence_by_applicability
  ON evidence(commission_id, obligation_id, criterion_version, candidate_revision);
