CREATE TABLE idempotency (
    key TEXT PRIMARY KEY,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
