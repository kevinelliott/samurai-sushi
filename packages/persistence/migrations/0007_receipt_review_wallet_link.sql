ALTER TABLE samurai_persistence.wallet_credentials
  DROP CONSTRAINT wallet_credentials_state_check,
  DROP CONSTRAINT wallet_credentials_chain_id_account_key,
  DROP CONSTRAINT wallet_credentials_player_id_chain_id_account_key,
  ADD COLUMN credential_revision bigint NOT NULL DEFAULT 1 CHECK (credential_revision BETWEEN 1 AND 9007199254740991),
  ADD COLUMN updated_at timestamptz DEFAULT clock_timestamp(),
  ADD COLUMN revoked_at timestamptz;

UPDATE samurai_persistence.wallet_credentials SET updated_at = linked_at WHERE updated_at IS NULL;

ALTER TABLE samurai_persistence.wallet_credentials
  ALTER COLUMN updated_at SET NOT NULL,
  ADD CONSTRAINT wallet_credentials_state_check CHECK (state IN ('active','revoked')),
  ADD CONSTRAINT wallet_credentials_state_time_check CHECK (
    updated_at IS NOT NULL AND isfinite(updated_at) AND updated_at >= linked_at
    AND ((state = 'active' AND revoked_at IS NULL)
      OR (state = 'revoked' AND revoked_at IS NOT NULL AND isfinite(revoked_at) AND revoked_at = updated_at))
  ),
  ADD UNIQUE (credential_id, player_id, chain_id, account);

CREATE UNIQUE INDEX wallet_credentials_active_chain_account
  ON samurai_persistence.wallet_credentials (chain_id, account) WHERE state = 'active';

CREATE UNIQUE INDEX wallet_credentials_active_player_chain_account
  ON samurai_persistence.wallet_credentials (player_id, chain_id, account) WHERE state = 'active';

CREATE FUNCTION samurai_persistence.reject_wallet_credential_identity_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_id IS DISTINCT FROM OLD.credential_id
    OR NEW.player_id IS DISTINCT FROM OLD.player_id
    OR NEW.chain_id IS DISTINCT FROM OLD.chain_id
    OR NEW.account IS DISTINCT FROM OLD.account
    OR NEW.public_key IS DISTINCT FROM OLD.public_key
    OR NEW.scheme IS DISTINCT FROM OLD.scheme
    OR NEW.linked_claim_id IS DISTINCT FROM OLD.linked_claim_id
    OR NEW.linked_at IS DISTINCT FROM OLD.linked_at THEN
    RAISE EXCEPTION 'wallet credential identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER wallet_credential_identity_immutable
BEFORE UPDATE OF credential_id, player_id, chain_id, account, public_key, scheme, linked_claim_id, linked_at
ON samurai_persistence.wallet_credentials
FOR EACH ROW EXECUTE FUNCTION samurai_persistence.reject_wallet_credential_identity_change();

ALTER TABLE samurai_persistence.player_sessions
  ADD UNIQUE (player_id, id, delivery_generation);

CREATE TABLE samurai_persistence.wallet_runtime_links (
  id uuid PRIMARY KEY,
  public_link_ref text NOT NULL UNIQUE,
  player_id text NOT NULL REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  player_session_id uuid NOT NULL,
  player_session_delivery_generation bigint NOT NULL CHECK (player_session_delivery_generation > 0),
  credential_id uuid,
  linked_challenge_id uuid,
  linked_challenge_state text CHECK (linked_challenge_state IS NULL OR linked_challenge_state IN ('ISSUED','CONSUMED','EXPIRED','REVOKED')),
  chain_id text NOT NULL CHECK (chain_id ~ '^Net[1-9A-HJ-NP-Za-km-z]{12}$'),
  account text NOT NULL CHECK (account ~ '^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$'),
  provider_id text NOT NULL CHECK (provider_id IN ('localnet-wallet','deterministic-wallet')),
  permission_scopes text[] NOT NULL,
  permission_scope_digest bytea NOT NULL CHECK (octet_length(permission_scope_digest) = 32),
  runtime_generation bigint NOT NULL CHECK (runtime_generation BETWEEN 0 AND 9007199254740991),
  session_revision bigint NOT NULL CHECK (session_revision BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN (
    'UNLINKED','CONNECTING','PERMISSIONED','LINKED_EXISTING','CHALLENGE_ISSUED','PROOF_PENDING','LINKED',
    'REJECTED','CANCELLED','EXPIRED','STALE','DISCONNECTED','REVOKED'
  )),
  terminal_reason text CHECK (terminal_reason IS NULL OR terminal_reason IN (
    'ACCOUNT_PROOF_UNAVAILABLE','PROVIDER_REJECTED','PROVIDER_CANCELLED','WRONG_NETWORK','ACCOUNT_CHANGED',
    'PERMISSION_CHANGED','PROVIDER_CHANGED','RUNTIME_CONTRADICTION','CHALLENGE_EXPIRED','PROVIDER_DISCONNECTED',
    'SESSION_REVOKED','CREDENTIAL_REVOKED'
  )),
  normalized_facts_digest bytea NOT NULL CHECK (octet_length(normalized_facts_digest) = 32),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  request_hash bytea NOT NULL UNIQUE CHECK (octet_length(request_hash) = 32),
  result_hash bytea NOT NULL CHECK (octet_length(result_hash) = 32),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  changed_at timestamptz NOT NULL CHECK (isfinite(changed_at)),
  disconnected_at timestamptz CHECK (disconnected_at IS NULL OR isfinite(disconnected_at)),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR isfinite(revoked_at)),
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (public_link_ref ~ '^wl_[A-Za-z0-9_-]{22}$'),
  CHECK (permission_scopes = ARRAY['account']::text[]),
  CHECK (changed_at >= created_at),
  CHECK (state IN ('DISCONNECTED','REVOKED','EXPIRED','REJECTED','CANCELLED')
    OR (runtime_generation < 9007199254740991 AND session_revision < 9007199254740991)),
  CHECK (
    (state IN ('UNLINKED','CONNECTING') AND credential_id IS NULL AND linked_challenge_id IS NULL AND linked_challenge_state IS NULL AND terminal_reason IS NULL
      AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state = 'PERMISSIONED' AND credential_id IS NULL AND linked_challenge_id IS NULL AND linked_challenge_state IS NULL
      AND terminal_reason = 'ACCOUNT_PROOF_UNAVAILABLE' AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state = 'LINKED_EXISTING' AND credential_id IS NOT NULL AND linked_challenge_id IS NULL AND linked_challenge_state IS NULL
      AND terminal_reason IS NULL AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state IN ('CHALLENGE_ISSUED','PROOF_PENDING') AND credential_id IS NULL AND linked_challenge_id IS NOT NULL AND linked_challenge_state = 'ISSUED'
      AND terminal_reason IS NULL AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state = 'LINKED' AND credential_id IS NOT NULL AND linked_challenge_id IS NOT NULL AND linked_challenge_state = 'CONSUMED'
      AND terminal_reason IS NULL AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state = 'REJECTED' AND credential_id IS NULL AND linked_challenge_id IS NULL AND linked_challenge_state IS NULL AND terminal_reason = 'PROVIDER_REJECTED'
      AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state = 'CANCELLED' AND credential_id IS NULL AND linked_challenge_id IS NULL AND linked_challenge_state IS NULL AND terminal_reason = 'PROVIDER_CANCELLED'
      AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state = 'EXPIRED' AND credential_id IS NULL AND linked_challenge_id IS NOT NULL AND linked_challenge_state = 'EXPIRED' AND terminal_reason = 'CHALLENGE_EXPIRED'
      AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state = 'STALE' AND terminal_reason IN ('WRONG_NETWORK','ACCOUNT_CHANGED','PERMISSION_CHANGED','PROVIDER_CHANGED','RUNTIME_CONTRADICTION')
      AND ((credential_id IS NULL AND linked_challenge_id IS NULL AND linked_challenge_state IS NULL)
        OR (credential_id IS NOT NULL AND ((linked_challenge_id IS NULL AND linked_challenge_state IS NULL)
          OR (linked_challenge_id IS NOT NULL AND linked_challenge_state = 'CONSUMED'))))
      AND disconnected_at IS NULL AND revoked_at IS NULL)
    OR (state = 'DISCONNECTED' AND terminal_reason = 'PROVIDER_DISCONNECTED'
      AND ((credential_id IS NULL AND linked_challenge_id IS NULL AND linked_challenge_state IS NULL)
        OR (credential_id IS NOT NULL AND ((linked_challenge_id IS NULL AND linked_challenge_state IS NULL)
          OR (linked_challenge_id IS NOT NULL AND linked_challenge_state = 'CONSUMED'))))
      AND disconnected_at IS NOT NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND terminal_reason IN ('SESSION_REVOKED','CREDENTIAL_REVOKED')
      AND ((credential_id IS NULL AND linked_challenge_id IS NULL AND linked_challenge_state IS NULL)
        OR (credential_id IS NULL AND linked_challenge_id IS NOT NULL AND linked_challenge_state = 'REVOKED')
        OR (credential_id IS NOT NULL AND ((linked_challenge_id IS NULL AND linked_challenge_state IS NULL)
          OR (linked_challenge_id IS NOT NULL AND linked_challenge_state = 'CONSUMED'))))
      AND disconnected_at IS NULL AND revoked_at IS NOT NULL)
  ),
  CHECK (disconnected_at IS NULL OR disconnected_at = changed_at),
  CHECK (revoked_at IS NULL OR revoked_at = changed_at),
  FOREIGN KEY (player_id, player_session_id, player_session_delivery_generation)
    REFERENCES samurai_persistence.player_sessions (player_id, id, delivery_generation) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (credential_id, player_id, chain_id, account)
    REFERENCES samurai_persistence.wallet_credentials (credential_id, player_id, chain_id, account) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX wallet_runtime_links_current_subject
  ON samurai_persistence.wallet_runtime_links (player_id)
  WHERE state NOT IN ('DISCONNECTED','REVOKED','EXPIRED','REJECTED','CANCELLED');

CREATE INDEX wallet_runtime_links_session
  ON samurai_persistence.wallet_runtime_links (player_session_id, runtime_generation, session_revision);

ALTER TABLE samurai_persistence.wallet_runtime_links
  ADD UNIQUE (id, player_id),
  ADD UNIQUE (id, player_id, player_session_id, player_session_delivery_generation, chain_id, account, provider_id,
    permission_scope_digest, runtime_generation, session_revision);

CREATE TABLE samurai_persistence.wallet_link_challenges (
  challenge_id uuid PRIMARY KEY,
  public_challenge_ref text NOT NULL UNIQUE,
  wallet_link_id uuid NOT NULL REFERENCES samurai_persistence.wallet_runtime_links(id) ON DELETE CASCADE,
  player_id text NOT NULL REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  player_session_id uuid NOT NULL,
  player_session_delivery_generation bigint NOT NULL CHECK (player_session_delivery_generation > 0),
  credential_id uuid,
  purpose text NOT NULL CHECK (purpose = 'RECEIPT_WALLET_LINK'),
  canonical_origin text NOT NULL,
  chain_id text NOT NULL,
  account text NOT NULL,
  provider_id text NOT NULL,
  permission_scope_digest bytea NOT NULL CHECK (octet_length(permission_scope_digest) = 32),
  issued_runtime_generation bigint NOT NULL CHECK (issued_runtime_generation BETWEEN 0 AND 9007199254740991),
  runtime_generation bigint NOT NULL CHECK (runtime_generation BETWEEN 0 AND 9007199254740991),
  issued_session_revision bigint NOT NULL CHECK (issued_session_revision BETWEEN 0 AND 9007199254740991),
  session_revision bigint NOT NULL CHECK (session_revision BETWEEN 0 AND 9007199254740991),
  privacy_policy_version text NOT NULL CHECK (privacy_policy_version = 'receipt-wallet-privacy-v1'),
  nonce_digest bytea NOT NULL UNIQUE CHECK (octet_length(nonce_digest) = 32),
  challenge_hash bytea NOT NULL UNIQUE CHECK (octet_length(challenge_hash) = 32),
  public_challenge jsonb NOT NULL CHECK (jsonb_typeof(public_challenge) = 'object' AND octet_length(public_challenge::text) <= 4096),
  request_hash bytea NOT NULL UNIQUE CHECK (octet_length(request_hash) = 32),
  proof_hash bytea CHECK (proof_hash IS NULL OR octet_length(proof_hash) = 32),
  proof_idempotency_key text UNIQUE CHECK (proof_idempotency_key IS NULL OR length(proof_idempotency_key) BETWEEN 16 AND 128),
  proof_request_hash bytea UNIQUE CHECK (proof_request_hash IS NULL OR octet_length(proof_request_hash) = 32),
  result_hash bytea CHECK (result_hash IS NULL OR octet_length(result_hash) = 32),
  public_result jsonb CHECK (public_result IS NULL OR (jsonb_typeof(public_result) = 'object' AND octet_length(public_result::text) <= 4096)),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  state text NOT NULL CHECK (state IN ('ISSUED','CONSUMED','EXPIRED','REVOKED')),
  issued_at timestamptz NOT NULL CHECK (isfinite(issued_at)),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  consumed_at timestamptz CHECK (consumed_at IS NULL OR isfinite(consumed_at)),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR isfinite(revoked_at)),
  CHECK (challenge_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (public_challenge_ref ~ '^wc_[A-Za-z0-9_-]{22}$'),
  CHECK (expires_at = issued_at + interval '5 minutes'),
  CHECK (
    (state IN ('ISSUED','EXPIRED') AND credential_id IS NULL AND proof_hash IS NULL AND proof_idempotency_key IS NULL
      AND proof_request_hash IS NULL AND result_hash IS NULL AND public_result IS NULL AND consumed_at IS NULL AND revoked_at IS NULL)
    OR (state = 'REVOKED' AND credential_id IS NULL AND proof_hash IS NULL AND proof_idempotency_key IS NULL
      AND proof_request_hash IS NULL AND result_hash IS NULL AND public_result IS NULL AND consumed_at IS NULL AND revoked_at IS NOT NULL)
    OR (state = 'CONSUMED' AND credential_id IS NOT NULL AND proof_hash IS NOT NULL AND proof_idempotency_key IS NOT NULL
      AND proof_request_hash IS NOT NULL AND result_hash IS NOT NULL AND public_result IS NOT NULL
      AND consumed_at IS NOT NULL AND revoked_at IS NULL)
  ),
  CHECK (consumed_at IS NULL OR (consumed_at >= issued_at AND consumed_at < expires_at)),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at),
  FOREIGN KEY (player_id, player_session_id, player_session_delivery_generation)
    REFERENCES samurai_persistence.player_sessions (player_id, id, delivery_generation) ON UPDATE CASCADE ON DELETE CASCADE,
  FOREIGN KEY (credential_id, player_id, chain_id, account)
    REFERENCES samurai_persistence.wallet_credentials (credential_id, player_id, chain_id, account) ON DELETE RESTRICT,
  FOREIGN KEY (wallet_link_id, player_id, player_session_id, player_session_delivery_generation, chain_id, account, provider_id,
    permission_scope_digest, runtime_generation, session_revision)
    REFERENCES samurai_persistence.wallet_runtime_links (id, player_id, player_session_id, player_session_delivery_generation,
      chain_id, account, provider_id, permission_scope_digest, runtime_generation, session_revision)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE samurai_persistence.wallet_link_challenges
  ADD UNIQUE (challenge_id, wallet_link_id),
  ADD UNIQUE (challenge_id, wallet_link_id, state),
  ADD UNIQUE (challenge_id, wallet_link_id, credential_id, state);

ALTER TABLE samurai_persistence.wallet_runtime_links
  ADD FOREIGN KEY (linked_challenge_id, id)
    REFERENCES samurai_persistence.wallet_link_challenges (challenge_id, wallet_link_id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY (linked_challenge_id, id, linked_challenge_state)
    REFERENCES samurai_persistence.wallet_link_challenges (challenge_id, wallet_link_id, state)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  ADD FOREIGN KEY (linked_challenge_id, id, credential_id, linked_challenge_state)
    REFERENCES samurai_persistence.wallet_link_challenges (challenge_id, wallet_link_id, credential_id, state)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX wallet_link_challenges_expiry
  ON samurai_persistence.wallet_link_challenges (expires_at, challenge_id) WHERE state = 'ISSUED';

CREATE FUNCTION samurai_persistence.revoke_wallet_runtime_for_session_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  authority_now timestamptz := clock_timestamp();
BEGIN
  IF NEW.delivery_generation <> OLD.delivery_generation OR NEW.state IN ('pending-delivery','revoked') THEN
    UPDATE samurai_persistence.wallet_link_challenges
       SET state='REVOKED', revoked_at=authority_now
     WHERE player_session_id=OLD.id AND state='ISSUED';
    UPDATE samurai_persistence.wallet_link_challenges c
       SET runtime_generation=CASE WHEN c.runtime_generation < 9007199254740991 THEN c.runtime_generation+1 ELSE c.runtime_generation END,
           session_revision=CASE WHEN c.session_revision < 9007199254740991 THEN c.session_revision+1 ELSE c.session_revision END
      FROM samurai_persistence.wallet_runtime_links l
     WHERE c.wallet_link_id=l.id AND l.player_session_id=OLD.id AND l.state <> 'REVOKED';
    UPDATE samurai_persistence.wallet_runtime_links
       SET state='REVOKED', terminal_reason='SESSION_REVOKED',
           runtime_generation=CASE WHEN runtime_generation < 9007199254740991 THEN runtime_generation+1 ELSE runtime_generation END,
           session_revision=CASE WHEN session_revision < 9007199254740991 THEN session_revision+1 ELSE session_revision END,
           linked_challenge_state=CASE WHEN linked_challenge_id IS NULL THEN NULL ELSE
             (SELECT state FROM samurai_persistence.wallet_link_challenges c WHERE c.challenge_id=linked_challenge_id) END,
           changed_at=authority_now, disconnected_at=NULL, revoked_at=authority_now
     WHERE player_session_id=OLD.id AND state <> 'REVOKED';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER player_session_wallet_runtime_revoke
BEFORE UPDATE OF delivery_generation, state ON samurai_persistence.player_sessions
FOR EACH ROW EXECUTE FUNCTION samurai_persistence.revoke_wallet_runtime_for_session_change();

CREATE FUNCTION samurai_persistence.revoke_wallet_runtime_for_credential_change()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  authority_now timestamptz := NEW.revoked_at;
BEGIN
  IF OLD.state = 'active' AND NEW.state = 'revoked' THEN
    UPDATE samurai_persistence.wallet_link_challenges c
       SET state='REVOKED', revoked_at=authority_now
     WHERE c.state='ISSUED' AND EXISTS (
       SELECT 1 FROM samurai_persistence.wallet_runtime_links l
        WHERE l.id=c.wallet_link_id AND l.player_id=NEW.player_id
          AND l.chain_id=NEW.chain_id AND l.account=NEW.account
          AND (l.credential_id=NEW.credential_id
            OR (l.credential_id IS NULL AND l.state IN ('CHALLENGE_ISSUED','PROOF_PENDING')))
     );
    UPDATE samurai_persistence.wallet_link_challenges c
       SET runtime_generation=CASE WHEN c.runtime_generation < 9007199254740991 THEN c.runtime_generation+1 ELSE c.runtime_generation END,
           session_revision=CASE WHEN c.session_revision < 9007199254740991 THEN c.session_revision+1 ELSE c.session_revision END
     WHERE EXISTS (
       SELECT 1 FROM samurai_persistence.wallet_runtime_links l
        WHERE l.id=c.wallet_link_id AND l.player_id=NEW.player_id
          AND l.chain_id=NEW.chain_id AND l.account=NEW.account AND l.state <> 'REVOKED'
          AND (l.credential_id=NEW.credential_id
            OR (l.credential_id IS NULL AND l.state IN ('CHALLENGE_ISSUED','PROOF_PENDING')))
     );
    UPDATE samurai_persistence.wallet_runtime_links
       SET state='REVOKED', terminal_reason='CREDENTIAL_REVOKED',
           runtime_generation=CASE WHEN runtime_generation < 9007199254740991 THEN runtime_generation+1 ELSE runtime_generation END,
           session_revision=CASE WHEN session_revision < 9007199254740991 THEN session_revision+1 ELSE session_revision END,
           linked_challenge_state=CASE WHEN linked_challenge_id IS NULL THEN NULL ELSE
             (SELECT state FROM samurai_persistence.wallet_link_challenges c WHERE c.challenge_id=linked_challenge_id) END,
           changed_at=authority_now, disconnected_at=NULL, revoked_at=authority_now
     WHERE player_id=NEW.player_id AND chain_id=NEW.chain_id AND account=NEW.account AND state <> 'REVOKED'
       AND (credential_id=NEW.credential_id
         OR (credential_id IS NULL AND state IN ('CHALLENGE_ISSUED','PROOF_PENDING')));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER wallet_credential_runtime_revoke
AFTER UPDATE OF state ON samurai_persistence.wallet_credentials
FOR EACH ROW EXECUTE FUNCTION samurai_persistence.revoke_wallet_runtime_for_credential_change();

CREATE TABLE samurai_persistence.wallet_link_events (
  wallet_link_id uuid NOT NULL REFERENCES samurai_persistence.wallet_runtime_links(id) ON DELETE CASCADE,
  sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991),
  kind text NOT NULL CHECK (kind IN ('RUNTIME_SYNCED','CHALLENGE_ISSUED','PROOF_CONSUMED','DISCONNECTED','REVOKED','CONTRADICTION')),
  public_payload jsonb NOT NULL CHECK (jsonb_typeof(public_payload) = 'object'),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  PRIMARY KEY (wallet_link_id, sequence),
  CHECK (octet_length(public_payload::text) <= 2048)
);

CREATE TABLE samurai_persistence.receipt_review_preparations (
  receipt_intent_id uuid PRIMARY KEY REFERENCES samurai_persistence.receipt_intents(id) ON DELETE CASCADE,
  wallet_link_id uuid NOT NULL REFERENCES samurai_persistence.wallet_runtime_links(id) ON DELETE RESTRICT,
  player_id text NOT NULL REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  result_hash bytea NOT NULL CHECK (octet_length(result_hash) = 32),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  UNIQUE (player_id, idempotency_key),
  UNIQUE (player_id, request_hash),
  FOREIGN KEY (wallet_link_id, player_id)
    REFERENCES samurai_persistence.wallet_runtime_links (id, player_id) ON DELETE RESTRICT
);
