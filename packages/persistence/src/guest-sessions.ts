import { randomUUID } from "node:crypto";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import {
  constantTimeDigestEqual,
  type GuestClaimKeyring,
  GuestSecretFormatError,
  issueCapabilitySecret,
  issueResumeSecret,
  keyIdentityBytes,
  type TombstoneKind,
} from "./crypto";
import { GuestResumeError, GuestRotationDeferredError, PersistenceError } from "./errors";
import {
  addMilliseconds,
  ADR_0003_PERSISTENCE_LIFECYCLE,
  assertPersistenceLifecycle,
} from "./lifecycle";
import type { PersistenceAuthority } from "./key-inventory";
import { GuestSessionRepository } from "./repositories";
import type { GuestProgressRecord, GuestSessionRecord, ResumeMatch } from "./repositories";

export interface GuestSessionPolicy {
  readonly idleAndAbsoluteLifetimeMs: number;
  readonly rotationIntervalMs: number;
  readonly predecessorGraceMs: number;
  readonly tombstoneLifetimeMs: number;
}

export const ADR_0003_GUEST_SESSION_POLICY: GuestSessionPolicy = {
  idleAndAbsoluteLifetimeMs: ADR_0003_PERSISTENCE_LIFECYCLE.sessionLifetimeMs,
  rotationIntervalMs: 7 * 24 * 60 * 60 * 1_000,
  predecessorGraceMs: ADR_0003_PERSISTENCE_LIFECYCLE.predecessorGraceMs,
  tombstoneLifetimeMs: ADR_0003_PERSISTENCE_LIFECYCLE.tombstoneLifetimeMs,
};

export interface IssueGuestInput<Checkpoint extends Readonly<Record<string, unknown>>> {
  readonly consentVersion: string;
  readonly contentVersion: string;
  readonly checkpointSchemaVersion: number;
  readonly checkpoint: Checkpoint;
}

export interface IssuedGuest<Checkpoint extends Readonly<Record<string, unknown>>> {
  readonly session: GuestSessionRecord;
  readonly progress: GuestProgressRecord<Checkpoint>;
  readonly resumeSecret: string;
  /** Present when Stage 3 claim authority is configured; returned once and never stored raw. */
  readonly claimCapability?: string;
}

export interface ResumedGuest {
  readonly session: GuestSessionRecord;
  readonly rotatedResumeSecret?: string;
}

export interface RotatedGuestClaimCapability {
  readonly claimCapability: string;
  readonly expiresAt: Date;
}

interface CommandKeyRow {
  readonly idempotency_key: string;
}

interface ExpiredSessionRow {
  readonly id: string;
}

interface ResumeDigestRow {
  readonly digest_key_version: number;
  readonly digest_key_identity: Uint8Array;
  readonly digest: Uint8Array;
}

interface SaveExportRow {
  readonly export_id: string;
  readonly expires_at: Date;
}
interface SaveImportRow {
  readonly import_id: string;
  readonly expires_at: Date;
}
interface ClaimCapabilityRow extends ResumeDigestRow {
  readonly expires_at: Date;
}
interface ClaimChallengeRow {
  readonly challenge_hash: Uint8Array;
  readonly nonce_digest: Uint8Array;
  readonly expires_at: Date;
}

export interface GuestSessionServiceOptions {
  readonly issueId?: () => string;
  readonly issueSecret?: () => string;
  readonly claimKeys?: GuestClaimKeyring;
  readonly issueClaimCapability?: () => string;
  readonly policy?: GuestSessionPolicy;
}

function sessionFromMatch(match: ResumeMatch): GuestSessionRecord {
  return {
    id: match.id,
    consentVersion: match.consentVersion,
    createdAt: match.createdAt,
    lastSeenAt: match.lastSeenAt,
    expiresAt: match.expiresAt,
    rotateAfter: match.rotateAfter,
  };
}

function mapDeletedSecretToInvalid(error: unknown): never {
  if (error instanceof PersistenceError && error.code === "GUEST_SECRET_TOMBSTONED") {
    throw new GuestResumeError("GUEST_RESUME_INVALID");
  }
  throw error;
}

export class GuestSessionService {
  private readonly runner: TransactionRunner;
  private readonly repository = new GuestSessionRepository();
  private readonly createId: () => string;
  private readonly createSecret: () => string;
  private readonly createClaimCapability: () => string;
  private readonly claimKeys: GuestClaimKeyring | undefined;
  private readonly policy: GuestSessionPolicy;

  constructor(
    pool: SqlPool,
    private readonly authority: PersistenceAuthority,
    options: GuestSessionServiceOptions = {},
  ) {
    this.runner = new TransactionRunner(pool);
    this.createId = options.issueId ?? randomUUID;
    this.createSecret = options.issueSecret ?? issueResumeSecret;
    this.createClaimCapability = options.issueClaimCapability ?? issueCapabilitySecret;
    this.claimKeys = options.claimKeys;
    this.policy = options.policy ?? ADR_0003_GUEST_SESSION_POLICY;
    assertPersistenceLifecycle({
      ...ADR_0003_PERSISTENCE_LIFECYCLE,
      sessionLifetimeMs: this.policy.idleAndAbsoluteLifetimeMs,
      predecessorGraceMs: this.policy.predecessorGraceMs,
      tombstoneLifetimeMs: this.policy.tombstoneLifetimeMs,
    });
  }

  async issue<Checkpoint extends Readonly<Record<string, unknown>>>(
    input: IssueGuestInput<Checkpoint>,
  ): Promise<IssuedGuest<Checkpoint>> {
    const secret = this.createSecret();
    return this.runner.run(async (client) => {
      const initialNow = await this.authority.assertTransactionReady(client);
      await this.authority.lockGuestSecretReplayFence(client, secret, initialNow);
      let now = await this.authority.assertTransactionReady(client);
      await this.authority.assertGuestSecretNotTombstoned(client, secret, now);
      const issuedCapability = this.claimKeys
        ? await this.issueFreshClaimCapability(client)
        : undefined;
      if (issuedCapability) {
        now = issuedCapability.now;
        await this.authority.assertGuestSecretNotTombstoned(client, secret, now);
      }
      const session: GuestSessionRecord = {
        id: this.createId(),
        consentVersion: input.consentVersion,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: addMilliseconds(now, this.policy.idleAndAbsoluteLifetimeMs),
        rotateAfter: addMilliseconds(now, this.policy.rotationIntervalMs),
      };
      const progress: GuestProgressRecord<Checkpoint> = {
        guestSessionId: session.id,
        revision: 0,
        contentVersion: input.contentVersion,
        checkpointSchemaVersion: input.checkpointSchemaVersion,
        checkpoint: input.checkpoint,
        createdAt: now,
        updatedAt: now,
      };
      await this.repository.insert(client, session, this.authority.resumeKeys.digest(secret, now), progress);
      if (issuedCapability) {
        await client.query(
          `INSERT INTO samurai_persistence.guest_claim_capabilities
            (guest_session_id, digest_key_version, digest_key_identity, digest, created_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [session.id, issuedCapability.digest.keyVersion, keyIdentityBytes(issuedCapability.digest.keyIdentity),
            issuedCapability.digest.digest, now, session.expiresAt],
        );
      }
      await this.authority.assertGuestSecretNotTombstoned(client, secret, now);
      return {
        session,
        progress,
        resumeSecret: secret,
        ...(issuedCapability ? { claimCapability: issuedCapability.secret } : {}),
      };
    });
  }

  async resume(secret: string): Promise<ResumedGuest> {
    return this.runner.run(async (client) => {
      const initialNow = await this.authority.assertTransactionReady(client);
      let candidates;
      try {
        candidates = this.authority.resumeKeys.candidates(secret, initialNow);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        throw error;
      }
      try {
        await this.authority.assertGuestSecretNotTombstoned(client, secret, initialNow);
      } catch (error) {
        mapDeletedSecretToInvalid(error);
      }
      const match = await this.repository.findResumeMatchForUpdate(client, candidates);
      const now = await this.authority.assertTransactionReady(client);
      try {
        candidates = this.authority.resumeKeys.candidates(secret, now);
        await this.authority.assertGuestSecretNotTombstoned(client, secret, now);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        mapDeletedSecretToInvalid(error);
      }
      if (!match) throw new GuestResumeError("GUEST_RESUME_INVALID");
      const candidate = candidates.find((item) => (
        item.keyVersion === match.digestKeyVersion
        && item.keyIdentity === match.digestKeyIdentity
      ));
      if (!candidate || !constantTimeDigestEqual(candidate.digest, match.digest)) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      if (match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      if (match.slot === "predecessor" && (!match.digestValidUntil || match.digestValidUntil.getTime() <= now.getTime())) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      if (match.slot === "predecessor") {
        await this.repository.touch(client, match.id, now);
        return { session: { ...sessionFromMatch(match), lastSeenAt: now } };
      }
      const mustRotate =
        match.digestKeyVersion !== this.authority.resumeKeys.active.version ||
        match.rotateAfter.getTime() <= now.getTime();
      if (!mustRotate) {
        await this.repository.touch(client, match.id, now);
        return { session: { ...sessionFromMatch(match), lastSeenAt: now } };
      }
      if (await this.repository.livePredecessorUntil(client, match.id, now)) {
        await this.repository.touch(client, match.id, now);
        return { session: { ...sessionFromMatch(match), lastSeenAt: now } };
      }
      const rotatedResumeSecret = this.createSecret();
      const rotateAfter = addMilliseconds(now, this.policy.rotationIntervalMs);
      await this.repository.rotate(
        client,
        match.id,
        this.authority.resumeKeys.digest(rotatedResumeSecret, now),
        addMilliseconds(now, this.policy.predecessorGraceMs),
        rotateAfter,
        now,
      );
      return {
        session: { ...sessionFromMatch(match), lastSeenAt: now, rotateAfter },
        rotatedResumeSecret,
      };
    });
  }

  async rotate(secret: string): Promise<ResumedGuest & { readonly rotatedResumeSecret: string }> {
    return this.runner.run(async (client) => {
      const initialNow = await this.authority.assertTransactionReady(client);
      try {
        await this.authority.assertGuestSecretNotTombstoned(client, secret, initialNow);
      } catch (error) {
        mapDeletedSecretToInvalid(error);
      }
      let candidates;
      try {
        candidates = this.authority.resumeKeys.candidates(secret, initialNow);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        throw error;
      }
      const match = await this.repository.findResumeMatchForUpdate(client, candidates);
      const now = await this.authority.assertTransactionReady(client);
      try {
        candidates = this.authority.resumeKeys.candidates(secret, now);
        await this.authority.assertGuestSecretNotTombstoned(client, secret, now);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        mapDeletedSecretToInvalid(error);
      }
      if (!match) throw new GuestResumeError("GUEST_RESUME_INVALID");
      const candidate = candidates.find((item) => (
        item.keyVersion === match.digestKeyVersion
        && item.keyIdentity === match.digestKeyIdentity
      ));
      if (!candidate || !constantTimeDigestEqual(candidate.digest, match.digest)) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      if (match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      const predecessorUntil = match.slot === "predecessor"
        ? match.digestValidUntil
        : await this.repository.livePredecessorUntil(client, match.id, now);
      if (predecessorUntil && predecessorUntil.getTime() > now.getTime()) {
        throw new GuestRotationDeferredError(predecessorUntil.getTime());
      }
      if (match.slot !== "current") throw new GuestResumeError("GUEST_RESUME_INVALID");
      const rotatedResumeSecret = this.createSecret();
      const rotateAfter = addMilliseconds(now, this.policy.rotationIntervalMs);
      await this.repository.rotate(
        client,
        match.id,
        this.authority.resumeKeys.digest(rotatedResumeSecret, now),
        addMilliseconds(now, this.policy.predecessorGraceMs),
        rotateAfter,
        now,
      );
      return {
        session: { ...sessionFromMatch(match), lastSeenAt: now, rotateAfter },
        rotatedResumeSecret,
      };
    });
  }

  async delete(secret: string): Promise<void> {
    await this.runner.run(async (client) => {
      const initialNow = await this.authority.assertTransactionReady(client);
      let candidates;
      try {
        candidates = this.authority.resumeKeys.candidates(secret, initialNow);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        throw error;
      }
      await this.authority.lockGuestSecretReplayFence(client, secret, initialNow);
      try {
        await this.authority.assertGuestSecretNotTombstoned(client, secret, initialNow);
      } catch (error) {
        mapDeletedSecretToInvalid(error);
      }
      const match = await this.repository.findResumeMatchForUpdate(client, candidates);
      const now = await this.authority.assertTransactionReady(client);
      try {
        candidates = this.authority.resumeKeys.candidates(secret, now);
        await this.authority.assertGuestSecretNotTombstoned(client, secret, now);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        mapDeletedSecretToInvalid(error);
      }
      if (!match) throw new GuestResumeError("GUEST_RESUME_INVALID");
      const candidate = candidates.find((item) => (
        item.keyVersion === match.digestKeyVersion
        && item.keyIdentity === match.digestKeyIdentity
      ));
      if (!candidate || !constantTimeDigestEqual(candidate.digest, match.digest)) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      if (match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      const digests = await client.query<ResumeDigestRow>(
        "SELECT digest_key_version, digest_key_identity, digest FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1",
        [match.id],
      );
      const commandKeys = await client.query<CommandKeyRow>(
        "SELECT idempotency_key FROM samurai_persistence.command_receipts WHERE guest_session_id = $1",
        [match.id],
      );
      const exportIds = await client.query<SaveExportRow>(
        `SELECT export_id::text, expires_at
           FROM samurai_persistence.save_exports
          WHERE guest_session_id = $1
          ORDER BY export_id
          FOR UPDATE`,
        [match.id],
      );
      const importIds = await client.query<SaveImportRow>(
        `SELECT import_id::text, expires_at
           FROM samurai_persistence.recovery_imports
          WHERE guest_session_id = $1
          ORDER BY import_id
          FOR UPDATE`,
        [match.id],
      );
      const claimCapability = await client.query<ClaimCapabilityRow>(
        `SELECT digest_key_version, digest_key_identity, digest, expires_at
           FROM samurai_persistence.guest_claim_capabilities
          WHERE guest_session_id = $1`,
        [match.id],
      );
      const claimChallenges = await client.query<ClaimChallengeRow>(
        `SELECT challenge_hash, nonce_digest, expires_at FROM samurai_persistence.claim_challenges
          WHERE guest_session_id = $1`,
        [match.id],
      );
      await this.lockClaimCapabilityDigestReplayFences(client, claimCapability.rows);
      await this.lockClaimChallengeNonceReplayFences(client, claimChallenges.rows);
      const lockedCapability = await client.query<ClaimCapabilityRow>(
        `SELECT digest_key_version, digest_key_identity, digest, expires_at
           FROM samurai_persistence.guest_claim_capabilities
          WHERE guest_session_id = $1 FOR UPDATE`,
        [match.id],
      );
      const lockedChallenges = await client.query<ClaimChallengeRow>(
        `SELECT challenge_hash, nonce_digest, expires_at FROM samurai_persistence.claim_challenges
          WHERE guest_session_id = $1 FOR UPDATE`,
        [match.id],
      );
      const deleteNow = await this.authority.assertTransactionReady(client);
      if (match.expiresAt.getTime() <= deleteNow.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      try {
        candidates = this.authority.resumeKeys.candidates(secret, deleteNow);
        await this.authority.assertGuestSecretNotTombstoned(client, secret, deleteNow);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        mapDeletedSecretToInvalid(error);
      }
      const finalCandidate = candidates.find((item) => (
        item.keyVersion === match.digestKeyVersion && item.keyIdentity === match.digestKeyIdentity
      ));
      if (!finalCandidate || !constantTimeDigestEqual(finalCandidate.digest, match.digest)) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      await client.query("DELETE FROM samurai_persistence.claim_challenges WHERE guest_session_id = $1", [match.id]);
      await client.query("DELETE FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1", [match.id]);
      await client.query("DELETE FROM samurai_persistence.guest_sessions WHERE id = $1", [match.id]);
      for (const row of digests.rows) await this.insertTombstone(client, "guest-session", this.resumeReplayKey(row), deleteNow, row);
      for (const row of commandKeys.rows) {
        await this.insertTombstone(client, "command", this.commandReplayKey(match.id, row.idempotency_key), deleteNow);
      }
      for (const row of exportIds.rows) {
        await this.insertTombstone(
          client,
          "save-export",
          this.exportReplayKey(row.export_id),
          deleteNow,
          undefined,
          addMilliseconds(row.expires_at, ADR_0003_PERSISTENCE_LIFECYCLE.cleanupMaximumDelayMs),
        );
      }
      for (const row of importIds.rows) {
        await this.insertTombstone(
          client,
          "save-import",
          this.importReplayKey(row.import_id),
          deleteNow,
          undefined,
          row.expires_at,
        );
      }
      for (const row of lockedCapability.rows) {
        await this.insertTombstone(
          client,
          "guest-claim",
          `guest-claim:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`,
          deleteNow,
          undefined,
          row.expires_at,
          row,
        );
      }
      for (const row of lockedChallenges.rows) {
        await this.insertTombstone(
          client,
          "claim-challenge",
          `challenge:${Buffer.from(row.challenge_hash).toString("base64url")}`,
          deleteNow,
          undefined,
          row.expires_at,
        );
        await this.insertTombstone(
          client,
          "claim-challenge",
          `challenge-nonce:${Buffer.from(row.nonce_digest).toString("base64url")}`,
          deleteNow,
          undefined,
          row.expires_at,
        );
      }
    });
  }

  async rotateClaimCapability(resumeSecret: string): Promise<RotatedGuestClaimCapability> {
    const claimKeys = this.claimKeys;
    if (!claimKeys) throw new PersistenceError("GUEST_CLAIM_UNAVAILABLE", "Guest claim authority is unavailable.");
    return this.runner.run(async (client) => {
      const initialNow = await this.authority.assertTransactionReady(client);
      let candidates;
      try {
        candidates = this.authority.resumeKeys.candidates(resumeSecret, initialNow);
        await this.authority.lockGuestSecretReplayFence(client, resumeSecret, initialNow);
        await this.authority.assertGuestSecretNotTombstoned(client, resumeSecret, initialNow);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        mapDeletedSecretToInvalid(error);
      }
      const match = await this.repository.findResumeMatchForUpdate(client, candidates);
      let now = await this.authority.assertTransactionReady(client);
      try {
        candidates = this.authority.resumeKeys.candidates(resumeSecret, now);
        await this.authority.assertGuestSecretNotTombstoned(client, resumeSecret, now);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        mapDeletedSecretToInvalid(error);
      }
      if (!match || match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_INVALID");
      const resume = candidates.find((candidate) => (
        candidate.keyVersion === match.digestKeyVersion && candidate.keyIdentity === match.digestKeyIdentity
      ));
      if (!resume || !constantTimeDigestEqual(resume.digest, match.digest)) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      const prior = await client.query<ClaimCapabilityRow>(
        `SELECT digest_key_version, digest_key_identity, digest, expires_at
           FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1`,
        [match.id],
      );
      const issued = await this.issueFreshClaimCapability(client, prior.rows);
      const locked = await client.query<ClaimCapabilityRow>(
        `SELECT digest_key_version, digest_key_identity, digest, expires_at
           FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1 FOR UPDATE`,
        [match.id],
      );
      now = await this.authority.assertTransactionReady(client);
      if (match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      try {
        candidates = this.authority.resumeKeys.candidates(resumeSecret, now);
        await this.authority.assertGuestSecretNotTombstoned(client, resumeSecret, now);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
        mapDeletedSecretToInvalid(error);
      }
      const finalResume = candidates.find((candidate) => (
        candidate.keyVersion === match.digestKeyVersion && candidate.keyIdentity === match.digestKeyIdentity
      ));
      if (!finalResume || !constantTimeDigestEqual(finalResume.digest, match.digest)) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      claimKeys.assertActive(now);
      const currentIssued = claimKeys.digest(issued.secret, now);
      await this.assertClaimCapabilitiesNotTombstoned(client, [{
        digest_key_version: currentIssued.keyVersion,
        digest_key_identity: keyIdentityBytes(currentIssued.keyIdentity),
        digest: currentIssued.digest,
      }], now);
      for (const row of locked.rows) {
        await this.insertTombstone(client, "guest-claim", this.claimCapabilityReplayKey(row), now,
          undefined, row.expires_at, row);
      }
      await client.query("DELETE FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1", [match.id]);
      await client.query(
        `INSERT INTO samurai_persistence.guest_claim_capabilities
          (guest_session_id, digest_key_version, digest_key_identity, digest, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [match.id, currentIssued.keyVersion, keyIdentityBytes(currentIssued.keyIdentity), currentIssued.digest,
          now, match.expiresAt],
      );
      return { claimCapability: issued.secret, expiresAt: match.expiresAt };
    });
  }

  async purgeUnavailableClaimCapabilities(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Claim capability cleanup limit must be an integer from 1 through 1000.");
    }
    return this.runner.run(async (client) => {
      const initialNow = await this.authority.assertRetentionTransactionReady(client);
      const candidates = await client.query<ClaimCapabilityRow & { readonly guest_session_id: string }>(
        `SELECT guest_session_id, digest_key_version, digest_key_identity, digest, expires_at
           FROM samurai_persistence.guest_claim_capabilities ORDER BY guest_session_id`,
      );
      let purged = 0;
      for (const candidate of candidates.rows) {
        if (purged === limit) break;
        if (!this.isClaimCapabilityKeyUnavailable(candidate, initialNow)) continue;
        const parent = await client.query<{ readonly expires_at: Date }>(
          "SELECT expires_at FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE",
          [candidate.guest_session_id],
        );
        if (!parent.rows[0]) continue;
        const resolved = await client.query<ClaimCapabilityRow>(
          `SELECT digest_key_version, digest_key_identity, digest, expires_at
             FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1`,
          [candidate.guest_session_id],
        );
        const row = resolved.rows[0];
        if (!row) continue;
        await this.lockClaimCapabilityDigestReplayFences(client, [row]);
        const locked = await client.query<ClaimCapabilityRow>(
          `SELECT digest_key_version, digest_key_identity, digest, expires_at
             FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1 FOR UPDATE`,
          [candidate.guest_session_id],
        );
        const current = locked.rows[0];
        const now = await this.authority.assertRetentionTransactionReady(client);
        if (!current || !this.isClaimCapabilityKeyUnavailable(current, now)) continue;
        await this.insertTombstone(client, "guest-claim", this.claimCapabilityReplayKey(current), now,
          undefined, current.expires_at, current);
        const deleted = await client.query(
          `DELETE FROM samurai_persistence.guest_claim_capabilities
            WHERE guest_session_id = $1 AND digest_key_version = $2 AND digest_key_identity = $3 AND digest = $4`,
          [candidate.guest_session_id, current.digest_key_version, current.digest_key_identity, current.digest],
        );
        if (deleted.rowCount === 1) purged += 1;
      }
      return purged;
    });
  }

  async deleteExpired(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Guest expiry cleanup limit must be an integer from 1 through 1000.");
    }
    return this.runner.run(async (client) => {
      const now = await this.authority.assertRetentionTransactionReady(client);
      await client.query(
        "DELETE FROM samurai_persistence.guest_resume_digests WHERE slot = 'predecessor' AND valid_until <= $1",
        [now],
      );
      await client.query("DELETE FROM samurai_persistence.deletion_tombstones WHERE expires_at <= $1", [now]);
      const expired = await client.query<ExpiredSessionRow>(
        `SELECT id
           FROM samurai_persistence.guest_sessions
          WHERE expires_at <= $1
          ORDER BY expires_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED`,
        [now, limit],
      );
      for (const session of expired.rows) {
        const digests = await client.query<ResumeDigestRow>(
          "SELECT digest_key_version, digest_key_identity, digest FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1",
          [session.id],
        );
        const commandKeys = await client.query<CommandKeyRow>(
          "SELECT idempotency_key FROM samurai_persistence.command_receipts WHERE guest_session_id = $1",
          [session.id],
        );
        const exportIds = await client.query<SaveExportRow>(
          `SELECT export_id::text, expires_at
             FROM samurai_persistence.save_exports
            WHERE guest_session_id = $1
            ORDER BY export_id
            FOR UPDATE`,
          [session.id],
        );
        const importIds = await client.query<SaveImportRow>(
          `SELECT import_id::text, expires_at
             FROM samurai_persistence.recovery_imports
            WHERE guest_session_id = $1
            ORDER BY import_id
            FOR UPDATE`,
          [session.id],
        );
        const claimCapability = await client.query<ClaimCapabilityRow>(
          `SELECT digest_key_version, digest_key_identity, digest, expires_at
             FROM samurai_persistence.guest_claim_capabilities
            WHERE guest_session_id = $1`,
          [session.id],
        );
        const claimChallenges = await client.query<ClaimChallengeRow>(
          `SELECT challenge_hash, nonce_digest, expires_at FROM samurai_persistence.claim_challenges
            WHERE guest_session_id = $1`,
          [session.id],
        );
        await this.lockClaimCapabilityDigestReplayFences(client, claimCapability.rows);
        await this.lockClaimChallengeNonceReplayFences(client, claimChallenges.rows);
        const lockedCapability = await client.query<ClaimCapabilityRow>(
          `SELECT digest_key_version, digest_key_identity, digest, expires_at
             FROM samurai_persistence.guest_claim_capabilities
            WHERE guest_session_id = $1 FOR UPDATE`,
          [session.id],
        );
        const lockedChallenges = await client.query<ClaimChallengeRow>(
          `SELECT challenge_hash, nonce_digest, expires_at FROM samurai_persistence.claim_challenges
            WHERE guest_session_id = $1 FOR UPDATE`,
          [session.id],
        );
        const deleteNow = await this.authority.assertRetentionTransactionReady(client);
        await client.query("DELETE FROM samurai_persistence.claim_challenges WHERE guest_session_id = $1", [session.id]);
        await client.query("DELETE FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1", [session.id]);
        await client.query("DELETE FROM samurai_persistence.guest_sessions WHERE id = $1", [session.id]);
        for (const row of digests.rows) {
          await this.insertTombstone(client, "guest-session", this.resumeReplayKey(row), deleteNow, row);
        }
        for (const row of commandKeys.rows) {
          await this.insertTombstone(client, "command", this.commandReplayKey(session.id, row.idempotency_key), deleteNow);
        }
        for (const row of exportIds.rows) {
          await this.insertTombstone(
            client,
            "save-export",
            this.exportReplayKey(row.export_id),
            deleteNow,
            undefined,
            addMilliseconds(row.expires_at, ADR_0003_PERSISTENCE_LIFECYCLE.cleanupMaximumDelayMs),
          );
        }
        for (const row of importIds.rows) {
          await this.insertTombstone(
            client,
            "save-import",
            this.importReplayKey(row.import_id),
            deleteNow,
            undefined,
            row.expires_at,
          );
        }
        for (const row of lockedCapability.rows) {
          await this.insertTombstone(
            client,
            "guest-claim",
            `guest-claim:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`,
            deleteNow,
            undefined,
            row.expires_at,
            row,
          );
        }
        for (const row of lockedChallenges.rows) {
          await this.insertTombstone(
            client,
            "claim-challenge",
            `challenge:${Buffer.from(row.challenge_hash).toString("base64url")}`,
            deleteNow,
            undefined,
            row.expires_at,
          );
          await this.insertTombstone(
            client,
            "claim-challenge",
            `challenge-nonce:${Buffer.from(row.nonce_digest).toString("base64url")}`,
            deleteNow,
            undefined,
            row.expires_at,
          );
        }
      }
      return expired.rows.length;
    });
  }

  private async insertTombstone(
    client: SqlClient,
    kind: TombstoneKind,
    replayKey: string,
    now: Date,
    resumeDigest?: ResumeDigestRow,
    minimumExpiresAt?: Date,
    claimCapability?: ResumeDigestRow,
  ): Promise<void> {
    const tombstone = this.authority.tombstoneKeys.digest(kind, replayKey, now);
    await client.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         resume_digest_key_version, resume_digest_key_identity,
         capability_key_purpose, capability_key_version, capability_key_identity,
         created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (kind, digest_key_version, digest_key_identity, tombstone_digest) DO UPDATE
         SET expires_at = GREATEST(samurai_persistence.deletion_tombstones.expires_at, EXCLUDED.expires_at)`,
      [
        kind,
        tombstone.keyVersion,
        Buffer.from(tombstone.keyIdentity.slice("sha256:".length), "hex"),
        tombstone.digest,
        resumeDigest?.digest_key_version ?? null,
        resumeDigest?.digest_key_identity ?? null,
        claimCapability ? "guest-claim" : null,
        claimCapability?.digest_key_version ?? null,
        claimCapability?.digest_key_identity ?? null,
        now,
        new Date(Math.max(
          addMilliseconds(now, this.policy.tombstoneLifetimeMs).getTime(),
          minimumExpiresAt?.getTime() ?? 0,
        )),
      ],
    );
  }

  private resumeReplayKey(row: ResumeDigestRow): string {
    return `resume:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`;
  }

  private claimCapabilityReplayKey(row: ResumeDigestRow): string {
    return `guest-claim:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`;
  }

  private async lockClaimCapabilityDigestReplayFences(
    client: SqlClient,
    rows: readonly ResumeDigestRow[],
  ): Promise<void> {
    const scopes = rows.map((row) => `guest-claim-replay:${this.claimCapabilityReplayKey(row)}`).sort();
    for (const scope of scopes) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
  }

  private async lockClaimChallengeNonceReplayFences(
    client: SqlClient,
    rows: readonly Pick<ClaimChallengeRow, "nonce_digest">[],
  ): Promise<void> {
    const scopes = rows
      .map((row) => `challenge-nonce:${Buffer.from(row.nonce_digest).toString("base64url")}`)
      .sort();
    for (const scope of scopes) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
  }

  private async assertClaimCapabilitiesNotTombstoned(
    client: SqlClient,
    rows: readonly ResumeDigestRow[],
    now: Date,
  ): Promise<void> {
    for (const row of rows) {
      const replayKey = this.claimCapabilityReplayKey(row);
      for (const candidate of this.authority.tombstoneKeys.replayCandidates("guest-claim", replayKey, now)) {
        const result = await client.query<{ readonly found: number }>(
          `SELECT 1 AS found FROM samurai_persistence.deletion_tombstones
            WHERE kind = 'guest-claim' AND digest_key_version = $1
              AND digest_key_identity = $2 AND tombstone_digest = $3 AND expires_at > $4 LIMIT 1`,
          [candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest, now],
        );
        if (result.rows[0]) throw new PersistenceError("GUEST_CLAIM_TOMBSTONED", "Guest claim capability is unavailable.");
      }
    }
  }

  private async issueFreshClaimCapability(
    client: SqlClient,
    replayRows: readonly ResumeDigestRow[] = [],
  ): Promise<{
    readonly secret: string;
    readonly digest: ReturnType<GuestClaimKeyring["digest"]>;
    readonly now: Date;
  }> {
    if (!this.claimKeys) throw new PersistenceError("GUEST_CLAIM_UNAVAILABLE", "Guest claim authority is unavailable.");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const secret = this.createClaimCapability();
      const initialNow = await this.authority.assertTransactionReady(client);
      let candidates = this.claimKeys.tombstoneCandidates(secret, initialNow).map((candidate) => ({
        digest_key_version: candidate.keyVersion,
        digest_key_identity: keyIdentityBytes(candidate.keyIdentity),
        digest: candidate.digest,
      }));
      await this.lockClaimCapabilityDigestReplayFences(client, [...replayRows, ...candidates]);
      const now = await this.authority.assertTransactionReady(client);
      this.claimKeys.assertActive(now);
      candidates = this.claimKeys.tombstoneCandidates(secret, now).map((candidate) => ({
        digest_key_version: candidate.keyVersion,
        digest_key_identity: keyIdentityBytes(candidate.keyIdentity),
        digest: candidate.digest,
      }));
      let collision = false;
      try {
        await this.assertClaimCapabilitiesNotTombstoned(client, candidates, now);
      } catch (error) {
        if (error instanceof PersistenceError && error.code === "GUEST_CLAIM_TOMBSTONED") collision = true;
        else throw error;
      }
      if (collision) continue;
      for (const candidate of candidates) {
        const live = await client.query<{ readonly found: number }>(
          `SELECT 1 AS found FROM samurai_persistence.guest_claim_capabilities
            WHERE digest_key_version = $1 AND digest_key_identity = $2 AND digest = $3 LIMIT 1`,
          [candidate.digest_key_version, candidate.digest_key_identity, candidate.digest],
        );
        if (live.rows[0]) {
          collision = true;
          break;
        }
      }
      if (collision) continue;
      return { secret, digest: this.claimKeys.digest(secret, now), now };
    }
    throw new PersistenceError("GUEST_CLAIM_COLLISION", "Guest claim capability issuance exhausted its collision budget.");
  }

  private isClaimCapabilityKeyUnavailable(row: ResumeDigestRow, now: Date): boolean {
    if (!this.claimKeys) return true;
    const metadata = this.claimKeys.metadata(row.digest_key_version);
    let storedIdentity: string | undefined;
    try {
      storedIdentity = `sha256:${Buffer.from(row.digest_key_identity).toString("hex")}`;
    } catch {
      return true;
    }
    return !metadata
      || metadata.keyIdentity !== storedIdentity
      || metadata.activatedAtMs > now.getTime()
      || (metadata.compromisedAtMs !== null && metadata.compromisedAtMs <= now.getTime())
      || (metadata.verifyUntilMs !== null && metadata.verifyUntilMs <= now.getTime());
  }

  private commandReplayKey(guestSessionId: string, idempotencyKey: string): string {
    return `guest:${guestSessionId}:command:${idempotencyKey}`;
  }

  private exportReplayKey(exportId: string): string {
    return `export:${exportId}`;
  }

  private importReplayKey(importId: string): string {
    return `import:${importId}`;
  }

}
