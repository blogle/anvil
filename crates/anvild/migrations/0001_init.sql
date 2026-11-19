CREATE TABLE campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    context TEXT NOT NULL DEFAULT '',
    strategy TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);

CREATE TABLE commissions (
    id TEXT PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    title TEXT NOT NULL,
    slug TEXT NOT NULL,
    repo TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    target_sha TEXT NOT NULL,
    wave INTEGER NOT NULL,
    state TEXT NOT NULL,
    state_detail TEXT,
    budget TEXT NOT NULL DEFAULT '{}',
    strategy TEXT NOT NULL DEFAULT '{}',
    branch TEXT NOT NULL DEFAULT '',
    pr_number INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX commissions_campaign ON commissions(campaign_id);
CREATE INDEX commissions_state ON commissions(state);

CREATE TABLE obligations (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    position INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(commission_id, position)
);

CREATE TABLE attempts (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    n INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    ended_at INTEGER,
    tokens INTEGER,
    outcome TEXT,
    UNIQUE(commission_id, n)
);

CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    prompt_hash TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    tokens INTEGER,
    result TEXT
);

CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    campaign_id TEXT,
    commission_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX events_commission ON events(commission_id);

CREATE TABLE attention (
    id TEXT PRIMARY KEY,
    commission_id TEXT NOT NULL REFERENCES commissions(id),
    kind TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX attention_state ON attention(state);

CREATE TABLE config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE credentials (
    name TEXT PRIMARY KEY,
    secret TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
