import { Pool } from "pg";
import type { JsonObject } from "@samurai-sushi/domain";
import { createCommandEnvelope, parseIdempotencyKey } from "@samurai-sushi/domain";
import type { PoolClient, QueryResult as PgQueryResult } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GuestCommandExecutor } from "../src/command-executor";
import { HmacKeyring, TombstoneKeyring } from "../src/crypto";
import type {
  ConnectedSqlClient,
  QueryResult,
  SqlPool,
  SqlValue,
} from "../src/database";
import type { PersistenceCommandEnvelope } from "../src/domain-adapter";
import {
  CommandAuthenticationError,
  GuestResumeError,
  IdempotencyPayloadMismatchError,
  IdempotencyReceiptExpiredError,
  MigrationChangedError,
  MigrationSchemaDriftError,
  OutboxClaimLostError,
  RevisionConflictError,
} from "../src/errors";
import { GuestSessionService } from "../src/guest-sessions";
import { PersistenceKeyInventoryService } from "../src/key-inventory";
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

const hmacKey = (version: number, marker: number) => ({ version, key: new Uint8Array(32).fill(marker) });
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
  const resumeKeys = new HmacKeyring(hmacKey(2, 2), hmacKey(1, 1));
  const tombstoneKeys = new TombstoneKeyring(hmacKey(3, 3));
  let now = new Date("2026-08-01T12:00:00.000Z");
  const sessionService = new GuestSessionService(pool, resumeKeys, tombstoneKeys);
  const executor = new GuestCommandExecutor(pool, resumeKeys, tombstoneKeys);
  const outbox = new OutboxDeliveryService(pool, { maxAttempts: 3 });

  beforeAll(async () => {
    await rawPool.query("DROP SCHEMA IF EXISTS samurai_persistence CASCADE");
    await applyMigrations(pool);
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
      [migration?.name ?? "", migration?.checksum ?? new Uint8Array(), new Uint8Array(32)],
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

  it("serializes two concurrent clean migration attempts into one attested catalog", async () => {
    await rawPool.query("DROP SCHEMA samurai_persistence CASCADE");
    await Promise.all([applyMigrations(pool), applyMigrations(pool)]);
    const result = await rawPool.query<CountRow>("SELECT count(*)::text AS count FROM samurai_persistence.schema_migrations");
    expect(result.rows[0]?.count).toBe("1");
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
    const twoAttemptOutbox = new OutboxDeliveryService(pool, { maxAttempts: 2 });
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
    const racingService = new GuestSessionService(racingPool, resumeKeys, tombstoneKeys);
    await expect(racingService.rotate(issued.resumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_EXPIRED" });
    const digests = await rawPool.query<{ slot: string }>(
      "SELECT slot FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1 ORDER BY slot",
      [issued.session.id],
    );
    expect(digests.rows).toEqual([{ slot: "current" }]);
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

    const missingTombstoneKeys = new TombstoneKeyring(hmacKey(4, 4));
    const missingTombstoneKeyService = new GuestSessionService(
      pool,
      resumeKeys,
      missingTombstoneKeys,
    );
    await expect(
      new PersistenceKeyInventoryService(pool, resumeKeys, missingTombstoneKeys).assertReady(),
    ).rejects.toMatchObject({ code: "KEY_VERSION_UNAVAILABLE" });
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
    const live = await missingTombstoneKeyService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await expect(
      new PersistenceKeyInventoryService(
        pool,
        new HmacKeyring(hmacKey(9, 9)),
        missingTombstoneKeys,
      ).assertReady(),
    ).rejects.toMatchObject({ code: "KEY_VERSION_UNAVAILABLE" });
    await missingTombstoneKeyService.delete(live.resumeSecret);
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
