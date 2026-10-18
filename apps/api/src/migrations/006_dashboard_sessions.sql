CREATE TABLE dashboard_sessions (
    id text PRIMARY KEY,
    csrf_token text NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE TABLE dashboard_notices (
    id text PRIMARY KEY,
    session_id text NOT NULL REFERENCES dashboard_sessions (id) ON DELETE CASCADE,
    payload jsonb NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE INDEX dashboard_notices_expires_at_idx
    ON dashboard_notices (expires_at);
