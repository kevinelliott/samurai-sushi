import type { SqlClient } from "./database";
import { keyIdentityBytes } from "./crypto";
import type { KeyIdentity, VersionedDigest } from "./crypto";

export interface GuestSessionRecord {
  readonly id: string;
  readonly consentVersion: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly rotateAfter: Date;
}

export interface GuestProgressRecord<Checkpoint = Readonly<Record<string, unknown>>> {
  readonly guestSessionId: string;
  readonly revision: number;
  readonly contentVersion: string;
  readonly checkpointSchemaVersion: number;
  readonly checkpoint: Checkpoint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface GuestSessionRow {
  readonly id: string;
  readonly consent_version: string;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  readonly expires_at: Date;
  readonly rotate_after: Date;
}

interface GuestProgressRow {
  readonly guest_session_id: string;
  readonly revision: string;
  readonly content_version: string;
  readonly checkpoint_schema_version: number;
  readonly checkpoint: unknown;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export interface ResumeMatch extends GuestSessionRecord {
  readonly slot: "current" | "predecessor";
  readonly digestKeyVersion: number;
  readonly digestKeyIdentity: KeyIdentity;
  readonly digest: Uint8Array;
  readonly digestValidUntil: Date | null;
}

interface ResumeMatchRow extends GuestSessionRow {
  readonly slot: "current" | "predecessor";
  readonly digest_key_version: number;
  readonly digest_key_identity: Uint8Array;
  readonly digest: Uint8Array;
  readonly digest_valid_until: Date | null;
}

export interface RepositoryResumeDigestRow {
  readonly digest_key_version: number;
  readonly digest_key_identity: Uint8Array;
  readonly digest: Uint8Array;
  readonly slot: "current" | "predecessor";
  readonly valid_until: Date | null;
}

function sessionFromRow(row: GuestSessionRow): GuestSessionRecord {
  return {
    id: row.id,
    consentVersion: row.consent_version,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    rotateAfter: row.rotate_after,
  };
}

export class GuestSessionRepository {
  private async findResumeMatch(
    client: SqlClient,
    candidates: readonly VersionedDigest[],
    lockParent: boolean,
  ): Promise<ResumeMatch | null> {
    if (candidates.length === 0) return null;
    const clauses: string[] = [];
    const values: Array<number | Uint8Array> = [];
    for (const candidate of candidates) {
      const offset = values.length;
      values.push(candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest);
      clauses.push(`(d.digest_key_version = $${offset + 1} AND d.digest_key_identity = $${offset + 2} AND d.digest = $${offset + 3})`);
    }
    const result = await client.query<ResumeMatchRow>(
      `SELECT s.id, s.consent_version, s.created_at, s.last_seen_at, s.expires_at, s.rotate_after,
              d.slot, d.digest_key_version, d.digest_key_identity, d.digest, d.valid_until AS digest_valid_until
         FROM samurai_persistence.guest_resume_digests d
         JOIN samurai_persistence.guest_sessions s ON s.id = d.guest_session_id
        WHERE ${clauses.join(" OR ")}
        ${lockParent ? "FOR UPDATE OF s" : ""}`,
      values,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...sessionFromRow(row),
      slot: row.slot,
      digestKeyVersion: row.digest_key_version,
      digestKeyIdentity: `sha256:${Buffer.from(row.digest_key_identity).toString("hex")}`,
      digest: row.digest,
      digestValidUntil: row.digest_valid_until,
    };
  }

  async findResumeMatchUnlocked(client: SqlClient, candidates: readonly VersionedDigest[]): Promise<ResumeMatch | null> {
    return this.findResumeMatch(client, candidates, false);
  }

  async insert(
    client: SqlClient,
    session: GuestSessionRecord,
    currentDigest: VersionedDigest,
    progress: Omit<GuestProgressRecord, "guestSessionId">,
  ): Promise<void> {
    await client.query(
      `INSERT INTO samurai_persistence.guest_sessions
        (id, consent_version, created_at, last_seen_at, expires_at, rotate_after)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [session.id, session.consentVersion, session.createdAt, session.lastSeenAt, session.expiresAt, session.rotateAfter],
    );
    await client.query(
      `INSERT INTO samurai_persistence.guest_resume_digests
        (guest_session_id, slot, digest_key_version, digest_key_identity, digest, valid_until)
       VALUES ($1, 'current', $2, $3, $4, NULL)`,
      [session.id, currentDigest.keyVersion, keyIdentityBytes(currentDigest.keyIdentity), currentDigest.digest],
    );
    await client.query(
      `INSERT INTO samurai_persistence.guest_progress
        (guest_session_id, revision, content_version, checkpoint_schema_version, checkpoint, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
      [
        session.id,
        progress.revision,
        progress.contentVersion,
        progress.checkpointSchemaVersion,
        JSON.stringify(progress.checkpoint),
        progress.createdAt,
        progress.updatedAt,
      ],
    );
  }

  async findResumeMatchForUpdate(
    client: SqlClient,
    candidates: readonly VersionedDigest[],
  ): Promise<ResumeMatch | null> {
    return this.findResumeMatch(client, candidates, true);
  }

  async resumeDigests(client: SqlClient, guestSessionId: string, lock = false): Promise<readonly RepositoryResumeDigestRow[]> {
    const result = await client.query<RepositoryResumeDigestRow>(
      `SELECT digest_key_version, digest_key_identity, digest, slot, valid_until
         FROM samurai_persistence.guest_resume_digests
        WHERE guest_session_id = $1 ORDER BY slot
        ${lock ? "FOR UPDATE" : ""}`,
      [guestSessionId],
    );
    return result.rows;
  }

  async touch(client: SqlClient, guestSessionId: string, now: Date): Promise<void> {
    await client.query(
      "UPDATE samurai_persistence.guest_sessions SET last_seen_at = $2 WHERE id = $1",
      [guestSessionId, now],
    );
  }

  async rotate(
    client: SqlClient,
    guestSessionId: string,
    digest: VersionedDigest,
    predecessorValidUntil: Date,
    rotateAfter: Date,
    now: Date,
  ): Promise<void> {
    await client.query(
      `DELETE FROM samurai_persistence.guest_resume_digests
        WHERE guest_session_id = $1 AND slot = 'predecessor' AND valid_until <= $2`,
      [guestSessionId, now],
    );
    const live = await client.query<{ readonly valid_until: Date }>(
      `SELECT valid_until FROM samurai_persistence.guest_resume_digests
        WHERE guest_session_id = $1 AND slot = 'predecessor' AND valid_until > $2`,
      [guestSessionId, now],
    );
    if (live.rows[0]) throw new Error("A live predecessor credential prevents rotation.");
    await client.query(
      `UPDATE samurai_persistence.guest_resume_digests
          SET slot = 'predecessor', valid_until = $2
        WHERE guest_session_id = $1 AND slot = 'current'`,
      [guestSessionId, predecessorValidUntil],
    );
    await client.query(
      `INSERT INTO samurai_persistence.guest_resume_digests
        (guest_session_id, slot, digest_key_version, digest_key_identity, digest, valid_until)
       VALUES ($1, 'current', $2, $3, $4, NULL)`,
      [guestSessionId, digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
    );
    await client.query(
      `UPDATE samurai_persistence.guest_sessions
          SET last_seen_at = $2, rotate_after = $3
        WHERE id = $1`,
      [guestSessionId, now, rotateAfter],
    );
  }

  async lockById(client: SqlClient, guestSessionId: string): Promise<GuestSessionRecord | null> {
    const result = await client.query<GuestSessionRow>(
      `SELECT id, consent_version, created_at, last_seen_at, expires_at, rotate_after
         FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE`,
      [guestSessionId],
    );
    const row = result.rows[0];
    return row ? sessionFromRow(row) : null;
  }
}

export class GuestProgressRepository {
  async lock<Checkpoint>(client: SqlClient, guestSessionId: string): Promise<GuestProgressRecord<Checkpoint> | null> {
    const result = await client.query<GuestProgressRow>(
      `SELECT guest_session_id, revision, content_version, checkpoint_schema_version,
              checkpoint, created_at, updated_at
         FROM samurai_persistence.guest_progress
        WHERE guest_session_id = $1
        FOR UPDATE`,
      [guestSessionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      guestSessionId: row.guest_session_id,
      revision: Number(row.revision),
      contentVersion: row.content_version,
      checkpointSchemaVersion: row.checkpoint_schema_version,
      checkpoint: row.checkpoint as Checkpoint,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
