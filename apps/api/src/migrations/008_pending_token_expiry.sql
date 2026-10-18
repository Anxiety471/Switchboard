ALTER TABLE agents
  ADD COLUMN pending_expires_at timestamptz;

UPDATE agents
SET pending_expires_at = clock_timestamp() + interval '120 seconds'
WHERE pending_token_hash IS NOT NULL;

ALTER TABLE agents
  ADD CONSTRAINT agents_pending_token_expiry
  CHECK (
    (
      pending_token_hash IS NULL
      AND pending_expires_at IS NULL
    )
    OR (
      pending_token_hash IS NOT NULL
      AND pending_expires_at IS NOT NULL
    )
  );
