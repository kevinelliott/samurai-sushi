import { randomUUID } from "node:crypto";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import {
  constantTimeDigestEqual,
  GuestSecretFormatError,
  issueResumeSecret,
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
}

export interface ResumedGuest {
  readonly session: GuestSessionRecord;
  readonly rotatedResumeSecret?: string;
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

export interface GuestSessionServiceOptions {
  readonly issueId?: () => string;
  readonly issueSecret?: () => string;
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
  private readonly policy: GuestSessionPolicy;

  constructor(
    pool: SqlPool,
    private readonly authority: PersistenceAuthority,
    options: GuestSessionServiceOptions = {},
  ) {
    this.runner = new TransactionRunner(pool);
    this.createId = options.issueId ?? randomUUID;
    this.createSecret = options.issueSecret ?? issueResumeSecret;
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
      const now = await this.authority.assertTransactionReady(client);
      await this.authority.assertGuestSecretNotTombstoned(client, secret, now);
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
      await this.authority.assertGuestSecretNotTombstoned(client, secret, now);
      return { session, progress, resumeSecret: secret };
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
      await client.query("DELETE FROM samurai_persistence.guest_sessions WHERE id = $1", [match.id]);
      for (const row of digests.rows) await this.insertTombstone(client, "guest-session", this.resumeReplayKey(row), now, row);
      for (const row of commandKeys.rows) {
        await this.insertTombstone(client, "command", this.commandReplayKey(match.id, row.idempotency_key), now);
      }
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
        await client.query("DELETE FROM samurai_persistence.guest_sessions WHERE id = $1", [session.id]);
        for (const row of digests.rows) {
          await this.insertTombstone(client, "guest-session", this.resumeReplayKey(row), now, row);
        }
        for (const row of commandKeys.rows) {
          await this.insertTombstone(client, "command", this.commandReplayKey(session.id, row.idempotency_key), now);
        }
      }
      return expired.rows.length;
    });
  }

  private async insertTombstone(
    client: SqlClient,
    kind: "guest-session" | "command",
    replayKey: string,
    now: Date,
    resumeDigest?: ResumeDigestRow,
  ): Promise<void> {
    const tombstone = this.authority.tombstoneKeys.digest(kind, replayKey, now);
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
        Buffer.from(tombstone.keyIdentity.slice("sha256:".length), "hex"),
        tombstone.digest,
        resumeDigest?.digest_key_version ?? null,
        resumeDigest?.digest_key_identity ?? null,
        now,
        addMilliseconds(now, this.policy.tombstoneLifetimeMs),
      ],
    );
  }

  private resumeReplayKey(row: ResumeDigestRow): string {
    return `resume:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`;
  }

  private commandReplayKey(guestSessionId: string, idempotencyKey: string): string {
    return `guest:${guestSessionId}:command:${idempotencyKey}`;
  }

}
