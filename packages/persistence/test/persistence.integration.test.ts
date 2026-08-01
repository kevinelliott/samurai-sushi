import { Pool } from "pg";
import type { JsonObject } from "@samurai-sushi/domain";
import { createCommandEnvelope, parseIdempotencyKey } from "@samurai-sushi/domain";
import type { PoolClient, QueryResult as PgQueryResult } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GuestCommandExecutor } from "../src/command-executor";
import { hmacKeyIdentity, HmacKeyring, issueResumeSecret, keyIdentityBytes, TombstoneKeyring } from "../src/crypto";
import type {
  ConnectedSqlClient,
  QueryResult,
  SqlPool,
  SqlValue,
} from "../src/database";
import type { PersistenceCommandEnvelope } from "../src/domain-adapter";
import {
  CommandAuthenticationError,
  GuestRotationDeferredError,
  GuestRotationRequiredError,
  GuestResumeError,
  IdempotencyPayloadMismatchError,
  IdempotencyReceiptExpiredError,
  MigrationChangedError,
  MigrationSchemaDriftError,
  OutboxClaimLostError,
  RevisionConflictError,
} from "../src/errors";
import { GuestSessionService } from "../src/guest-sessions";
import { PersistenceAuthority } from "../src/key-inventory";
import { ADR_0003_PERSISTENCE_LIFECYCLE } from "../src/lifecycle";
import { applyMigrations, bundledMigrations } from "../src/migrations";
import { OutboxDeliveryService } from "../src/outbox";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; the PostgreSQL persistence suite must never skip silently.");

class PgClientAdapter implements ConnectedSqlClient {
  constructor(private readonly client: PoolClient) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result = await this.client.query(text, values ? [...values] : undefined);
    return result as unknown as QueryResult<Row>;
  }

  release(): void {
    this.client.release();
  }
}

class PgPoolAdapter implements SqlPool {
  constructor(readonly pool: Pool) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result = await this.pool.query(text, values ? [...values] : undefined);
    return result as unknown as QueryResult<Row>;
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new PgClientAdapter(await this.pool.connect());
  }
}

class FailAfterMigrationClient implements ConnectedSqlClient {
  constructor(private readonly delegate: ConnectedSqlClient) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result = await this.delegate.query<Row>(text, values);
    if (text.includes("CREATE TABLE samurai_persistence.guest_sessions")) {
      throw new Error("Injected failure after migration DDL.");
    }
    return result;
  }

  release(): void {
    this.delegate.release();
  }
}

class FailAfterMigrationPool implements SqlPool {
  constructor(private readonly delegate: SqlPool) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new FailAfterMigrationClient(await this.delegate.connect());
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

class ObservedAdvisoryLockClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly attempted: Deferred<number>,
    private readonly acquired: Deferred<number>,
    private readonly releaseAfterAcquisition?: Promise<void>,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    if (!text.includes("pg_advisory_xact_lock")) return this.delegate.query<Row>(text, values);
    const backend = await this.delegate.query<{ readonly pid: string }>("SELECT pg_backend_pid()::text AS pid");
    const pid = Number(backend.rows[0]?.pid);
    this.attempted.resolve(pid);
    const result = await this.delegate.query<Row>(text, values);
    this.acquired.resolve(pid);
    if (this.releaseAfterAcquisition) await this.releaseAfterAcquisition;
    return result;
  }

  release(): void {
    this.delegate.release();
  }
}

class ObservedAdvisoryLockPool implements SqlPool {
  constructor(
    private readonly delegate: SqlPool,
    readonly attempted: Deferred<number>,
    readonly acquired: Deferred<number>,
    private readonly releaseAfterAcquisition?: Promise<void>,
  ) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new ObservedAdvisoryLockClient(
      await this.delegate.connect(),
      this.attempted,
      this.acquired,
      this.releaseAfterAcquisition,
    );
  }
}

class ObservedSessionLockClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly attempted: Deferred<number>,
    private readonly acquired: Deferred<number>,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    if (!text.includes("FOR UPDATE OF s")) return this.delegate.query<Row>(text, values);
    const backend = await this.delegate.query<{ readonly pid: string }>("SELECT pg_backend_pid()::text AS pid");
    const pid = Number(backend.rows[0]?.pid);
    this.attempted.resolve(pid);
    const result = await this.delegate.query<Row>(text, values);
    this.acquired.resolve(pid);
    return result;
  }

  release(): void {
    this.delegate.release();
  }
}

class ObservedSessionLockPool implements SqlPool {
  constructor(
    private readonly delegate: SqlPool,
    readonly attempted: Deferred<number>,
    readonly acquired: Deferred<number>,
  ) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new ObservedSessionLockClient(
      await this.delegate.connect(),
      this.attempted,
      this.acquired,
    );
  }
}

class ObservedReplayFenceClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly attempted: Deferred<number>,
    private readonly acquired: Deferred<number>,
    private readonly releaseFence?: Promise<void>,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const scope = values?.[0];
    if (!text.includes("pg_advisory_xact_lock") || typeof scope !== "string" || !scope.startsWith("guest-resume-replay:")) {
      return this.delegate.query<Row>(text, values);
    }
    const backend = await this.delegate.query<{ readonly pid: string }>("SELECT pg_backend_pid()::text AS pid");
    const pid = Number(backend.rows[0]?.pid);
    this.attempted.resolve(pid);
    const result = await this.delegate.query<Row>(text, values);
    this.acquired.resolve(pid);
    await this.releaseFence;
    return result;
  }

  release(): void {
    this.delegate.release();
  }
}

class ObservedReplayFencePool implements SqlPool {
  constructor(
    private readonly delegate: SqlPool,
    readonly attempted: Deferred<number>,
    readonly acquired: Deferred<number>,
    private readonly releaseFence?: Promise<void>,
  ) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new ObservedReplayFenceClient(
      await this.delegate.connect(),
      this.attempted,
      this.acquired,
      this.releaseFence,
    );
  }
}

async function expectAdvisoryWait(rawPool: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const locks = await rawPool.query<{ readonly granted: boolean }>(
      "SELECT granted FROM pg_locks WHERE locktype = 'advisory' AND pid = $1",
      [pid],
    );
    if (locks.rows.some((row) => !row.granted)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not block on the migration advisory lock.`);
}

async function expectLockWait(rawPool: Pool, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const activity = await rawPool.query<{ readonly wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not block on a row lock.`);
}

class AfterCommitClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly afterCommit: () => Promise<void>,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result = await this.delegate.query<Row>(text, values);
    if (text.trim() === "COMMIT") await this.afterCommit();
    return result;
  }

  release(): void {
    this.delegate.release();
  }
}

class AfterFirstCommitPool implements SqlPool {
  private fired = false;

  constructor(
    private readonly delegate: SqlPool,
    private readonly onFirstCommit: () => Promise<void>,
  ) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new AfterCommitClient(await this.delegate.connect(), async () => {
      if (this.fired) return;
      this.fired = true;
      await this.onFirstCommit();
    });
  }
}

interface CountRow {
  readonly count: string;
}

interface RevisionRow {
  readonly revision: string;
  readonly checkpoint: Readonly<Record<string, unknown>>;
}

const hmacKey = (purpose: "resume" | "tombstone", version: number, marker: number, retired = false) => {
  const key = new Uint8Array(32).fill(marker);
  return {
    version,
    key,
    keyIdentity: hmacKeyIdentity(purpose, key),
    activatedAt: new Date("2025-01-01T00:00:00.000Z"),
    retiredAt: retired ? new Date("2026-06-01T00:00:00.000Z") : null,
    verifyUntil: retired ? new Date("2027-01-01T00:00:00.000Z") : null,
    compromisedAt: null,
  } as const;
};
function command(
  guestSessionId: string,
  idempotencyKey: string,
  expectedRevision: number,
  payload: JsonObject = { action: "advance" },
): PersistenceCommandEnvelope<JsonObject> {
  return createCommandEnvelope({
    schemaVersion: 1,
    commandName: "checkpoint.advance",
    subject: { kind: "guest", guestSessionId },
    idempotencyKey: parseIdempotencyKey(idempotencyKey),
    expectedRevision,
    contentVersion: "content-v1",
    payload,
  }) as PersistenceCommandEnvelope<JsonObject>;
}

describe("PostgreSQL persistence spine", () => {
  const rawPool = new Pool({ connectionString: databaseUrl });
  const pool = new PgPoolAdapter(rawPool);
  const resumeKeys = new HmacKeyring(hmacKey("resume", 2, 2), hmacKey("resume", 1, 1, true));
  const tombstoneKeys = new TombstoneKeyring(hmacKey("tombstone", 3, 3));
  const authority = new PersistenceAuthority(pool, resumeKeys, tombstoneKeys);
  let now = new Date("2026-08-01T12:00:00.000Z");
  const sessionService = new GuestSessionService(pool, authority);
  const executor = new GuestCommandExecutor(pool, authority);
  const outbox = new OutboxDeliveryService(pool, authority, { maxAttempts: 3 });

  beforeAll(async () => {
    await rawPool.query("DROP SCHEMA IF EXISTS samurai_persistence CASCADE");
    await applyMigrations(pool);
    await authority.bootstrap();
  });

  beforeEach(async () => {
    now = new Date("2026-08-01T12:00:00.000Z");
    await rawPool.query("TRUNCATE samurai_persistence.guest_sessions CASCADE");
    await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
  });

  afterAll(async () => {
    await rawPool.end();
  });

  it("migrates an empty PostgreSQL database and cleanly reapplies forward migrations", async () => {
    const migration = (await bundledMigrations())[0];
    expect(Buffer.from(migration?.checksum ?? []).toString("hex")).toBe(
      "00d95adda1af34ed05a5e9477d597455af9d53ded2c09f86452e9cb1a13eff1f",
    );
    await applyMigrations(pool);
    const result = await rawPool.query<CountRow>("SELECT count(*)::text AS count FROM samurai_persistence.schema_migrations");
    expect(result.rows[0]?.count).toBe("1");
  });

  it("fails closed without mutating an empty or partial pre-existing namespace", async () => {
    for (const precreate of [
      "CREATE SCHEMA samurai_persistence",
      "CREATE SCHEMA samurai_persistence; CREATE TABLE samurai_persistence.guest_sessions (id text PRIMARY KEY)",
    ]) {
      await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
      await rawPool.query(precreate);
      await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
      const ledger = await rawPool.query<{ ledger: string | null }>(
        "SELECT to_regclass('samurai_persistence.schema_migrations')::text AS ledger",
      );
      expect(ledger.rows[0]?.ledger).toBeNull();
    }
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);
  });

  it("rejects a forged matching ledger when the live catalog is partial", async () => {
    const migration = (await bundledMigrations())[0];
    expect(migration).toBeDefined();
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await rawPool.query(`
      CREATE SCHEMA samurai_persistence;
      CREATE TABLE samurai_persistence.schema_migrations (
        name text PRIMARY KEY,
        checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
        catalog_checksum bytea NOT NULL CHECK (octet_length(catalog_checksum) = 32),
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE samurai_persistence.guest_sessions (id text PRIMARY KEY)
    `);
    await rawPool.query(
      "INSERT INTO samurai_persistence.schema_migrations (name, checksum, catalog_checksum) VALUES ($1, $2, $3)",
      [migration?.name ?? "", migration?.checksum ?? new Uint8Array(), migration?.catalogChecksum ?? new Uint8Array()],
    );
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    const tables = await rawPool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'samurai_persistence' ORDER BY table_name",
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["guest_sessions", "schema_migrations"]);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);
  });

  it("rejects a pre-existing empty exact ledger with or without unrelated objects", async () => {
    for (const unexpectedObject of [false, true]) {
      await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
      await rawPool.query(`
        CREATE SCHEMA samurai_persistence;
        CREATE TABLE samurai_persistence.schema_migrations (
          name text PRIMARY KEY,
          checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
          catalog_checksum bytea NOT NULL CHECK (octet_length(catalog_checksum) = 32),
          applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
        )
      `);
      if (unexpectedObject) {
        await rawPool.query("CREATE TABLE samurai_persistence.unexpected (id text PRIMARY KEY)");
      }
      await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
      const tables = await rawPool.query<{ table_name: string }>(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'samurai_persistence' ORDER BY table_name",
      );
      expect(tables.rows.map((row) => row.table_name)).toEqual(
        unexpectedObject ? ["schema_migrations", "unexpected"] : ["schema_migrations"],
      );
    }
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);
  });

  it("holds a concurrent clean migration attempt on the transaction-scoped advisory lock", async () => {
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    const releaseHolder = deferred<void>();
    const holder = new ObservedAdvisoryLockPool(pool, deferred<number>(), deferred<number>(), releaseHolder.promise);
    const first = applyMigrations(holder);
    await holder.acquired.promise;

    const waiter = new ObservedAdvisoryLockPool(pool, deferred<number>(), deferred<number>());
    let waiterAcquired = false;
    void waiter.acquired.promise.then(() => {
      waiterAcquired = true;
    });
    const second = applyMigrations(waiter);
    const waiterPid = await waiter.attempted.promise;
    await expectAdvisoryWait(rawPool, waiterPid);
    expect(waiterAcquired).toBe(false);

    releaseHolder.resolve();
    await Promise.all([first, second]);
    await expect(waiter.acquired.promise).resolves.toBe(waiterPid);
    const result = await rawPool.query<CountRow>("SELECT count(*)::text AS count FROM samurai_persistence.schema_migrations");
    expect(result.rows[0]?.count).toBe("1");
  });

  it("canonicalizes caller search_path and rejects ACL, type, collation, and generic schema-object drift", async () => {
    const alternateSearchPathPool = new Pool({
      connectionString: databaseUrl,
      options: "-c search_path=samurai_persistence,public",
    });
    try {
      await expect(applyMigrations(new PgPoolAdapter(alternateSearchPathPool))).resolves.toBeUndefined();
    } finally {
      await alternateSearchPathPool.end();
    }

    const aclProbeRole = `samurai_migration_acl_probe_${process.pid}`;
    await rawPool.query(`CREATE ROLE ${aclProbeRole} NOLOGIN`);
    try {
      await rawPool.query(`GRANT SELECT (consent_version) ON samurai_persistence.guest_sessions TO ${aclProbeRole}`);
      await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    } finally {
      await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
      await rawPool.query(`DROP ROLE ${aclProbeRole}`);
      await applyMigrations(pool);
    }

    await rawPool.query("CREATE TYPE samurai_persistence.unexpected_state AS ENUM ('unexpected')");
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);

    await rawPool.query(
      "CREATE DOMAIN samurai_persistence.unexpected_identifier AS text CHECK (VALUE <> '')",
    );
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);

    await rawPool.query("CREATE COLLATION samurai_persistence.unexpected_collation FROM pg_catalog.\"C\"");
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);

    await rawPool.query(`
      CREATE OPERATOR samurai_persistence.=== (
        LEFTARG = integer,
        RIGHTARG = integer,
        FUNCTION = pg_catalog.int4eq
      )
    `);
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);

    await rawPool.query(`
      CREATE STATISTICS samurai_persistence.unexpected_stats (dependencies)
        ON consent_version, state
      FROM samurai_persistence.guest_sessions
    `);
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);
  });

  it("rejects changed migration bytes, unknown ledger rows, and live catalog drift", async () => {
    const migration = (await bundledMigrations())[0];
    expect(migration).toBeDefined();
    await rawPool.query(
      "UPDATE samurai_persistence.schema_migrations SET checksum = $2 WHERE name = $1",
      [migration!.name, new Uint8Array(32)],
    );
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationChangedError);
    await rawPool.query(
      "UPDATE samurai_persistence.schema_migrations SET checksum = $2 WHERE name = $1",
      [migration!.name, migration!.checksum],
    );

    await rawPool.query(
      `INSERT INTO samurai_persistence.schema_migrations (name, checksum, catalog_checksum)
       VALUES ('9999_future.sql', $1, $1)`,
      [new Uint8Array(32)],
    );
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DELETE FROM samurai_persistence.schema_migrations WHERE name = '9999_future.sql'");

    await rawPool.query("DROP INDEX samurai_persistence.guest_resume_digests_lookup");
    await rawPool.query(
      "CREATE INDEX guest_resume_digests_lookup ON samurai_persistence.guest_resume_digests (guest_session_id)",
    );
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);

    const invalidated = await rawPool.query(
      `UPDATE pg_catalog.pg_index
          SET indisvalid = false
        WHERE indexrelid = 'samurai_persistence.guest_resume_digests_lookup'::regclass`,
    );
    expect(invalidated.rowCount).toBe(1);
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);

    await rawPool.query("ALTER TABLE samurai_persistence.guest_sessions ENABLE ROW LEVEL SECURITY");
    await expect(applyMigrations(pool)).rejects.toBeInstanceOf(MigrationSchemaDriftError);
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await applyMigrations(pool);
  });

  it("rolls an injected first-migration failure back without leaving a namespace or ledger", async () => {
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await expect(applyMigrations(new FailAfterMigrationPool(pool))).rejects.toThrow("Injected failure after migration DDL.");
    const state = await rawPool.query<{ namespace_exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'samurai_persistence') AS namespace_exists",
    );
    expect(state.rows[0]?.namespace_exists).toBe(false);
    await applyMigrations(pool);
  });

  it("issues and resumes a guest while rejecting wrong, expired, and deleted secrets", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await expect(sessionService.resume(issued.resumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
    await expect(sessionService.resume("A".repeat(43))).rejects.toBeInstanceOf(GuestResumeError);

    await rawPool.query(
      `UPDATE samurai_persistence.guest_sessions
          SET created_at = clock_timestamp() - interval '31 days',
              last_seen_at = clock_timestamp() - interval '31 days',
              rotate_after = clock_timestamp() - interval '30 days',
              expires_at = clock_timestamp() - interval '1 millisecond'
        WHERE id = $1`,
      [issued.session.id],
    );
    await expect(sessionService.resume(issued.resumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_EXPIRED" });
    await rawPool.query("UPDATE samurai_persistence.guest_sessions SET expires_at = $2 WHERE id = $1", [
      issued.session.id,
      issued.session.expiresAt,
    ]);
    await sessionService.delete(issued.resumeSecret);
    await expect(sessionService.resume(issued.resumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_INVALID" });
  });

  it("deletes expired guest-owned rows in one retention batch and leaves only irreversible tombstones", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await executor.execute(issued.resumeSecret, command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd560", 0), () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd561",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: true },
    }));
    await rawPool.query(
      `UPDATE samurai_persistence.guest_sessions
          SET created_at = clock_timestamp() - interval '31 days',
              last_seen_at = clock_timestamp() - interval '31 days',
              rotate_after = clock_timestamp() - interval '30 days',
              expires_at = clock_timestamp() - interval '1 millisecond'
        WHERE id = $1`,
      [issued.session.id],
    );
    await expect(sessionService.deleteExpired()).resolves.toBe(1);
    await expect(sessionService.resume(issued.resumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_INVALID" });
    for (const table of [
      "guest_sessions",
      "guest_resume_digests",
      "guest_progress",
      "command_receipts",
      "domain_events",
      "outbox_deliveries",
    ]) {
      const result = (await rawPool.query(`SELECT count(*)::text AS count FROM samurai_persistence.${table}`)) as PgQueryResult<CountRow>;
      expect(result.rows[0]?.count, table).toBe("0");
    }
    const tombstones = await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.deletion_tombstones",
    );
    expect(tombstones.rows[0]?.count).toBe("2");
  });

  it("returns the stored versioned response for an exact retry before checking stale revision", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd551", 0);
    const handler = () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd552",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: { accepted: true } },
    });
    const first = await executor.execute(issued.resumeSecret, envelope, handler);
    const retry = await executor.execute(issued.resumeSecret, envelope, () => {
      throw new Error("the domain handler must not run for a durable retry");
    });
    expect(first).toMatchObject({ disposition: "committed", committedRevision: 1 });
    expect(retry).toEqual({ ...first, disposition: "replayed" });
    expect(Object.isFrozen(first.response)).toBe(true);
    expect(Object.isFrozen(retry.response)).toBe(true);
  });

  it("authenticates and locks the unexpired guest before any receipt access", async () => {
    const firstGuest = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const secondGuest = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    let handlerCalls = 0;
    await expect(
      executor.execute(
        firstGuest.resumeSecret,
        command(secondGuest.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd570", 0),
        () => {
          handlerCalls += 1;
          throw new Error("must not run");
        },
      ),
    ).rejects.toBeInstanceOf(CommandAuthenticationError);
    await expect(
      executor.execute(
        "A".repeat(43),
        command(firstGuest.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd571", 0),
        () => {
          handlerCalls += 1;
          throw new Error("must not run");
        },
      ),
    ).rejects.toBeInstanceOf(CommandAuthenticationError);
    expect(handlerCalls).toBe(0);
  });

  it("rejects expired receipts and expired sessions before invoking the handler", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd572", 0);
    await executor.execute(issued.resumeSecret, envelope, () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd573",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: { accepted: true } },
    }));
    await rawPool.query(
      "UPDATE samurai_persistence.command_receipts SET expires_at = clock_timestamp() WHERE guest_session_id = $1",
      [issued.session.id],
    );
    await expect(
      executor.execute(issued.resumeSecret, envelope, () => {
        throw new Error("must not run");
      }),
    ).rejects.toBeInstanceOf(IdempotencyReceiptExpiredError);
    await rawPool.query(
      `UPDATE samurai_persistence.guest_sessions
          SET created_at = clock_timestamp() - interval '31 days',
              last_seen_at = clock_timestamp() - interval '31 days',
              rotate_after = clock_timestamp() - interval '30 days',
              expires_at = clock_timestamp()
        WHERE id = $1`,
      [issued.session.id],
    );
    await expect(
      executor.execute(issued.resumeSecret, envelope, () => {
        throw new Error("must not run");
      }),
    ).rejects.toBeInstanceOf(CommandAuthenticationError);
  });

  it("rechecks receipt expiry after waiting on the guest-session row lock", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd603", 0);
    await executor.execute(issued.resumeSecret, envelope, () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd604",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: true },
    }));
    const attempted = deferred<number>();
    const acquired = deferred<number>();
    const observedPool = new ObservedSessionLockPool(pool, attempted, acquired);
    const observedAuthority = new PersistenceAuthority(observedPool, resumeKeys, tombstoneKeys);
    await observedAuthority.bootstrap();
    const observedExecutor = new GuestCommandExecutor(observedPool, observedAuthority);
    const blocker = await rawPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE", [issued.session.id]);
      const pending = observedExecutor.execute(issued.resumeSecret, envelope, () => {
        throw new Error("the handler must not run for a durable retry");
      });
      const pid = await attempted.promise;
      await expectLockWait(rawPool, pid);
      await blocker.query(
        "UPDATE samurai_persistence.command_receipts SET expires_at = clock_timestamp() + interval '100 milliseconds' WHERE guest_session_id = $1",
        [issued.session.id],
      );
      await blocker.query("SELECT pg_sleep(0.2)");
      await blocker.query("COMMIT");
      await acquired.promise;
      await expect(pending).rejects.toBeInstanceOf(IdempotencyReceiptExpiredError);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("rechecks session expiry after resume waits on the guest-session row lock", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const attempted = deferred<number>();
    const acquired = deferred<number>();
    const observedPool = new ObservedSessionLockPool(pool, attempted, acquired);
    const observedAuthority = new PersistenceAuthority(observedPool, resumeKeys, tombstoneKeys);
    await observedAuthority.bootstrap();
    const observedService = new GuestSessionService(observedPool, observedAuthority);
    const blocker = await rawPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE", [issued.session.id]);
      const pending = observedService.resume(issued.resumeSecret);
      const pid = await attempted.promise;
      await expectLockWait(rawPool, pid);
      await blocker.query(
        `UPDATE samurai_persistence.guest_sessions
            SET rotate_after = clock_timestamp() + interval '50 milliseconds',
                expires_at = clock_timestamp() + interval '100 milliseconds'
          WHERE id = $1`,
        [issued.session.id],
      );
      await blocker.query("SELECT pg_sleep(0.2)");
      await blocker.query("COMMIT");
      await acquired.promise;
      await expect(pending).rejects.toMatchObject({ code: "GUEST_RESUME_EXPIRED" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("starts the full receipt lifetime from a fresh post-handler database timestamp", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    let handlerFinishedAt: Date | undefined;
    await executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd605", 0),
      async () => {
        await rawPool.query("SELECT pg_sleep(0.2)");
        const clock = await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
        handlerFinishedAt = clock.rows[0]!.now;
        return {
          checkpointSchemaVersion: 1,
          checkpoint: { step: 1 },
          event: {
            eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd606",
            eventType: "checkpoint.advanced",
            schemaVersion: 1,
            payload: { step: 1 },
          },
          response: { schemaVersion: 1, payload: true },
        };
      },
    );
    const receipt = await rawPool.query<{ readonly created_at: Date; readonly expires_at: Date }>(
      `SELECT created_at, expires_at
         FROM samurai_persistence.command_receipts
        WHERE guest_session_id = $1 AND idempotency_key = $2`,
      [issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd605"],
    );
    expect(handlerFinishedAt).toBeDefined();
    expect(receipt.rows[0]!.created_at.getTime()).toBeGreaterThanOrEqual(handlerFinishedAt!.getTime());
    expect(receipt.rows[0]!.expires_at.getTime() - receipt.rows[0]!.created_at.getTime())
      .toBe(ADR_0003_PERSISTENCE_LIFECYCLE.receiptLifetimeMs);
  });

  it("rolls back when a handler crosses the locked session authority boundary", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await rawPool.query(
      `UPDATE samurai_persistence.guest_sessions
          SET rotate_after = clock_timestamp() + interval '400 milliseconds',
              expires_at = clock_timestamp() + interval '500 milliseconds'
        WHERE id = $1`,
      [issued.session.id],
    );
    let handled = false;
    await expect(executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd607", 0),
      async () => {
        handled = true;
        await rawPool.query("SELECT pg_sleep(0.6)");
        return {
          checkpointSchemaVersion: 1,
          checkpoint: { step: 1 },
          event: {
            eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd608",
            eventType: "checkpoint.advanced",
            schemaVersion: 1,
            payload: { step: 1 },
          },
          response: { schemaVersion: 1, payload: true },
        };
      },
    )).rejects.toBeInstanceOf(CommandAuthenticationError);
    expect(handled).toBe(true);

    const state = await rawPool.query<{
      readonly revision: string;
      readonly receipt_count: string;
      readonly event_count: string;
      readonly outbox_count: string;
    }>(
      `SELECT progress.revision::text,
              (SELECT count(*) FROM samurai_persistence.command_receipts
                WHERE guest_session_id = $1)::text AS receipt_count,
              (SELECT count(*) FROM samurai_persistence.domain_events
                WHERE guest_session_id = $1)::text AS event_count,
              (SELECT count(*) FROM samurai_persistence.outbox_deliveries delivery
                 JOIN samurai_persistence.domain_events event ON event.event_id = delivery.event_id
                WHERE event.guest_session_id = $1)::text AS outbox_count
         FROM samurai_persistence.guest_progress progress
        WHERE progress.guest_session_id = $1`,
      [issued.session.id],
    );
    expect(state.rows[0]).toEqual({
      revision: "0",
      receipt_count: "0",
      event_count: "0",
      outbox_count: "0",
    });
  });

  it("detaches canonical command, checkpoint, decision, and response values", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { nested: { step: 0 } },
    });
    const envelope = command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd574", 0);
    const forged = { ...envelope, payload: { action: "forged" } };
    await expect(
      executor.execute(issued.resumeSecret, forged, () => {
        throw new Error("must not run");
      }),
    ).rejects.toMatchObject({ code: "INVALID_COMMAND_SHAPE" });

    const response = { accepted: true, nested: { order: [2, 1] } };
    const first = await executor.execute(issued.resumeSecret, envelope, (checkpoint, canonicalCommand) => {
      expect(Object.isFrozen(checkpoint)).toBe(true);
      expect(Object.isFrozen((checkpoint as { nested: object }).nested)).toBe(true);
      expect(Object.isFrozen(canonicalCommand)).toBe(true);
      expect(Object.isFrozen(canonicalCommand.payload)).toBe(true);
      return {
        checkpointSchemaVersion: 1,
        checkpoint: { nested: { step: 1 } },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd575",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: 1 },
        },
        response: { schemaVersion: 1, payload: response },
      };
    });
    response.nested.order[0] = 99;
    const retry = await executor.execute(issued.resumeSecret, envelope, () => {
      throw new Error("must not run");
    });
    expect(retry.response).toEqual({ accepted: true, nested: { order: [2, 1] } });
    expect(retry.resultHash).toBe(first.resultHash);
    expect(Object.isFrozen(first.response)).toBe(true);
    expect(Object.isFrozen(retry.response)).toBe(true);
  });

  it("fails closed when a stored canonical response drifts from its result hash", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd591", 0);
    await executor.execute(issued.resumeSecret, envelope, () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd592",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: { accepted: true } },
    }));
    await rawPool.query(
      `UPDATE samurai_persistence.command_receipts
          SET response_payload = '{"accepted":false}'::jsonb
        WHERE guest_session_id = $1 AND idempotency_key = $2`,
      [issued.session.id, envelope.idempotencyKey],
    );
    let handlerCalls = 0;
    await expect(
      executor.execute(issued.resumeSecret, envelope, () => {
        handlerCalls += 1;
        throw new Error("must not run");
      }),
    ).rejects.toMatchObject({ code: "RECEIPT_INTEGRITY_FAILURE" });
    expect(handlerCalls).toBe(0);
  });

  it("rejects a hostile non-canonical decision atomically", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await expect(
      executor.execute(issued.resumeSecret, command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd576", 0), () => ({
        checkpointSchemaVersion: 1,
        checkpoint: { step: -0 },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd577",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: 1 },
        },
        response: { schemaVersion: 1, payload: { accepted: true } },
      })),
    ).rejects.toMatchObject({ code: "INVALID_DECISION_SHAPE" });
    const progress = await rawPool.query<RevisionRow>(
      "SELECT revision::text, checkpoint FROM samurai_persistence.guest_progress WHERE guest_session_id = $1",
      [issued.session.id],
    );
    expect(progress.rows[0]).toEqual({ revision: "0", checkpoint: { step: 0 } });
  });

  it("serializes concurrent exact retries so the domain decision commits once", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd562", 0);
    let decisionCount = 0;
    const handler = () => {
      decisionCount += 1;
      return {
        checkpointSchemaVersion: 1,
        checkpoint: { step: 1 },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd563",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: 1 },
        },
        response: { schemaVersion: 1, payload: { accepted: true } },
      };
    };
    const results = await Promise.all([
      executor.execute(issued.resumeSecret, envelope, handler),
      executor.execute(issued.resumeSecret, envelope, handler),
    ]);
    expect(decisionCount).toBe(1);
    expect(results.map((result) => result.disposition).sort()).toEqual(["committed", "replayed"]);
    expect(results[0]?.committedRevision).toBe(1);
    expect(results[1]?.committedRevision).toBe(1);
  });

  it("rejects changed idempotency payload and stale revisions without mutation", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const idempotencyKey = "018f47fe-347b-4dac-8f45-a6f3f43bd553";
    await executor.execute(issued.resumeSecret, command(issued.session.id, idempotencyKey, 0), () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd554",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: { accepted: true } },
    }));
    await expect(
      executor.execute(issued.resumeSecret, command(issued.session.id, idempotencyKey, 0, { action: "changed" }), () => {
        throw new Error("must not run");
      }),
    ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    for (const changed of [
      { ...command(issued.session.id, idempotencyKey, 0), commandName: "checkpoint.rewind" },
      { ...command(issued.session.id, idempotencyKey, 0), contentVersion: "content-v2" },
      { ...command(issued.session.id, idempotencyKey, 0), expectedRevision: 1 },
    ] as const) {
      await expect(
        executor.execute(issued.resumeSecret, changed, () => {
          throw new Error("must not run");
        }),
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    }
    await expect(
      executor.execute(issued.resumeSecret, command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd555", 0), () => {
        throw new Error("must not run");
      }),
    ).rejects.toBeInstanceOf(RevisionConflictError);
    const progress = await rawPool.query<RevisionRow>(
      "SELECT revision::text, checkpoint FROM samurai_persistence.guest_progress WHERE guest_session_id = $1",
      [issued.session.id],
    );
    expect(progress.rows[0]).toEqual({ revision: "1", checkpoint: { step: 1 } });
  });

  it("rolls progress, event, outbox, and receipt back together on a late SQL failure", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await rawPool.query(
      `INSERT INTO samurai_persistence.domain_events
        (event_id, guest_session_id, event_type, schema_version, payload, committed_revision, created_at)
       VALUES ($1, $2, 'seed', 1, '{}'::jsonb, 99, $3)`,
      ["018f47fe-347b-4dac-8f45-a6f3f43bd556", issued.session.id, now],
    );
    await expect(
      executor.execute(issued.resumeSecret, command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd557", 0), () => ({
        checkpointSchemaVersion: 1,
        checkpoint: { step: 1 },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd556",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: 1 },
        },
        response: { schemaVersion: 1, payload: { accepted: true } },
      })),
    ).rejects.toMatchObject({ code: "23505" });
    const progress = await rawPool.query<RevisionRow>(
      "SELECT revision::text, checkpoint FROM samurai_persistence.guest_progress WHERE guest_session_id = $1",
      [issued.session.id],
    );
    expect(progress.rows[0]).toEqual({ revision: "0", checkpoint: { step: 0 } });
    const receipts = await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.command_receipts WHERE guest_session_id = $1",
      [issued.session.id],
    );
    const outbox = await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.outbox_deliveries",
    );
    expect(receipts.rows[0]?.count).toBe("0");
    expect(outbox.rows[0]?.count).toBe("0");
  });

  it("fences outbox claims by lease token and generation through retry and dead-letter", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    for (const [revision, suffix] of [[0, "580"], [1, "582"]] as const) {
      await executor.execute(
        issued.resumeSecret,
        command(issued.session.id, `018f47fe-347b-4dac-8f45-a6f3f43bd${suffix}`, revision),
        () => ({
          checkpointSchemaVersion: 1,
          checkpoint: { step: revision + 1 },
          event: {
            eventId: `018f47fe-347b-4dac-8f45-a6f3f43bd${Number(suffix) + 1}`,
            eventType: "checkpoint.advanced",
            schemaVersion: 1,
            payload: { step: revision + 1 },
          },
          response: { schemaVersion: 1, payload: { accepted: true } },
        }),
      );
    }
    const concurrent = await Promise.all([outbox.claim(1, 60_000), outbox.claim(1, 60_000)]);
    const claims = concurrent.flat();
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map((claim) => claim.eventId)).size).toBe(2);
    const delivered = claims[0];
    const retrying = claims[1];
    expect(delivered).toBeDefined();
    expect(retrying).toBeDefined();
    await outbox.markDelivered(delivered!.eventId, delivered!.claimToken, delivered!.claimGeneration);

    await rawPool.query(
      "UPDATE samurai_persistence.outbox_deliveries SET claim_expires_at = clock_timestamp() WHERE event_id = $1",
      [retrying!.eventId],
    );
    await expect(
      outbox.markDelivered(retrying!.eventId, retrying!.claimToken, retrying!.claimGeneration),
    ).rejects.toBeInstanceOf(OutboxClaimLostError);
    const reclaimed = (await outbox.claim(1, 60_000))[0];
    expect(reclaimed?.eventId).toBe(retrying!.eventId);
    expect(reclaimed?.claimGeneration).toBe(retrying!.claimGeneration + 1);
    await expect(
      outbox.recordFailure(retrying!.eventId, retrying!.claimToken, retrying!.claimGeneration, "STALE"),
    ).rejects.toBeInstanceOf(OutboxClaimLostError);
    await expect(
      outbox.recordFailure(reclaimed!.eventId, reclaimed!.claimToken, reclaimed!.claimGeneration, "TRANSIENT", {
        backoffMs: 60_000,
      }),
    ).resolves.toBe("pending");
    await expect(outbox.claim(1, 60_000)).resolves.toEqual([]);
    await rawPool.query(
      "UPDATE samurai_persistence.outbox_deliveries SET available_at = clock_timestamp() WHERE event_id = $1",
      [retrying!.eventId],
    );
    const terminal = (await outbox.claim(1, 60_000))[0];
    await expect(
      outbox.recordFailure(terminal!.eventId, terminal!.claimToken, terminal!.claimGeneration, "EXHAUSTED", {
      }),
    ).resolves.toBe("dead-letter");
    await expect(outbox.claim(10, 60_000)).resolves.toEqual([]);
  });

  it("dead-letters a repeatedly expired outbox lease at the service-owned attempt limit", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd593", 0),
      () => ({
        checkpointSchemaVersion: 1,
        checkpoint: { step: 1 },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd594",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: 1 },
        },
        response: { schemaVersion: 1, payload: true },
      }),
    );
    const twoAttemptOutbox = new OutboxDeliveryService(pool, authority, { maxAttempts: 2 });
    const first = (await twoAttemptOutbox.claim(1, 60_000))[0];
    expect(first?.attemptCount).toBe(1);
    await rawPool.query(
      "UPDATE samurai_persistence.outbox_deliveries SET claim_expires_at = clock_timestamp() WHERE event_id = $1",
      [first!.eventId],
    );
    const second = (await twoAttemptOutbox.claim(1, 60_000))[0];
    expect(second?.attemptCount).toBe(2);
    await rawPool.query(
      "UPDATE samurai_persistence.outbox_deliveries SET claim_expires_at = clock_timestamp() WHERE event_id = $1",
      [second!.eventId],
    );
    await expect(twoAttemptOutbox.claim(1, 60_000)).resolves.toEqual([]);
    const terminal = await rawPool.query<{ state: string; attempt_count: number; last_error_code: string }>(
      `SELECT state, attempt_count, last_error_code
         FROM samurai_persistence.outbox_deliveries WHERE event_id = $1`,
      [second!.eventId],
    );
    expect(terminal.rows[0]).toEqual({ state: "dead-letter", attempt_count: 2, last_error_code: "LEASE_EXHAUSTED" });
  });

  it("leases only an immutable opaque event fence and deletion revokes the leased row", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd595", 0),
      () => ({
        checkpointSchemaVersion: 1,
        checkpoint: { step: 1 },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd596",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { privateStep: 1 },
        },
        response: { schemaVersion: 1, payload: true },
      }),
    );
    const claim = (await outbox.claim(1, 60_000))[0];
    expect(claim).toBeDefined();
    expect(Object.isFrozen(claim)).toBe(true);
    expect(Object.keys(claim!).sort()).toEqual([
      "attemptCount",
      "claimExpiresAt",
      "claimGeneration",
      "claimToken",
      "eventId",
    ]);
    expect(JSON.stringify(claim)).not.toContain("privateStep");

    await sessionService.delete(issued.resumeSecret);
    await expect(outbox.markDelivered(claim!.eventId, claim!.claimToken, claim!.claimGeneration))
      .rejects.toBeInstanceOf(OutboxClaimLostError);
    await expect(outbox.recordFailure(claim!.eventId, claim!.claimToken, claim!.claimGeneration, "STALE"))
      .rejects.toBeInstanceOf(OutboxClaimLostError);
    const remaining = await rawPool.query<CountRow>(
      `SELECT (SELECT count(*) FROM samurai_persistence.domain_events)::text AS count
       UNION ALL
       SELECT (SELECT count(*) FROM samurai_persistence.outbox_deliveries)::text`,
    );
    expect(remaining.rows.map((row) => row.count)).toEqual(["0", "0"]);
  });

  it("rechecks PostgreSQL time after a blocked outbox row lock for ack and failure", async () => {
    const issueClaim = async (commandSuffix: string, eventSuffix: string) => {
      const issued = await sessionService.issue({
        consentVersion: "privacy-v1",
        contentVersion: "content-v1",
        checkpointSchemaVersion: 1,
        checkpoint: { step: 0 },
      });
      await executor.execute(
        issued.resumeSecret,
        command(issued.session.id, `018f47fe-347b-4dac-8f45-a6f3f43bd${commandSuffix}`, 0),
        () => ({
          checkpointSchemaVersion: 1,
          checkpoint: { step: 1 },
          event: {
            eventId: `018f47fe-347b-4dac-8f45-a6f3f43bd${eventSuffix}`,
            eventType: "checkpoint.advanced",
            schemaVersion: 1,
            payload: { step: 1 },
          },
          response: { schemaVersion: 1, payload: true },
        }),
      );
      return (await outbox.claim(1, 60_000))[0]!;
    };

    const assertBlockedPastExpiry = async (
      claim: Awaited<ReturnType<typeof issueClaim>>,
      transition: () => Promise<unknown>,
    ) => {
      const blocker = await rawPool.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query(
          `UPDATE samurai_persistence.outbox_deliveries
              SET claim_expires_at = clock_timestamp() + interval '100 milliseconds'
            WHERE event_id = $1`,
          [claim.eventId],
        );
        const pending = transition();
        await new Promise((resolve) => setTimeout(resolve, 175));
        await blocker.query("COMMIT");
        await expect(pending).rejects.toBeInstanceOf(OutboxClaimLostError);
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        blocker.release();
      }
    };

    const ackClaim = await issueClaim("597", "598");
    await assertBlockedPastExpiry(
      ackClaim,
      () => outbox.markDelivered(ackClaim.eventId, ackClaim.claimToken, ackClaim.claimGeneration),
    );
    const failClaim = await issueClaim("599", "600");
    await assertBlockedPastExpiry(
      failClaim,
      () => outbox.recordFailure(failClaim.eventId, failClaim.claimToken, failClaim.claimGeneration, "TRANSIENT"),
    );
  });

  it("rejects impossible outbox states at the SQL boundary", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd601", 0),
      () => ({
        checkpointSchemaVersion: 1,
        checkpoint: { step: 1 },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd602",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: 1 },
        },
        response: { schemaVersion: 1, payload: true },
      }),
    );
    const eventId = "018f47fe-347b-4dac-8f45-a6f3f43bd602";
    for (const statement of [
      `UPDATE samurai_persistence.outbox_deliveries SET state = 'processing', claim_token = 'token',
         claim_generation = 1, claim_expires_at = clock_timestamp() + interval '1 minute' WHERE event_id = $1`,
      `UPDATE samurai_persistence.outbox_deliveries SET state = 'processing', attempt_count = 1,
         last_attempt_at = clock_timestamp(), claim_token = '', claim_generation = 1,
         claim_expires_at = clock_timestamp() + interval '1 minute' WHERE event_id = $1`,
      `UPDATE samurai_persistence.outbox_deliveries SET state = 'processing', attempt_count = 1,
         last_attempt_at = clock_timestamp(), claim_token = 'token', claim_generation = 1,
         claim_expires_at = last_attempt_at WHERE event_id = $1`,
      `UPDATE samurai_persistence.outbox_deliveries SET state = 'delivered', delivered_at = clock_timestamp()
         WHERE event_id = $1`,
      `UPDATE samurai_persistence.outbox_deliveries SET state = 'dead-letter', attempt_count = 1,
         claim_generation = 1, last_attempt_at = clock_timestamp(), dead_lettered_at = clock_timestamp()
         WHERE event_id = $1`,
      `UPDATE samurai_persistence.outbox_deliveries SET state = 'dead-letter', attempt_count = 1,
         claim_generation = 1, last_attempt_at = clock_timestamp(), dead_lettered_at = clock_timestamp(),
         last_error_code = 'unstable' WHERE event_id = $1`,
      `UPDATE samurai_persistence.outbox_deliveries SET attempt_count = 1, claim_generation = 1
         WHERE event_id = $1`,
    ]) {
      await expect(rawPool.query(statement, [eventId])).rejects.toMatchObject({ code: "23514" });
    }

    const hostileEvents = [
      ["018f47fe-347b-4dac-8f45-a6f3f43bd603", 2],
      ["018f47fe-347b-4dac-8f45-a6f3f43bd604", 3],
      ["018f47fe-347b-4dac-8f45-a6f3f43bd605", 4],
    ] as const;
    for (const [hostileEventId, revision] of hostileEvents) {
      await rawPool.query(
        `INSERT INTO samurai_persistence.domain_events
          (event_id, guest_session_id, event_type, schema_version, payload, committed_revision, created_at)
         VALUES ($1, $2, 'hostile.outbox-state', 1, '{}'::jsonb, $3, clock_timestamp())`,
        [hostileEventId, issued.session.id, revision],
      );
    }

    const hostileInserts = [
      `INSERT INTO samurai_persistence.outbox_deliveries
        (event_id, state, attempt_count, available_at, last_attempt_at, claim_token, claim_generation, claim_expires_at)
       VALUES ($1, 'processing', 1, clock_timestamp(), clock_timestamp(), 'token', 2,
               clock_timestamp() + interval '1 minute')`,
      `INSERT INTO samurai_persistence.outbox_deliveries
        (event_id, state, attempt_count, available_at, last_attempt_at, claim_generation)
       VALUES ($1, 'pending', 1, clock_timestamp(), clock_timestamp(), 1)`,
      `INSERT INTO samurai_persistence.outbox_deliveries
        (event_id, state, attempt_count, available_at, last_attempt_at, claim_generation, delivered_at, last_error_code)
       VALUES ($1, 'delivered', 1, clock_timestamp(), clock_timestamp(), 1, clock_timestamp(), 'STALE')`,
    ] as const;
    for (const [index, statement] of hostileInserts.entries()) {
      await expect(rawPool.query(statement, [hostileEvents[index]![0]])).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("serializes command execution against deletion without resurrection", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    let markEntered!: () => void;
    let releaseHandler!: () => void;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const release = new Promise<void>((resolve) => { releaseHandler = resolve; });
    const execution = executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd584", 0),
      async () => {
        markEntered();
        await release;
        return {
          checkpointSchemaVersion: 1,
          checkpoint: { step: 1 },
          event: {
            eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd585",
            eventType: "checkpoint.advanced",
            schemaVersion: 1,
            payload: { step: 1 },
          },
          response: { schemaVersion: 1, payload: { accepted: true } },
        };
      },
    );
    await entered;
    const deletion = sessionService.delete(issued.resumeSecret);
    releaseHandler();
    await expect(execution).resolves.toMatchObject({ disposition: "committed" });
    await expect(deletion).resolves.toBeUndefined();
    const rows = await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.guest_sessions WHERE id = $1",
      [issued.session.id],
    );
    expect(rows.rows[0]?.count).toBe("0");
    await expect(
      executor.execute(
        issued.resumeSecret,
        command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd586", 1),
        () => {
          throw new Error("must not run");
        },
      ),
    ).rejects.toBeInstanceOf(CommandAuthenticationError);
  });

  it("rechecks current credential and session expiry in the second rotate transaction", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const racingPool = new AfterFirstCommitPool(pool, async () => {
      await rawPool.query(
        `UPDATE samurai_persistence.guest_sessions
            SET created_at = clock_timestamp() - interval '1 day',
                last_seen_at = clock_timestamp() - interval '1 day',
                rotate_after = clock_timestamp() - interval '1 second',
                expires_at = clock_timestamp()
          WHERE id = $1`,
        [issued.session.id],
      );
    });
    const racingAuthority = new PersistenceAuthority(racingPool, resumeKeys, tombstoneKeys);
    await racingAuthority.bootstrap();
    const racingService = new GuestSessionService(racingPool, racingAuthority);
    await expect(racingService.rotate(issued.resumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_EXPIRED" });
    const digests = await rawPool.query<{ slot: string }>(
      "SELECT slot FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1 ORDER BY slot",
      [issued.session.id],
    );
    expect(digests.rows).toEqual([{ slot: "current" }]);
  });

  it("rejects deleted-secret reissue before tombstone expiry and treats equality as expired", async () => {
    const secret = issueResumeSecret();
    const fixedService = new GuestSessionService(pool, authority, { issueSecret: () => secret });
    await fixedService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await fixedService.delete(secret);
    await expect(fixedService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    })).rejects.toMatchObject({ code: "GUEST_SECRET_TOMBSTONED" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const clock = await client.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
      const boundary = clock.rows[0]!.now;
      await client.query("UPDATE samurai_persistence.deletion_tombstones SET expires_at = $1", [new Date(boundary.getTime() + 1)]);
      await expect(authority.assertGuestSecretNotTombstoned(client, secret, boundary)).rejects.toMatchObject({ code: "GUEST_SECRET_TOMBSTONED" });
      await client.query("UPDATE samurai_persistence.deletion_tombstones SET expires_at = $1", [boundary]);
      await expect(authority.assertGuestSecretNotTombstoned(client, secret, boundary)).resolves.toBeUndefined();
      await client.query("UPDATE samurai_persistence.deletion_tombstones SET expires_at = $1", [new Date(boundary.getTime() - 1)]);
      await expect(authority.assertGuestSecretNotTombstoned(client, secret, boundary)).resolves.toBeUndefined();
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await rawPool.query("UPDATE samurai_persistence.deletion_tombstones SET expires_at = clock_timestamp() - interval '1 millisecond'");
    await expect(fixedService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    })).resolves.toHaveProperty("resumeSecret", secret);
  });

  it("serializes forced-secret issue and delete in both lock orders without resurrecting guest state", async () => {
    const input = {
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    } as const;
    const secret = issueResumeSecret();
    const fixedService = new GuestSessionService(pool, authority, { issueSecret: () => secret });
    await fixedService.issue(input);

    const deleteRelease = deferred<void>();
    const deletePool = new ObservedReplayFencePool(pool, deferred<number>(), deferred<number>(), deleteRelease.promise);
    const blockedIssuePool = new ObservedReplayFencePool(pool, deferred<number>(), deferred<number>());
    const deleteAuthority = new PersistenceAuthority(deletePool, resumeKeys, tombstoneKeys);
    const blockedIssueAuthority = new PersistenceAuthority(blockedIssuePool, resumeKeys, tombstoneKeys);
    await deleteAuthority.bootstrap();
    await blockedIssueAuthority.bootstrap();
    const deleting = new GuestSessionService(deletePool, deleteAuthority).delete(secret);
    await deletePool.acquired.promise;
    const issuingAfterDelete = new GuestSessionService(blockedIssuePool, blockedIssueAuthority, {
      issueSecret: () => secret,
    }).issue(input);
    const blockedIssuePid = await blockedIssuePool.attempted.promise;
    await expectLockWait(rawPool, blockedIssuePid);
    deleteRelease.resolve();
    await expect(deleting).resolves.toBeUndefined();
    await blockedIssuePool.acquired.promise;
    await expect(issuingAfterDelete).rejects.toMatchObject({ code: "GUEST_SECRET_TOMBSTONED" });

    await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
    const issueRelease = deferred<void>();
    const issuePool = new ObservedReplayFencePool(pool, deferred<number>(), deferred<number>(), issueRelease.promise);
    const blockedDeletePool = new ObservedReplayFencePool(pool, deferred<number>(), deferred<number>());
    const issueAuthority = new PersistenceAuthority(issuePool, resumeKeys, tombstoneKeys);
    const blockedDeleteAuthority = new PersistenceAuthority(blockedDeletePool, resumeKeys, tombstoneKeys);
    await issueAuthority.bootstrap();
    await blockedDeleteAuthority.bootstrap();
    const issuingFirst = new GuestSessionService(issuePool, issueAuthority, {
      issueSecret: () => secret,
    }).issue(input);
    await issuePool.acquired.promise;
    const deletingAfterIssue = new GuestSessionService(blockedDeletePool, blockedDeleteAuthority).delete(secret);
    const blockedDeletePid = await blockedDeletePool.attempted.promise;
    await expectLockWait(rawPool, blockedDeletePid);
    issueRelease.resolve();
    await expect(issuingFirst).resolves.toHaveProperty("resumeSecret", secret);
    await blockedDeletePool.acquired.promise;
    await expect(deletingAfterIssue).resolves.toBeUndefined();

    const remaining = await rawPool.query<{ readonly sessions: string; readonly progress: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS sessions,
              (SELECT count(*)::text FROM samurai_persistence.guest_progress) AS progress`,
    );
    expect(remaining.rows[0]).toEqual({ sessions: "0", progress: "0" });
  });

  it("preserves the single predecessor through overlapping use and defers further rotation", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const rotated = await sessionService.rotate(issued.resumeSecret);
    await expect(sessionService.resume(issued.resumeSecret)).resolves.not.toHaveProperty("rotatedResumeSecret");
    await expect(sessionService.resume(issued.resumeSecret)).resolves.not.toHaveProperty("rotatedResumeSecret");
    await rawPool.query("UPDATE samurai_persistence.guest_sessions SET rotate_after = clock_timestamp() WHERE id = $1", [issued.session.id]);
    await expect(sessionService.resume(rotated.rotatedResumeSecret)).resolves.not.toHaveProperty("rotatedResumeSecret");
    await expect(sessionService.rotate(rotated.rotatedResumeSecret)).rejects.toBeInstanceOf(GuestRotationDeferredError);
    const bounded = await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1",
      [issued.session.id],
    );
    expect(bounded.rows[0]?.count).toBe("2");
    await rawPool.query(
      "UPDATE samurai_persistence.guest_resume_digests SET valid_until = clock_timestamp() WHERE guest_session_id = $1 AND slot = 'predecessor'",
      [issued.session.id],
    );
    await expect(sessionService.rotate(rotated.rotatedResumeSecret)).resolves.toHaveProperty("rotatedResumeSecret");
  });

  it("requires rotation at the database boundary and for a retired-key current credential before receipt access", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    let handled = 0;
    const handler = () => {
      handled += 1;
      return {
        checkpointSchemaVersion: 1,
        checkpoint: { step: handled },
        event: {
          eventId: `018f47fe-347b-4dac-8f45-a6f3f43bd${590 + handled}`,
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: handled },
        },
        response: { schemaVersion: 1, payload: { accepted: true } },
      };
    };
    await executor.execute(issued.resumeSecret, command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd590", 0), handler);
    await rawPool.query("UPDATE samurai_persistence.guest_sessions SET rotate_after = clock_timestamp() WHERE id = $1", [issued.session.id]);
    await expect(executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd592", 1),
      handler,
    )).rejects.toBeInstanceOf(GuestRotationRequiredError);
    expect(handled).toBe(1);
    await rawPool.query("UPDATE samurai_persistence.guest_sessions SET rotate_after = clock_timestamp() - interval '1 millisecond' WHERE id = $1", [issued.session.id]);
    await expect(executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd593", 1),
      handler,
    )).rejects.toBeInstanceOf(GuestRotationRequiredError);

    const clock = await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
    const retired = resumeKeys.digest(issued.resumeSecret, clock.rows[0]!.now, 1);
    await rawPool.query(
      `UPDATE samurai_persistence.guest_resume_digests
          SET digest_key_version = $2, digest_key_identity = $3, digest = $4
        WHERE guest_session_id = $1 AND slot = 'current'`,
      [issued.session.id, retired.keyVersion, keyIdentityBytes(retired.keyIdentity), retired.digest],
    );
    await rawPool.query("UPDATE samurai_persistence.guest_sessions SET rotate_after = expires_at WHERE id = $1", [issued.session.id]);
    await expect(executor.execute(
      issued.resumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd594", 1),
      handler,
    )).rejects.toBeInstanceOf(GuestRotationRequiredError);
    expect(handled).toBe(1);
  });

  it("updates last-seen on both committed and replayed commands", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd595", 0);
    const handler = () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: { eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd596", eventType: "checkpoint.advanced", schemaVersion: 1, payload: { step: 1 } },
      response: { schemaVersion: 1, payload: { accepted: true } },
    });
    await rawPool.query("UPDATE samurai_persistence.guest_sessions SET last_seen_at = created_at WHERE id = $1", [issued.session.id]);
    await executor.execute(issued.resumeSecret, envelope, handler);
    const committed = await rawPool.query<{ readonly changed: boolean }>(
      "SELECT last_seen_at > created_at AS changed FROM samurai_persistence.guest_sessions WHERE id = $1",
      [issued.session.id],
    );
    expect(committed.rows[0]?.changed).toBe(true);
    await rawPool.query("UPDATE samurai_persistence.guest_sessions SET last_seen_at = created_at WHERE id = $1", [issued.session.id]);
    await executor.execute(issued.resumeSecret, envelope, handler);
    const replayed = await rawPool.query<{ readonly changed: boolean }>(
      "SELECT last_seen_at > created_at AS changed FROM samurai_persistence.guest_sessions WHERE id = $1",
      [issued.session.id],
    );
    expect(replayed.rows[0]?.changed).toBe(true);
  });

  it("bounds unauthenticated command depth, node count, and string bytes before handler work", async () => {
    let deep: unknown = "leaf";
    for (let depth = 0; depth < 40; depth += 1) deep = { child: deep };
    const wide = Object.fromEntries(Array.from({ length: 2_100 }, (_, index) => [`k${index}`, index]));
    for (const value of [deep, wide, "x".repeat(16 * 1_024 + 1)]) {
      await expect(executor.execute("invalid", value, () => {
        throw new Error("must not run");
      })).rejects.toMatchObject({ code: "COMMAND_BOUNDS_EXCEEDED" });
    }
  });

  it("tombstones every credential consistently and fails closed on missing live key versions", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const rotated = await sessionService.rotate(issued.resumeSecret);
    await executor.execute(
      rotated.rotatedResumeSecret,
      command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd587", 0),
      () => ({
        checkpointSchemaVersion: 1,
        checkpoint: { step: 1 },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd588",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: 1 },
        },
        response: { schemaVersion: 1, payload: true },
      }),
    );
    await sessionService.delete(rotated.rotatedResumeSecret);
    const tombstones = await rawPool.query<{ kind: string; count: string }>(
      `SELECT kind, count(*)::text AS count
         FROM samurai_persistence.deletion_tombstones
        GROUP BY kind ORDER BY kind`,
    );
    expect(tombstones.rows).toEqual([
      { kind: "command", count: "1" },
      { kind: "guest-session", count: "2" },
    ]);

    const missingTombstoneKeys = new TombstoneKeyring(hmacKey("tombstone", 4, 4));
    let missingAuthority = new PersistenceAuthority(pool, resumeKeys, missingTombstoneKeys);
    let missingTombstoneKeyService = new GuestSessionService(pool, missingAuthority);
    await expect(missingAuthority.bootstrap()).resolves.toEqual({
      retentionReady: true,
      capabilityServingReady: false,
      capabilityBlockerCode: "KEY_VERSION_UNAVAILABLE",
    });
    await expect(
      missingTombstoneKeyService.issue({
        consentVersion: "privacy-v1",
        contentVersion: "content-v1",
        checkpointSchemaVersion: 1,
        checkpoint: { step: 0 },
      }),
    ).rejects.toMatchObject({ code: "KEY_VERSION_UNAVAILABLE" });
    await rawPool.query(
      "UPDATE samurai_persistence.deletion_tombstones SET expires_at = clock_timestamp() - interval '1 millisecond'",
    );
    await expect(missingTombstoneKeyService.deleteExpired()).resolves.toBe(0);
    missingAuthority = new PersistenceAuthority(pool, resumeKeys, missingTombstoneKeys);
    await missingAuthority.bootstrap();
    missingTombstoneKeyService = new GuestSessionService(pool, missingAuthority);
    const live = await missingTombstoneKeyService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const missingResumeAuthority = new PersistenceAuthority(
      pool,
      new HmacKeyring(hmacKey("resume", 9, 9)),
      missingTombstoneKeys,
    );
    await expect(missingResumeAuthority.bootstrap()).resolves.toEqual({
      retentionReady: true,
      capabilityServingReady: false,
      capabilityBlockerCode: "KEY_VERSION_UNAVAILABLE",
    });
    const missingResumeService = new GuestSessionService(pool, missingResumeAuthority);
    await expect(missingResumeService.resume(live.resumeSecret))
      .rejects.toMatchObject({ code: "KEY_VERSION_UNAVAILABLE" });
    await rawPool.query(
      `UPDATE samurai_persistence.guest_sessions
          SET expires_at = statement_timestamp() - interval '1 millisecond',
              rotate_after = statement_timestamp() - interval '1 millisecond'
        WHERE id = $1`,
      [live.session.id],
    );
    await expect(missingResumeService.deleteExpired()).resolves.toBe(1);
    const recoveredAuthority = new PersistenceAuthority(pool, resumeKeys, missingTombstoneKeys);
    await expect(recoveredAuthority.bootstrap()).resolves.toEqual({
      retentionReady: true,
      capabilityServingReady: true,
    });
    await expect(new GuestSessionService(pool, recoveredAuthority).issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    })).resolves.toHaveProperty("resumeSecret");
  });

  it("requires the production bootstrap and attests same-version key identity", async () => {
    const unready = new PersistenceAuthority(pool, resumeKeys, tombstoneKeys);
    const unreadyService = new GuestSessionService(pool, unready);
    const unreadyOutbox = new OutboxDeliveryService(pool, unready);
    await expect(unreadyService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    })).rejects.toMatchObject({ code: "PERSISTENCE_NOT_READY" });
    await expect(unreadyOutbox.claim()).rejects.toMatchObject({ code: "PERSISTENCE_NOT_READY" });

    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await rawPool.query(
      "UPDATE samurai_persistence.guest_resume_digests SET digest_key_identity = decode(repeat('ab', 32), 'hex') WHERE guest_session_id = $1",
      [issued.session.id],
    );
    const driftedAuthority = new PersistenceAuthority(pool, resumeKeys, tombstoneKeys);
    await expect(driftedAuthority.bootstrap()).resolves.toEqual({
      retentionReady: true,
      capabilityServingReady: false,
      capabilityBlockerCode: "KEY_IDENTITY_MISMATCH",
    });
    await expect(new GuestSessionService(pool, driftedAuthority).issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    })).rejects.toMatchObject({ code: "KEY_IDENTITY_MISMATCH" });
  });

  it("retains a deleted session's source resume key dependency through the tombstone horizon", async () => {
    const sourceKeys = new HmacKeyring(hmacKey("resume", 16, 16));
    const sourceAuthority = new PersistenceAuthority(pool, sourceKeys, tombstoneKeys);
    await sourceAuthority.bootstrap();
    const sourceService = new GuestSessionService(pool, sourceAuthority);
    const issued = await sourceService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await sourceService.delete(issued.resumeSecret);
    await expect(
      new PersistenceAuthority(
        pool,
        new HmacKeyring(hmacKey("resume", 17, 17)),
        tombstoneKeys,
      ).bootstrap(),
    ).resolves.toEqual({
      retentionReady: true,
      capabilityServingReady: false,
      capabilityBlockerCode: "KEY_VERSION_UNAVAILABLE",
    });
  });

  it("enforces verify horizons and safe destruction against authoritative database time", async () => {
    const tooShort = hmacKey("resume", 10, 10, true);
    const shortRing = new HmacKeyring(
      hmacKey("resume", 11, 11),
      { ...tooShort, verifyUntil: new Date("2026-06-02T00:00:00.000Z") },
    );
    await expect(new PersistenceAuthority(pool, shortRing, tombstoneKeys).bootstrap())
      .resolves.toEqual({
        retentionReady: true,
        capabilityServingReady: false,
        capabilityBlockerCode: "KEY_VERIFY_HORIZON_TOO_SHORT",
      });

    const clock = await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
    const boundary = clock.rows[0]!.now;
    const retiredBytes = new Uint8Array(32).fill(12);
    const retired = {
      version: 12,
      key: retiredBytes,
      keyIdentity: hmacKeyIdentity("resume", retiredBytes),
      activatedAt: new Date("2024-01-01T00:00:00.000Z"),
      retiredAt: new Date("2025-01-01T00:00:00.000Z"),
      verifyUntil: boundary,
      compromisedAt: null,
    } as const;
    const boundaryAuthority = new PersistenceAuthority(
      pool,
      new HmacKeyring(hmacKey("resume", 13, 13), retired),
      tombstoneKeys,
    );
    await boundaryAuthority.bootstrap();
    await expect(boundaryAuthority.assertSafeToDestroy("resume", 12)).resolves.toBeUndefined();
    await expect(authority.assertSafeToDestroy("resume", 1)).rejects.toMatchObject({ code: "KEY_DESTRUCTION_UNSAFE" });
  });

  it("revokes compromised-key capabilities without blocking retention cleanup", async () => {
    const compromised = hmacKey("resume", 14, 14, true);
    const compromisedRing = new HmacKeyring(
      hmacKey("resume", 15, 15),
      { ...compromised, compromisedAt: new Date("2026-07-01T00:00:00.000Z") },
    );
    const compromisedSecret = issueResumeSecret();
    const digestClock = await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
    const digest = new HmacKeyring(
      hmacKey("resume", 15, 15),
      compromised,
    ).digest(compromisedSecret, digestClock.rows[0]!.now, compromised.version);
    const createdAt = new Date("2026-07-30T00:00:00.000Z");
    const expiresAt = new Date("2026-08-02T00:00:00.000Z");
    await rawPool.query(
      `INSERT INTO samurai_persistence.guest_sessions
        (id, consent_version, created_at, last_seen_at, expires_at, rotate_after)
       VALUES ($1, 'privacy-v1', $2, $2, $3, $3)`,
      ["compromised-cleanup-subject", createdAt, expiresAt],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.guest_resume_digests
        (guest_session_id, slot, digest_key_version, digest_key_identity, digest, valid_until)
       VALUES ($1, 'current', $2, $3, $4, NULL)`,
      ["compromised-cleanup-subject", digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
    );
    const cleanupAuthority = new PersistenceAuthority(pool, compromisedRing, tombstoneKeys);
    await expect(cleanupAuthority.bootstrap()).resolves.toEqual({
      retentionReady: true,
      capabilityServingReady: false,
      capabilityBlockerCode: "KEY_VERSION_COMPROMISED",
    });
    const cleanupService = new GuestSessionService(pool, cleanupAuthority);
    await expect(cleanupService.resume(compromisedSecret)).rejects.toMatchObject({ code: "KEY_VERSION_COMPROMISED" });
    await rawPool.query(
      `UPDATE samurai_persistence.guest_sessions
          SET expires_at = statement_timestamp() - interval '1 millisecond',
              rotate_after = statement_timestamp() - interval '1 millisecond'
        WHERE id = $1`,
      ["compromised-cleanup-subject"],
    );
    await expect(cleanupService.deleteExpired()).resolves.toBe(1);
    const remaining = await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.guest_sessions WHERE id = $1",
      ["compromised-cleanup-subject"],
    );
    expect(remaining.rows[0]?.count).toBe("0");

    await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
    const compromisedTombstone = {
      ...hmacKey("tombstone", 16, 16, true),
      compromisedAt: new Date("2026-07-01T00:00:00.000Z"),
    } as const;
    await rawPool.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         resume_digest_key_version, resume_digest_key_identity, created_at, expires_at)
       VALUES ('command', $1, $2, decode(repeat('cd', 32), 'hex'), NULL, NULL,
               clock_timestamp(), clock_timestamp() + interval '1 day')`,
      [compromisedTombstone.version, keyIdentityBytes(compromisedTombstone.keyIdentity)],
    );
    const compromisedTombstoneAuthority = new PersistenceAuthority(
      pool,
      resumeKeys,
      new TombstoneKeyring(hmacKey("tombstone", 17, 17), [compromisedTombstone]),
    );
    await expect(compromisedTombstoneAuthority.bootstrap()).resolves.toEqual({
      retentionReady: true,
      capabilityServingReady: false,
      capabilityBlockerCode: "KEY_VERSION_COMPROMISED",
    });
  });

  it("deletes the complete stage-1 subject matrix and leaves only irreversible tombstones", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await executor.execute(issued.resumeSecret, command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd558", 0), () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd559",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: { accepted: true } },
    }));
    await sessionService.delete(issued.resumeSecret);
    for (const table of [
      "guest_sessions",
      "guest_resume_digests",
      "guest_progress",
      "command_receipts",
      "domain_events",
      "outbox_deliveries",
    ]) {
      const result = (await rawPool.query(`SELECT count(*)::text AS count FROM samurai_persistence.${table}`)) as PgQueryResult<CountRow>;
      expect(result.rows[0]?.count, table).toBe("0");
    }
    const tombstones = await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.deletion_tombstones",
    );
    expect(tombstones.rows[0]?.count).toBe("2");
    const columns = await rawPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'samurai_persistence' AND table_name = 'deletion_tombstones'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("guest_session_id");
  });
});
