ALTER TABLE samurai_persistence.deletion_tombstones
  DROP CONSTRAINT deletion_tombstones_kind_check,
  DROP CONSTRAINT deletion_tombstones_check;

ALTER TABLE samurai_persistence.deletion_tombstones
  ADD CONSTRAINT deletion_tombstones_kind_check
    CHECK (kind IN ('guest-session', 'command', 'save-export', 'save-import')),
  ADD CONSTRAINT deletion_tombstones_resume_identity_check CHECK (
    (kind = 'guest-session' AND resume_digest_key_version IS NOT NULL AND resume_digest_key_identity IS NOT NULL) OR
    (kind IN ('command', 'save-export', 'save-import')
      AND resume_digest_key_version IS NULL AND resume_digest_key_identity IS NULL)
  );

CREATE TABLE samurai_persistence.save_exports (
  export_id uuid PRIMARY KEY,
  guest_session_id text NOT NULL REFERENCES samurai_persistence.guest_sessions(id) ON DELETE CASCADE,
  subject_revision bigint NOT NULL CHECK (subject_revision >= 0),
  content_version text NOT NULL,
  checkpoint_schema_version integer NOT NULL CHECK (checkpoint_schema_version > 0),
  save_payload_hash bytea NOT NULL CHECK (octet_length(save_payload_hash) = 32),
  unlinkable_claim_commitment_hash bytea NOT NULL UNIQUE
    CHECK (octet_length(unlinkable_claim_commitment_hash) = 32),
  claims_hash bytea NOT NULL CHECK (octet_length(claims_hash) = 32),
  integrity_key_version integer NOT NULL CHECK (integrity_key_version > 0),
  integrity_key_identity bytea NOT NULL CHECK (octet_length(integrity_key_identity) = 32),
  integrity_tag bytea NOT NULL CHECK (octet_length(integrity_tag) = 32),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (integrity_key_version, integrity_key_identity, integrity_tag),
  CHECK (export_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '29 days')
);

CREATE INDEX save_exports_subject
  ON samurai_persistence.save_exports (guest_session_id, created_at, export_id);

CREATE INDEX save_exports_expiry
  ON samurai_persistence.save_exports (expires_at, export_id);

CREATE INDEX save_exports_integrity_key
  ON samurai_persistence.save_exports (integrity_key_version, integrity_key_identity, expires_at);

CREATE TABLE samurai_persistence.recovery_imports (
  import_id uuid PRIMARY KEY,
  guest_session_id text NOT NULL REFERENCES samurai_persistence.guest_sessions(id) ON DELETE CASCADE,
  export_id uuid NOT NULL UNIQUE,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
  committed_revision bigint NOT NULL CHECK (committed_revision >= 0),
  integrity_key_version integer NOT NULL CHECK (integrity_key_version > 0),
  integrity_key_identity bytea NOT NULL CHECK (octet_length(integrity_key_identity) = 32),
  issued_digest_key_version integer NOT NULL CHECK (issued_digest_key_version > 0),
  issued_digest_key_identity bytea NOT NULL CHECK (octet_length(issued_digest_key_identity) = 32),
  issued_digest bytea NOT NULL CHECK (octet_length(issued_digest) = 32),
  delivery_generation bigint NOT NULL CHECK (delivery_generation > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  original_export_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (import_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (export_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CHECK (updated_at >= created_at),
  CHECK (updated_at < original_export_expires_at),
  CHECK (isfinite(original_export_expires_at)),
  CHECK (original_export_expires_at > created_at),
  CHECK (original_export_expires_at <= created_at + interval '29 days'),
  CHECK (expires_at = original_export_expires_at + interval '1 day')
);

CREATE INDEX recovery_imports_subject
  ON samurai_persistence.recovery_imports (guest_session_id, created_at, import_id);

CREATE INDEX recovery_imports_expiry
  ON samurai_persistence.recovery_imports (expires_at, import_id);

CREATE INDEX recovery_imports_integrity_key
  ON samurai_persistence.recovery_imports (integrity_key_version, integrity_key_identity, expires_at);
