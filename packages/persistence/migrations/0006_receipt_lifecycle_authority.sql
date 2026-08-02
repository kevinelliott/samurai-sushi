CREATE TABLE samurai_persistence.receipt_intents (
  id uuid PRIMARY KEY,
  public_intent_ref text NOT NULL UNIQUE,
  guest_session_id text REFERENCES samurai_persistence.guest_sessions(id) ON DELETE CASCADE,
  player_id text REFERENCES samurai_persistence.players(id) ON DELETE CASCADE,
  subject_kind text GENERATED ALWAYS AS (CASE WHEN guest_session_id IS NOT NULL THEN 'guest' ELSE 'player' END) STORED,
  subject_id text GENERATED ALWAYS AS (COALESCE(guest_session_id, player_id)) STORED,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  result_hash bytea NOT NULL CHECK (octet_length(result_hash) = 32),
  chain_id text NOT NULL,
  profile text NOT NULL CHECK (profile = 'localnet'),
  network_label_ref text NOT NULL CHECK (network_label_ref = 'network.localnet-rehearsal'),
  account text NOT NULL,
  owner text NOT NULL,
  source text NOT NULL,
  contract_address text NOT NULL,
  entrypoint text NOT NULL CHECK (entrypoint = 'submit_receipt'),
  attached_mutez bigint NOT NULL CHECK (attached_mutez = 0),
  service_commitment bytea NOT NULL CHECK (octet_length(service_commitment) = 32),
  content_version text NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  deployment_manifest_hash bytea NOT NULL CHECK (octet_length(deployment_manifest_hash) = 32),
  issuer_key_id text NOT NULL,
  issuer_policy_version text NOT NULL,
  packed_payload bytea NOT NULL CHECK (octet_length(packed_payload) BETWEEN 1 AND 2048),
  issuer_signature text NOT NULL,
  confirmation_threshold integer NOT NULL CHECK (confirmation_threshold BETWEEN 1 AND 10000),
  finality_policy_id text NOT NULL CHECK (finality_policy_id = 'localnet-two-confirmation-rehearsal-v1'),
  state text NOT NULL CHECK (state IN (
    'DRAFT', 'REVIEWED', 'AWAITING_SIGNATURE', 'SUBMITTED', 'INCLUDED', 'CONFIRMED', 'FINALIZED',
    'CANCELLED', 'REJECTED', 'EXPIRED', 'REORGED'
  )),
  projection_revision bigint NOT NULL DEFAULT 0 CHECK (projection_revision BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL,
  state_changed_at timestamptz NOT NULL,
  reviewed_at timestamptz,
  awaiting_signature_at timestamptz,
  submitted_at timestamptz,
  included_at timestamptz,
  confirmed_at timestamptz,
  finalized_at timestamptz,
  concluded_at timestamptz,
  UNIQUE (subject_kind, subject_id, idempotency_key),
  UNIQUE (chain_id, contract_address, nonce),
  UNIQUE (chain_id, contract_address, payload_hash),
  UNIQUE (id, chain_id, account),
  UNIQUE (
    id, chain_id, contract_address, account, service_commitment, content_version, nonce,
    payload_hash, deployment_manifest_hash, issuer_key_id, issuer_policy_version
  ),
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (public_intent_ref ~ '^ri_[A-Za-z0-9_-]{22}$'),
  CHECK ((guest_session_id IS NOT NULL AND player_id IS NULL) OR (guest_session_id IS NULL AND player_id IS NOT NULL)),
  CHECK (length(idempotency_key) BETWEEN 16 AND 128),
  CHECK (chain_id = 'NetXtJqPyJGB6Pc'),
  CHECK (account ~ '^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$'),
  CHECK (owner = account AND source = account),
  CHECK (contract_address ~ '^KT1[1-9A-HJ-NP-Za-km-z]{33}$'),
  CHECK (content_version ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$' AND length(content_version) <= 128),
  CHECK (issuer_key_id ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$' AND length(issuer_key_id) <= 64),
  CHECK (issuer_policy_version ~ '^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$' AND length(issuer_policy_version) <= 64),
  CHECK (issuer_signature ~ '^edsig[1-9A-HJ-NP-Za-km-z]{94}$'),
  CHECK (isfinite(issued_at) AND isfinite(expires_at) AND issued_at = date_trunc('second', issued_at)
    AND expires_at = date_trunc('second', expires_at) AND issued_at < expires_at
    AND expires_at <= issued_at + interval '15 minutes'),
  CHECK (isfinite(created_at) AND isfinite(state_changed_at) AND state_changed_at >= created_at),
  CHECK (reviewed_at IS NULL OR (isfinite(reviewed_at) AND reviewed_at >= created_at)),
  CHECK (awaiting_signature_at IS NULL OR (isfinite(awaiting_signature_at) AND awaiting_signature_at >= created_at)),
  CHECK (submitted_at IS NULL OR (isfinite(submitted_at) AND submitted_at >= created_at)),
  CHECK (included_at IS NULL OR (isfinite(included_at) AND included_at >= created_at)),
  CHECK (confirmed_at IS NULL OR (isfinite(confirmed_at) AND confirmed_at >= created_at)),
  CHECK (finalized_at IS NULL OR (isfinite(finalized_at) AND finalized_at >= created_at)),
  CHECK (concluded_at IS NULL OR (isfinite(concluded_at) AND concluded_at >= created_at)),
  CHECK ((state = 'DRAFT' AND reviewed_at IS NULL)
    OR state = 'EXPIRED'
    OR (state NOT IN ('DRAFT','EXPIRED') AND reviewed_at IS NOT NULL)),
  CHECK ((state IN ('SUBMITTED','INCLUDED','CONFIRMED','FINALIZED','REORGED')) = (submitted_at IS NOT NULL)),
  CHECK ((state IN ('INCLUDED','CONFIRMED','FINALIZED','REORGED')) = (included_at IS NOT NULL)),
  CHECK ((state IN ('CONFIRMED','FINALIZED') OR (state = 'REORGED' AND confirmed_at IS NOT NULL)) = (confirmed_at IS NOT NULL)),
  CHECK ((state = 'FINALIZED') = (finalized_at IS NOT NULL)),
  CHECK ((state IN ('CANCELLED','REJECTED','EXPIRED')) = (concluded_at IS NOT NULL))
);

CREATE UNIQUE INDEX receipt_intents_active_service
  ON samurai_persistence.receipt_intents (chain_id, contract_address, account, service_commitment)
  WHERE state NOT IN ('CANCELLED', 'REJECTED', 'EXPIRED');

CREATE TABLE samurai_persistence.operation_attempts (
  id uuid PRIMARY KEY,
  public_attempt_ref text NOT NULL UNIQUE,
  intent_id uuid NOT NULL REFERENCES samurai_persistence.receipt_intents(id) ON DELETE CASCADE,
  chain_id text NOT NULL,
  operation_hash text NOT NULL,
  source_account text NOT NULL,
  contract_address text NOT NULL,
  deployment_manifest_hash bytea NOT NULL CHECK (octet_length(deployment_manifest_hash) = 32),
  counter bigint NOT NULL CHECK (counter BETWEEN 0 AND 9007199254740991),
  state text NOT NULL CHECK (state IN ('SUBMITTED','INCLUDED','CONFIRMED','FINALIZED','FAILED','DROPPED','REPLACED','REORGED')),
  replaces_attempt_id uuid,
  retry_of_attempt_id uuid,
  canonical_block_level bigint CHECK (canonical_block_level BETWEEN 0 AND 9007199254740991),
  canonical_block_hash text,
  included_operation_index integer CHECK (included_operation_index >= 0),
  last_head_level bigint CHECK (last_head_level BETWEEN 0 AND 9007199254740991),
  last_head_block_hash text,
  confirmations integer NOT NULL DEFAULT 0 CHECK (confirmations BETWEEN 0 AND 10000),
  policy_evidence text,
  orphaned_block_level bigint CHECK (orphaned_block_level BETWEEN 0 AND 9007199254740991),
  orphaned_block_hash text,
  failure_code text,
  last_rpc_source_sequence bigint CHECK (last_rpc_source_sequence BETWEEN 0 AND 9007199254740991),
  last_indexer_source_sequence bigint CHECK (last_indexer_source_sequence BETWEEN 0 AND 9007199254740991),
  submitted_at timestamptz NOT NULL,
  included_at timestamptz,
  confirmed_at timestamptz,
  finalized_at timestamptz,
  orphaned_at timestamptz,
  last_observed_at timestamptz NOT NULL,
  UNIQUE (chain_id, operation_hash),
  UNIQUE (intent_id, id),
  UNIQUE (id, chain_id, operation_hash),
  UNIQUE (id, intent_id, chain_id, operation_hash),
  UNIQUE (replaces_attempt_id),
  UNIQUE (retry_of_attempt_id),
  FOREIGN KEY (intent_id, chain_id, source_account)
    REFERENCES samurai_persistence.receipt_intents(id, chain_id, account) ON DELETE CASCADE,
  FOREIGN KEY (intent_id, replaces_attempt_id)
    REFERENCES samurai_persistence.operation_attempts(intent_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (intent_id, retry_of_attempt_id)
    REFERENCES samurai_persistence.operation_attempts(intent_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED,
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (public_attempt_ref ~ '^ra_[A-Za-z0-9_-]{22}$'),
  CHECK (replaces_attempt_id IS NULL OR replaces_attempt_id <> id),
  CHECK (retry_of_attempt_id IS NULL OR retry_of_attempt_id <> id),
  CHECK (num_nonnulls(replaces_attempt_id, retry_of_attempt_id) <= 1),
  CHECK (chain_id ~ '^Net[1-9A-HJ-NP-Za-km-z]{12}$'),
  CHECK (operation_hash ~ '^o[1-9A-HJ-NP-Za-km-z]{50}$'),
  CHECK (source_account ~ '^tz[1-4][1-9A-HJ-NP-Za-km-z]{33}$'),
  CHECK (contract_address ~ '^KT1[1-9A-HJ-NP-Za-km-z]{33}$'),
  CHECK (canonical_block_hash IS NULL OR canonical_block_hash ~ '^[1-9A-HJ-NP-Za-km-z]{16,96}$'),
  CHECK (last_head_block_hash IS NULL OR last_head_block_hash ~ '^[1-9A-HJ-NP-Za-km-z]{16,96}$'),
  CHECK (orphaned_block_hash IS NULL OR orphaned_block_hash ~ '^[1-9A-HJ-NP-Za-km-z]{16,96}$'),
  CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CHECK (isfinite(submitted_at) AND isfinite(last_observed_at) AND last_observed_at >= submitted_at),
  CHECK (included_at IS NULL OR (isfinite(included_at) AND included_at >= submitted_at)),
  CHECK (confirmed_at IS NULL OR (isfinite(confirmed_at) AND confirmed_at >= submitted_at)),
  CHECK (finalized_at IS NULL OR (isfinite(finalized_at) AND finalized_at >= submitted_at)),
  CHECK (orphaned_at IS NULL OR (isfinite(orphaned_at) AND orphaned_at >= submitted_at)),
  CHECK ((canonical_block_level IS NULL) = (canonical_block_hash IS NULL)),
  CHECK ((canonical_block_level IS NULL) = (included_operation_index IS NULL)),
  CHECK ((last_head_level IS NULL) = (last_head_block_hash IS NULL)),
  CHECK ((orphaned_block_level IS NULL) = (orphaned_block_hash IS NULL)),
  CHECK ((orphaned_block_level IS NULL) = (orphaned_at IS NULL)),
  CHECK (
    (state = 'SUBMITTED' AND canonical_block_hash IS NULL AND confirmations = 0 AND policy_evidence IS NULL
      AND orphaned_block_hash IS NULL AND failure_code IS NULL AND included_at IS NULL AND confirmed_at IS NULL AND finalized_at IS NULL)
    OR (state = 'INCLUDED' AND canonical_block_hash IS NOT NULL AND confirmations BETWEEN 1 AND 1
      AND last_rpc_source_sequence IS NOT NULL AND last_head_level IS NOT NULL
      AND confirmations = last_head_level - canonical_block_level + 1
      AND policy_evidence IS NULL AND orphaned_block_hash IS NULL AND failure_code IS NULL
      AND included_at IS NOT NULL AND confirmed_at IS NULL AND finalized_at IS NULL)
    OR (state = 'CONFIRMED' AND canonical_block_hash IS NOT NULL AND confirmations BETWEEN 2 AND 64
      AND last_rpc_source_sequence IS NOT NULL AND last_head_level IS NOT NULL
      AND confirmations = last_head_level - canonical_block_level + 1
      AND policy_evidence IS NOT NULL AND orphaned_block_hash IS NULL AND failure_code IS NULL
      AND included_at IS NOT NULL AND confirmed_at IS NOT NULL AND finalized_at IS NULL)
    OR (state = 'FINALIZED' AND canonical_block_hash IS NOT NULL AND confirmations BETWEEN 2 AND 64
      AND last_rpc_source_sequence IS NOT NULL AND last_head_level IS NOT NULL
      AND confirmations = last_head_level - canonical_block_level + 1
      AND policy_evidence IS NOT NULL AND orphaned_block_hash IS NULL AND failure_code IS NULL
      AND included_at IS NOT NULL AND confirmed_at IS NOT NULL AND finalized_at IS NOT NULL)
    OR (state = 'REORGED' AND canonical_block_hash IS NULL AND confirmations = 0 AND policy_evidence IS NULL
      AND orphaned_block_hash IS NOT NULL AND failure_code IS NULL AND included_at IS NOT NULL AND finalized_at IS NULL)
    OR (state IN ('FAILED','DROPPED') AND canonical_block_hash IS NULL AND confirmations = 0 AND policy_evidence IS NULL
      AND orphaned_block_hash IS NULL AND failure_code IS NOT NULL AND included_at IS NULL AND confirmed_at IS NULL AND finalized_at IS NULL)
    OR (state = 'REPLACED' AND canonical_block_hash IS NULL AND confirmations = 0 AND policy_evidence IS NULL
      AND orphaned_block_hash IS NULL AND failure_code IS NULL AND included_at IS NULL AND confirmed_at IS NULL AND finalized_at IS NULL)
  )
);

CREATE FUNCTION samurai_persistence.assert_receipt_attempt_lineage() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, samurai_persistence AS $$
DECLARE
  predecessor samurai_persistence.operation_attempts%ROWTYPE;
  successor_count integer;
  cycle_found boolean;
BEGIN
  IF NEW.replaces_attempt_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM samurai_persistence.operation_attempts WHERE id = NEW.replaces_attempt_id;
    IF NOT FOUND OR predecessor.intent_id <> NEW.intent_id OR predecessor.chain_id <> NEW.chain_id
      OR predecessor.source_account <> NEW.source_account OR predecessor.counter <> NEW.counter
      OR predecessor.state <> 'REPLACED' THEN
      RAISE EXCEPTION 'receipt replacement lineage mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.retry_of_attempt_id IS NOT NULL THEN
    SELECT * INTO predecessor FROM samurai_persistence.operation_attempts WHERE id = NEW.retry_of_attempt_id;
    IF NOT FOUND OR predecessor.intent_id <> NEW.intent_id OR predecessor.chain_id <> NEW.chain_id
      OR predecessor.source_account <> NEW.source_account OR predecessor.contract_address <> NEW.contract_address
      OR predecessor.deployment_manifest_hash <> NEW.deployment_manifest_hash
      OR predecessor.state NOT IN ('FAILED','DROPPED') OR NEW.state <> 'SUBMITTED'
      OR NEW.counter < predecessor.counter THEN
      RAISE EXCEPTION 'receipt retry lineage mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW.state = 'REPLACED' THEN
    SELECT count(*) INTO successor_count FROM samurai_persistence.operation_attempts WHERE replaces_attempt_id = NEW.id;
    IF successor_count <> 1 THEN RAISE EXCEPTION 'replaced attempt must have exactly one successor' USING ERRCODE = '23514'; END IF;
  END IF;
  WITH RECURSIVE lineage(id, replaces_attempt_id) AS (
    SELECT id, replaces_attempt_id FROM samurai_persistence.operation_attempts WHERE id = NEW.id
    UNION ALL
    SELECT candidate.id, candidate.replaces_attempt_id
      FROM samurai_persistence.operation_attempts candidate JOIN lineage ON candidate.id = lineage.replaces_attempt_id
  )
  SELECT EXISTS (SELECT 1 FROM lineage WHERE replaces_attempt_id = NEW.id) INTO cycle_found;
  IF cycle_found THEN RAISE EXCEPTION 'receipt replacement lineage cycle' USING ERRCODE = '23514'; END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER operation_attempt_lineage
AFTER INSERT OR UPDATE ON samurai_persistence.operation_attempts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION samurai_persistence.assert_receipt_attempt_lineage();

CREATE FUNCTION samurai_persistence.prevent_receipt_attempt_identity_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, samurai_persistence AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.public_attempt_ref <> OLD.public_attempt_ref OR NEW.intent_id <> OLD.intent_id
    OR NEW.chain_id <> OLD.chain_id OR NEW.operation_hash <> OLD.operation_hash
    OR NEW.source_account <> OLD.source_account OR NEW.contract_address <> OLD.contract_address
    OR NEW.deployment_manifest_hash <> OLD.deployment_manifest_hash OR NEW.counter <> OLD.counter
    OR NEW.submitted_at <> OLD.submitted_at OR NEW.replaces_attempt_id IS DISTINCT FROM OLD.replaces_attempt_id
    OR NEW.retry_of_attempt_id IS DISTINCT FROM OLD.retry_of_attempt_id THEN
    RAISE EXCEPTION 'operation attempt immutable identity changed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER operation_attempt_identity_immutable
BEFORE UPDATE ON samurai_persistence.operation_attempts FOR EACH ROW
EXECUTE FUNCTION samurai_persistence.prevent_receipt_attempt_identity_update();

CREATE UNIQUE INDEX operation_attempts_one_initial_root
  ON samurai_persistence.operation_attempts (intent_id) WHERE replaces_attempt_id IS NULL AND retry_of_attempt_id IS NULL;

CREATE TABLE samurai_persistence.receipt_chain_observations (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL,
  chain_id text NOT NULL,
  operation_hash text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('fake-rpc','fake-indexer')),
  source_observation_id text NOT NULL,
  source_sequence bigint NOT NULL CHECK (source_sequence BETWEEN 0 AND 9007199254740991),
  normalized_digest bytea NOT NULL CHECK (octet_length(normalized_digest) = 32),
  disposition text NOT NULL CHECK (disposition IN ('PENDING','INCLUDED','FAILED','DROPPED','REORGED')),
  apply_result text NOT NULL CHECK (apply_result IN ('APPLIED','RECORDED_HINT','DUPLICATE','IGNORED_STALE','INCIDENT')),
  head_level bigint NOT NULL CHECK (head_level BETWEEN 0 AND 9007199254740991),
  head_block_hash text NOT NULL,
  included_level bigint CHECK (included_level BETWEEN 0 AND 9007199254740991),
  included_block_hash text,
  operation_index integer CHECK (operation_index >= 0),
  failure_code text,
  canonical_chain_proof jsonb,
  receipt_owner text,
  receipt_contract text,
  receipt_service_commitment bytea CHECK (receipt_service_commitment IS NULL OR octet_length(receipt_service_commitment) = 32),
  receipt_content_version text,
  receipt_nonce bytea CHECK (receipt_nonce IS NULL OR octet_length(receipt_nonce) = 32),
  receipt_payload_hash bytea CHECK (receipt_payload_hash IS NULL OR octet_length(receipt_payload_hash) = 32),
  receipt_manifest_hash bytea CHECK (receipt_manifest_hash IS NULL OR octet_length(receipt_manifest_hash) = 32),
  observed_at timestamptz NOT NULL,
  UNIQUE (source_kind, source_observation_id),
  UNIQUE (attempt_id, source_kind, source_sequence),
  UNIQUE (attempt_id, normalized_digest),
  FOREIGN KEY (attempt_id, chain_id, operation_hash)
    REFERENCES samurai_persistence.operation_attempts(id, chain_id, operation_hash) ON DELETE CASCADE,
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (length(source_observation_id) BETWEEN 1 AND 128),
  CHECK (head_block_hash ~ '^[1-9A-HJ-NP-Za-km-z]{16,96}$'),
  CHECK (canonical_chain_proof IS NULL OR (jsonb_typeof(canonical_chain_proof) = 'array' AND jsonb_array_length(canonical_chain_proof) BETWEEN 1 AND 64 AND pg_column_size(canonical_chain_proof) <= 16384)),
  CHECK (included_block_hash IS NULL OR included_block_hash ~ '^[1-9A-HJ-NP-Za-km-z]{16,96}$'),
  CHECK ((included_level IS NULL) = (included_block_hash IS NULL)),
  CHECK ((included_level IS NULL) = (operation_index IS NULL)),
  CHECK ((disposition IN ('INCLUDED','REORGED')) = (included_level IS NOT NULL)),
  CHECK ((disposition IN ('FAILED','DROPPED')) = (failure_code IS NOT NULL)),
  CHECK (failure_code IS NULL OR failure_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  CHECK (isfinite(observed_at)),
  CHECK ((receipt_owner IS NULL AND receipt_contract IS NULL AND receipt_service_commitment IS NULL
    AND receipt_content_version IS NULL AND receipt_nonce IS NULL AND receipt_payload_hash IS NULL AND receipt_manifest_hash IS NULL)
    OR (receipt_owner IS NOT NULL AND receipt_contract IS NOT NULL AND receipt_service_commitment IS NOT NULL
    AND receipt_content_version IS NOT NULL AND receipt_nonce IS NOT NULL AND receipt_payload_hash IS NOT NULL AND receipt_manifest_hash IS NOT NULL))
);

CREATE TABLE samurai_persistence.service_receipts (
  id uuid PRIMARY KEY,
  intent_id uuid NOT NULL UNIQUE,
  attempt_id uuid NOT NULL UNIQUE,
  chain_id text NOT NULL,
  contract_address text NOT NULL,
  owner text NOT NULL,
  service_commitment bytea NOT NULL CHECK (octet_length(service_commitment) = 32),
  content_version text NOT NULL,
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 32),
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  deployment_manifest_hash bytea NOT NULL CHECK (octet_length(deployment_manifest_hash) = 32),
  issuer_key_id text NOT NULL,
  issuer_policy_version text NOT NULL,
  operation_hash text NOT NULL,
  state text NOT NULL CHECK (state IN ('INCLUDED','CONFIRMED','FINALIZED','REORGED')),
  canonical_block_level bigint CHECK (canonical_block_level BETWEEN 0 AND 9007199254740991),
  canonical_block_hash text,
  orphaned_block_level bigint CHECK (orphaned_block_level BETWEEN 0 AND 9007199254740991),
  orphaned_block_hash text,
  recorded_at timestamptz NOT NULL,
  finalized_at timestamptz,
  updated_at timestamptz NOT NULL,
  UNIQUE (chain_id, contract_address, owner, service_commitment),
  UNIQUE (chain_id, contract_address, nonce),
  UNIQUE (chain_id, contract_address, payload_hash),
  FOREIGN KEY (attempt_id, intent_id, chain_id, operation_hash)
    REFERENCES samurai_persistence.operation_attempts(id, intent_id, chain_id, operation_hash) ON DELETE CASCADE,
  FOREIGN KEY (intent_id, chain_id, contract_address, owner, service_commitment, content_version, nonce,
    payload_hash, deployment_manifest_hash, issuer_key_id, issuer_policy_version)
    REFERENCES samurai_persistence.receipt_intents(id, chain_id, contract_address, account, service_commitment,
      content_version, nonce, payload_hash, deployment_manifest_hash, issuer_key_id, issuer_policy_version)
    ON DELETE CASCADE,
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK ((canonical_block_level IS NULL) = (canonical_block_hash IS NULL)),
  CHECK ((orphaned_block_level IS NULL) = (orphaned_block_hash IS NULL)),
  CHECK (state <> 'REORGED' OR (canonical_block_hash IS NULL AND orphaned_block_hash IS NOT NULL)),
  CHECK (state = 'REORGED' OR canonical_block_hash IS NOT NULL),
  CHECK ((state = 'FINALIZED') = (finalized_at IS NOT NULL)),
  CHECK (isfinite(recorded_at) AND isfinite(updated_at) AND updated_at >= recorded_at),
  CHECK (finalized_at IS NULL OR (isfinite(finalized_at) AND finalized_at >= recorded_at))
);

CREATE TABLE samurai_persistence.receipt_incidents (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN (
    'FINALIZED_CHAIN_CONTRADICTION','CANONICAL_ATTEMPT_CONFLICT','RECEIPT_EVENT_IDENTITY_MISMATCH',
    'CHAIN_OR_MANIFEST_DRIFT','RPC_INDEXER_DIVERGENCE','OBSERVATION_HISTORY_CONTRADICTION',
    'REPLACEMENT_LINEAGE_CORRUPTION','RECONCILIATION_EXHAUSTED'
  )),
  scope_digest bytea NOT NULL CHECK (octet_length(scope_digest) = 32),
  state text NOT NULL CHECK (state IN ('OPEN','RESOLVED')),
  intent_id uuid NOT NULL REFERENCES samurai_persistence.receipt_intents(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  first_observation_id uuid REFERENCES samurai_persistence.receipt_chain_observations(id) ON DELETE SET NULL,
  occurrence_count bigint NOT NULL DEFAULT 1 CHECK (occurrence_count BETWEEN 1 AND 9007199254740991),
  opened_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  resolved_at timestamptz,
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  FOREIGN KEY (intent_id, attempt_id) REFERENCES samurai_persistence.operation_attempts(intent_id, id) ON DELETE CASCADE,
  CHECK (isfinite(opened_at) AND isfinite(last_seen_at) AND last_seen_at >= opened_at),
  CHECK ((state = 'RESOLVED') = (resolved_at IS NOT NULL)),
  CHECK (resolved_at IS NULL OR (isfinite(resolved_at) AND resolved_at >= opened_at))
);

CREATE UNIQUE INDEX receipt_incidents_one_open_scope
  ON samurai_persistence.receipt_incidents (intent_id, attempt_id, kind, scope_digest) WHERE state = 'OPEN';

CREATE TABLE samurai_persistence.receipt_incident_occurrences (
  id uuid PRIMARY KEY,
  incident_id uuid NOT NULL REFERENCES samurai_persistence.receipt_incidents(id) ON DELETE CASCADE,
  evidence_digest bytea NOT NULL CHECK (octet_length(evidence_digest) = 32),
  observation_id uuid REFERENCES samurai_persistence.receipt_chain_observations(id) ON DELETE SET NULL,
  observed_at timestamptz NOT NULL CHECK (isfinite(observed_at)),
  UNIQUE (incident_id, evidence_digest, observation_id),
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

CREATE TABLE samurai_persistence.receipt_lifecycle_events (
  event_id text PRIMARY KEY,
  intent_id uuid NOT NULL REFERENCES samurai_persistence.receipt_intents(id) ON DELETE CASCADE,
  intent_sequence bigint NOT NULL CHECK (intent_sequence BETWEEN 0 AND 9007199254740991),
  attempt_id uuid REFERENCES samurai_persistence.operation_attempts(id) ON DELETE CASCADE,
  observation_id uuid REFERENCES samurai_persistence.receipt_chain_observations(id) ON DELETE SET NULL,
  incident_id uuid REFERENCES samurai_persistence.receipt_incidents(id) ON DELETE SET NULL,
  event_kind text NOT NULL CHECK (event_kind ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  from_state text,
  to_state text,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND pg_column_size(payload) <= 8192),
  payload_digest bytea NOT NULL CHECK (octet_length(payload_digest) = 32),
  created_at timestamptz NOT NULL CHECK (isfinite(created_at)),
  UNIQUE (intent_id, intent_sequence),
  CHECK (event_id ~ '^receipt:[0-9a-f]{64}$'),
  CHECK ((from_state IS NULL) = (event_kind = 'INTENT_CREATED'))
);

CREATE TABLE samurai_persistence.receipt_outbox_deliveries (
  event_id text PRIMARY KEY REFERENCES samurai_persistence.receipt_lifecycle_events(event_id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending','processing','delivered','dead-letter')),
  available_at timestamptz NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  claim_token uuid,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation BETWEEN 0 AND 9007199254740991),
  claim_expires_at timestamptz,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text,
  CHECK (isfinite(available_at)),
  CHECK ((state = 'processing') = (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((state = 'dead-letter') = (dead_lettered_at IS NOT NULL)),
  CHECK (claim_generation = attempt_count),
  CHECK (claim_expires_at IS NULL OR isfinite(claim_expires_at)),
  CHECK (last_attempt_at IS NULL OR isfinite(last_attempt_at)),
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE INDEX receipt_outbox_available ON samurai_persistence.receipt_outbox_deliveries (available_at, event_id)
  WHERE state IN ('pending','processing');

CREATE TABLE samurai_persistence.receipt_reconciliation_jobs (
  attempt_id uuid PRIMARY KEY REFERENCES samurai_persistence.operation_attempts(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending','processing','complete','dead-letter')),
  available_at timestamptz NOT NULL,
  claim_token uuid,
  claim_generation bigint NOT NULL DEFAULT 0 CHECK (claim_generation BETWEEN 0 AND 9007199254740991),
  claim_expires_at timestamptz,
  consecutive_failure_count integer NOT NULL DEFAULT 0 CHECK (consecutive_failure_count BETWEEN 0 AND 100),
  last_claimed_at timestamptz,
  last_success_at timestamptz,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  last_error_code text,
  CHECK (isfinite(available_at)),
  CHECK ((state = 'processing') = (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK ((state = 'complete') = (completed_at IS NOT NULL)),
  CHECK ((state = 'dead-letter') = (dead_lettered_at IS NOT NULL)),
  CHECK (claim_expires_at IS NULL OR isfinite(claim_expires_at)),
  CHECK (last_claimed_at IS NULL OR isfinite(last_claimed_at)),
  CHECK (last_success_at IS NULL OR isfinite(last_success_at)),
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE INDEX receipt_reconciliation_available ON samurai_persistence.receipt_reconciliation_jobs (available_at, attempt_id)
  WHERE state IN ('pending','processing');

CREATE TABLE samurai_persistence.receipt_security_audit (
  id uuid PRIMARY KEY,
  issuer_key_id text NOT NULL,
  issuer_policy_version text NOT NULL,
  nonce_digest bytea NOT NULL CHECK (octet_length(nonce_digest) = 32),
  outcome text NOT NULL CHECK (outcome IN ('PREPARED','EXPIRED','REJECTED','CONSUMED')),
  created_at timestamptz NOT NULL,
  purge_at timestamptz NOT NULL,
  UNIQUE (issuer_key_id, issuer_policy_version, nonce_digest),
  CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (isfinite(created_at) AND isfinite(purge_at) AND purge_at > created_at AND purge_at <= created_at + interval '30 days')
);
