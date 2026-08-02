import type { HmacKeyMetadata, HmacKeyring, TombstoneKeyring } from "./crypto";
import { KeyLifecycleError, keyIdentityBytes, keyIdentityFromBytes } from "./crypto";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import { PersistenceError } from "./errors";
import { ADR_0003_PERSISTENCE_LIFECYCLE } from "./lifecycle";
import { applyMigrations } from "./migrations";

interface DatabaseClockRow { readonly now: Date }

type PersistenceKeyPurpose = "resume" | "tombstone";

interface KeyReferenceRow {
  readonly source: PersistenceKeyPurpose;
  readonly key_version: number;
  readonly key_identity: Uint8Array;
  readonly required_until: Date;
}

interface ReferenceCountRow { readonly reference_count: string }

function metadataFor(
  source: PersistenceKeyPurpose,
  version: number,
  resumeKeys: HmacKeyring,
  tombstoneKeys: TombstoneKeyring,
): HmacKeyMetadata | undefined {
  return source === "resume" ? resumeKeys.metadata(version) : tombstoneKeys.metadata(version);
}

function minimumVerifyUntilMs(source: PersistenceKeyPurpose, retiredAtMs: number): number {
  const lifecycle = ADR_0003_PERSISTENCE_LIFECYCLE;
  return source === "resume"
    ? retiredAtMs + lifecycle.sessionLifetimeMs + lifecycle.cleanupMaximumDelayMs
      + lifecycle.tombstoneLifetimeMs + lifecycle.cleanupMaximumDelayMs
    : retiredAtMs + lifecycle.tombstoneLifetimeMs + lifecycle.cleanupMaximumDelayMs;
}

async function databaseNow(client: SqlClient): Promise<Date> {
  const result = await client.query<DatabaseClockRow>("SELECT clock_timestamp() AS now");
  const now = result.rows[0]?.now;
  if (!now) throw new PersistenceError("DATABASE_CLOCK_UNAVAILABLE", "PostgreSQL did not return its authoritative clock.");
  return now;
}

async function keyReferences(client: SqlClient): Promise<readonly KeyReferenceRow[]> {
  const cleanup = ADR_0003_PERSISTENCE_LIFECYCLE.cleanupMaximumDelayMs;
  const result = await client.query<KeyReferenceRow>(`
    SELECT 'resume'::text AS source,
           d.digest_key_version AS key_version,
           d.digest_key_identity AS key_identity,
           MAX((CASE WHEN d.slot = 'current' THEN s.expires_at
                     ELSE LEAST(s.expires_at, d.valid_until) END)
               + ($1::bigint * interval '1 millisecond')) AS required_until
      FROM samurai_persistence.guest_resume_digests d
      JOIN samurai_persistence.guest_sessions s ON s.id = d.guest_session_id
     GROUP BY d.digest_key_version, d.digest_key_identity
    UNION ALL
    SELECT 'tombstone'::text,
           t.digest_key_version,
           t.digest_key_identity,
           MAX(t.expires_at + ($1::bigint * interval '1 millisecond'))
      FROM samurai_persistence.deletion_tombstones t
     GROUP BY t.digest_key_version, t.digest_key_identity
    UNION ALL
    SELECT 'resume'::text,
           t.resume_digest_key_version,
           t.resume_digest_key_identity,
           MAX(t.expires_at + ($1::bigint * interval '1 millisecond'))
      FROM samurai_persistence.deletion_tombstones t
     WHERE t.kind = 'guest-session'
     GROUP BY t.resume_digest_key_version, t.resume_digest_key_identity
     ORDER BY source, key_version
  `, [cleanup]);
  return result.rows;
}

async function assertInventory(
  client: SqlClient,
  now: Date,
  resumeKeys: HmacKeyring,
  tombstoneKeys: TombstoneKeyring,
): Promise<void> {
  resumeKeys.assertActive(now);
  tombstoneKeys.assertActive(now);
  for (const [source, ring] of [["resume", resumeKeys], ["tombstone", tombstoneKeys]] as const) {
    for (const key of ring.allMetadata()) {
      if (key.retiredAtMs !== null && key.verifyUntilMs! < minimumVerifyUntilMs(source, key.retiredAtMs)) {
        throw new PersistenceError(
          "KEY_VERIFY_HORIZON_TOO_SHORT",
          `${source} key version ${key.version} retires before the maximum lifecycle horizon.`,
        );
      }
    }
  }
  for (const row of await keyReferences(client)) {
    const metadata = metadataFor(row.source, row.key_version, resumeKeys, tombstoneKeys);
    if (!metadata) {
      throw new PersistenceError("KEY_VERSION_UNAVAILABLE", `Required ${row.source} key version ${row.key_version} is unavailable.`);
    }
    const storedIdentity = keyIdentityFromBytes(row.key_identity);
    if (metadata.keyIdentity !== storedIdentity) {
      throw new PersistenceError("KEY_IDENTITY_MISMATCH", `${row.source} key version ${row.key_version} has different configured and stored identities.`);
    }
    if (metadata.activatedAtMs > now.getTime()) {
      throw new PersistenceError("KEY_VERSION_NOT_ACTIVE", `${row.source} key version ${row.key_version} is not active yet.`);
    }
    if (metadata.compromisedAtMs !== null && metadata.compromisedAtMs <= now.getTime()) {
      throw new PersistenceError("KEY_VERSION_COMPROMISED", `${row.source} key version ${row.key_version} is compromised while live references remain.`);
    }
    if (metadata.verifyUntilMs !== null && metadata.verifyUntilMs < row.required_until.getTime()) {
      throw new PersistenceError("KEY_VERIFY_HORIZON_TOO_SHORT", `${row.source} key version ${row.key_version} cannot cover its live database references.`);
    }
  }
}

const CAPABILITY_BLOCKER_CODES = new Set([
  "ACTIVE_KEY_UNAVAILABLE",
  "KEY_IDENTITY_MISMATCH",
  "KEY_VERIFY_HORIZON_TOO_SHORT",
  "KEY_VERSION_COMPROMISED",
  "KEY_VERSION_NOT_ACTIVE",
  "KEY_VERSION_UNAVAILABLE",
]);

function capabilityBlockerCode(error: unknown): string | undefined {
  if (error instanceof KeyLifecycleError) return error.code;
  if (error instanceof PersistenceError && CAPABILITY_BLOCKER_CODES.has(error.code)) return error.code;
  return undefined;
}

export interface PersistenceBootstrapReadiness {
  readonly retentionReady: true;
  readonly capabilityServingReady: boolean;
  readonly capabilityBlockerCode?: string;
}

export class PersistenceAuthority {
  readonly resumeKeys: HmacKeyring;
  readonly tombstoneKeys: TombstoneKeyring;
  readonly #runner: TransactionRunner;
  readonly #pool: SqlPool;
  #retentionReady = false;

  constructor(pool: SqlPool, resumeKeys: HmacKeyring, tombstoneKeys: TombstoneKeyring) {
    this.#pool = pool;
    this.#runner = new TransactionRunner(pool);
    this.resumeKeys = resumeKeys;
    this.tombstoneKeys = tombstoneKeys;
  }

  async bootstrap(): Promise<PersistenceBootstrapReadiness> {
    await applyMigrations(this.#pool);
    await this.#runner.run(async (client) => {
      const now = await databaseNow(client);
      this.tombstoneKeys.assertActive(now);
    });
    this.#retentionReady = true;
    try {
      await this.#runner.run(async (client) => {
        const now = await databaseNow(client);
        await assertInventory(client, now, this.resumeKeys, this.tombstoneKeys);
      });
      return { retentionReady: true, capabilityServingReady: true };
    } catch (error) {
      const blocker = capabilityBlockerCode(error);
      if (!blocker) throw error;
      return {
        retentionReady: true,
        capabilityServingReady: false,
        capabilityBlockerCode: blocker,
      };
    }
  }

  async assertRetentionTransactionReady(client: SqlClient): Promise<Date> {
    if (!this.#retentionReady) {
      throw new PersistenceError("PERSISTENCE_NOT_READY", "Persistence key authority must pass bootstrap before retention runs.");
    }
    const now = await databaseNow(client);
    this.tombstoneKeys.assertActive(now);
    return now;
  }

  async assertTransactionReady(client: SqlClient): Promise<Date> {
    if (!this.#retentionReady) {
      throw new PersistenceError("PERSISTENCE_NOT_READY", "Persistence key authority must pass bootstrap before serving requests.");
    }
    const now = await databaseNow(client);
    await assertInventory(client, now, this.resumeKeys, this.tombstoneKeys);
    return now;
  }

  async lockGuestSecretReplayFence(client: SqlClient, secret: string, now: Date): Promise<void> {
    const scopes = this.resumeKeys.tombstoneCandidates(secret, now)
      .map((candidate) => (
        `guest-resume-replay:v${candidate.keyVersion}:${candidate.keyIdentity}:${Buffer.from(candidate.digest).toString("base64url")}`
      ))
      .sort();
    for (const scope of scopes) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
    }
  }

  async assertGuestSecretNotTombstoned(client: SqlClient, secret: string, now: Date): Promise<void> {
    for (const resume of this.resumeKeys.tombstoneCandidates(secret, now)) {
      const replayKey = `resume:v${resume.keyVersion}:${Buffer.from(resume.digest).toString("base64url")}`;
      for (const tombstone of this.tombstoneKeys.replayCandidates("guest-session", replayKey, now)) {
        const result = await client.query<{ readonly found: number }>(
          `SELECT 1 AS found
             FROM samurai_persistence.deletion_tombstones
            WHERE kind = 'guest-session'
              AND digest_key_version = $1
              AND digest_key_identity = $2
              AND tombstone_digest = $3
              AND resume_digest_key_version = $4
              AND resume_digest_key_identity = $5
              AND expires_at > $6
            LIMIT 1`,
          [
            tombstone.keyVersion,
            keyIdentityBytes(tombstone.keyIdentity),
            tombstone.digest,
            resume.keyVersion,
            keyIdentityBytes(resume.keyIdentity),
            now,
          ],
        );
        if (result.rows[0]) {
          throw new PersistenceError("GUEST_SECRET_TOMBSTONED", "The guest resume secret was permanently deleted within its replay horizon.");
        }
      }
    }
  }

  async assertSafeToDestroy(source: PersistenceKeyPurpose, version: number): Promise<void> {
    await this.#runner.run(async (client) => {
      const now = await databaseNow(client);
      const metadata = metadataFor(source, version, this.resumeKeys, this.tombstoneKeys);
      if (metadata?.retiredAtMs === null || (metadata?.verifyUntilMs ?? Number.POSITIVE_INFINITY) > now.getTime()) {
        throw new PersistenceError("KEY_DESTRUCTION_UNSAFE", `${source} key version ${version} has not reached its destruction horizon.`);
      }
      const identity = metadata?.keyIdentity;
      const result = await client.query<ReferenceCountRow>(
        source === "resume"
          ? `SELECT COUNT(*)::text AS reference_count FROM (
               SELECT 1 FROM samurai_persistence.guest_resume_digests
                WHERE digest_key_version = $1 AND ($2::bytea IS NULL OR digest_key_identity = $2)
               UNION ALL
               SELECT 1 FROM samurai_persistence.deletion_tombstones
                WHERE kind = 'guest-session' AND resume_digest_key_version = $1
                  AND ($2::bytea IS NULL OR resume_digest_key_identity = $2)
             ) refs`
          : `SELECT COUNT(*)::text AS reference_count FROM samurai_persistence.deletion_tombstones
              WHERE digest_key_version = $1 AND ($2::bytea IS NULL OR digest_key_identity = $2)`,
        [version, identity ? keyIdentityBytes(identity) : null],
      );
      if (Number(result.rows[0]?.reference_count ?? 0) !== 0) {
        throw new PersistenceError("KEY_DESTRUCTION_UNSAFE", `${source} key version ${version} still has database references.`);
      }
    });
  }
}
