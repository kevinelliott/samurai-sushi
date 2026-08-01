import { randomUUID } from "node:crypto";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import {
  constantTimeDigestEqual,
  GuestSecretFormatError,
  issueResumeSecret,
} from "./crypto";
import type { HmacKeyring, TombstoneKeyring } from "./crypto";
import { GuestResumeError } from "./errors";
import { GuestSessionRepository } from "./repositories";
import type { GuestProgressRecord, GuestSessionRecord, ResumeMatch } from "./repositories";

const SECOND_MS = 1_000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;

export interface GuestSessionPolicy {
  readonly idleAndAbsoluteLifetimeMs: number;
  readonly rotationIntervalMs: number;
  readonly predecessorGraceMs: number;
  readonly tombstoneLifetimeMs: number;
}

export const ADR_0003_GUEST_SESSION_POLICY: GuestSessionPolicy = {
  idleAndAbsoluteLifetimeMs: 30 * DAY_MS,
  rotationIntervalMs: 7 * DAY_MS,
  predecessorGraceMs: 60 * SECOND_MS,
  tombstoneLifetimeMs: 30 * DAY_MS,
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
  readonly digest: Uint8Array;
}

export interface GuestSessionServiceOptions {
  readonly now?: () => Date;
  readonly issueId?: () => string;
  readonly issueSecret?: () => string;
  readonly policy?: GuestSessionPolicy;
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
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

export class GuestSessionService {
  private readonly runner: TransactionRunner;
  private readonly repository = new GuestSessionRepository();
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createSecret: () => string;
  private readonly policy: GuestSessionPolicy;

  constructor(
    pool: SqlPool,
    private readonly resumeKeys: HmacKeyring,
    private readonly tombstoneKeys: TombstoneKeyring,
    options: GuestSessionServiceOptions = {},
  ) {
    this.runner = new TransactionRunner(pool);
    this.now = options.now ?? (() => new Date());
    this.createId = options.issueId ?? randomUUID;
    this.createSecret = options.issueSecret ?? issueResumeSecret;
    this.policy = options.policy ?? ADR_0003_GUEST_SESSION_POLICY;
    if (this.policy.predecessorGraceMs !== 60 * SECOND_MS) {
      throw new Error("ADR 0003 requires an exact 60-second predecessor-cookie grace window.");
    }
  }

  async issue<Checkpoint extends Readonly<Record<string, unknown>>>(
    input: IssueGuestInput<Checkpoint>,
  ): Promise<IssuedGuest<Checkpoint>> {
    const now = this.now();
    const secret = this.createSecret();
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
    await this.runner.run((client) => this.repository.insert(client, session, this.resumeKeys.digest(secret), progress));
    return { session, progress, resumeSecret: secret };
  }

  async resume(secret: string): Promise<ResumedGuest> {
    let candidates;
    try {
      candidates = this.resumeKeys.candidates(secret);
    } catch (error) {
      if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
      throw error;
    }
    return this.runner.run(async (client) => {
      const now = this.now();
      const match = await this.repository.findResumeMatchForUpdate(client, candidates);
      if (!match) throw new GuestResumeError("GUEST_RESUME_INVALID");
      const candidate = candidates.find((item) => item.keyVersion === match.digestKeyVersion);
      if (!candidate || !constantTimeDigestEqual(candidate.digest, match.digest)) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      if (match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      if (match.slot === "predecessor" && (!match.digestValidUntil || match.digestValidUntil.getTime() <= now.getTime())) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      const mustRotate =
        match.slot === "predecessor" ||
        match.digestKeyVersion !== this.resumeKeys.active.version ||
        match.rotateAfter.getTime() <= now.getTime();
      if (!mustRotate) {
        await this.repository.touch(client, match.id, now);
        return { session: { ...sessionFromMatch(match), lastSeenAt: now } };
      }
      const rotatedResumeSecret = this.createSecret();
      const rotateAfter = addMilliseconds(now, this.policy.rotationIntervalMs);
      await this.repository.rotate(
        client,
        match.id,
        this.resumeKeys.digest(rotatedResumeSecret),
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
    const resumed = await this.resume(secret);
    if (resumed.rotatedResumeSecret) return resumed as ResumedGuest & { readonly rotatedResumeSecret: string };
    return this.runner.run(async (client) => {
      const now = this.now();
      const candidates = this.resumeKeys.candidates(secret);
      const match = await this.repository.findResumeMatchForUpdate(client, candidates);
      if (!match || match.slot !== "current") throw new GuestResumeError("GUEST_RESUME_INVALID");
      const rotatedResumeSecret = this.createSecret();
      const rotateAfter = addMilliseconds(now, this.policy.rotationIntervalMs);
      await this.repository.rotate(
        client,
        match.id,
        this.resumeKeys.digest(rotatedResumeSecret),
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
    let candidates;
    try {
      candidates = this.resumeKeys.candidates(secret);
    } catch (error) {
      if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
      throw error;
    }
    await this.runner.run(async (client) => {
      const now = this.now();
      const match = await this.repository.findResumeMatchForUpdate(client, candidates);
      if (!match) throw new GuestResumeError("GUEST_RESUME_INVALID");
      const candidate = candidates.find((item) => item.keyVersion === match.digestKeyVersion);
      if (!candidate || !constantTimeDigestEqual(candidate.digest, match.digest)) {
        throw new GuestResumeError("GUEST_RESUME_INVALID");
      }
      if (match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_EXPIRED");
      const commandKeys = await client.query<CommandKeyRow>(
        "SELECT idempotency_key FROM samurai_persistence.command_receipts WHERE guest_session_id = $1",
        [match.id],
      );
      await client.query("DELETE FROM samurai_persistence.guest_sessions WHERE id = $1", [match.id]);
      await this.insertTombstone(client, "guest-session", secret, now);
      for (const row of commandKeys.rows) await this.insertTombstone(client, "command", row.idempotency_key, now);
    });
  }

  async deleteExpired(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error("Guest expiry cleanup limit must be an integer from 1 through 1000.");
    }
    return this.runner.run(async (client) => {
      const now = this.now();
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
          "SELECT digest FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1",
          [session.id],
        );
        const commandKeys = await client.query<CommandKeyRow>(
          "SELECT idempotency_key FROM samurai_persistence.command_receipts WHERE guest_session_id = $1",
          [session.id],
        );
        await client.query("DELETE FROM samurai_persistence.guest_sessions WHERE id = $1", [session.id]);
        for (const row of digests.rows) {
          await this.insertTombstone(client, "guest-session", Buffer.from(row.digest).toString("base64url"), now);
        }
        for (const row of commandKeys.rows) await this.insertTombstone(client, "command", row.idempotency_key, now);
      }
      return expired.rows.length;
    });
  }

  private async insertTombstone(
    client: SqlClient,
    kind: "guest-session" | "command",
    replayKey: string,
    now: Date,
  ): Promise<void> {
    const tombstone = this.tombstoneKeys.digest(kind, replayKey);
    await client.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, tombstone_digest, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [kind, tombstone.keyVersion, tombstone.digest, now, addMilliseconds(now, this.policy.tombstoneLifetimeMs)],
    );
  }
}
