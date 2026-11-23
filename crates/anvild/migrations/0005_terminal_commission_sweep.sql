ALTER TABLE commissions ADD COLUMN sandbox_destroyed_at INTEGER;

CREATE INDEX commissions_pending_sandbox_teardown
    ON commissions(state, updated_at)
    WHERE state IN ('cancelled', 'merged') AND sandbox_destroyed_at IS NULL;
