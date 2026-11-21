CREATE INDEX commissions_terminal_updated
    ON commissions(state, updated_at)
    WHERE state IN ('cancelled', 'merged');
