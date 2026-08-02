ALTER TABLE samurai_persistence.deletion_tombstones
  DROP CONSTRAINT deletion_tombstones_kind_check,
  DROP CONSTRAINT deletion_tombstones_resume_identity_check;

ALTER TABLE samurai_persistence.deletion_tombstones
  ADD COLUMN capability_key_purpose text,
  ADD COLUMN capability_key_version integer CHECK (capability_key_version > 0),
  ADD COLUMN capability_key_identity bytea CHECK (octet_length(capability_key_identity) = 32),
  ADD CONSTRAINT deletion_tombstones_kind_check CHECK (kind IN (
    'guest-session', 'command', 'save-export', 'save-import',
    'guest-claim', 'claim-challenge', 'claim-id', 'claim-idempotency',
    'player-session', 'wallet-credential'
  )),
  ADD CONSTRAINT deletion_tombstones_capability_identity_check CHECK (
    (kind = 'guest-session'
      AND resume_digest_key_version IS NOT NULL
      AND resume_digest_key_identity IS NOT NULL
      AND capability_key_purpose IS NULL
      AND capability_key_version IS NULL
      AND capability_key_identity IS NULL)
    OR
    (kind = 'guest-claim'
      AND resume_digest_key_version IS NULL
      AND resume_digest_key_identity IS NULL
      AND capability_key_purpose = 'guest-claim'
      AND capability_key_version IS NOT NULL
      AND capability_key_identity IS NOT NULL)
    OR
    (kind = 'player-session'
      AND resume_digest_key_version IS NULL
      AND resume_digest_key_identity IS NULL
      AND capability_key_purpose = 'player-session'
      AND capability_key_version IS NOT NULL
      AND capability_key_identity IS NOT NULL)
    OR
    (kind IN (
      'command', 'save-export', 'save-import', 'claim-challenge',
      'claim-id', 'claim-idempotency', 'wallet-credential'
    )
      AND resume_digest_key_version IS NULL
      AND resume_digest_key_identity IS NULL
      AND capability_key_purpose IS NULL
      AND capability_key_version IS NULL
      AND capability_key_identity IS NULL)
  );

CREATE TABLE samurai_persistence.guest_claim_capabilities (
  guest_session_id text PRIMARY KEY REFERENCES samurai_persistence.guest_sessions(id) ON DELETE RESTRICT,
  digest_key_version integer NOT NULL CHECK (digest_key_version > 0),
  digest_key_identity bytea NOT NULL CHECK (octet_length(digest_key_identity) = 32),
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  UNIQUE (digest_key_version, digest_key_identity, digest),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '30 days')
);

CREATE TABLE samurai_persistence.players (
  id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'active' CHECK (state = 'active'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  CHECK (length(id) BETWEEN 16 AND 128),
  CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$'),
  CHECK (updated_at >= created_at)
);

CREATE TABLE samurai_persistence.player_progress (
  player_id text PRIMARY KEY REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision BETWEEN 0 AND 9007199254740991),
  content_version text NOT NULL,
  checkpoint_schema_version integer NOT NULL CHECK (checkpoint_schema_version > 0),
  checkpoint jsonb NOT NULL CHECK (jsonb_typeof(checkpoint) = 'object'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  updated_at timestamptz NOT NULL CHECK (isfinite(updated_at)),
  CHECK (updated_at >= created_at)
);

CREATE TABLE samurai_persistence.wallet_credentials (
  credential_id uuid PRIMARY KEY,
  player_id text NOT NULL REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  chain_id text NOT NULL,
  account text NOT NULL,
  public_key text NOT NULL,
  scheme text NOT NULL CHECK (scheme IN ('tz1', 'tz2', 'tz3', 'tz4')),
  linked_claim_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state = 'active'),
  linked_at timestamptz NOT NULL CHECK (isfinite(linked_at)),
  UNIQUE (chain_id, account),
  UNIQUE (linked_claim_id),
  UNIQUE (player_id, chain_id, account),
  CHECK (credential_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (linked_claim_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (chain_id ~ '^Net[1-9A-HJ-NP-Za-km-z]{12}$'),
  CHECK (account ~ '^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$'),
  CHECK (
    (scheme = 'tz1' AND account LIKE 'tz1%' AND public_key ~ '^edpk[1-9A-HJ-NP-Za-km-z]{50}$') OR
    (scheme = 'tz2' AND account LIKE 'tz2%' AND public_key ~ '^sppk[1-9A-HJ-NP-Za-km-z]{51}$') OR
    (scheme = 'tz3' AND account LIKE 'tz3%' AND public_key ~ '^p2pk[1-9A-HJ-NP-Za-km-z]{51}$') OR
    (scheme = 'tz4' AND account LIKE 'tz4%' AND public_key ~ '^BLpk[1-9A-HJ-NP-Za-km-z]{72}$')
  )
);

CREATE TABLE samurai_persistence.player_sessions (
  id uuid PRIMARY KEY,
  player_id text NOT NULL REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  issuance_kind text NOT NULL CHECK (issuance_kind = 'claim'),
  issuance_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('pending-delivery', 'active', 'revoked')),
  delivery_generation bigint NOT NULL CHECK (delivery_generation > 0),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  last_seen_at timestamptz NOT NULL CHECK (isfinite(last_seen_at)),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  rotate_after timestamptz NOT NULL CHECK (isfinite(rotate_after)),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR isfinite(revoked_at)),
  UNIQUE (player_id, issuance_kind, issuance_id),
  UNIQUE (player_id, issuance_kind, issuance_id, id),
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (issuance_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (last_seen_at >= created_at),
  CHECK (last_seen_at <= expires_at),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (rotate_after > created_at AND rotate_after <= expires_at),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE INDEX player_sessions_expiry
  ON samurai_persistence.player_sessions (expires_at, id);

CREATE INDEX player_sessions_idle
  ON samurai_persistence.player_sessions (last_seen_at, id);

CREATE TABLE samurai_persistence.player_session_digests (
  player_session_id uuid NOT NULL REFERENCES samurai_persistence.player_sessions(id) ON DELETE CASCADE,
  slot text NOT NULL CHECK (slot IN ('current', 'predecessor')),
  digest_key_version integer NOT NULL CHECK (digest_key_version > 0),
  digest_key_identity bytea NOT NULL CHECK (octet_length(digest_key_identity) = 32),
  digest bytea NOT NULL CHECK (octet_length(digest) = 32),
  valid_until timestamptz,
  PRIMARY KEY (player_session_id, slot),
  UNIQUE (digest_key_version, digest_key_identity, digest),
  CHECK (
    (slot = 'current' AND valid_until IS NULL) OR
    (slot = 'predecessor' AND valid_until IS NOT NULL AND isfinite(valid_until))
  )
);

CREATE INDEX player_session_digests_lookup
  ON samurai_persistence.player_session_digests (digest_key_version, digest_key_identity, digest);

CREATE TABLE samurai_persistence.claim_challenges (
  challenge_id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('claim', 'recovery', 'delete')),
  guest_session_id text REFERENCES samurai_persistence.guest_sessions(id) ON DELETE RESTRICT,
  claim_id uuid NOT NULL,
  nonce_digest bytea NOT NULL UNIQUE CHECK (octet_length(nonce_digest) = 32),
  challenge_hash bytea NOT NULL UNIQUE CHECK (octet_length(challenge_hash) = 32),
  intent_hash bytea NOT NULL CHECK (octet_length(intent_hash) = 32),
  issued_at timestamptz NOT NULL CHECK (isfinite(issued_at)),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  consumed_at timestamptz CHECK (consumed_at IS NULL OR isfinite(consumed_at)),
  consumed_claim_id uuid,
  CHECK (challenge_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (claim_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (consumed_claim_id IS NULL OR consumed_claim_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (expires_at = issued_at + interval '5 minutes'),
  CHECK ((consumed_at IS NULL) = (consumed_claim_id IS NULL)),
  CHECK (consumed_claim_id IS NULL OR consumed_claim_id = claim_id),
  CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at)),
  CHECK (
    (purpose = 'claim' AND ((consumed_at IS NULL AND guest_session_id IS NOT NULL) OR
                            (consumed_at IS NOT NULL AND guest_session_id IS NULL))) OR
    (purpose IN ('recovery', 'delete') AND guest_session_id IS NULL)
  )
);

CREATE INDEX claim_challenges_guest
  ON samurai_persistence.claim_challenges (guest_session_id, expires_at, challenge_id)
  WHERE guest_session_id IS NOT NULL;

CREATE INDEX claim_challenges_expiry
  ON samurai_persistence.claim_challenges (expires_at, challenge_id);

CREATE TABLE samurai_persistence.progress_merges (
  claim_id uuid PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  request_hash bytea NOT NULL UNIQUE CHECK (octet_length(request_hash) = 32),
  claim_intent_hash bytea NOT NULL UNIQUE CHECK (octet_length(claim_intent_hash) = 32),
  challenge_hash bytea NOT NULL UNIQUE CHECK (octet_length(challenge_hash) = 32),
  guest_origin_commitment bytea NOT NULL UNIQUE CHECK (octet_length(guest_origin_commitment) = 32),
  player_id text NOT NULL REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  create_player boolean NOT NULL,
  target_player_id text REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  guest_revision bigint NOT NULL CHECK (guest_revision BETWEEN 0 AND 9007199254740991),
  player_revision_before bigint CHECK (
    player_revision_before IS NULL OR player_revision_before BETWEEN 0 AND 9007199254740991
  ),
  player_revision_after bigint NOT NULL CHECK (player_revision_after BETWEEN 0 AND 9007199254740991),
  content_version text NOT NULL,
  cosmetic_selections jsonb NOT NULL CHECK (jsonb_typeof(cosmetic_selections) = 'object'),
  session_id uuid NOT NULL UNIQUE,
  session_issuance_kind text NOT NULL DEFAULT 'claim' CHECK (session_issuance_kind = 'claim'),
  session_issuance_id uuid NOT NULL,
  result_hash bytea NOT NULL CHECK (octet_length(result_hash) = 32),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  CHECK (claim_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (session_issuance_id = claim_id),
  FOREIGN KEY (player_id, session_issuance_kind, session_issuance_id, session_id)
    REFERENCES samurai_persistence.player_sessions (player_id, issuance_kind, issuance_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '30 days'),
  CHECK (
    (create_player AND target_player_id IS NULL AND player_revision_before IS NULL AND player_revision_after = 0) OR
    (NOT create_player AND target_player_id = player_id AND player_revision_before IS NOT NULL
      AND player_revision_after = player_revision_before + 1)
  )
);

ALTER TABLE samurai_persistence.command_receipts
  DROP CONSTRAINT command_receipts_pkey,
  ADD COLUMN player_id text REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  ADD COLUMN origin_claim_id uuid,
  ALTER COLUMN guest_session_id DROP NOT NULL,
  ADD COLUMN subject_kind text GENERATED ALWAYS AS (
    CASE WHEN guest_session_id IS NOT NULL THEN 'guest' ELSE 'player' END
  ) STORED,
  ADD COLUMN subject_id text GENERATED ALWAYS AS (COALESCE(guest_session_id, player_id)) STORED,
  ADD CONSTRAINT command_receipts_subject_check CHECK (
    (guest_session_id IS NOT NULL AND player_id IS NULL AND origin_claim_id IS NULL) OR
    (guest_session_id IS NULL AND player_id IS NOT NULL)
  ),
  ADD PRIMARY KEY (subject_kind, subject_id, idempotency_key);

ALTER TABLE samurai_persistence.domain_events
  ADD COLUMN player_id text REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  ADD COLUMN origin_claim_id uuid,
  ALTER COLUMN guest_session_id DROP NOT NULL,
  DROP CONSTRAINT domain_events_guest_session_id_committed_revision_key,
  ADD COLUMN subject_kind text GENERATED ALWAYS AS (
    CASE WHEN guest_session_id IS NOT NULL THEN 'guest' ELSE 'player' END
  ) STORED,
  ADD COLUMN subject_id text GENERATED ALWAYS AS (COALESCE(guest_session_id, player_id)) STORED,
  ADD CONSTRAINT domain_events_subject_check CHECK (
    (guest_session_id IS NOT NULL AND player_id IS NULL AND origin_claim_id IS NULL) OR
    (guest_session_id IS NULL AND player_id IS NOT NULL)
  );

CREATE UNIQUE INDEX domain_events_guest_revision
  ON samurai_persistence.domain_events (guest_session_id, committed_revision)
  WHERE guest_session_id IS NOT NULL;

CREATE UNIQUE INDEX domain_events_player_native_revision
  ON samurai_persistence.domain_events (player_id, committed_revision)
  WHERE player_id IS NOT NULL AND origin_claim_id IS NULL;

CREATE UNIQUE INDEX domain_events_claim_origin
  ON samurai_persistence.domain_events (player_id, origin_claim_id, event_id)
  WHERE player_id IS NOT NULL AND origin_claim_id IS NOT NULL;
