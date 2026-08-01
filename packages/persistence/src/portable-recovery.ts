import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  canonicalJson,
  canonicalPortableSaveEnvelopeBytes,
  parsePortableSaveEnvelope,
  portableSaveClaims,
} from "@samurai-sushi/domain";
import type {
  PortableSaveClaimsV1,
  PortableSaveContentRefV1,
  PortableSaveEnvelopeV1,
} from "@samurai-sushi/domain";
import {
  constantTimeDigestEqual,
  GuestSecretFormatError,
  type IntegrityKeyring,
  issueResumeSecret,
  keyIdentityBytes,
  keyIdentityFromBytes,
  type KeyIdentity,
  type TombstoneKind,
} from "./crypto";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import { GuestResumeError, PersistenceError, PortableRecoveryError } from "./errors";
import type { PersistenceAuthority } from "./key-inventory";
import { addMilliseconds, ADR_0003_PERSISTENCE_LIFECYCLE } from "./lifecycle";
import { GuestProgressRepository, GuestSessionRepository } from "./repositories";
import type { GuestProgressRecord, GuestSessionRecord, ResumeMatch } from "./repositories";

const PORTABLE_SAVE_PAYLOAD_DOMAIN = "samurai-sushi:portable-save-payload:v1\n";
const PORTABLE_SAVE_CLAIMS_HASH_DOMAIN = "samurai-sushi:portable-save-claims-hash:v1\n";
const PORTABLE_SAVE_COMMITMENT_DOMAIN = "samurai-sushi:portable-save-commitment:v1\n";
const PORTABLE_SAVE_IMPORT_REQUEST_DOMAIN = "samurai-sushi:portable-save-import-request:v1\n";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const IMPORT_REPLAY_SKEW_MS = 24 * 60 * 60 * 1_000;
const ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;
const REPLACEMENT_SECRET_ATTEMPTS = 8;

interface CountRow { readonly reference_count: string }

interface OwnerRow { readonly guest_session_id: string }

interface SaveExportRow {
  readonly export_id: string;
  readonly guest_session_id: string;
  readonly subject_revision: string;
  readonly content_version: string;
  readonly checkpoint_schema_version: number;
  readonly save_payload_hash: Uint8Array;
  readonly unlinkable_claim_commitment_hash: Uint8Array;
  readonly claims_hash: Uint8Array;
  readonly integrity_key_version: number;
  readonly integrity_key_identity: Uint8Array;
  readonly integrity_tag: Uint8Array;
  readonly created_at: Date;
  readonly expires_at: Date;
}

interface ResumeDigestRow {
  readonly slot?: "current" | "predecessor";
  readonly digest_key_version: number;
  readonly digest_key_identity: Uint8Array;
  readonly digest: Uint8Array;
}

interface ExportReplayRow {
  readonly export_id: string;
  readonly expires_at: Date;
}

interface ImportReceiptRow {
  readonly import_id: string;
  readonly guest_session_id: string;
  readonly export_id: string;
  readonly request_hash: Uint8Array;
  readonly committed_revision: string;
  readonly integrity_key_version: number;
  readonly integrity_key_identity: Uint8Array;
  readonly issued_digest_key_version: number;
  readonly issued_digest_key_identity: Uint8Array;
  readonly issued_digest: Uint8Array;
  readonly delivery_generation: string;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly original_export_expires_at: Date;
  readonly expires_at: Date;
}

interface ImportCleanupRow {
  readonly guest_session_id: string;
  readonly import_id: string;
  readonly expires_at: Date;
}

interface IntegrityPurgeRow {
  readonly guest_session_id: string;
  readonly reference_id: string;
  readonly integrity_key_version: number;
  readonly integrity_key_identity: Uint8Array;
  readonly expires_at: Date;
}

interface ReplacementCredential {
  readonly secret: string;
  readonly digest: ReturnType<PersistenceAuthority["resumeKeys"]["digest"]>;
  readonly now: Date;
}

export interface PortableSaveContentDescriptor {
  readonly pack: PortableSaveClaimsV1["content"]["pack"];
  readonly refs: readonly PortableSaveContentRefV1[];
}

export interface PortableSaveContentAuthority {
  describe(progress: GuestProgressRecord): Promise<PortableSaveContentDescriptor>;
}

export interface CreatePortableSaveInput {
  readonly resumeSecret: string;
  readonly expectedRevision: number;
  readonly validityMs: number;
}

export interface ImportPortableSaveInput {
  readonly importId: string;
  readonly envelope: unknown;
}

export interface ImportedPortableSave {
  readonly disposition: "committed" | "replayed";
  readonly guestSessionId: string;
  readonly revision: number;
  readonly rotatedResumeSecret: string;
}

export interface PortableRecoveryServiceOptions {
  readonly issueExportId?: () => string;
  readonly issueCommitment?: () => Uint8Array;
  readonly issueResumeSecret?: () => string;
}

function sha256(domain: string, bytes: Uint8Array | string): Uint8Array {
  return createHash("sha256").update(domain, "utf8").update(bytes).digest();
}

function hashText(value: Uint8Array): `sha256:${string}` {
  return `sha256:${Buffer.from(value).toString("hex")}`;
}

function canonicalClaimsBytes(claims: PortableSaveClaimsV1): Uint8Array {
  return new TextEncoder().encode(canonicalJson(claims));
}

function replayKey(kind: "save-export" | "save-import", id: string): string {
  return `${kind === "save-export" ? "export" : "import"}:${id}`;
}

function validUuid(value: string, name: string): void {
  if (!UUID_V4_PATTERN.test(value)) throw new Error(`${name} must be a canonical UUIDv4.`);
}

function exactHashBytes(value: string): Uint8Array {
  if (!HASH_PATTERN.test(value)) throw new Error("Portable save hashes must use lowercase sha256:<hex> form.");
  return Buffer.from(value.slice("sha256:".length), "hex");
}

function candidateMatches(match: ResumeMatch, candidates: ReturnType<PersistenceAuthority["resumeKeys"]["candidates"]>): boolean {
  const candidate = candidates.find((item) => (
    item.keyVersion === match.digestKeyVersion && item.keyIdentity === match.digestKeyIdentity
  ));
  return Boolean(candidate && constantTimeDigestEqual(candidate.digest, match.digest));
}

function replayExpiry(exportExpiresAt: Date): Date {
  return addMilliseconds(exportExpiresAt, IMPORT_REPLAY_SKEW_MS);
}

function nextRotateAfter(session: GuestSessionRecord, now: Date): Date {
  return new Date(Math.min(session.expiresAt.getTime(), now.getTime() + ROTATION_INTERVAL_MS));
}

function invalidRecovery(): PortableRecoveryError {
  return new PortableRecoveryError("RECOVERY_INVALID");
}

export class PortableRecoveryAuthority {
  private readonly runner: TransactionRunner;

  constructor(
    pool: SqlPool,
    readonly integrityKeys: IntegrityKeyring | undefined,
  ) {
    this.runner = new TransactionRunner(pool);
  }

  async assertExportReady(client: SqlClient, now: Date): Promise<IntegrityKeyring> {
    const keys = this.requiredKeys();
    keys.assertActive(now);
    const reusedVersion = await client.query<{ readonly found: number }>(
      `SELECT 1 AS found FROM (
         SELECT integrity_key_identity FROM samurai_persistence.save_exports
          WHERE integrity_key_version = $1
         UNION ALL
         SELECT integrity_key_identity FROM samurai_persistence.recovery_imports
          WHERE integrity_key_version = $1
       ) refs
       WHERE integrity_key_identity <> $2
       LIMIT 1`,
      [keys.active.version, keyIdentityBytes(keys.active.keyIdentity)],
    );
    if (reusedVersion.rows[0]) {
      throw new PersistenceError(
        "KEY_IDENTITY_MISMATCH",
        "The active portable-integrity key version conflicts with a retained private-record identity.",
      );
    }
    return keys;
  }

  async assertImportReady(
    _client: SqlClient,
    now: Date,
    keyVersion: number,
    keyIdentity: KeyIdentity,
    requiredUntil: Date,
  ): Promise<IntegrityKeyring> {
    const keys = this.requiredKeys();
    const metadata = keys.metadata(keyVersion);
    if (!metadata || metadata.keyIdentity !== keyIdentity || !keys.canVerify(keyVersion, now)) {
      throw new PersistenceError(
        "KEY_VERSION_UNAVAILABLE",
        "The selected portable-integrity key version and identity are unavailable.",
      );
    }
    if (metadata.verifyUntilMs !== null && metadata.verifyUntilMs < requiredUntil.getTime()) {
      throw new PersistenceError(
        "KEY_VERIFY_HORIZON_TOO_SHORT",
        "The selected portable-integrity key does not cover the envelope authority horizon.",
      );
    }
    return keys;
  }

  verificationPairs(now: Date): readonly { readonly version: number; readonly identity: Uint8Array }[] {
    if (!this.integrityKeys) return [];
    return this.integrityKeys.allMetadata()
      .filter((metadata) => this.integrityKeys!.canVerify(metadata.version, now))
      .map((metadata) => ({ version: metadata.version, identity: keyIdentityBytes(metadata.keyIdentity) }));
  }

  isVerificationAvailable(version: number, identity: Uint8Array, now: Date): boolean {
    if (!this.integrityKeys) return false;
    const metadata = this.integrityKeys.metadata(version);
    return Boolean(
      metadata
      && metadata.keyIdentity === keyIdentityFromBytes(identity)
      && this.integrityKeys.canVerify(version, now),
    );
  }

  async assertSafeToDestroy(version: number): Promise<void> {
    const keys = this.requiredKeys();
    await this.runner.run(async (client) => {
      const clock = await client.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
      const now = clock.rows[0]?.now;
      if (!now) throw new PersistenceError("DATABASE_CLOCK_UNAVAILABLE", "PostgreSQL did not return its authoritative clock.");
      const metadata = keys.metadata(version);
      if (!metadata || metadata.retiredAtMs === null || (metadata.verifyUntilMs ?? Number.POSITIVE_INFINITY) > now.getTime()) {
        throw new PersistenceError("KEY_DESTRUCTION_UNSAFE", `portable-integrity key version ${version} has not reached its destruction horizon.`);
      }
      const result = await client.query<CountRow>(
        `SELECT COUNT(*)::text AS reference_count FROM (
           SELECT 1 FROM samurai_persistence.save_exports
            WHERE integrity_key_version = $1 AND integrity_key_identity = $2
           UNION ALL
           SELECT 1 FROM samurai_persistence.recovery_imports
            WHERE integrity_key_version = $1 AND integrity_key_identity = $2
         ) refs`,
        [version, keyIdentityBytes(metadata.keyIdentity)],
      );
      if (Number(result.rows[0]?.reference_count ?? 0) !== 0) {
        throw new PersistenceError("KEY_DESTRUCTION_UNSAFE", `portable-integrity key version ${version} still has database references.`);
      }
    });
  }

  private requiredKeys(): IntegrityKeyring {
    if (!this.integrityKeys) {
      throw new PersistenceError("PORTABLE_INTEGRITY_UNAVAILABLE", "Portable recovery integrity authority is unavailable.");
    }
    return this.integrityKeys;
  }

}

export class PortableRecoveryService {
  private readonly runner: TransactionRunner;
  private readonly sessions = new GuestSessionRepository();
  private readonly progress = new GuestProgressRepository();
  private readonly createExportId: () => string;
  private readonly createCommitment: () => Uint8Array;
  private readonly createResumeSecret: () => string;

  constructor(
    pool: SqlPool,
    private readonly persistence: PersistenceAuthority,
    private readonly recovery: PortableRecoveryAuthority,
    private readonly contentAuthority: PortableSaveContentAuthority,
    options: PortableRecoveryServiceOptions = {},
  ) {
    this.runner = new TransactionRunner(pool);
    this.createExportId = options.issueExportId ?? randomUUID;
    this.createCommitment = options.issueCommitment ?? (() => randomBytes(32));
    this.createResumeSecret = options.issueResumeSecret ?? issueResumeSecret;
  }

  async createExport(input: CreatePortableSaveInput): Promise<PortableSaveEnvelopeV1> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error("Expected export revision must be a non-negative safe integer.");
    }
    if (!Number.isSafeInteger(input.validityMs) || input.validityMs <= 0
      || input.validityMs > ADR_0003_PERSISTENCE_LIFECYCLE.portableExportMaximumLifetimeMs) {
      throw new Error("Portable save validity must be from one millisecond through exactly 29 days.");
    }
    const exportId = this.createExportId();
    validUuid(exportId, "exportId");
    const commitmentBytes = new Uint8Array(this.createCommitment());
    if (commitmentBytes.byteLength !== 32) throw new Error("Portable save commitments must contain exactly 256 bits.");

    return this.runner.run(async (client) => {
      const authenticated = await this.authenticateForUpdate(client, input.resumeSecret);
      await this.lockRecoveryReplayFences(client, [["save-export", exportId]]);
      let now = await this.persistence.assertTransactionReady(client);
      let keys: IntegrityKeyring;
      try {
        keys = await this.recovery.assertExportReady(client, now);
      } catch {
        throw invalidRecovery();
      }
      await this.assertReplayAvailable(client, "save-export", exportId, now);
      const progress = await this.lockProgress(client, authenticated.match.id);
      now = await this.persistence.assertTransactionReady(client);
      try {
        keys = await this.recovery.assertExportReady(client, now);
      } catch {
        throw invalidRecovery();
      }
      if (authenticated.match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      if (progress.revision !== input.expectedRevision) {
        throw new PortableRecoveryError(progress.revision > input.expectedRevision
          ? "RECOVERY_REVISION_STALE"
          : "RECOVERY_AUTHORITY_ROLLBACK");
      }
      let descriptor: PortableSaveContentDescriptor;
      try {
        descriptor = await this.contentAuthority.describe(progress);
      } catch {
        throw new PortableRecoveryError("RECOVERY_CONTENT_INCOMPATIBLE");
      }
      now = await this.persistence.assertTransactionReady(client);
      try {
        keys = await this.recovery.assertExportReady(client, now);
      } catch {
        throw invalidRecovery();
      }
      if (authenticated.match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      const savePayloadHash = hashText(sha256(
        PORTABLE_SAVE_PAYLOAD_DOMAIN,
        new TextEncoder().encode(canonicalJson(progress.checkpoint)),
      ));
      let claims: PortableSaveClaimsV1;
      try {
        claims = portableSaveClaims({
          domain: "samurai-sushi:portable-save:v1",
          schemaVersion: 1,
          exportId,
          subjectRevision: progress.revision,
          unlinkableClaimCommitment: Buffer.from(commitmentBytes).toString("base64url"),
          content: {
            contentVersion: progress.contentVersion,
            checkpointSchemaVersion: progress.checkpointSchemaVersion,
            pack: descriptor.pack,
            refs: descriptor.refs,
            savePayloadHash,
          },
          expiresAt: addMilliseconds(now, input.validityMs).toISOString(),
          integrity: {
            keyVersion: keys.active.version,
            keyIdentity: keys.active.keyIdentity,
            tag: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
        });
      } catch {
        throw new PortableRecoveryError("RECOVERY_CONTENT_INCOMPATIBLE");
      }
      const claimsBytes = canonicalClaimsBytes(claims);
      const signed = keys.sign(claimsBytes, now);
      const envelope = parsePortableSaveEnvelope({
        ...claims,
        integrity: { ...claims.integrity, tag: Buffer.from(signed.digest).toString("base64url") },
      });
      await client.query(
        `INSERT INTO samurai_persistence.save_exports
          (export_id, guest_session_id, subject_revision, content_version, checkpoint_schema_version,
           save_payload_hash, unlinkable_claim_commitment_hash, claims_hash,
           integrity_key_version, integrity_key_identity, integrity_tag, created_at, expires_at)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          exportId,
          authenticated.match.id,
          progress.revision,
          progress.contentVersion,
          progress.checkpointSchemaVersion,
          exactHashBytes(savePayloadHash),
          sha256(PORTABLE_SAVE_COMMITMENT_DOMAIN, commitmentBytes),
          sha256(PORTABLE_SAVE_CLAIMS_HASH_DOMAIN, claimsBytes),
          signed.keyVersion,
          keyIdentityBytes(signed.keyIdentity),
          signed.digest,
          now,
          new Date(envelope.expiresAt),
        ],
      );
      return envelope;
    });
  }

  async import(input: ImportPortableSaveInput): Promise<ImportedPortableSave> {
    try {
      validUuid(input.importId, "importId");
    } catch {
      throw invalidRecovery();
    }
    let envelope: PortableSaveEnvelopeV1;
    try {
      envelope = parsePortableSaveEnvelope(input.envelope);
    } catch {
      throw invalidRecovery();
    }
    const envelopeBytes = canonicalPortableSaveEnvelopeBytes(envelope);
    const claims = portableSaveClaims(envelope);
    const claimsBytes = canonicalClaimsBytes(claims);
    const requestHash = sha256(
      PORTABLE_SAVE_IMPORT_REQUEST_DOMAIN,
      new Uint8Array([...new TextEncoder().encode(`${input.importId}\n`), ...envelopeBytes]),
    );

    return this.runner.run(async (client) => {
      const owners = await client.query<OwnerRow>(
        `SELECT guest_session_id FROM samurai_persistence.save_exports WHERE export_id = $1::uuid
         UNION ALL
         SELECT guest_session_id FROM samurai_persistence.recovery_imports
          WHERE import_id = $2::uuid AND export_id = $1::uuid`,
        [envelope.exportId, input.importId],
      );
      if (owners.rows.length !== 1) throw invalidRecovery();
      const session = await this.sessions.lockById(client, owners.rows[0]!.guest_session_id);
      if (!session) throw invalidRecovery();
      await this.persistence.assertTransactionReady(client);
      await this.lockRecoveryReplayFences(client, [
        ["save-export", envelope.exportId],
        ["save-import", input.importId],
      ]);
      let now = await this.persistence.assertTransactionReady(client);

      const receiptResult = await client.query<ImportReceiptRow>(
        `SELECT import_id::text, guest_session_id, export_id::text, request_hash, committed_revision::text,
                integrity_key_version, integrity_key_identity,
                issued_digest_key_version, issued_digest_key_identity, issued_digest,
                delivery_generation::text, created_at, updated_at, original_export_expires_at, expires_at
           FROM samurai_persistence.recovery_imports
          WHERE import_id = $1::uuid
          FOR UPDATE`,
        [input.importId],
      );
      now = await this.persistence.assertTransactionReady(client);
      const receipt = receiptResult.rows[0];
      if (receipt) {
        return this.replayImport(client, session, receipt, envelope, claimsBytes, requestHash, now);
      }

      await this.assertReplayAvailable(client, "save-export", envelope.exportId, now);
      await this.assertReplayAvailable(client, "save-import", input.importId, now);
      const recordResult = await client.query<SaveExportRow>(
        `SELECT export_id::text, guest_session_id, subject_revision::text, content_version,
                checkpoint_schema_version, save_payload_hash, unlinkable_claim_commitment_hash,
                claims_hash, integrity_key_version, integrity_key_identity, integrity_tag,
                created_at, expires_at
           FROM samurai_persistence.save_exports
          WHERE export_id = $1::uuid AND guest_session_id = $2
          FOR UPDATE`,
        [envelope.exportId, session.id],
      );
      now = await this.persistence.assertTransactionReady(client);
      const stored = recordResult.rows[0];
      if (!stored) throw invalidRecovery();
      const siblings = await client.query<ExportReplayRow>(
        `SELECT export_id::text, expires_at
           FROM samurai_persistence.save_exports
          WHERE guest_session_id = $1
          ORDER BY export_id
          FOR UPDATE`,
        [session.id],
      );
      const progress = await this.lockProgress(client, session.id);
      const oldDigests = await client.query<ResumeDigestRow>(
        `SELECT slot, digest_key_version, digest_key_identity, digest
           FROM samurai_persistence.guest_resume_digests
          WHERE guest_session_id = $1
          ORDER BY slot
          FOR UPDATE`,
        [session.id],
      );
      now = await this.persistence.assertTransactionReady(client);
      let keys: IntegrityKeyring;
      try {
        keys = await this.recovery.assertImportReady(
          client,
          now,
          envelope.integrity.keyVersion,
          envelope.integrity.keyIdentity,
          stored.expires_at,
        );
      } catch {
        throw invalidRecovery();
      }
      if (session.expiresAt.getTime() <= now.getTime()) throw invalidRecovery();
      if (stored.expires_at.getTime() <= now.getTime() || new Date(envelope.expiresAt).getTime() <= now.getTime()) {
        throw new PortableRecoveryError("RECOVERY_EXPIRED");
      }
      this.assertStoredEnvelope(stored, envelope, claimsBytes, keys, now);
      const exportedRevision = Number(stored.subject_revision);
      if (progress.revision > exportedRevision) throw new PortableRecoveryError("RECOVERY_REVISION_STALE");
      if (progress.revision < exportedRevision) throw new PortableRecoveryError("RECOVERY_AUTHORITY_ROLLBACK");
      if (envelope.subjectRevision !== exportedRevision) throw invalidRecovery();
      await this.assertCurrentContent(progress, stored, envelope);

      now = await this.persistence.assertTransactionReady(client);
      try {
        keys = await this.recovery.assertImportReady(
          client,
          now,
          envelope.integrity.keyVersion,
          envelope.integrity.keyIdentity,
          stored.expires_at,
        );
      } catch {
        throw invalidRecovery();
      }
      if (session.expiresAt.getTime() <= now.getTime()
        || stored.expires_at.getTime() <= now.getTime()
        || new Date(envelope.expiresAt).getTime() <= now.getTime()) {
        throw new PortableRecoveryError("RECOVERY_EXPIRED");
      }
      this.assertStoredEnvelope(stored, envelope, claimsBytes, keys, now);

      const replacementCredential = await this.allocateReplacementCredential(client, async (candidateNow) => {
        let candidateKeys: IntegrityKeyring;
        try {
          candidateKeys = await this.recovery.assertImportReady(
            client,
            candidateNow,
            envelope.integrity.keyVersion,
            envelope.integrity.keyIdentity,
            stored.expires_at,
          );
        } catch {
          throw invalidRecovery();
        }
        if (session.expiresAt.getTime() <= candidateNow.getTime()
          || stored.expires_at.getTime() <= candidateNow.getTime()
          || new Date(envelope.expiresAt).getTime() <= candidateNow.getTime()) {
          throw new PortableRecoveryError("RECOVERY_EXPIRED");
        }
        this.assertStoredEnvelope(stored, envelope, claimsBytes, candidateKeys, candidateNow);
      });
      const { secret: replacementSecret, digest: replacement, now: writeNow } = replacementCredential;
      await client.query("DELETE FROM samurai_persistence.save_exports WHERE guest_session_id = $1", [session.id]);
      await client.query("DELETE FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1", [session.id]);
      await this.insertCurrentDigest(client, session.id, replacement);
      await this.touchRecoveredSession(client, session, writeNow);
      await client.query(
        `INSERT INTO samurai_persistence.recovery_imports
          (import_id, guest_session_id, export_id, request_hash, committed_revision,
           integrity_key_version, integrity_key_identity,
           issued_digest_key_version, issued_digest_key_identity, issued_digest,
           delivery_generation, created_at, updated_at, original_export_expires_at, expires_at)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10, 1, $11, $11, $12, $13)`,
        [
          input.importId,
          session.id,
          envelope.exportId,
          requestHash,
          progress.revision,
          stored.integrity_key_version,
          stored.integrity_key_identity,
          replacement.keyVersion,
          keyIdentityBytes(replacement.keyIdentity),
          replacement.digest,
          writeNow,
          stored.expires_at,
          replayExpiry(stored.expires_at),
        ],
      );
      for (const digest of oldDigests.rows) {
        await this.insertTombstone(
          client,
          "guest-session",
          `resume:v${digest.digest_key_version}:${Buffer.from(digest.digest).toString("base64url")}`,
          writeNow,
          addMilliseconds(writeNow, ADR_0003_PERSISTENCE_LIFECYCLE.tombstoneLifetimeMs),
          digest,
        );
      }
      for (const item of siblings.rows) {
        await this.insertTombstone(
          client,
          "save-export",
          replayKey("save-export", item.export_id),
          writeNow,
          replayExpiry(item.expires_at),
        );
      }
      await this.insertTombstone(
        client,
        "save-import",
        replayKey("save-import", input.importId),
        writeNow,
        replayExpiry(stored.expires_at),
      );
      await this.persistence.assertGuestSecretNotTombstoned(client, replacementSecret, writeNow);
      return {
        disposition: "committed",
        guestSessionId: session.id,
        revision: progress.revision,
        rotatedResumeSecret: replacementSecret,
      };
    });
  }

  async deleteExpired(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Portable recovery cleanup limit must be an integer from 1 through 1000.");
    }
    return this.runner.run(async (client) => {
      const initialNow = await this.persistence.assertRetentionTransactionReady(client);
      const candidates = await client.query<OwnerRow & ExportReplayRow>(
        `SELECT guest_session_id, export_id::text, expires_at
           FROM samurai_persistence.save_exports
          WHERE expires_at <= $1
          ORDER BY expires_at, export_id
          LIMIT $2`,
        [initialNow, limit],
      );
      let removed = 0;
      for (const candidate of candidates.rows) {
        const session = await this.sessions.lockById(client, candidate.guest_session_id);
        await this.persistence.assertRetentionTransactionReady(client);
        if (!session) continue;
        const locked = await client.query<ExportReplayRow>(
          `SELECT export_id::text, expires_at
             FROM samurai_persistence.save_exports
            WHERE export_id = $1::uuid AND guest_session_id = $2
            FOR UPDATE`,
          [candidate.export_id, candidate.guest_session_id],
        );
        const writeNow = await this.persistence.assertRetentionTransactionReady(client);
        const row = locked.rows[0];
        if (!row || row.expires_at.getTime() > writeNow.getTime()) continue;
        await client.query("DELETE FROM samurai_persistence.save_exports WHERE export_id = $1::uuid", [row.export_id]);
        await this.insertTombstone(
          client,
          "save-export",
          replayKey("save-export", row.export_id),
          writeNow,
          replayExpiry(row.expires_at),
        );
        removed += 1;
      }
      const receiptClock = await this.persistence.assertRetentionTransactionReady(client);
      const receipts = await client.query<ImportCleanupRow>(
        `SELECT guest_session_id, import_id::text, expires_at
           FROM samurai_persistence.recovery_imports
          WHERE expires_at <= $1
          ORDER BY expires_at, import_id
          LIMIT $2`,
        [receiptClock, limit],
      );
      for (const candidate of receipts.rows) {
        const session = await this.sessions.lockById(client, candidate.guest_session_id);
        await this.persistence.assertRetentionTransactionReady(client);
        if (!session) continue;
        const locked = await client.query<Pick<ImportCleanupRow, "import_id" | "expires_at">>(
          `SELECT import_id::text, expires_at
             FROM samurai_persistence.recovery_imports
            WHERE import_id = $1::uuid AND guest_session_id = $2
            FOR UPDATE`,
          [candidate.import_id, candidate.guest_session_id],
        );
        const deleteNow = await this.persistence.assertRetentionTransactionReady(client);
        const row = locked.rows[0];
        if (!row || row.expires_at.getTime() > deleteNow.getTime()) continue;
        await client.query("DELETE FROM samurai_persistence.recovery_imports WHERE import_id = $1::uuid", [row.import_id]);
      }
      return removed;
    });
  }

  async purgeUnavailableIntegrityReferences(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Portable recovery purge limit must be an integer from 1 through 1000.");
    }
    return this.runner.run(async (client) => {
      const initialNow = await this.persistence.assertRetentionTransactionReady(client);
      const exportFilter = this.unavailableIntegrityFilter(initialNow);
      const exports = await client.query<IntegrityPurgeRow>(
        `SELECT guest_session_id, export_id::text AS reference_id,
                integrity_key_version, integrity_key_identity, expires_at
           FROM samurai_persistence.save_exports
          WHERE ${exportFilter.sql}
          ORDER BY expires_at, export_id
          LIMIT $${exportFilter.values.length + 1}`,
        [...exportFilter.values, limit],
      );
      let removed = 0;
      for (const candidate of exports.rows) {
        const session = await this.sessions.lockById(client, candidate.guest_session_id);
        await this.persistence.assertRetentionTransactionReady(client);
        if (!session) continue;
        const locked = await client.query<IntegrityPurgeRow>(
          `SELECT guest_session_id, export_id::text AS reference_id,
                  integrity_key_version, integrity_key_identity, expires_at
             FROM samurai_persistence.save_exports
            WHERE export_id = $1::uuid AND guest_session_id = $2
            FOR UPDATE`,
          [candidate.reference_id, candidate.guest_session_id],
        );
        const writeNow = await this.persistence.assertRetentionTransactionReady(client);
        const row = locked.rows[0];
        if (!row || this.recovery.isVerificationAvailable(
          row.integrity_key_version,
          row.integrity_key_identity,
          writeNow,
        )) continue;
        await client.query("DELETE FROM samurai_persistence.save_exports WHERE export_id = $1::uuid", [row.reference_id]);
        await this.insertTombstone(
          client,
          "save-export",
          replayKey("save-export", row.reference_id),
          writeNow,
          replayExpiry(row.expires_at),
        );
        removed += 1;
      }

      const remaining = limit - removed;
      if (remaining <= 0) return removed;
      const receiptNow = await this.persistence.assertRetentionTransactionReady(client);
      const receiptFilter = this.unavailableIntegrityFilter(receiptNow);
      const receipts = await client.query<IntegrityPurgeRow>(
        `SELECT guest_session_id, import_id::text AS reference_id,
                integrity_key_version, integrity_key_identity, expires_at
           FROM samurai_persistence.recovery_imports
          WHERE ${receiptFilter.sql}
          ORDER BY expires_at, import_id
          LIMIT $${receiptFilter.values.length + 1}`,
        [...receiptFilter.values, remaining],
      );
      for (const candidate of receipts.rows) {
        const session = await this.sessions.lockById(client, candidate.guest_session_id);
        await this.persistence.assertRetentionTransactionReady(client);
        if (!session) continue;
        const locked = await client.query<IntegrityPurgeRow>(
          `SELECT guest_session_id, import_id::text AS reference_id,
                  integrity_key_version, integrity_key_identity, expires_at
             FROM samurai_persistence.recovery_imports
            WHERE import_id = $1::uuid AND guest_session_id = $2
            FOR UPDATE`,
          [candidate.reference_id, candidate.guest_session_id],
        );
        const writeNow = await this.persistence.assertRetentionTransactionReady(client);
        const row = locked.rows[0];
        if (!row || this.recovery.isVerificationAvailable(
          row.integrity_key_version,
          row.integrity_key_identity,
          writeNow,
        )) continue;
        await client.query("DELETE FROM samurai_persistence.recovery_imports WHERE import_id = $1::uuid", [row.reference_id]);
        await this.insertTombstone(
          client,
          "save-import",
          replayKey("save-import", row.reference_id),
          writeNow,
          row.expires_at,
        );
        removed += 1;
      }
      return removed;
    });
  }

  private async replayImport(
    client: SqlClient,
    session: GuestSessionRecord,
    receipt: ImportReceiptRow,
    envelope: PortableSaveEnvelopeV1,
    claimsBytes: Uint8Array,
    requestHash: Uint8Array,
    now: Date,
  ): Promise<ImportedPortableSave> {
    if (receipt.guest_session_id !== session.id || receipt.export_id !== envelope.exportId
      || Number(receipt.committed_revision) !== envelope.subjectRevision
      || receipt.original_export_expires_at.getTime() !== new Date(envelope.expiresAt).getTime()
      || !constantTimeDigestEqual(receipt.request_hash, requestHash)) {
      throw new PortableRecoveryError("RECOVERY_IDEMPOTENCY_MISMATCH");
    }
    if (receipt.original_export_expires_at.getTime() <= now.getTime()
      || session.expiresAt.getTime() <= now.getTime()) {
      throw new PortableRecoveryError("RECOVERY_ALREADY_CONSUMED");
    }
    let keys: IntegrityKeyring;
    try {
      keys = await this.recovery.assertImportReady(
        client,
        now,
        envelope.integrity.keyVersion,
        envelope.integrity.keyIdentity,
        receipt.original_export_expires_at,
      );
      if (receipt.integrity_key_version !== envelope.integrity.keyVersion
        || keyIdentityFromBytes(receipt.integrity_key_identity) !== envelope.integrity.keyIdentity
        || !keys.verify(
          claimsBytes,
          Buffer.from(envelope.integrity.tag, "base64url"),
          envelope.integrity.keyVersion,
          envelope.integrity.keyIdentity,
          now,
        )) throw invalidRecovery();
    } catch {
      throw invalidRecovery();
    }
    const progress = await this.lockProgress(client, session.id);
    const current = await client.query<ResumeDigestRow>(
      `SELECT slot, digest_key_version, digest_key_identity, digest
         FROM samurai_persistence.guest_resume_digests
        WHERE guest_session_id = $1
        ORDER BY slot
        FOR UPDATE`,
      [session.id],
    );
    const writeNow = await this.persistence.assertTransactionReady(client);
    try {
      keys = await this.recovery.assertImportReady(
        client,
        writeNow,
        envelope.integrity.keyVersion,
        envelope.integrity.keyIdentity,
        receipt.original_export_expires_at,
      );
      if (!keys.verify(
        claimsBytes,
        Buffer.from(envelope.integrity.tag, "base64url"),
        envelope.integrity.keyVersion,
        envelope.integrity.keyIdentity,
        writeNow,
      )) throw invalidRecovery();
    } catch {
      throw invalidRecovery();
    }
    if (receipt.original_export_expires_at.getTime() <= writeNow.getTime()
      || session.expiresAt.getTime() <= writeNow.getTime()) {
      throw new PortableRecoveryError("RECOVERY_ALREADY_CONSUMED");
    }
    if (progress.revision !== Number(receipt.committed_revision) || current.rows.length !== 1) {
      throw new PortableRecoveryError("RECOVERY_ALREADY_CONSUMED");
    }
    const issued = current.rows[0]!;
    if (issued.slot !== "current"
      || issued.digest_key_version !== receipt.issued_digest_key_version
      || !constantTimeDigestEqual(issued.digest_key_identity, receipt.issued_digest_key_identity)
      || !constantTimeDigestEqual(issued.digest, receipt.issued_digest)) {
      throw new PortableRecoveryError("RECOVERY_ALREADY_CONSUMED");
    }
    const replacementCredential = await this.allocateReplacementCredential(client, async (candidateNow) => {
      let candidateKeys: IntegrityKeyring;
      try {
        candidateKeys = await this.recovery.assertImportReady(
          client,
          candidateNow,
          envelope.integrity.keyVersion,
          envelope.integrity.keyIdentity,
          receipt.original_export_expires_at,
        );
        if (!candidateKeys.verify(
          claimsBytes,
          Buffer.from(envelope.integrity.tag, "base64url"),
          envelope.integrity.keyVersion,
          envelope.integrity.keyIdentity,
          candidateNow,
        )) throw invalidRecovery();
      } catch {
        throw invalidRecovery();
      }
      if (receipt.original_export_expires_at.getTime() <= candidateNow.getTime()
        || session.expiresAt.getTime() <= candidateNow.getTime()) {
        throw new PortableRecoveryError("RECOVERY_ALREADY_CONSUMED");
      }
    });
    const { secret: replacementSecret, digest: replacement, now: replacementNow } = replacementCredential;
    await client.query("DELETE FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1", [session.id]);
    await this.insertCurrentDigest(client, session.id, replacement);
    await this.touchRecoveredSession(client, session, replacementNow);
    await client.query(
      `UPDATE samurai_persistence.recovery_imports
          SET issued_digest_key_version = $2,
              issued_digest_key_identity = $3,
              issued_digest = $4,
              delivery_generation = delivery_generation + 1,
              updated_at = $5
        WHERE import_id = $1::uuid`,
      [receipt.import_id, replacement.keyVersion, keyIdentityBytes(replacement.keyIdentity), replacement.digest, replacementNow],
    );
    await this.insertTombstone(
      client,
      "guest-session",
      `resume:v${issued.digest_key_version}:${Buffer.from(issued.digest).toString("base64url")}`,
      replacementNow,
      addMilliseconds(replacementNow, ADR_0003_PERSISTENCE_LIFECYCLE.tombstoneLifetimeMs),
      issued,
    );
    await this.persistence.assertGuestSecretNotTombstoned(client, replacementSecret, replacementNow);
    return {
      disposition: "replayed",
      guestSessionId: session.id,
      revision: progress.revision,
      rotatedResumeSecret: replacementSecret,
    };
  }

  private assertStoredEnvelope(
    stored: SaveExportRow,
    envelope: PortableSaveEnvelopeV1,
    claimsBytes: Uint8Array,
    keys: IntegrityKeyring,
    now: Date,
  ): void {
    const claimsHash = sha256(PORTABLE_SAVE_CLAIMS_HASH_DOMAIN, claimsBytes);
    const commitmentHash = sha256(
      PORTABLE_SAVE_COMMITMENT_DOMAIN,
      Buffer.from(envelope.unlinkableClaimCommitment, "base64url"),
    );
    try {
      if (stored.export_id !== envelope.exportId
        || Number(stored.subject_revision) !== envelope.subjectRevision
        || stored.expires_at.getTime() !== new Date(envelope.expiresAt).getTime()
        || !constantTimeDigestEqual(stored.claims_hash, claimsHash)
        || !constantTimeDigestEqual(stored.unlinkable_claim_commitment_hash, commitmentHash)
        || stored.integrity_key_version !== envelope.integrity.keyVersion
        || keyIdentityFromBytes(stored.integrity_key_identity) !== envelope.integrity.keyIdentity
        || !constantTimeDigestEqual(stored.integrity_tag, Buffer.from(envelope.integrity.tag, "base64url"))
        || !keys.verify(
          claimsBytes,
          Buffer.from(envelope.integrity.tag, "base64url"),
          envelope.integrity.keyVersion,
          envelope.integrity.keyIdentity,
          now,
        )) throw invalidRecovery();
    } catch {
      throw invalidRecovery();
    }
  }

  private async assertCurrentContent(
    progress: GuestProgressRecord,
    stored: SaveExportRow,
    envelope: PortableSaveEnvelopeV1,
  ): Promise<void> {
    const currentPayloadHash = sha256(
      PORTABLE_SAVE_PAYLOAD_DOMAIN,
      new TextEncoder().encode(canonicalJson(progress.checkpoint)),
    );
    let descriptor: PortableSaveContentDescriptor;
    try {
      descriptor = await this.contentAuthority.describe(progress);
    } catch {
      throw new PortableRecoveryError("RECOVERY_CONTENT_INCOMPATIBLE");
    }
    let compatible = false;
    try {
      compatible = stored.content_version === progress.contentVersion
        && stored.checkpoint_schema_version === progress.checkpointSchemaVersion
        && envelope.content.contentVersion === progress.contentVersion
        && envelope.content.checkpointSchemaVersion === progress.checkpointSchemaVersion
        && canonicalJson(descriptor.pack) === canonicalJson(envelope.content.pack)
        && canonicalJson(descriptor.refs) === canonicalJson(envelope.content.refs)
        && constantTimeDigestEqual(stored.save_payload_hash, currentPayloadHash)
        && constantTimeDigestEqual(exactHashBytes(envelope.content.savePayloadHash), currentPayloadHash);
    } catch {
      throw new PortableRecoveryError("RECOVERY_CONTENT_INCOMPATIBLE");
    }
    if (!compatible) {
      throw new PortableRecoveryError("RECOVERY_CONTENT_INCOMPATIBLE");
    }
  }

  private async authenticateForUpdate(
    client: SqlClient,
    secret: string,
  ): Promise<{ readonly match: ResumeMatch; readonly now: Date }> {
    const initialNow = await this.persistence.assertTransactionReady(client);
    let candidates;
    try {
      candidates = this.persistence.resumeKeys.candidates(secret, initialNow);
    } catch (error) {
      if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
      throw error;
    }
    await this.persistence.lockGuestSecretReplayFence(client, secret, initialNow);
    const match = await this.sessions.findResumeMatchForUpdate(client, candidates);
    const now = await this.persistence.assertTransactionReady(client);
    try {
      candidates = this.persistence.resumeKeys.candidates(secret, now);
      await this.persistence.assertGuestSecretNotTombstoned(client, secret, now);
    } catch (error) {
      if (error instanceof GuestSecretFormatError
        || (error instanceof PersistenceError && error.code === "GUEST_SECRET_TOMBSTONED")) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      throw error;
    }
    if (!match || !candidateMatches(match, candidates)) throw new GuestResumeError("GUEST_RESUME_INVALID");
    if (match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
    if (match.slot === "predecessor" && (!match.digestValidUntil || match.digestValidUntil.getTime() <= now.getTime())) {
      throw new GuestResumeError("GUEST_RESUME_INVALID");
    }
    return { match, now };
  }

  private async lockProgress(client: SqlClient, guestSessionId: string): Promise<GuestProgressRecord> {
    const progress = await this.progress.lock<Readonly<Record<string, unknown>>>(client, guestSessionId);
    if (!progress) throw invalidRecovery();
    return progress;
  }

  private async lockRecoveryReplayFences(
    client: SqlClient,
    entries: readonly (readonly ["save-export" | "save-import", string])[],
  ): Promise<void> {
    const scopes = entries.map(([kind, id]) => `portable-recovery-replay:${kind}:${id}`).sort();
    for (const scope of scopes) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
    }
  }

  private async assertReplayAvailable(
    client: SqlClient,
    kind: "save-export" | "save-import",
    id: string,
    now: Date,
  ): Promise<void> {
    for (const candidate of this.persistence.tombstoneKeys.replayCandidates(kind, replayKey(kind, id), now)) {
      const found = await client.query<{ readonly found: number }>(
        `SELECT 1 AS found
           FROM samurai_persistence.deletion_tombstones
          WHERE kind = $1 AND digest_key_version = $2 AND digest_key_identity = $3
            AND tombstone_digest = $4 AND expires_at > $5
          LIMIT 1`,
        [kind, candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest, now],
      );
      if (found.rows[0]) throw new PortableRecoveryError("RECOVERY_ALREADY_CONSUMED");
    }
  }

  private issueReplacementSecret(): string {
    const secret = this.createResumeSecret();
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || Buffer.from(secret, "base64url").byteLength !== 32) {
      throw new Error("Portable recovery issued a non-canonical resume secret.");
    }
    return secret;
  }

  private unavailableIntegrityFilter(
    now: Date,
  ): { readonly sql: string; readonly values: readonly (number | Uint8Array)[] } {
    const pairs = this.recovery.verificationPairs(now);
    if (pairs.length === 0) return { sql: "TRUE", values: [] };
    const values: Array<number | Uint8Array> = [];
    const available = pairs.map((pair) => {
      const versionParameter = values.push(pair.version);
      const identityParameter = values.push(pair.identity);
      return `(integrity_key_version = $${versionParameter} AND integrity_key_identity = $${identityParameter})`;
    });
    return { sql: `NOT (${available.join(" OR ")})`, values };
  }

  private async allocateReplacementCredential(
    client: SqlClient,
    revalidate: (now: Date) => Promise<void>,
  ): Promise<ReplacementCredential> {
    for (let attempt = 0; attempt < REPLACEMENT_SECRET_ATTEMPTS; attempt += 1) {
      const secret = this.issueReplacementSecret();
      const beforeLock = await this.persistence.assertTransactionReady(client);
      await this.persistence.lockGuestSecretReplayFence(client, secret, beforeLock);
      const now = await this.persistence.assertTransactionReady(client);
      await revalidate(now);
      try {
        await this.persistence.assertGuestSecretNotTombstoned(client, secret, now);
      } catch (error) {
        if (error instanceof PersistenceError && error.code === "GUEST_SECRET_TOMBSTONED") continue;
        throw error;
      }
      const digest = this.persistence.resumeKeys.digest(secret, now);
      const collision = await client.query<{ readonly found: number }>(
        `SELECT 1 AS found
           FROM samurai_persistence.guest_resume_digests
          WHERE digest_key_version = $1 AND digest_key_identity = $2 AND digest = $3
          LIMIT 1`,
        [digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
      );
      if (!collision.rows[0]) return { secret, digest, now };
    }
    throw new PersistenceError(
      "RECOVERY_SECRET_ALLOCATION_FAILED",
      "Portable recovery could not allocate a fresh resume credential.",
    );
  }

  private async insertCurrentDigest(
    client: SqlClient,
    guestSessionId: string,
    digest: ReturnType<PersistenceAuthority["resumeKeys"]["digest"]>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO samurai_persistence.guest_resume_digests
        (guest_session_id, slot, digest_key_version, digest_key_identity, digest, valid_until)
       VALUES ($1, 'current', $2, $3, $4, NULL)`,
      [guestSessionId, digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
    );
  }

  private async touchRecoveredSession(client: SqlClient, session: GuestSessionRecord, now: Date): Promise<void> {
    await client.query(
      `UPDATE samurai_persistence.guest_sessions
          SET last_seen_at = $2, rotate_after = $3
        WHERE id = $1`,
      [session.id, now, nextRotateAfter(session, now)],
    );
  }

  private async insertTombstone(
    client: SqlClient,
    kind: TombstoneKind,
    key: string,
    now: Date,
    expiresAt: Date,
    resumeDigest?: ResumeDigestRow,
  ): Promise<void> {
    if (expiresAt.getTime() <= now.getTime()) return;
    const tombstone = this.persistence.tombstoneKeys.digest(kind, key, now);
    await client.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         resume_digest_key_version, resume_digest_key_identity, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (kind, digest_key_version, digest_key_identity, tombstone_digest) DO UPDATE
         SET expires_at = GREATEST(samurai_persistence.deletion_tombstones.expires_at, EXCLUDED.expires_at)`,
      [
        kind,
        tombstone.keyVersion,
        keyIdentityBytes(tombstone.keyIdentity),
        tombstone.digest,
        resumeDigest?.digest_key_version ?? null,
        resumeDigest?.digest_key_identity ?? null,
        now,
        expiresAt,
      ],
    );
  }
}
