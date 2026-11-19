ALTER TABLE attempts ADD COLUMN done_claimed_at INTEGER;

CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    created_at INTEGER NOT NULL
);
CREATE INDEX tokens_commission ON tokens(commission_id);
