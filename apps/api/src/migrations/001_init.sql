CREATE TABLE agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_seen_at timestamptz,
  CONSTRAINT agents_name_unique UNIQUE (name),
  CONSTRAINT agents_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT agents_name_length CHECK (char_length(name) BETWEEN 1 AND 64),
  CONSTRAINT agents_name_pattern CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9_-]*$'),
  CONSTRAINT agents_token_hash_len CHECK (octet_length(token_hash) = 32)
);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent uuid NOT NULL REFERENCES agents (id),
  to_agent uuid REFERENCES agents (id),
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at timestamptz,
  CONSTRAINT messages_body_nonempty CHECK (octet_length(body) > 0),
  CONSTRAINT messages_body_size CHECK (octet_length(body) <= 8192),
  CONSTRAINT messages_not_self CHECK (to_agent IS NULL OR to_agent <> from_agent)
);

CREATE TABLE message_receipts (
  message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents (id),
  read_at timestamptz,
  PRIMARY KEY (message_id, agent_id)
);

CREATE INDEX message_receipts_agent_id_idx ON message_receipts (agent_id);
