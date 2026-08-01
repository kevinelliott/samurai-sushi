import { createHash } from "node:crypto";
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
  GuestResumeError,
  IdempotencyPayloadMismatchError,
  RevisionConflictError,
} from "../src/errors";
import { GuestSessionService } from "../src/guest-sessions";
import { applyMigrations } from "../src/migrations";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

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

interface CountRow {
  readonly count: string;
}

interface RevisionRow {
  readonly revision: string;
  readonly checkpoint: Readonly<Record<string, unknown>>;
}

const hmacKey = (version: number, marker: number) => ({ version, key: new Uint8Array(32).fill(marker) });
const sha256 = (value: string): `sha256:${string}` => `sha256:${createHash("sha256").update(value).digest("hex")}`;

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

describeDatabase("PostgreSQL persistence spine", () => {
  const rawPool = new Pool({ connectionString: databaseUrl });
  const pool = new PgPoolAdapter(rawPool);
  const resumeKeys = new HmacKeyring(hmacKey(2, 2), hmacKey(1, 1));
  const tombstoneKeys = new TombstoneKeyring(hmacKey(3, 3));
  let now = new Date("2026-08-01T12:00:00.000Z");
  const sessionService = new GuestSessionService(pool, resumeKeys, tombstoneKeys, { now: () => now });
  const executor = new GuestCommandExecutor(pool, () => now);

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
       SET created_at = $2, last_seen_at = $2, rotate_after = $3, expires_at = $4
       WHERE id = $1`,
      [
        issued.session.id,
        new Date(now.getTime() - 31 * 24 * 60 * 60 * 1_000),
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000),
        new Date(now.getTime() - 1),
      ],
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
    await executor.execute(command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd560", 0), () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd561",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: true, resultHash: sha256("accepted") },
    }));
    now = new Date(issued.session.expiresAt.getTime() + 1);
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
      response: { schemaVersion: 1, payload: { accepted: true }, resultHash: sha256("accepted") },
    });
    const first = await executor.execute(envelope, handler);
    const retry = await executor.execute(envelope, () => {
      throw new Error("the domain handler must not run for a durable retry");
    });
    expect(first).toMatchObject({ disposition: "committed", committedRevision: 1 });
    expect(retry).toEqual({ ...first, disposition: "replayed" });
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
        response: { schemaVersion: 1, payload: { accepted: true }, resultHash: sha256("accepted") },
      };
    };
    const results = await Promise.all([
      executor.execute(envelope, handler),
      executor.execute(envelope, handler),
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
    await executor.execute(command(issued.session.id, idempotencyKey, 0), () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd554",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: { accepted: true }, resultHash: sha256("accepted") },
    }));
    await expect(
      executor.execute(command(issued.session.id, idempotencyKey, 0, { action: "changed" }), () => {
        throw new Error("must not run");
      }),
    ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    for (const changed of [
      { ...command(issued.session.id, idempotencyKey, 0), commandName: "checkpoint.rewind" },
      { ...command(issued.session.id, idempotencyKey, 0), contentVersion: "content-v2" },
      { ...command(issued.session.id, idempotencyKey, 0), expectedRevision: 1 },
    ] as const) {
      await expect(
        executor.execute(changed, () => {
          throw new Error("must not run");
        }),
      ).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    }
    await expect(
      executor.execute(command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd555", 0), () => {
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
      executor.execute(command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd557", 0), () => ({
        checkpointSchemaVersion: 1,
        checkpoint: { step: 1 },
        event: {
          eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd556",
          eventType: "checkpoint.advanced",
          schemaVersion: 1,
          payload: { step: 1 },
        },
        response: { schemaVersion: 1, payload: { accepted: true }, resultHash: sha256("accepted") },
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

  it("deletes the complete stage-1 subject matrix and leaves only irreversible tombstones", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await executor.execute(command(issued.session.id, "018f47fe-347b-4dac-8f45-a6f3f43bd558", 0), () => ({
      checkpointSchemaVersion: 1,
      checkpoint: { step: 1 },
      event: {
        eventId: "018f47fe-347b-4dac-8f45-a6f3f43bd559",
        eventType: "checkpoint.advanced",
        schemaVersion: 1,
        payload: { step: 1 },
      },
      response: { schemaVersion: 1, payload: { accepted: true }, resultHash: sha256("accepted") },
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
