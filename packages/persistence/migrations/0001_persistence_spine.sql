CREATE TABLE samurai_persistence.guest_sessions (
  id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'active' CHECK (state = 'active'),
  consent_version text NOT NULL,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  rotate_after timestamptz NOT NULL,
  CHECK (length(id) BETWEEN 22 AND 128),
  CHECK (last_seen_at >= created_at),
  CHECK (expires_at > created_at),
  CHECK (rotate_after > created_at AND rotate_after <= expires_at)
);

CREATE TABLE samurai_persistence.guest_resume_digests (
  guest_session_id text NOT NULL REFERENCES samurai_persistence.guest_sessions(id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('current', 'predecessor')),
  digest_key_version integer NOT NULL CHECK (digest_key_version > 0),
  digest_key_identity bytea NOT NULL CHECK (octet_length(digest_key_identity) = 32),
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  valid_until timestamptz,
  PRIMARY KEY (guest_session_id, slot),
  UNIQUE (digest_key_version, digest_key_identity, digest),
  CHECK (
    (slot = 'current' AND valid_until IS NULL) OR
    (slot = 'predecessor' AND valid_until IS NOT NULL)
  )
);

CREATE INDEX guest_resume_digests_lookup
  ON samurai_persistence.guest_resume_digests (digest_key_version, digest_key_identity, digest);

CREATE TABLE samurai_persistence.guest_progress (
  guest_session_id text PRIMARY KEY REFERENCES samurai_persistence.guest_sessions(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  content_version text NOT NULL,
  checkpoint_schema_version integer NOT NULL CHECK (checkpoint_schema_version > 0),
  checkpoint jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (jsonb_typeof(checkpoint) = 'object'),
  CHECK (updated_at >= created_at)
);

CREATE TABLE samurai_persistence.command_receipts (
  guest_session_id text NOT NULL REFERENCES samurai_persistence.guest_sessions(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  command_name text NOT NULL,
  expected_revision bigint NOT NULL CHECK (expected_revision >= 0),
  content_version text NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  response_schema_version integer NOT NULL CHECK (response_schema_version > 0),
  response_payload jsonb NOT NULL,
  result_hash bytea NOT NULL CHECK (octet_length(result_hash) = 32),
  committed_revision bigint NOT NULL CHECK (committed_revision = expected_revision + 1),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (guest_session_id, idempotency_key),
  CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  CHECK (length(command_name) BETWEEN 1 AND 128),
  CHECK (expires_at > created_at)
);

CREATE TABLE samurai_persistence.domain_events (
  event_id text PRIMARY KEY,
  guest_session_id text NOT NULL REFERENCES samurai_persistence.guest_sessions(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  schema_version integer NOT NULL CHECK (schema_version > 0),
  payload jsonb NOT NULL,
  committed_revision bigint NOT NULL CHECK (committed_revision > 0),
  created_at timestamptz NOT NULL,
  UNIQUE (guest_session_id, committed_revision)
);

CREATE TABLE samurai_persistence.outbox_deliveries (
  event_id text PRIMARY KEY REFERENCES samurai_persistence.domain_events(event_id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'delivered', 'dead-letter')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL,
  last_attempt_at timestamptz,
  claim_token text,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation >= 0),
  claim_expires_at timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text,
  CHECK ((state = 'processing') = (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((state = 'dead-letter') = (dead_lettered_at IS NOT NULL)),
  CHECK (state = 'processing' OR (claim_token IS NULL AND claim_expires_at IS NULL)),
  CHECK (claim_token IS NULL OR length(claim_token) > 0),
  CHECK (
    state NOT IN ('processing', 'delivered', 'dead-letter') OR
    (attempt_count > 0 AND claim_generation > 0 AND last_attempt_at IS NOT NULL)
  ),
  CHECK (state <> 'processing' OR claim_expires_at > last_attempt_at),
  CHECK (state <> 'dead-letter' OR last_error_code IS NOT NULL),
  CHECK (
    state <> 'pending' OR
    (attempt_count = 0 AND claim_generation = 0 AND last_attempt_at IS NULL) OR
    (attempt_count > 0 AND claim_generation > 0 AND last_attempt_at IS NOT NULL)
  ),
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,127}$')
);

CREATE INDEX outbox_deliveries_claimable
  ON samurai_persistence.outbox_deliveries (available_at, event_id)
  WHERE state IN ('pending', 'processing');

CREATE TABLE samurai_persistence.deletion_tombstones (
  kind text NOT NULL CHECK (kind IN ('guest-session', 'command')),
  digest_key_version integer NOT NULL CHECK (digest_key_version > 0),
  digest_key_identity bytea NOT NULL CHECK (octet_length(digest_key_identity) = 32),
  tombstone_digest bytea NOT NULL CHECK (octet_length(tombstone_digest) = 32),
  resume_digest_key_version integer CHECK (resume_digest_key_version > 0),
  resume_digest_key_identity bytea CHECK (octet_length(resume_digest_key_identity) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (kind, digest_key_version, digest_key_identity, tombstone_digest),
  CHECK (
    (kind = 'guest-session' AND resume_digest_key_version IS NOT NULL AND resume_digest_key_identity IS NOT NULL) OR
    (kind = 'command' AND resume_digest_key_version IS NULL AND resume_digest_key_identity IS NULL)
  ),
  CHECK (expires_at > created_at)
);

CREATE INDEX deletion_tombstones_expiry
  ON samurai_persistence.deletion_tombstones (expires_at);
