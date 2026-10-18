DELETE FROM dashboard_notices;

ALTER TABLE dashboard_notices
  ADD CONSTRAINT dashboard_notices_no_token
  CHECK (
    jsonb_typeof(payload) = 'object'
    AND NOT (payload ? 'token')
  );

ALTER TABLE agents
  ADD COLUMN pending_token_hash bytea,
  ADD CONSTRAINT agents_pending_token_hash_len
    CHECK (
      pending_token_hash IS NULL
      OR octet_length(pending_token_hash) = 32
    );

CREATE UNIQUE INDEX agents_pending_token_hash_unique
  ON agents (pending_token_hash)
  WHERE pending_token_hash IS NOT NULL;
