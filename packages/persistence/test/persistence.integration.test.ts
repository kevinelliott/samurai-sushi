import { Pool } from "pg";
import { generateKeyPairSync, randomBytes, randomUUID, sign as signMessage } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { b58Encode, getPkhfromPk, PrefixV2 } from "@taquito/utils";
import type { JsonObject } from "@samurai-sushi/domain";
import { createCommandEnvelope, parseIdempotencyKey } from "@samurai-sushi/domain";
import { walletSigningBytes } from "@samurai-sushi/domain/claim-protocol";
import {
  FIRST_EVENING_CONTENT_VERSION,
  FIRST_EVENING_SERVICE_DEFINITION,
  SALMON_SASHIMI_UNLOCK_ID,
  createInitialEveningServiceCheckpoint,
  decodeEveningServiceCheckpoint,
  reduceEveningService,
  type EveningServiceCheckpoint,
} from "@samurai-sushi/domain/evening-service";
import type { PoolClient, QueryResult as PgQueryResult } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GuestCommandExecutor } from "../src/command-executor";
import {
  ACCOUNT_CLAIM_REAUTH_REQUIRED,
  ACCOUNT_CLAIM_PUBLIC_FAILURE,
  ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE,
  ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED,
  ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE,
  AccountClaimAuthority,
  AccountClaimService,
} from "../src/account-claim";
import {
  GuestClaimKeyring,
  hmacKeyIdentity,
  HmacKeyring,
  IntegrityKeyring,
  issueResumeSecret,
  keyIdentityBytes,
  PlayerSessionKeyring,
  TombstoneKeyring,
} from "../src/crypto";
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
import { PortableRecoveryAuthority, PortableRecoveryService } from "../src/portable-recovery";
import { EveningServiceAuthority, mergeFirstEveningCheckpointForClaim } from "../src/service-authority";

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

class FailOnQueryClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly needle: string,
    private readonly failAfter = false,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    if (text.includes(this.needle) && !this.failAfter) throw new Error(`Injected failure at ${this.needle}.`);
    const result = await this.delegate.query<Row>(text, values);
    if (text.includes(this.needle)) throw new Error(`Injected failure after ${this.needle}.`);
    return result;
  }

  release(): void {
    this.delegate.release();
  }
}

class FailOnQueryPool implements SqlPool {
  constructor(
    private readonly delegate: SqlPool,
    private readonly needle: string,
    private readonly failAfter = false,
  ) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new FailOnQueryClient(await this.delegate.connect(), this.needle, this.failAfter);
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

class ObservedQueryLockClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly matches: (text: string) => boolean,
    private readonly attempted: Deferred<number>,
    private readonly acquired: Deferred<number>,
    private readonly releaseAfterAcquisition?: Promise<void>,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    if (!this.matches(text)) return this.delegate.query<Row>(text, values);
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

class ObservedQueryLockPool implements SqlPool {
  constructor(
    private readonly delegate: SqlPool,
    private readonly matches: (text: string) => boolean,
    readonly attempted: Deferred<number>,
    readonly acquired: Deferred<number>,
    private readonly releaseAfterAcquisition?: Promise<void>,
  ) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new ObservedQueryLockClient(
      await this.delegate.connect(),
      this.matches,
      this.attempted,
      this.acquired,
      this.releaseAfterAcquisition,
    );
  }
}

class ObservedScopeClockClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly scope: string,
    private readonly attempted: Deferred<number>,
    private readonly acquired: Deferred<number>,
    private readonly nextNow: () => Date | undefined,
    private readonly releaseAfterAcquisition?: Promise<void>,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    if (text.trim() === "SELECT clock_timestamp() AS now") {
      const now = this.nextNow();
      if (now) return { rows: [{ now }] as unknown as readonly Row[], rowCount: 1 };
    }
    if (!text.includes("pg_advisory_xact_lock") || values?.[0] !== this.scope) {
      return this.delegate.query<Row>(text, values);
    }
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

class ObservedScopeClockPool implements SqlPool {
  private readonly sequence: Date[];

  constructor(
    private readonly delegate: SqlPool,
    private readonly scope: string,
    readonly attempted: Deferred<number>,
    readonly acquired: Deferred<number>,
    sequence: readonly Date[] = [],
    private readonly releaseAfterAcquisition?: Promise<void>,
  ) {
    this.sequence = [...sequence];
  }

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new ObservedScopeClockClient(
      await this.delegate.connect(),
      this.scope,
      this.attempted,
      this.acquired,
      () => this.sequence.shift(),
      this.releaseAfterAcquisition,
    );
  }
}

class ObservedReplayFenceClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly attempted: Deferred<number>,
    private readonly acquired: Deferred<number>,
    private readonly releaseFence?: Promise<void>,
    private readonly nextNow?: () => Date | undefined,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    if (text.trim() === "SELECT clock_timestamp() AS now") {
      const now = this.nextNow?.();
      if (now) return { rows: [{ now }] as unknown as readonly Row[], rowCount: 1 };
    }
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
  private clockSequence: Date[] = [];

  constructor(
    private readonly delegate: SqlPool,
    readonly attempted: Deferred<number>,
    readonly acquired: Deferred<number>,
    private readonly releaseFence?: Promise<void>,
  ) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  setClockSequence(sequence: readonly Date[]): void {
    this.clockSequence = [...sequence];
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new ObservedReplayFenceClient(
      await this.delegate.connect(),
      this.attempted,
      this.acquired,
      this.releaseFence,
      () => this.clockSequence.shift(),
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

class ControlledClockClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly nextNow: () => Date | undefined,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    if (text.trim() === "SELECT clock_timestamp() AS now") {
      const now = this.nextNow();
      if (now) return { rows: [{ now }] as unknown as readonly Row[], rowCount: 1 };
    }
    return this.delegate.query<Row>(text, values);
  }

  release(): void {
    this.delegate.release();
  }
}

class ControlledClockPool implements SqlPool {
  private readonly sequence: Date[];

  constructor(private readonly delegate: SqlPool, sequence: readonly Date[]) {
    this.sequence = [...sequence];
  }

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new ControlledClockClient(await this.delegate.connect(), () => this.sequence.shift());
  }
}

class FailAfterStatementClient implements ConnectedSqlClient {
  constructor(
    private readonly delegate: ConnectedSqlClient,
    private readonly statement: string,
    private readonly trip: () => boolean,
  ) {}

  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result = await this.delegate.query<Row>(text, values);
    if (text.includes(this.statement) && this.trip()) throw new Error(`Injected failure after ${this.statement}.`);
    return result;
  }

  release(): void {
    this.delegate.release();
  }
}

class FailAfterStatementPool implements SqlPool {
  private fired = false;

  constructor(
    private readonly delegate: SqlPool,
    private readonly statement: string,
  ) {}

  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.delegate.query<Row>(text, values);
  }

  async connect(): Promise<ConnectedSqlClient> {
    return new FailAfterStatementClient(await this.delegate.connect(), this.statement, () => {
      if (this.fired) return false;
      this.fired = true;
      return true;
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

const hmacKey = (
  purpose: "resume" | "tombstone" | "portable-integrity" | "guest-claim" | "player-session",
  version: number,
  marker: number,
  retired = false,
) => {
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

const recoveryHash = (marker: string): `sha256:${string}` => `sha256:${marker.repeat(64)}`;
const recoveryContent = Object.freeze({
  pack: Object.freeze({
    id: "samurai-core",
    version: 1,
    contentHash: recoveryHash("1"),
    contentManifestHash: recoveryHash("2"),
    artAssetMapHash: recoveryHash("3"),
  }),
  refs: Object.freeze([
    Object.freeze({ kind: "ingredient", id: "rice", version: 1, contentHash: recoveryHash("4") }),
  ]),
});

describe("PostgreSQL persistence spine", () => {
  const rawPool = new Pool({ connectionString: databaseUrl });
  const pool = new PgPoolAdapter(rawPool);
  const resumeKeys = new HmacKeyring(hmacKey("resume", 2, 2), hmacKey("resume", 1, 1, true));
  const tombstoneKeys = new TombstoneKeyring(hmacKey("tombstone", 3, 3));
  const authority = new PersistenceAuthority(pool, resumeKeys, tombstoneKeys);
  const integrityKeys = new IntegrityKeyring(hmacKey("portable-integrity", 5, 5));
  const recoveryAuthority = new PortableRecoveryAuthority(pool, integrityKeys);
  const guestClaimKeys = new GuestClaimKeyring(hmacKey("guest-claim", 6, 6));
  const playerSessionKeys = new PlayerSessionKeyring(hmacKey("player-session", 7, 7));
  const claimAuthority = new AccountClaimAuthority(pool, authority, guestClaimKeys, playerSessionKeys);
  let now = new Date("2026-08-01T12:00:00.000Z");
  const sessionService = new GuestSessionService(pool, authority);
  const executor = new GuestCommandExecutor(pool, authority);
  const outbox = new OutboxDeliveryService(pool, authority, { maxAttempts: 3 });
  const recovery = new PortableRecoveryService(pool, authority, recoveryAuthority, {
    async describe() { return recoveryContent; },
  });

  beforeAll(async () => {
    await rawPool.query("DROP SCHEMA IF EXISTS samurai_persistence CASCADE");
    await applyMigrations(pool);
    await authority.bootstrap();
    await claimAuthority.bootstrap();
  });

  beforeEach(async () => {
    now = new Date("2026-08-01T12:00:00.000Z");
    await rawPool.query("TRUNCATE samurai_persistence.guest_sessions CASCADE");
    await rawPool.query("TRUNCATE samurai_persistence.players, samurai_persistence.claim_challenges CASCADE");
    await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
  });

  const stage3Wallet = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    const publicKeyText = b58Encode(publicDer.subarray(publicDer.byteLength - 32), PrefixV2.Ed25519PublicKey);
    return { privateKey, publicKey: publicKeyText, account: getPkhfromPk(publicKeyText) };
  };

  const stage3Service = (servicePool: SqlPool = pool, options: Partial<{
    readonly issueUuid: () => string;
    readonly issueNonce: () => string;
    readonly issuePlayerSecret: () => string;
  }> = {}) => new AccountClaimService(servicePool, claimAuthority, {
    origin: "https://game.samurai-sushi.example",
    chainId: "NetXdQprcVkpaWU",
    mergeCheckpoint: mergeFirstEveningCheckpointForClaim,
    ...options,
  });

  const firstServiceCommandsBeforeSettlement = (): Array<{ readonly commandName: string; readonly payload: JsonObject }> => {
    const commands: Array<{ readonly commandName: string; readonly payload: JsonObject }> = [
      { commandName: "service.start", payload: {} },
      ...FIRST_EVENING_SERVICE_DEFINITION.riceBeats.map((beat) => ({ commandName: "service.prepare-rice", payload: { beat } })),
    ];
    FIRST_EVENING_SERVICE_DEFINITION.orders.forEach((order, orderIndex) => {
      commands.push({ commandName: "service.accept-order", payload: { orderId: order.id } });
      order.steps.forEach((step) => commands.push({ commandName: "service.perform-step", payload: { orderId: order.id, stepId: step.id } }));
      if (orderIndex === 0) commands.push({ commandName: "service.choose-presentation", payload: { orderId: order.id, choice: "indigo-rim" } });
      commands.push({ commandName: "service.plate-order", payload: { orderId: order.id } });
      commands.push({ commandName: "service.serve-order", payload: { orderId: order.id } });
    });
    commands.push({ commandName: "service.close-ledger", payload: {} });
    return commands;
  };

  const reduceServiceCommands = (
    commands: readonly { readonly commandName: string; readonly payload: JsonObject }[],
  ): EveningServiceCheckpoint => {
    let checkpoint = createInitialEveningServiceCheckpoint();
    commands.forEach((command, index) => {
      checkpoint = reduceEveningService(checkpoint, createCommandEnvelope({
        schemaVersion: 1,
        subject: { kind: "guest", guestSessionId: "guest-service-fixture-0001" },
        idempotencyKey: parseIdempotencyKey(`018f47fe-347b-4dac-8f45-a6f3f43b${(3000 + index).toString().padStart(4, "0")}`),
        expectedRevision: checkpoint.revision,
        contentVersion: FIRST_EVENING_CONTENT_VERSION,
        commandName: command.commandName,
        payload: command.payload,
      })).checkpoint;
    });
    return checkpoint;
  };

  const stage3Fixture = async (wallet = stage3Wallet()) => {
    const claimCapability = randomBytes(32).toString("base64url");
    const guest = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys,
      issueClaimCapability: () => claimCapability,
    }).issue({
      consentVersion: "consent-v1",
      contentVersion: "phase0-salmon@1",
      checkpointSchemaVersion: 1,
      checkpoint: { orders: ["rice"] },
    });
    const firstExport = await recovery.createExport({
      resumeSecret: guest.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const importId = randomUUID();
    const imported = await recovery.import({ importId, envelope: firstExport });
    const authoritativeRevision = imported.revision + 1;
    await rawPool.query(
      "UPDATE samurai_persistence.guest_progress SET revision=$2,updated_at=clock_timestamp() WHERE guest_session_id=$1",
      [guest.session.id, authoritativeRevision],
    );
    const liveExport = await recovery.createExport({
      resumeSecret: imported.rotatedResumeSecret,
      expectedRevision: authoritativeRevision,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    await rawPool.query(
      `INSERT INTO samurai_persistence.command_receipts
        (guest_session_id,idempotency_key,command_name,expected_revision,content_version,payload_hash,
         response_schema_version,response_payload,result_hash,committed_revision,created_at,expires_at)
       VALUES ($1,$2,'checkpoint.advance',$3-1,'phase0-salmon@1',decode(repeat('31',32),'hex'),
               1,'{}',decode(repeat('32',32),'hex'),$3,clock_timestamp(),clock_timestamp()+interval '1 day')`,
      [guest.session.id, randomUUID(), authoritativeRevision],
    );
    const eventId = `claim-race-${randomUUID()}`;
    await rawPool.query(
      `INSERT INTO samurai_persistence.domain_events
        (event_id,guest_session_id,event_type,schema_version,payload,committed_revision,created_at)
       VALUES ($1,$2,'checkpoint.advanced',1,'{}',$3,clock_timestamp())`,
      [eventId, guest.session.id, authoritativeRevision],
    );
    await rawPool.query(
      "INSERT INTO samurai_persistence.outbox_deliveries (event_id,available_at) VALUES ($1,clock_timestamp())",
      [eventId],
    );
    const intent = {
      claimId: randomUUID(),
      guestClaimCommitment: claimCapability,
      createPlayer: true,
      guestRevision: authoritativeRevision,
      idempotencyKey: randomUUID(),
      contentVersion: "phase0-salmon@1",
      cosmeticSelections: { counter: "moonwake" },
    } as const;
    const challenge = await stage3Service().issueClaimChallenge({
      resumeSecret: imported.rotatedResumeSecret,
      intent,
      account: wallet.account,
    });
    if ("code" in challenge) throw new Error("Stage 3 fixture challenge issuance failed.");
    const proof = {
      challenge: challenge.challenge,
      publicKey: wallet.publicKey,
      signature: b58Encode(
        signMessage(null, blake2b(walletSigningBytes(challenge.challenge), { dkLen: 32 }), wallet.privateKey),
        PrefixV2.Ed25519Signature,
      ),
    };
    return {
      wallet,
      guest,
      resumeSecret: imported.rotatedResumeSecret,
      intent,
      challenge,
      proof,
      liveExport,
      liveExportId: liveExport.exportId,
      importId,
      claimInput: {
        resumeSecret: imported.rotatedResumeSecret,
        intent,
        challengeId: challenge.challengeId,
        proof,
      },
    };
  };

  const stage3Matrix = async () => (await rawPool.query(`
    SELECT
      (SELECT count(*)::integer FROM samurai_persistence.guest_sessions) AS guests,
      (SELECT count(*)::integer FROM samurai_persistence.guest_progress) AS guest_progress,
      (SELECT count(*)::integer FROM samurai_persistence.guest_claim_capabilities) AS claim_capabilities,
      (SELECT count(*)::integer FROM samurai_persistence.guest_resume_digests) AS guest_digests,
      (SELECT count(*)::integer FROM samurai_persistence.players) AS players,
      (SELECT count(*)::integer FROM samurai_persistence.player_progress) AS player_progress,
      (SELECT count(*)::integer FROM samurai_persistence.wallet_credentials) AS wallets,
      (SELECT count(*)::integer FROM samurai_persistence.player_sessions) AS player_sessions,
      (SELECT count(*)::integer FROM samurai_persistence.player_session_digests) AS player_digests,
      (SELECT count(*)::integer FROM samurai_persistence.command_receipts) AS commands,
      (SELECT count(*)::integer FROM samurai_persistence.domain_events) AS events,
      (SELECT count(*)::integer FROM samurai_persistence.outbox_deliveries) AS outbox,
      (SELECT count(*)::integer FROM samurai_persistence.save_exports) AS exports,
      (SELECT count(*)::integer FROM samurai_persistence.recovery_imports) AS imports,
      (SELECT count(*)::integer FROM samurai_persistence.claim_challenges) AS challenges,
      (SELECT count(*)::integer FROM samurai_persistence.claim_challenges WHERE consumed_at IS NULL) AS virgin_challenges,
      (SELECT count(*)::integer FROM samurai_persistence.progress_merges) AS merges,
      COALESCE((SELECT jsonb_object_agg(kind,total) FROM (
        SELECT kind,count(*)::integer AS total FROM samurai_persistence.deletion_tombstones GROUP BY kind ORDER BY kind
      ) tombstone_counts),'{}'::jsonb) AS tombstones
  `)).rows[0];

  const resetStage3Rows = async () => {
    await rawPool.query("TRUNCATE samurai_persistence.players, samurai_persistence.guest_sessions, samurai_persistence.claim_challenges CASCADE");
    await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
  };

  afterAll(async () => {
    await rawPool.end();
  });

  it("migrates an empty PostgreSQL database and cleanly reapplies forward migrations", async () => {
    const migrations = await bundledMigrations();
    expect(Buffer.from(migrations[0]?.checksum ?? []).toString("hex")).toBe(
      "4d7fd2b2103a1cf7bf332db8e7f14b034e66e72de64efc398a7d4e42b2571533",
    );
    expect(Buffer.from(migrations[1]?.checksum ?? []).toString("hex")).toBe(
      "19228c2338e44feffab73d71c8641bc98b5bcb806be19300501f072a9a49dc48",
    );
    await applyMigrations(pool);
    const result = await rawPool.query<CountRow>("SELECT count(*)::text AS count FROM samurai_persistence.schema_migrations");
    expect(result.rows[0]?.count).toBe("7");
  });

  it("upgrades an exactly attested 0001 catalog to 0002 atomically", async () => {
    const migrations = await bundledMigrations();
    const first = migrations[0]!;
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
    await rawPool.query(first.sql);
    await rawPool.query(
      "INSERT INTO samurai_persistence.schema_migrations (name, checksum, catalog_checksum) VALUES ($1, $2, $3)",
      [first.name, first.checksum, first.catalogChecksum],
    );

    await applyMigrations(pool);

    const ledger = await rawPool.query<{ readonly name: string }>(
      "SELECT name FROM samurai_persistence.schema_migrations ORDER BY applied_at, name",
    );
    expect(ledger.rows.map((row) => row.name)).toEqual([
      "0001_persistence_spine.sql",
      "0002_portable_recovery.sql",
      "0003_account_claim_persistence.sql",
      "0004_evening_service_authority.sql",
      "0005_evening_service_generation.sql",
      "0006_receipt_lifecycle_authority.sql",
      "0007_receipt_review_wallet_link.sql",
    ]);
    const tables = await rawPool.query<{ readonly table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'samurai_persistence' AND table_name IN ('save_exports', 'recovery_imports')
        ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual(["recovery_imports", "save_exports"]);
  });

  it("upgrades historical create-player merge revisions while enforcing continuity on new writes", async () => {
    const migrations = await bundledMigrations();
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
    for (const migration of migrations.slice(0, 3)) {
      await rawPool.query(migration.sql);
      await rawPool.query(
        "INSERT INTO samurai_persistence.schema_migrations (name,checksum,catalog_checksum) VALUES ($1,$2,$3)",
        [migration.name, migration.checksum, migration.catalogChecksum],
      );
    }
    const playerId = "historical-player-0001";
    const claimId = "018f47fe-347b-4dac-8f45-a6f3f43bd700";
    const sessionId = "018f47fe-347b-4dac-8f45-a6f3f43bd701";
    await rawPool.query(
      `INSERT INTO samurai_persistence.players (id,created_at,updated_at)
       VALUES ($1,'2026-08-01T12:00:00Z','2026-08-01T12:00:00Z')`,
      [playerId],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_progress
        (player_id,revision,content_version,checkpoint_schema_version,checkpoint,created_at,updated_at)
       VALUES ($1,0,'historical-v1',1,'{}','2026-08-01T12:00:00Z','2026-08-01T12:00:00Z')`,
      [playerId],
    );
    const historicalServicePlayerId = "historical-service-player-0001";
    await rawPool.query(
      `INSERT INTO samurai_persistence.players (id,created_at,updated_at)
       VALUES ($1,'2026-08-01T12:00:00Z','2026-08-01T12:00:00Z')`,
      [historicalServicePlayerId],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_progress
        (player_id,revision,content_version,checkpoint_schema_version,checkpoint,created_at,updated_at)
       VALUES ($1,2,$2,1,'{"revision":0}','2026-08-01T12:00:00Z','2026-08-01T12:00:00Z')`,
      [historicalServicePlayerId, FIRST_EVENING_CONTENT_VERSION],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
       VALUES ($1,$2,'claim',$3,'pending-delivery',1,'2026-08-01T12:00:00Z','2026-08-01T12:00:00Z',
               '2026-08-02T12:00:00Z','2026-08-01T18:00:00Z')`,
      [sessionId, playerId, claimId],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.progress_merges
        (claim_id,idempotency_key,request_hash,claim_intent_hash,challenge_hash,guest_origin_commitment,
         player_id,create_player,target_player_id,guest_revision,player_revision_before,player_revision_after,
         content_version,cosmetic_selections,session_id,session_issuance_id,result_hash,created_at,expires_at)
       VALUES ($1,'historical-merge-idempotency',decode(repeat('11',32),'hex'),decode(repeat('12',32),'hex'),
               decode(repeat('13',32),'hex'),decode(repeat('14',32),'hex'),$2,true,NULL,2,NULL,0,
               'historical-v1','{}',$3,$1,decode(repeat('15',32),'hex'),
               '2026-08-01T12:00:00Z','2026-08-02T12:00:00Z')`,
      [claimId, playerId, sessionId],
    );

    await applyMigrations(pool);

    const historical = await rawPool.query<{ readonly guest_revision: string; readonly player_revision_after: string; readonly validated: boolean }>(`
      SELECT m.guest_revision::text,m.player_revision_after::text,
             (SELECT convalidated FROM pg_constraint WHERE conname='progress_merges_revision_transition_check') AS validated
        FROM samurai_persistence.progress_merges m WHERE m.claim_id=$1
    `, [claimId]);
    expect(historical.rows[0]).toEqual({ guest_revision: "2", player_revision_after: "0", validated: false });
    const historicalService = await rawPool.query<{ readonly revision: string; readonly checkpoint_revision: string; readonly validated: boolean }>(`
      SELECT p.revision::text,p.checkpoint->>'revision' AS checkpoint_revision,
             (SELECT convalidated FROM pg_constraint WHERE conname='player_progress_service_revision_check') AS validated
        FROM samurai_persistence.player_progress p WHERE p.player_id=$1
    `, [historicalServicePlayerId]);
    expect(historicalService.rows[0]).toEqual({ revision: "2", checkpoint_revision: "0", validated: false });
    await expect(rawPool.query(
      "UPDATE samurai_persistence.progress_merges SET idempotency_key=idempotency_key WHERE claim_id=$1",
      [claimId],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(rawPool.query(
      "UPDATE samurai_persistence.player_progress SET revision=revision WHERE player_id=$1",
      [historicalServicePlayerId],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("rolls the complete 0002 catalog and ledger row back on a post-DDL failure", async () => {
    const first = (await bundledMigrations())[0]!;
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
    await rawPool.query(first.sql);
    await rawPool.query(
      "INSERT INTO samurai_persistence.schema_migrations (name, checksum, catalog_checksum) VALUES ($1, $2, $3)",
      [first.name, first.checksum, first.catalogChecksum],
    );

    await expect(applyMigrations(new FailOnQueryPool(
      pool,
      "CREATE TABLE samurai_persistence.recovery_imports",
      true,
    ))).rejects.toThrow(/Injected failure after/u);

    const state = await rawPool.query<{ readonly migrations: string; readonly exports: string | null; readonly imports: string | null }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.schema_migrations) AS migrations,
              to_regclass('samurai_persistence.save_exports')::text AS exports,
              to_regclass('samurai_persistence.recovery_imports')::text AS imports`,
    );
    expect(state.rows[0]).toEqual({ migrations: "1", exports: null, imports: null });
    await applyMigrations(pool);
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
    expect(result.rows[0]?.count).toBe("7");
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
      ["018f47fe-347b-4dac-8f45-a6f3f43bd606", 5],
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
      `INSERT INTO samurai_persistence.outbox_deliveries
        (event_id, state, attempt_count, available_at, claim_generation, last_error_code)
       VALUES ($1, 'pending', 0, clock_timestamp(), 0, 'PRETEND')`,
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

  it("rechecks key authority after issue waits on the replay fence", async () => {
    const clock = await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
    const compromisedAt = new Date(clock.rows[0]!.now.getTime() + 60_000);
    const active = {
      ...hmacKey("resume", 18, 18),
      compromisedAt,
    } as const;
    const release = deferred<void>();
    const observedPool = new ObservedReplayFencePool(pool, deferred<number>(), deferred<number>(), release.promise);
    const observedAuthority = new PersistenceAuthority(
      observedPool,
      new HmacKeyring(active),
      tombstoneKeys,
    );
    await observedAuthority.bootstrap();
    observedPool.setClockSequence([
      new Date(compromisedAt.getTime() - 1),
      new Date(compromisedAt.getTime() + 1),
    ]);
    const service = new GuestSessionService(observedPool, observedAuthority, {
      issueSecret: () => issueResumeSecret(),
    });
    const pending = service.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await observedPool.acquired.promise;
    release.resolve();
    await expect(pending).rejects.toMatchObject({ code: "ACTIVE_KEY_UNAVAILABLE" });
    const counts = await rawPool.query<{ readonly sessions: string; readonly progress: string; readonly digests: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS sessions,
              (SELECT count(*)::text FROM samurai_persistence.guest_progress) AS progress,
              (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests`,
    );
    expect(counts.rows[0]).toEqual({ sessions: "0", progress: "0", digests: "0" });
  });

  it("preserves the single predecessor through overlapping use and defers further rotation", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const rotated = await sessionService.rotate(issued.resumeSecret);
    const lostResponseRetries = await Promise.all([
      sessionService.rotate(issued.resumeSecret),
      sessionService.rotate(issued.resumeSecret),
    ]);
    expect(lostResponseRetries.map((item) => item.rotatedResumeSecret)).toEqual([
      rotated.rotatedResumeSecret,
      rotated.rotatedResumeSecret,
    ]);
    await expect(sessionService.resume(issued.resumeSecret)).resolves.toMatchObject({ credentialKind: "predecessor" });
    await expect(sessionService.resume(rotated.rotatedResumeSecret)).resolves.toMatchObject({ credentialKind: "current" });
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

  it("serializes automatic and explicit guest rotation at the stored-digest fence in both winners", async () => {
    for (const winner of ["automatic", "explicit"] as const) {
      await rawPool.query("TRUNCATE samurai_persistence.guest_sessions CASCADE");
      await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
      const issued = await sessionService.issue({
        consentVersion: "privacy-v1",
        contentVersion: "content-v1",
        checkpointSchemaVersion: 1,
        checkpoint: { step: 0 },
      });
      await rawPool.query(
        "UPDATE samurai_persistence.guest_sessions SET rotate_after=clock_timestamp() WHERE id=$1",
        [issued.session.id],
      );
      const blocker = await rawPool.connect();
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT id FROM samurai_persistence.guest_sessions WHERE id=$1 FOR UPDATE",
        [issued.session.id],
      );
      const firstAttempted = deferred<number>();
      const firstAcquired = deferred<number>();
      const firstPool = new ObservedQueryLockPool(
        pool,
        (text) => text.includes("FOR UPDATE OF s"),
        firstAttempted,
        firstAcquired,
      );
      const secondPool = new ObservedReplayFencePool(pool, deferred<number>(), deferred<number>());
      const launch = (servicePool: SqlPool, operation: "automatic" | "explicit") => {
        const service = new GuestSessionService(servicePool, authority);
        return operation === "automatic" ? service.resume(issued.resumeSecret) : service.rotate(issued.resumeSecret);
      };
      const first = launch(firstPool, winner);
      await firstAttempted.promise;
      const secondOperation = winner === "automatic" ? "explicit" : "automatic";
      const second = launch(secondPool, secondOperation);
      const secondPid = await secondPool.attempted.promise;
      await expectLockWait(rawPool, secondPid);
      await blocker.query("COMMIT");
      blocker.release();
      await firstAcquired.promise;
      const [firstResult, secondResult] = await Promise.all([first, second]);
      await secondPool.acquired.promise;
      if (!("rotatedResumeSecret" in firstResult)) throw new Error("Winning guest rotation returned no credential.");
      if (secondOperation === "explicit") {
        expect(secondResult).toMatchObject({ rotatedResumeSecret: firstResult.rotatedResumeSecret });
      } else {
        expect(secondResult).toMatchObject({ credentialKind: "predecessor" });
        expect(secondResult).not.toHaveProperty("rotatedResumeSecret");
      }
      await expect(sessionService.resume(firstResult.rotatedResumeSecret)).resolves.toMatchObject({
        credentialKind: "current",
      });
      const state = await rawPool.query<{ readonly slots: string[] }>(
        `SELECT array_agg(slot ORDER BY slot)::text[] AS slots
           FROM samurai_persistence.guest_resume_digests
          WHERE guest_session_id=$1`,
        [issued.session.id],
      );
      expect(state.rows[0]?.slots).toEqual(["current", "predecessor"]);
    }
  });

  it("serializes guest rotation with explicit deletion and portable import in both winners", async () => {
    for (const winner of ["rotate", "delete"] as const) {
      await rawPool.query("TRUNCATE samurai_persistence.guest_sessions CASCADE");
      await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
      const issued = await sessionService.issue({
        consentVersion: "privacy-v1", contentVersion: "content-v1", checkpointSchemaVersion: 1, checkpoint: { step: 0 },
      });
      const blocker = await rawPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM samurai_persistence.guest_sessions WHERE id=$1 FOR UPDATE", [issued.session.id]);
      const firstAttempted = deferred<number>(); const firstAcquired = deferred<number>();
      const firstPool = new ObservedQueryLockPool(
        pool, (text) => text.includes("FOR UPDATE OF s"), firstAttempted, firstAcquired,
      );
      const secondPool = new ObservedReplayFencePool(pool, deferred<number>(), deferred<number>());
      const first = winner === "rotate"
        ? new GuestSessionService(firstPool, authority).rotate(issued.resumeSecret)
        : new GuestSessionService(firstPool, authority).delete(issued.resumeSecret);
      await firstAttempted.promise;
      const second = winner === "rotate"
        ? new GuestSessionService(secondPool, authority).delete(issued.resumeSecret)
        : new GuestSessionService(secondPool, authority).rotate(issued.resumeSecret);
      await expectLockWait(rawPool, await secondPool.attempted.promise);
      await blocker.query("COMMIT"); blocker.release();
      await firstAcquired.promise;
      const results = await Promise.allSettled([first, second]);
      await secondPool.acquired.promise;
      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]?.status).toBe(winner === "rotate" ? "fulfilled" : "rejected");
      expect((await rawPool.query<CountRow>(
        "SELECT count(*)::text AS count FROM samurai_persistence.guest_sessions WHERE id=$1", [issued.session.id],
      )).rows[0]?.count).toBe("0");
      await expect(sessionService.delete(issued.resumeSecret)).resolves.toBeUndefined();
    }

    for (const winner of ["rotate", "import"] as const) {
      await rawPool.query("TRUNCATE samurai_persistence.guest_sessions CASCADE");
      await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
      const issued = await sessionService.issue({
        consentVersion: "privacy-v1", contentVersion: "content-v1", checkpointSchemaVersion: 1, checkpoint: { step: 0 },
      });
      const envelope = await recovery.createExport({
        resumeSecret: issued.resumeSecret, expectedRevision: 0, validityMs: 24 * 60 * 60 * 1_000,
      });
      const fresh = issueResumeSecret();
      const blocker = await rawPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM samurai_persistence.guest_sessions WHERE id=$1 FOR UPDATE", [issued.session.id]);
      const firstAttempted = deferred<number>(); const firstAcquired = deferred<number>();
      const secondAttempted = deferred<number>(); const secondAcquired = deferred<number>();
      const releaseFirst = deferred<void>();
      const firstPool = new ObservedQueryLockPool(
        pool,
        (text) => text.includes("FOR UPDATE OF s")
          || text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
        firstAttempted,
        firstAcquired,
        releaseFirst.promise,
      );
      const secondPool = new ObservedQueryLockPool(
        pool,
        (text) => text.includes("FOR UPDATE OF s")
          || text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
        secondAttempted,
        secondAcquired,
      );
      const importing = (servicePool: SqlPool) => {
        let calls = 0;
        return new PortableRecoveryService(
          servicePool,
          authority,
          recoveryAuthority,
          { async describe() { return recoveryContent; } },
          { issueResumeSecret: () => calls++ === 0 ? issued.resumeSecret : fresh },
        ).import({ importId: randomUUID(), envelope });
      };
      const first = winner === "rotate"
        ? new GuestSessionService(firstPool, authority).rotate(issued.resumeSecret)
        : importing(firstPool);
      await firstAttempted.promise;
      await blocker.query("COMMIT"); blocker.release();
      await firstAcquired.promise;
      const second = winner === "rotate"
        ? importing(secondPool)
        : new GuestSessionService(secondPool, authority).rotate(issued.resumeSecret);
      await expectLockWait(rawPool, await secondAttempted.promise);
      releaseFirst.resolve();
      const results = await Promise.allSettled([first, second]);
      await secondAcquired.promise;
      expect(results[0]?.status).toBe("fulfilled");
      expect(results[1]?.status).toBe(winner === "rotate" ? "fulfilled" : "rejected");
      const importResult = results.find((result) => result.status === "fulfilled"
        && "disposition" in result.value) as PromiseFulfilledResult<Awaited<ReturnType<typeof importing>>> | undefined;
      expect(importResult?.value.disposition).toBe("committed");
      await expect(sessionService.resume(fresh)).resolves.toMatchObject({ session: { id: issued.session.id } });
      const state = await rawPool.query<{ readonly guests: string; readonly digests: string; readonly imports: string }>(
        `SELECT
          (SELECT count(*)::text FROM samurai_persistence.guest_sessions WHERE id=$1) AS guests,
          (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests WHERE guest_session_id=$1) AS digests,
          (SELECT count(*)::text FROM samurai_persistence.recovery_imports WHERE guest_session_id=$1) AS imports`,
        [issued.session.id],
      );
      expect(state.rows[0]).toEqual({ guests: "1", digests: "1", imports: "1" });
    }
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
      { kind: "guest-session", count: "3" },
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
    expect(tombstones.rows[0]?.count).toBe("3");
    const columns = await rawPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'samurai_persistence' AND table_name = 'deletion_tombstones'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain("guest_session_id");
  });

  it("atomically imports the equal authoritative revision, revokes siblings and every prior credential, and supports explicit lost-response recovery", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const first = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 29 * 24 * 60 * 60 * 1_000,
    });
    const sibling = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    expect(first.unlinkableClaimCommitment).not.toBe(sibling.unlinkableClaimCommitment);
    expect(JSON.stringify(first)).not.toContain(issued.session.id);

    const importId = "123e4567-e89b-42d3-a456-426614174100";
    const imported = await recovery.import({
      importId,
      envelope: first,
    });
    await expect(sessionService.resume(issued.resumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_INVALID" });
    await expect(sessionService.resume(imported.rotatedResumeSecret)).resolves.toMatchObject({ session: { id: issued.session.id } });
    const rows = await rawPool.query<{ exports: string; imports: string; digests: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
              (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
              (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests`,
    );
    expect(rows.rows[0]).toEqual({ exports: "0", imports: "1", digests: "1" });
    const kinds = await rawPool.query<{ kind: string; count: string }>(
      `SELECT kind, count(*)::text AS count
         FROM samurai_persistence.deletion_tombstones
        GROUP BY kind ORDER BY kind`,
    );
    expect(kinds.rows).toEqual([
      { kind: "guest-session", count: "1" },
      { kind: "save-export", count: "2" },
      { kind: "save-import", count: "1" },
    ]);

    const recovered = await recovery.import({
      importId,
      envelope: first,
    });
    expect(recovered.disposition).toBe("replayed");
    await expect(sessionService.resume(imported.rotatedResumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_INVALID" });
    await expect(sessionService.resume(recovered.rotatedResumeSecret)).resolves.toMatchObject({ session: { id: issued.session.id } });
    const retry = await rawPool.query<{ delivery_generation: string }>(
      "SELECT delivery_generation::text FROM samurai_persistence.recovery_imports WHERE import_id = $1::uuid",
      [importId],
    );
    expect(retry.rows[0]?.delivery_generation).toBe("2");
  });

  it("retries a generated credential collision and installs only fresh random authority", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const fresh = Buffer.alloc(32, 91).toString("base64url");
    const generated = [issued.resumeSecret, fresh];
    let calls = 0;
    const collisionSafe = new PortableRecoveryService(
      pool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
      { issueResumeSecret: () => generated[calls++] ?? Buffer.alloc(32, 92).toString("base64url") },
    );

    const imported = await collisionSafe.import({
      importId: "123e4567-e89b-42d3-a456-426614174109",
      envelope,
    });

    expect(calls).toBe(2);
    expect(imported.rotatedResumeSecret).toBe(fresh);
    await expect(sessionService.resume(issued.resumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_INVALID" });
    await expect(sessionService.resume(fresh)).resolves.toMatchObject({ session: { id: issued.session.id } });
  });

  it("serializes duplicate imports into one commit and one fresh-secret replay", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const request = {
      importId: "123e4567-e89b-42d3-a456-426614174110",
      envelope,
    } as const;

    const releaseFirst = deferred<void>();
    const firstAttempted = deferred<number>();
    const firstAcquired = deferred<number>();
    const firstPool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      firstAttempted,
      firstAcquired,
      releaseFirst.promise,
    );
    const first = new PortableRecoveryService(
      firstPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    ).import(request);
    await firstAcquired.promise;
    const secondAttempted = deferred<number>();
    const secondAcquired = deferred<number>();
    const secondPool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      secondAttempted,
      secondAcquired,
    );
    const second = new PortableRecoveryService(
      secondPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    ).import(request);
    await expectLockWait(rawPool, await secondAttempted.promise);
    releaseFirst.resolve();
    const results = [await first, await second];

    expect(results.map((result) => result.disposition).sort()).toEqual(["committed", "replayed"]);
    const committed = results.find((result) => result.disposition === "committed")!;
    const replayed = results.find((result) => result.disposition === "replayed")!;
    await expect(sessionService.resume(committed.rotatedResumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_INVALID" });
    await expect(sessionService.resume(replayed.rotatedResumeSecret)).resolves.toMatchObject({ session: { id: issued.session.id } });
    const receipt = await rawPool.query<{ readonly delivery_generation: string }>(
      "SELECT delivery_generation::text FROM samurai_persistence.recovery_imports WHERE import_id = $1::uuid",
      [request.importId],
    );
    expect(receipt.rows[0]?.delivery_generation).toBe("2");
  });

  it("permits only one of two different concurrent import identities to consume an export", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });

    const releaseFirst = deferred<void>();
    const firstAttempted = deferred<number>();
    const firstAcquired = deferred<number>();
    const firstPool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      firstAttempted,
      firstAcquired,
      releaseFirst.promise,
    );
    const first = new PortableRecoveryService(
      firstPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    ).import({ importId: "123e4567-e89b-42d3-a456-426614174111", envelope });
    await firstAcquired.promise;
    const secondAttempted = deferred<number>();
    const secondAcquired = deferred<number>();
    const secondPool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      secondAttempted,
      secondAcquired,
    );
    const second = new PortableRecoveryService(
      secondPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    ).import({ importId: "123e4567-e89b-42d3-a456-426614174112", envelope });
    await expectLockWait(rawPool, await secondAttempted.promise);
    releaseFirst.resolve();

    await expect(first).resolves.toMatchObject({ disposition: "committed" });
    await expect(second).rejects.toMatchObject({ recoveryCode: "RECOVERY_ALREADY_CONSUMED" });
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.recovery_imports",
    )).rows[0]?.count).toBe("1");
  });

  it("serializes healthy import before explicit deletion at the guest-parent lock", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const releaseImport = deferred<void>();
    const importAttempted = deferred<number>();
    const importAcquired = deferred<number>();
    const importPool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      importAttempted,
      importAcquired,
      releaseImport.promise,
    );
    const importing = new PortableRecoveryService(
      importPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    );
    const importResult = importing.import({
      importId: "123e4567-e89b-42d3-a456-426614174160",
      envelope,
    });
    await importAcquired.promise;

    const deleteAttempted = deferred<number>();
    const deleteAcquired = deferred<number>();
    const deletePool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FOR UPDATE OF s"),
      deleteAttempted,
      deleteAcquired,
    );
    const deletion = new GuestSessionService(deletePool, authority).delete(issued.resumeSecret);
    await expectLockWait(rawPool, await deleteAttempted.promise);
    releaseImport.resolve();

    const imported = await importResult;
    await expect(deletion).rejects.toMatchObject({ code: "GUEST_RESUME_INVALID" });
    await expect(sessionService.resume(imported.rotatedResumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
    const state = await rawPool.query<{
      guests: string; digests: string; exports: string; imports: string;
      guest_tombstones: string; command_tombstones: string; export_tombstones: string; import_tombstones: string;
    }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS guests,
      (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
      (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
      (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'guest-session') AS guest_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'command') AS command_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-export') AS export_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-import') AS import_tombstones`);
    expect(state.rows[0]).toEqual({
      guests: "1", digests: "1", exports: "0", imports: "1",
      guest_tombstones: "1", command_tombstones: "0", export_tombstones: "1", import_tombstones: "1",
    });
  });

  it("serializes explicit deletion before healthy import at the guest-parent lock", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const releaseDelete = deferred<void>();
    const deleteAttempted = deferred<number>();
    const deleteAcquired = deferred<number>();
    const deletePool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FOR UPDATE OF s"),
      deleteAttempted,
      deleteAcquired,
      releaseDelete.promise,
    );
    const deletion = new GuestSessionService(deletePool, authority).delete(issued.resumeSecret);
    await deleteAcquired.promise;

    const importAttempted = deferred<number>();
    const importAcquired = deferred<number>();
    const importPool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      importAttempted,
      importAcquired,
    );
    const importing = new PortableRecoveryService(
      importPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    ).import({
      importId: "123e4567-e89b-42d3-a456-426614174161",
      envelope,
    });
    await expectLockWait(rawPool, await importAttempted.promise);
    releaseDelete.resolve();

    await expect(deletion).resolves.toBeUndefined();
    await expect(importing).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });
    const state = await rawPool.query<{
      guests: string; digests: string; exports: string; imports: string;
      guest_tombstones: string; command_tombstones: string; export_tombstones: string; import_tombstones: string;
    }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS guests,
      (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
      (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
      (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'guest-session') AS guest_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'command') AS command_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-export') AS export_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-import') AS import_tombstones`);
    expect(state.rows[0]).toEqual({
      guests: "0", digests: "0", exports: "0", imports: "0",
      guest_tombstones: "2", command_tombstones: "0", export_tombstones: "1", import_tombstones: "0",
    });
  });

  it("serializes healthy import before expiry deletion with SKIP LOCKED", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const releaseImport = deferred<void>();
    const importAttempted = deferred<number>();
    const importAcquired = deferred<number>();
    const importPool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      importAttempted,
      importAcquired,
      releaseImport.promise,
    );
    const importResult = new PortableRecoveryService(
      importPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    ).import({
      importId: "123e4567-e89b-42d3-a456-426614174162",
      envelope,
    });
    await importAcquired.promise;
    const future = new Date(issued.session.expiresAt.getTime() + 1);
    const cleanupPool = new ControlledClockPool(pool, [future, future]);
    await expect(new GuestSessionService(cleanupPool, authority).deleteExpired()).resolves.toBe(0);
    releaseImport.resolve();

    const imported = await importResult;
    await expect(sessionService.resume(imported.rotatedResumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
    const state = await rawPool.query<{
      guests: string; digests: string; exports: string; imports: string;
      guest_tombstones: string; command_tombstones: string; export_tombstones: string; import_tombstones: string;
    }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS guests,
      (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
      (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
      (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'guest-session') AS guest_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'command') AS command_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-export') AS export_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-import') AS import_tombstones`);
    expect(state.rows[0]).toEqual({
      guests: "1", digests: "1", exports: "0", imports: "1",
      guest_tombstones: "1", command_tombstones: "0", export_tombstones: "1", import_tombstones: "1",
    });
  });

  it("serializes expiry deletion before healthy import at the guest-parent lock", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const future = new Date(issued.session.expiresAt.getTime() + 1);
    const releaseCleanup = deferred<void>();
    const cleanupAttempted = deferred<number>();
    const cleanupAcquired = deferred<number>();
    const cleanupPool = new ObservedQueryLockPool(
      new ControlledClockPool(pool, [future, future]),
      (text) => text.includes("FROM samurai_persistence.guest_sessions") && text.includes("FOR UPDATE SKIP LOCKED"),
      cleanupAttempted,
      cleanupAcquired,
      releaseCleanup.promise,
    );
    const cleanup = new GuestSessionService(cleanupPool, authority).deleteExpired();
    await cleanupAcquired.promise;

    const importAttempted = deferred<number>();
    const importAcquired = deferred<number>();
    const importPool = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      importAttempted,
      importAcquired,
    );
    const importing = new PortableRecoveryService(
      importPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    ).import({
      importId: "123e4567-e89b-42d3-a456-426614174163",
      envelope,
    });
    await expectLockWait(rawPool, await importAttempted.promise);
    releaseCleanup.resolve();

    await expect(cleanup).resolves.toBe(1);
    await expect(importing).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });
    const state = await rawPool.query<{
      guests: string; digests: string; exports: string; imports: string;
      guest_tombstones: string; command_tombstones: string; export_tombstones: string; import_tombstones: string;
    }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS guests,
      (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
      (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
      (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'guest-session') AS guest_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'command') AS command_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-export') AS export_tombstones,
      (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-import') AS import_tombstones`);
    expect(state.rows[0]).toEqual({
      guests: "0", digests: "0", exports: "0", imports: "0",
      guest_tombstones: "1", command_tombstones: "0", export_tombstones: "1", import_tombstones: "0",
    });
  });

  it("rechecks exact export expiry after a blocked export-row lock", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const blocker = await rawPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT export_id FROM samurai_persistence.save_exports WHERE export_id = $1::uuid FOR UPDATE",
        [envelope.exportId],
      );
      const attempted = deferred<number>();
      const acquired = deferred<number>();
      const expiry = new Date(envelope.expiresAt);
      const before = new Date(expiry.getTime() - 1);
      const importPool = new ObservedQueryLockPool(
        new ControlledClockPool(pool, [before, before, before, expiry, expiry]),
        (text) => text.includes("WHERE export_id = $1::uuid AND guest_session_id = $2") && text.includes("FOR UPDATE"),
        attempted,
        acquired,
      );
      const importing = new PortableRecoveryService(
        importPool,
        authority,
        recoveryAuthority,
        { async describe() { return recoveryContent; } },
      ).import({
        importId: "123e4567-e89b-42d3-a456-426614174164",
        envelope,
      });
      await expectLockWait(rawPool, await attempted.promise);
      await blocker.query("COMMIT");
      await acquired.promise;
      await expect(importing).rejects.toMatchObject({ recoveryCode: "RECOVERY_EXPIRED" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    const state = await rawPool.query<{ exports: string; imports: string; digests: string; tombstones: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
              (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
              (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
              (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones) AS tombstones`,
    );
    expect(state.rows[0]).toEqual({ exports: "1", imports: "0", digests: "1", tombstones: "0" });
  });

  it("rechecks integrity-key compromise after a blocked export-row lock", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const compromisedAt = new Date(new Date(envelope.expiresAt).getTime() - 12 * 60 * 60 * 1_000);
    const before = new Date(compromisedAt.getTime() - 1);
    const after = new Date(compromisedAt.getTime() + 1);
    const compromisedKey = { ...hmacKey("portable-integrity", 5, 5), compromisedAt } as const;
    const blocker = await rawPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        "SELECT export_id FROM samurai_persistence.save_exports WHERE export_id = $1::uuid FOR UPDATE",
        [envelope.exportId],
      );
      const attempted = deferred<number>();
      const acquired = deferred<number>();
      const importPool = new ObservedQueryLockPool(
        new ControlledClockPool(pool, [before, before, before, after, after]),
        (text) => text.includes("WHERE export_id = $1::uuid AND guest_session_id = $2") && text.includes("FOR UPDATE"),
        attempted,
        acquired,
      );
      const crossingAuthority = new PortableRecoveryAuthority(importPool, new IntegrityKeyring(compromisedKey));
      const importing = new PortableRecoveryService(
        importPool,
        authority,
        crossingAuthority,
        { async describe() { return recoveryContent; } },
      ).import({
        importId: "123e4567-e89b-42d3-a456-426614174165",
        envelope,
      });
      await expectLockWait(rawPool, await attempted.promise);
      await blocker.query("COMMIT");
      await acquired.promise;
      await expect(importing).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
    const state = await rawPool.query<{ exports: string; imports: string; digests: string; tombstones: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
              (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
              (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
              (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones) AS tombstones`,
    );
    expect(state.rows[0]).toEqual({ exports: "1", imports: "0", digests: "1", tombstones: "0" });
  });

  it("deletes every credential, export, receipt, and replay identity for explicit and expiry deletion", async () => {
    for (const [index, mode] of ["explicit", "expiry"].entries()) {
      await rawPool.query("TRUNCATE samurai_persistence.guest_sessions CASCADE");
      await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
      const issued = await sessionService.issue({
        consentVersion: "privacy-v1",
        contentVersion: "content-v1",
        checkpointSchemaVersion: 1,
        checkpoint: { step: 0 },
      });
      const consumed = await recovery.createExport({
        resumeSecret: issued.resumeSecret,
        expectedRevision: 0,
        validityMs: 24 * 60 * 60 * 1_000,
      });
      const imported = await recovery.import({
        importId: `123e4567-e89b-42d3-a456-42661417417${index}`,
        envelope: consumed,
      });
      await executor.execute(
        imported.rotatedResumeSecret,
        command(issued.session.id, `018f47fe-347b-4dac-8f45-a6f3f43bd61${index}`, 0),
        () => ({
          checkpointSchemaVersion: 1,
          checkpoint: { step: 1 },
          event: {
            eventId: `018f47fe-347b-4dac-8f45-a6f3f43bd62${index}`,
            eventType: "checkpoint.advanced",
            schemaVersion: 1,
            payload: { step: 1 },
          },
          response: { schemaVersion: 1, payload: { accepted: true } },
        }),
      );
      await recovery.createExport({
        resumeSecret: imported.rotatedResumeSecret,
        expectedRevision: 1,
        validityMs: 24 * 60 * 60 * 1_000,
      });
      await recovery.createExport({
        resumeSecret: imported.rotatedResumeSecret,
        expectedRevision: 1,
        validityMs: 2 * 24 * 60 * 60 * 1_000,
      });

      if (mode === "explicit") {
        await sessionService.delete(imported.rotatedResumeSecret);
      } else {
        const clock = await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
        const expiry = new Date(clock.rows[0]!.now.getTime() + 24 * 60 * 60 * 1_000);
        await rawPool.query(
          `UPDATE samurai_persistence.guest_sessions
              SET rotate_after = $2,
                  expires_at = $3
            WHERE id = $1`,
          [issued.session.id, new Date(expiry.getTime() - 1), expiry],
        );
        const expiryService = new GuestSessionService(
          new ControlledClockPool(pool, [expiry, expiry]),
          authority,
        );
        await expect(expiryService.deleteExpired()).resolves.toBe(1);
      }

      const state = await rawPool.query<{
        guests: string; digests: string; commands: string; exports: string; imports: string;
        guest_tombstones: string; command_tombstones: string; export_tombstones: string; import_tombstones: string;
      }>(`SELECT
        (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS guests,
        (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts) AS commands,
        (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
        (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'guest-session') AS guest_tombstones,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'command') AS command_tombstones,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-export') AS export_tombstones,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind = 'save-import') AS import_tombstones`);
      expect(state.rows[0], mode).toEqual({
        guests: "0", digests: "0", commands: "0", exports: "0", imports: "0",
        guest_tombstones: mode === "explicit" ? "3" : "2",
        command_tombstones: "1", export_tombstones: "3", import_tombstones: "1",
      });
    }
  });

  it("rolls every recovery mutation back when receipt persistence fails late", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const failing = new PortableRecoveryService(
      new FailOnQueryPool(pool, "INSERT INTO samurai_persistence.recovery_imports"),
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    );

    await expect(failing.import({
      importId: "123e4567-e89b-42d3-a456-426614174113",
      envelope,
    })).rejects.toThrow(/Injected failure/u);

    await expect(sessionService.resume(issued.resumeSecret)).resolves.toMatchObject({ session: { id: issued.session.id } });
    const state = await rawPool.query<{ readonly exports: string; readonly imports: string; readonly digests: string; readonly tombstones: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
              (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
              (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
              (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones) AS tombstones`,
    );
    expect(state.rows[0]).toEqual({ exports: "1", imports: "0", digests: "1", tombstones: "0" });
  });

  it("collapses hostile server content descriptors without creating or consuming recovery authority", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const hostile = new PortableRecoveryService(
      pool,
      authority,
      recoveryAuthority,
      {
        async describe() {
          return { pack: { ...recoveryContent.pack, contentHash: "not-a-hash" }, refs: [] } as never;
        },
      },
    );

    await expect(hostile.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 1_000,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_CONTENT_INCOMPATIBLE" });
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.save_exports",
    )).rows[0]?.count).toBe("0");
  });

  it("keeps one durable random credential on exact retry and stops retry authority at envelope expiry", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const importId = "123e4567-e89b-42d3-a456-426614174110";
    const committed = await recovery.import({ importId, envelope });
    const replayed = await recovery.import({ importId, envelope });
    expect([committed.disposition, replayed.disposition]).toEqual(["committed", "replayed"]);
    expect(committed.rotatedResumeSecret).not.toBe(replayed.rotatedResumeSecret);
    await expect(sessionService.resume(committed.rotatedResumeSecret)).rejects.toMatchObject({ code: "GUEST_RESUME_INVALID" });
    await expect(sessionService.resume(replayed.rotatedResumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
    const durable = await rawPool.query<{ digests: string; receipts: string; generation: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
              (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS receipts,
              (SELECT delivery_generation::text FROM samurai_persistence.recovery_imports
                WHERE import_id = $1::uuid) AS generation`,
      [importId],
    );
    expect(durable.rows[0]).toEqual({ digests: "1", receipts: "1", generation: "2" });

    const expiry = new Date(envelope.expiresAt);
    const controlledPool = new ControlledClockPool(pool, [expiry, expiry, expiry, expiry]);
    const expiredRetry = new PortableRecoveryService(
      controlledPool,
      authority,
      recoveryAuthority,
      { async describe() { return recoveryContent; } },
    );
    await expect(expiredRetry.import({ importId, envelope })).rejects.toMatchObject({
      recoveryCode: "RECOVERY_ALREADY_CONSUMED",
    });
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.recovery_imports WHERE expires_at > original_export_expires_at",
    )).rows[0]?.count).toBe("1");
  });

  it("rejects receipt metadata drift that would extend the MAC-bound retry authority", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const importId = "123e4567-e89b-42d3-a456-426614174131";
    const imported = await recovery.import({ importId, envelope });
    await rawPool.query(
      `UPDATE samurai_persistence.recovery_imports
          SET original_export_expires_at = original_export_expires_at + interval '1 hour',
              expires_at = expires_at + interval '1 hour'
        WHERE import_id = $1::uuid`,
      [importId],
    );
    await expect(recovery.import({ importId, envelope })).rejects.toMatchObject({
      recoveryCode: "RECOVERY_IDEMPOTENCY_MISMATCH",
    });
    await expect(sessionService.resume(imported.rotatedResumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
  });

  it("trusts only server content authority and rolls back every destructive import phase", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const unavailableContent = new PortableRecoveryService(
      pool,
      authority,
      recoveryAuthority,
      { async describe() { throw new Error("catalog unavailable"); } },
    );
    await expect(unavailableContent.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 1_000,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_CONTENT_INCOMPATIBLE" });
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.save_exports",
    )).rows[0]?.count).toBe("0");

    const failureStatements = [
      "DELETE FROM samurai_persistence.save_exports WHERE guest_session_id",
      "DELETE FROM samurai_persistence.guest_resume_digests WHERE guest_session_id",
      "INSERT INTO samurai_persistence.guest_resume_digests",
      "INSERT INTO samurai_persistence.recovery_imports",
      "INSERT INTO samurai_persistence.deletion_tombstones",
    ];
    for (const [index, statement] of failureStatements.entries()) {
      await rawPool.query("TRUNCATE samurai_persistence.guest_sessions CASCADE");
      await rawPool.query("DELETE FROM samurai_persistence.deletion_tombstones");
      const subject = await sessionService.issue({
        consentVersion: "privacy-v1",
        contentVersion: "content-v1",
        checkpointSchemaVersion: 1,
        checkpoint: { step: 0 },
      });
      const envelope = await recovery.createExport({
        resumeSecret: subject.resumeSecret,
        expectedRevision: 0,
        validityMs: 24 * 60 * 60 * 1_000,
      });
      const failingPool = new FailAfterStatementPool(pool, statement);
      const failing = new PortableRecoveryService(
        failingPool,
        authority,
        recoveryAuthority,
        { async describe() { return recoveryContent; } },
      );
      await expect(failing.import({
        importId: `123e4567-e89b-42d3-a456-42661417412${index}`,
        envelope,
      })).rejects.toThrow("Injected failure");
      await expect(sessionService.resume(subject.resumeSecret)).resolves.toMatchObject({
        session: { id: subject.session.id },
      });
      const state = await rawPool.query<{ exports: string; imports: string; digests: string; tombstones: string }>(
        `SELECT (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
                (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
                (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests) AS digests,
                (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones) AS tombstones`,
      );
      expect(state.rows[0]).toEqual({ exports: "1", imports: "0", digests: "1", tombstones: "0" });
    }
  });

  it("rejects server-content drift without consuming the export or credential", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const drifted = new PortableRecoveryService(pool, authority, recoveryAuthority, {
      async describe() {
        return {
          ...recoveryContent,
          pack: { ...recoveryContent.pack, contentHash: recoveryHash("9") },
        };
      },
    });
    await expect(drifted.import({
      importId: "123e4567-e89b-42d3-a456-426614174130",
      envelope,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_CONTENT_INCOMPATIBLE" });
    await expect(sessionService.resume(issued.resumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.save_exports WHERE export_id = $1::uuid",
      [envelope.exportId],
    )).rows[0]?.count).toBe("1");
  });

  it("rejects tamper, exact expiry, and both directions of revision drift without mutation", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const tampered = { ...envelope, subjectRevision: 1 };
    await expect(recovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174101",
      envelope: tampered,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });
    expect((await rawPool.query<CountRow>("SELECT count(*)::text AS count FROM samurai_persistence.save_exports")).rows[0]?.count).toBe("1");

    await rawPool.query(
      "UPDATE samurai_persistence.save_exports SET expires_at = clock_timestamp() WHERE export_id = $1::uuid",
      [envelope.exportId],
    );
    await expect(recovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174102",
      envelope,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_EXPIRED" });

    await rawPool.query(
      `UPDATE samurai_persistence.save_exports
          SET expires_at = $2
        WHERE export_id = $1::uuid`,
      [envelope.exportId, new Date(envelope.expiresAt)],
    );
    await rawPool.query("UPDATE samurai_persistence.guest_progress SET revision = 1 WHERE guest_session_id = $1", [issued.session.id]);
    await expect(recovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174103",
      envelope,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_REVISION_STALE" });

    await rawPool.query("UPDATE samurai_persistence.guest_progress SET revision = 0 WHERE guest_session_id = $1", [issued.session.id]);
    const revisionOne = await rawPool.query(
      `UPDATE samurai_persistence.guest_progress
          SET revision = 1, checkpoint = '{"step":1}'::jsonb
        WHERE guest_session_id = $1`,
      [issued.session.id],
    );
    expect(revisionOne.rowCount).toBe(1);
    const futureEnvelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 1,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    await rawPool.query(
      `UPDATE samurai_persistence.guest_progress
          SET revision = 0, checkpoint = '{"step":0}'::jsonb
        WHERE guest_session_id = $1`,
      [issued.session.id],
    );
    await expect(recovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174104",
      envelope: futureEnvelope,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_AUTHORITY_ROLLBACK" });
    expect((await rawPool.query<CountRow>("SELECT count(*)::text AS count FROM samurai_persistence.recovery_imports")).rows[0]?.count).toBe("0");
  });

  it("fails portable entry points closed without integrity inventory and revokes compromised live export keys", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const missing = new PersistenceAuthority(pool, resumeKeys, tombstoneKeys);
    await expect(missing.bootstrap()).resolves.toEqual({
      retentionReady: true,
      capabilityServingReady: true,
    });
    await expect(new GuestSessionService(pool, missing).resume(issued.resumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
    const missingService = new PortableRecoveryService(
      pool,
      missing,
      new PortableRecoveryAuthority(pool, undefined),
      { async describe() { return recoveryContent; } },
    );
    await expect(missingService.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 1_000,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });

    const compromisedKey = {
      ...hmacKey("portable-integrity", 5, 5),
      compromisedAt: new Date("2026-07-01T00:00:00.000Z"),
    } as const;
    const compromisedRecovery = new PortableRecoveryAuthority(
      pool,
      new IntegrityKeyring(compromisedKey),
    );
    const compromisedService = new PortableRecoveryService(
      pool,
      authority,
      compromisedRecovery,
      { async describe() { return recoveryContent; } },
    );
    await expect(compromisedService.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 1_000,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });
    await expect(sessionService.resume(issued.resumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
  });

  it("keeps compromised-key rejection scoped while healthy re-export and import remain available", async () => {
    const affected = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const compromisedEnvelope = await recovery.createExport({
      resumeSecret: affected.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const compromisedOld = {
      ...hmacKey("portable-integrity", 5, 5, true),
      compromisedAt: new Date("2026-07-01T00:00:00.000Z"),
    } as const;
    const healthyAuthority = new PortableRecoveryAuthority(
      pool,
      new IntegrityKeyring(hmacKey("portable-integrity", 6, 6), [compromisedOld]),
    );
    const healthyRecovery = new PortableRecoveryService(
      pool,
      authority,
      healthyAuthority,
      { async describe() { return recoveryContent; } },
    );
    const replacementEnvelope = await healthyRecovery.createExport({
      resumeSecret: affected.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    expect(replacementEnvelope.integrity.keyVersion).toBe(6);
    await expect(healthyRecovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174141",
      envelope: compromisedEnvelope,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });

    const unrelated = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const unrelatedEnvelope = await healthyRecovery.createExport({
      resumeSecret: unrelated.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    await expect(healthyRecovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174142",
      envelope: unrelatedEnvelope,
    })).resolves.toMatchObject({ guestSessionId: unrelated.session.id });
    await expect(healthyRecovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174143",
      envelope: replacementEnvelope,
    })).resolves.toMatchObject({ guestSessionId: affected.session.id });
  });

  it("purges unavailable integrity references guest-first and keeps destruction fenced until they are gone", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const receiptSubject = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const receiptEnvelope = await recovery.createExport({
      resumeSecret: receiptSubject.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const receiptImport = await recovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174147",
      envelope: receiptEnvelope,
    });
    const verifyUntil = new Date(envelope.expiresAt);
    const compromisedAt = new Date(verifyUntil.getTime() - 12 * 60 * 60 * 1_000);
    const beforeCompromise = new Date(compromisedAt.getTime() - 1);
    const afterVerification = new Date(verifyUntil.getTime() + 1);
    const unavailableOld = {
      ...hmacKey("portable-integrity", 5, 5, true),
      retiredAt: new Date(compromisedAt.getTime() - 24 * 60 * 60 * 1_000),
      verifyUntil,
      compromisedAt,
    } as const;
    const integrityRing = new IntegrityKeyring(hmacKey("portable-integrity", 6, 6), [unavailableOld]);
    const releasePurge = deferred<void>();
    const purgeAttempted = deferred<number>();
    const purgeAcquired = deferred<number>();
    const purgePool = new ObservedQueryLockPool(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => afterVerification)),
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      purgeAttempted,
      purgeAcquired,
      releasePurge.promise,
    );
    const purgeAuthority = new PortableRecoveryAuthority(purgePool, integrityRing);
    const purgeService = new PortableRecoveryService(
      purgePool,
      authority,
      purgeAuthority,
      { async describe() { return recoveryContent; } },
    );
    const destructionAuthority = new PortableRecoveryAuthority(
      new ControlledClockPool(pool, [afterVerification, afterVerification]),
      integrityRing,
    );
    await expect(destructionAuthority.assertSafeToDestroy(5)).rejects.toMatchObject({
      code: "KEY_DESTRUCTION_UNSAFE",
    });
    const purgeResult = purgeService.purgeUnavailableIntegrityReferences();
    await purgeAcquired.promise;
    const importAttempted = deferred<number>();
    const importAcquired = deferred<number>();
    const importPool = new ObservedQueryLockPool(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => beforeCompromise)),
      (text) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE"),
      importAttempted,
      importAcquired,
    );
    const importResult = new PortableRecoveryService(
      importPool,
      authority,
      new PortableRecoveryAuthority(importPool, integrityRing),
      { async describe() { return recoveryContent; } },
    ).import({
        importId: "123e4567-e89b-42d3-a456-426614174144",
        envelope,
      });
    await expectLockWait(rawPool, await importAttempted.promise);
    releasePurge.resolve();
    await expect(purgeResult).resolves.toBe(2);
    await expect(importResult).rejects.toMatchObject({ recoveryCode: "RECOVERY_ALREADY_CONSUMED" });
    await expect(sessionService.resume(issued.resumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
    await expect(sessionService.resume(receiptImport.rotatedResumeSecret)).resolves.toMatchObject({
      session: { id: receiptSubject.session.id },
    });
    const state = await rawPool.query<{ exports: string; imports: string; export_tombstones: string; import_tombstones: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.save_exports) AS exports,
              (SELECT count(*)::text FROM samurai_persistence.recovery_imports) AS imports,
              (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones
                WHERE kind = 'save-export') AS export_tombstones,
              (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones
                WHERE kind = 'save-import') AS import_tombstones`,
    );
    expect(state.rows[0]).toEqual({
      exports: "0",
      imports: "0",
      export_tombstones: "2",
      import_tombstones: "1",
    });
    await expect(destructionAuthority.assertSafeToDestroy(5)).resolves.toBeUndefined();
  });

  it("imports a pre-retirement export through its verification-only integrity key", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const rotatedIntegrity = new IntegrityKeyring(
      hmacKey("portable-integrity", 6, 6),
      [hmacKey("portable-integrity", 5, 5, true)],
    );
    const rotatedService = new PortableRecoveryService(
      pool,
      authority,
      new PortableRecoveryAuthority(pool, rotatedIntegrity),
      { async describe() { return recoveryContent; } },
    );
    await expect(rotatedService.import({
      importId: "123e4567-e89b-42d3-a456-426614174105",
      envelope,
    })).resolves.toMatchObject({ guestSessionId: issued.session.id, revision: 0 });
  });

  it("requires the selected retired integrity key to cover the exact envelope horizon", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const shortRetired = {
      ...hmacKey("portable-integrity", 5, 5, true),
      verifyUntil: new Date(new Date(envelope.expiresAt).getTime() - 1),
    } as const;
    const shortService = new PortableRecoveryService(
      pool,
      authority,
      new PortableRecoveryAuthority(
        pool,
        new IntegrityKeyring(hmacKey("portable-integrity", 6, 6), [shortRetired]),
      ),
      { async describe() { return recoveryContent; } },
    );
    await expect(shortService.import({
      importId: "123e4567-e89b-42d3-a456-426614174145",
      envelope,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });

    const exactRetired = {
      ...shortRetired,
      verifyUntil: new Date(envelope.expiresAt),
    } as const;
    const exactService = new PortableRecoveryService(
      pool,
      authority,
      new PortableRecoveryAuthority(
        pool,
        new IntegrityKeyring(hmacKey("portable-integrity", 6, 6), [exactRetired]),
      ),
      { async describe() { return recoveryContent; } },
    );
    await expect(exactService.import({
      importId: "123e4567-e89b-42d3-a456-426614174146",
      envelope,
    })).resolves.toMatchObject({ guestSessionId: issued.session.id });
  });

  it("fails closed on private-record key identity drift without widening the failure domain", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    await rawPool.query(
      "UPDATE samurai_persistence.save_exports SET integrity_key_identity = $2 WHERE export_id = $1::uuid",
      [envelope.exportId, Buffer.alloc(32, 99)],
    );
    await expect(recovery.import({
      importId: "123e4567-e89b-42d3-a456-426614174140",
      envelope,
    })).rejects.toMatchObject({ recoveryCode: "RECOVERY_INVALID" });
    await expect(sessionService.resume(issued.resumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
  });

  it("refuses portable-integrity key destruction through the final private reference", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    const retired = {
      ...hmacKey("portable-integrity", 5, 5, true),
      retiredAt: new Date("2025-02-01T00:00:00.000Z"),
      verifyUntil: new Date("2025-03-01T00:00:00.000Z"),
    } as const;
    const destructionAuthority = new PortableRecoveryAuthority(
      pool,
      new IntegrityKeyring(hmacKey("portable-integrity", 6, 6), [retired]),
    );
    await expect(destructionAuthority.assertSafeToDestroy(5)).rejects.toMatchObject({
      code: "KEY_DESTRUCTION_UNSAFE",
    });
    await rawPool.query("DELETE FROM samurai_persistence.save_exports");
    await expect(destructionAuthority.assertSafeToDestroy(5)).resolves.toBeUndefined();
  });

  it("enforces Stage 2 UUID, commitment, expiry, key-shape, and tombstone-shape constraints in PostgreSQL", async () => {
    const issued = await sessionService.issue({
      consentVersion: "privacy-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { step: 0 },
    });
    const baseValues = [
      issued.session.id,
      Buffer.alloc(32, 1),
      Buffer.alloc(32, 2),
      Buffer.alloc(32, 3),
      Buffer.alloc(32, 4),
      Buffer.alloc(32, 5),
    ];
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.save_exports
        (export_id, guest_session_id, subject_revision, content_version, checkpoint_schema_version,
         save_payload_hash, unlinkable_claim_commitment_hash, claims_hash,
         integrity_key_version, integrity_key_identity, integrity_tag, created_at, expires_at)
       VALUES ('123e4567-e89b-12d3-a456-426614174106', $1, 0, 'content-v1', 1,
               $2, $3, $4, 5, $5, $6, clock_timestamp(), clock_timestamp() + interval '1 day')`,
      baseValues,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         resume_digest_key_version, resume_digest_key_identity, created_at, expires_at)
       VALUES ('save-export', 3, $1, $2, 2, $3, clock_timestamp(), clock_timestamp() + interval '1 day')`,
      [Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3)],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         resume_digest_key_version, resume_digest_key_identity, created_at, expires_at)
       VALUES ('guest-session', 3, $1, $2, NULL, NULL,
               clock_timestamp(), clock_timestamp() + interval '1 day')`,
      [Buffer.alloc(32, 1), Buffer.alloc(32, 8)],
    )).rejects.toMatchObject({ code: "23514" });
    await rawPool.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         resume_digest_key_version, resume_digest_key_identity, created_at, expires_at)
       VALUES ('save-export', 3, $1, $2, NULL, NULL,
               clock_timestamp(), clock_timestamp() + interval '1 day'),
              ('save-import', 3, $1, $3, NULL, NULL,
               clock_timestamp(), clock_timestamp() + interval '1 day')`,
      [keyIdentityBytes(tombstoneKeys.active.keyIdentity), Buffer.alloc(32, 9), Buffer.alloc(32, 10)],
    );
    const validKinds = await rawPool.query<{ kind: string }>(
      "SELECT kind FROM samurai_persistence.deletion_tombstones ORDER BY kind",
    );
    expect(validKinds.rows).toEqual([{ kind: "save-export" }, { kind: "save-import" }]);
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.recovery_imports
        (import_id, guest_session_id, export_id, request_hash, committed_revision,
         integrity_key_version, integrity_key_identity,
         issued_digest_key_version, issued_digest_key_identity, issued_digest,
         delivery_generation, created_at, updated_at, original_export_expires_at, expires_at)
       VALUES ('123e4567-e89b-12d3-a456-426614174107', $1,
               '123e4567-e89b-42d3-a456-426614174108', $2, 0,
               5, $3, 2, $4, $5, 1,
               '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
               '2026-08-02T00:00:00.000Z', '2026-08-03T00:00:00.000Z')`,
      [
        issued.session.id,
        Buffer.alloc(32, 4),
        Buffer.alloc(32, 5),
        Buffer.alloc(32, 6),
        Buffer.alloc(32, 7),
      ],
    )).rejects.toMatchObject({ code: "23514" });
    const receiptInsert = (importId: string, updatedAt: string, originalExpiresAt: string, expiresAt: string) => rawPool.query(
      `INSERT INTO samurai_persistence.recovery_imports
        (import_id, guest_session_id, export_id, request_hash, committed_revision,
         integrity_key_version, integrity_key_identity,
         issued_digest_key_version, issued_digest_key_identity, issued_digest,
         delivery_generation, created_at, updated_at, original_export_expires_at, expires_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, 0, 5, $5, 2, $6, $7, 1,
               '2026-08-01T00:00:00.000Z', $8::timestamptz, $9::timestamptz, $10::timestamptz)`,
      [
        importId,
        issued.session.id,
        "123e4567-e89b-42d3-a456-426614174159",
        Buffer.alloc(32, 11),
        keyIdentityBytes(integrityKeys.active.keyIdentity),
        Buffer.alloc(32, 13),
        Buffer.alloc(32, 14),
        updatedAt,
        originalExpiresAt,
        expiresAt,
      ],
    );
    await expect(receiptInsert(
      "123e4567-e89b-42d3-a456-426614174150",
      "2026-08-01T00:00:00.000Z",
      "infinity",
      "infinity",
    )).rejects.toMatchObject({ code: "23514" });
    await expect(receiptInsert(
      "123e4567-e89b-42d3-a456-426614174151",
      "2026-08-01T00:00:00.000Z",
      "2026-08-30T00:00:00.001Z",
      "2026-08-31T00:00:00.001Z",
    )).rejects.toMatchObject({ code: "23514" });
    await expect(receiptInsert(
      "123e4567-e89b-42d3-a456-426614174152",
      "2026-08-30T00:00:00.000Z",
      "2026-08-30T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    )).rejects.toMatchObject({ code: "23514" });
    await expect(receiptInsert(
      "123e4567-e89b-42d3-a456-426614174153",
      "2026-08-29T23:59:59.999Z",
      "2026-08-30T00:00:00.000Z",
      "2026-08-31T00:00:00.000Z",
    )).resolves.toMatchObject({ rowCount: 1 });
    const envelope = await recovery.createExport({
      resumeSecret: issued.resumeSecret,
      expectedRevision: 0,
      validityMs: 24 * 60 * 60 * 1_000,
    });
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.save_exports
        (export_id, guest_session_id, subject_revision, content_version, checkpoint_schema_version,
         save_payload_hash, unlinkable_claim_commitment_hash, claims_hash,
         integrity_key_version, integrity_key_identity, integrity_tag, created_at, expires_at)
       SELECT '123e4567-e89b-42d3-a456-426614174109', guest_session_id, subject_revision,
              content_version, checkpoint_schema_version, save_payload_hash,
              unlinkable_claim_commitment_hash, claims_hash, integrity_key_version,
              integrity_key_identity, decode(repeat('ab', 32), 'hex'), created_at, expires_at
         FROM samurai_persistence.save_exports WHERE export_id = $1::uuid`,
      [envelope.exportId],
    )).rejects.toMatchObject({
      code: "23505",
      constraint: "save_exports_unlinkable_claim_commitment_hash_key",
    });
    const columns = await rawPool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'samurai_persistence' AND table_name = 'deletion_tombstones'`,
    );
    expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining([
      "guest_session_id",
      "export_id",
      "import_id",
      "payload",
    ]));
  });

  it("retries tombstoned guest claim capabilities and exhausts the bounded collision budget atomically", async () => {
    const rejectedCapability = Buffer.alloc(32, 0xa1).toString("base64url");
    const acceptedCapability = Buffer.alloc(32, 0xa2).toString("base64url");
    const clock = await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
    const issuedAt = clock.rows[0]!.now;
    const rejectedDigest = guestClaimKeys.digest(rejectedCapability, issuedAt);
    const replayKey = `guest-claim:v${rejectedDigest.keyVersion}:${Buffer.from(rejectedDigest.digest).toString("base64url")}`;
    const tombstone = tombstoneKeys.digest("guest-claim", replayKey, issuedAt);
    await rawPool.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         capability_key_purpose, capability_key_version, capability_key_identity,
         created_at, expires_at)
       VALUES ('guest-claim', $1, $2, $3, 'guest-claim', $4, $5, $6, $7)`,
      [
        tombstone.keyVersion,
        keyIdentityBytes(tombstone.keyIdentity),
        tombstone.digest,
        rejectedDigest.keyVersion,
        keyIdentityBytes(rejectedDigest.keyIdentity),
        issuedAt,
        new Date(issuedAt.getTime() + 30 * 24 * 60 * 60 * 1_000),
      ],
    );

    const capabilities = [rejectedCapability, acceptedCapability];
    const issued = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys,
      issueClaimCapability: () => capabilities.shift()!,
    }).issue({
      consentVersion: "consent-v1",
      contentVersion: "phase0-salmon@1",
      checkpointSchemaVersion: 1,
      checkpoint: { orders: [] },
    });
    expect(issued.claimCapability).toBe(acceptedCapability);

    await expect(new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys,
      issueClaimCapability: () => rejectedCapability,
    }).issue({
      consentVersion: "consent-v1",
      contentVersion: "phase0-salmon@1",
      checkpointSchemaVersion: 1,
      checkpoint: { orders: [] },
    })).rejects.toMatchObject({ code: "GUEST_CLAIM_COLLISION" });
    const state = await rawPool.query<{ readonly guests: string; readonly capabilities: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS guests,
        (SELECT count(*)::text FROM samurai_persistence.guest_claim_capabilities) AS capabilities
    `);
    expect(state.rows[0]).toEqual({ guests: "1", capabilities: "1" });
  });

  it("atomically claims a guest into one pending player issuance and preserves transferred history", async () => {
    const claimCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const claimIntent = {
      claimId: "123e4567-e89b-42d3-a456-426614174000",
      guestClaimCommitment: claimCapability,
      createPlayer: true,
      guestRevision: 7,
      idempotencyKey: "223e4567-e89b-42d3-a456-426614174000",
      contentVersion: "phase0-salmon@1",
      cosmeticSelections: { counter: "moonwake", norens: "indigo" },
    } as const;
    const issued = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys,
      issueClaimCapability: () => claimCapability,
    }).issue({
      consentVersion: "consent-v1",
      contentVersion: claimIntent.contentVersion,
      checkpointSchemaVersion: 1,
      checkpoint: { orders: ["rice"] },
    });
    expect(issued.claimCapability).toBe(claimCapability);
    await rawPool.query(
      "UPDATE samurai_persistence.guest_progress SET revision = 7 WHERE guest_session_id = $1",
      [issued.session.id],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.command_receipts
        (guest_session_id,idempotency_key,command_name,expected_revision,content_version,payload_hash,
         response_schema_version,response_payload,result_hash,committed_revision,created_at,expires_at)
       VALUES ($1,'323e4567-e89b-42d3-a456-426614174000','checkpoint.advance',6,$2,
               decode(repeat('11',32),'hex'),1,'{}',decode(repeat('22',32),'hex'),7,
               '2026-08-01T20:00:00Z','2026-08-02T20:00:00Z')`,
      [issued.session.id, claimIntent.contentVersion],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.domain_events
        (event_id,guest_session_id,event_type,schema_version,payload,committed_revision,created_at)
       VALUES ('claim-transfer-event',$1,'checkpoint.advanced',1,'{}',7,'2026-08-01T20:00:00Z')`,
      [issued.session.id],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.outbox_deliveries (event_id,available_at)
       VALUES ('claim-transfer-event','2026-08-01T20:00:00Z')`,
    );

    const issuedAt = new Date("2026-08-01T20:30:00.000Z");
    const issueService = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 24 }, () => issuedAt)),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "423e4567-e89b-42d3-a456-426614174000",
        issueNonce: () => "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
      },
    );
    const challenge = await issueService.issueClaimChallenge({
      resumeSecret: issued.resumeSecret,
      intent: claimIntent,
      account: "tz1MsZxMSJdiUV9hVs4UKAMrXtksDvxWAZe2",
    });
    if ("code" in challenge) throw new Error("Claim challenge issuance unexpectedly failed.");
    expect(challenge.challenge).toMatchObject({
      nonce: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA",
      issuedAt: "2026-08-01T20:30:00.000Z",
      expiresAt: "2026-08-01T20:35:00.000Z",
    });
    const ids = [
      "523e4567-e89b-42d3-a456-426614174000",
      "623e4567-e89b-42d3-a456-426614174000",
      "723e4567-e89b-42d3-a456-426614174000",
    ];
    const rejectedPlayerSecret = Buffer.alloc(32, 0xc1).toString("base64url");
    const acceptedPlayerSecret = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";
    const claimNow = new Date("2026-08-01T20:30:01.000Z");
    const rejectedPlayerDigest = playerSessionKeys.digest(rejectedPlayerSecret, claimNow);
    const rejectedPlayerReplayKey = `player-session:v${rejectedPlayerDigest.keyVersion}:${Buffer.from(rejectedPlayerDigest.digest).toString("base64url")}`;
    const rejectedPlayerTombstone = tombstoneKeys.digest("player-session", rejectedPlayerReplayKey, claimNow);
    await rawPool.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         capability_key_purpose, capability_key_version, capability_key_identity,
         created_at, expires_at)
       VALUES ('player-session', $1, $2, $3, 'player-session', $4, $5, $6, $7)`,
      [
        rejectedPlayerTombstone.keyVersion,
        keyIdentityBytes(rejectedPlayerTombstone.keyIdentity),
        rejectedPlayerTombstone.digest,
        rejectedPlayerDigest.keyVersion,
        keyIdentityBytes(rejectedPlayerDigest.keyIdentity),
        claimNow,
        new Date("2026-08-31T20:30:01.000Z"),
      ],
    );
    const playerSecrets = [rejectedPlayerSecret, acceptedPlayerSecret];
    const claimService = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 32 }, () => new Date("2026-08-01T20:30:01.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => ids.shift()!,
        issuePlayerSecret: () => playerSecrets.shift()!,
      },
    );
    const proof = {
      challenge: challenge.challenge,
      publicKey: "edpkuZpp81M8NmaFbueXY8bk7EP9V54XTnwsFFt77Z5FTPs2QzLU9r",
      signature: "edsigu1EdH9zrocmLnTumfutDWqnYfvY3H73y7qbPmQJANttSDZiqWsSaV1e26TR73LWi7Deu1c11UR3J4BBCLo1TKJgwe83ocE",
    };
    await rawPool.query(
      `CREATE TABLE samurai_persistence.hostile_guest_owned (
         id text PRIMARY KEY,
         guest_session_id text NOT NULL REFERENCES samurai_persistence.guest_sessions(id) ON DELETE CASCADE
       )`,
    );
    await rawPool.query(
      "INSERT INTO samurai_persistence.hostile_guest_owned (id, guest_session_id) VALUES ('unknown-owned-row', $1)",
      [issued.session.id],
    );
    expect(await claimService.claimGuest({
      resumeSecret: issued.resumeSecret,
      intent: claimIntent,
      challengeId: challenge.challengeId,
      proof,
    })).toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
    const guarded = await rawPool.query<{ readonly guests: string; readonly players: string; readonly challenges: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS guests,
        (SELECT count(*)::text FROM samurai_persistence.players) AS players,
        (SELECT count(*)::text FROM samurai_persistence.claim_challenges WHERE consumed_at IS NULL) AS challenges
    `);
    expect(guarded.rows[0]).toEqual({ guests: "1", players: "0", challenges: "1" });
    await rawPool.query("DROP TABLE samurai_persistence.hostile_guest_owned");
    const claimed = await claimService.claimGuest({
      resumeSecret: issued.resumeSecret,
      intent: claimIntent,
      challengeId: challenge.challengeId,
      proof,
    });
    if ("code" in claimed) throw new Error(`Claim unexpectedly failed: ${claimed.code}`);
    expect(claimed).toMatchObject({
      playerId: "523e4567-e89b-42d3-a456-426614174000",
      claimId: claimIntent.claimId,
      sessionId: "623e4567-e89b-42d3-a456-426614174000",
      sessionSecret: acceptedPlayerSecret,
      disposition: "claimed",
    });
    const matrix = await rawPool.query<{ readonly guests: string; readonly players: string; readonly wallets: string;
      readonly sessions: string; readonly merges: string; readonly commands: string; readonly events: string;
      readonly outbox: string; readonly tombstones: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.guest_sessions) AS guests,
        (SELECT count(*)::text FROM samurai_persistence.players) AS players,
        (SELECT count(*)::text FROM samurai_persistence.wallet_credentials) AS wallets,
        (SELECT count(*)::text FROM samurai_persistence.player_sessions WHERE state='pending-delivery') AS sessions,
        (SELECT count(*)::text FROM samurai_persistence.progress_merges) AS merges,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE player_id=$1 AND guest_session_id IS NULL) AS commands,
        (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE player_id=$1 AND guest_session_id IS NULL) AS events,
        (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries) AS outbox,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones
          WHERE kind IN ('guest-session','guest-claim','claim-challenge','claim-id','claim-idempotency')) AS tombstones
    `, [claimed.playerId]);
    expect(matrix.rows[0]).toEqual({
      guests: "0", players: "1", wallets: "1", sessions: "1", merges: "1",
      commands: "1", events: "1", outbox: "1", tombstones: "6",
    });
    await rawPool.query(
      `INSERT INTO samurai_persistence.domain_events
        (event_id,player_id,event_type,schema_version,payload,committed_revision,created_at)
       VALUES ('native-player-event',$1,'player.native',1,'{}',7,'2026-08-01T20:31:00Z')`,
      [claimed.playerId],
    );
    expect(await claimService.claimGuestPublic({
      resumeSecret: issued.resumeSecret,
      intent: claimIntent,
      challengeId: challenge.challengeId,
      proof,
    })).toEqual(ACCOUNT_CLAIM_REAUTH_REQUIRED);

    await rawPool.query(
      "UPDATE samurai_persistence.progress_merges SET expires_at='2026-08-01T20:31:00.000Z' WHERE claim_id=$1::uuid",
      [claimIntent.claimId],
    );
    const receiptCleanup = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 20 }, () => new Date("2026-08-01T20:31:00.000Z"))),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(receiptCleanup.deleteExpiredMergeReceipts()).resolves.toBe(1);
    await expect(receiptCleanup.deleteExpiredMergeReceipts()).resolves.toBe(0);
    const provenance = await rawPool.query<{
      readonly merges: string; readonly commands: string; readonly events: string;
      readonly command_origin: string; readonly event_origin: string;
    }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.progress_merges) AS merges,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE player_id=$1) AS commands,
        (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE player_id=$1) AS events,
        (SELECT origin_claim_id::text FROM samurai_persistence.command_receipts WHERE player_id=$1 LIMIT 1) AS command_origin,
        (SELECT origin_claim_id::text FROM samurai_persistence.domain_events
          WHERE player_id=$1 AND origin_claim_id IS NOT NULL LIMIT 1) AS event_origin
    `, [claimed.playerId]);
    expect(provenance.rows[0]).toEqual({
      merges: "0", commands: "1", events: "2",
      command_origin: claimIntent.claimId, event_origin: claimIntent.claimId,
    });
    expect(await claimService.claimGuestPublic({
      resumeSecret: issued.resumeSecret,
      intent: claimIntent,
      challengeId: challenge.challengeId,
      proof,
    })).toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);

    await expect(claimService.deletePlayer(claimed.sessionSecret)).resolves.toBeUndefined();
    expect(await claimService.claimGuestPublic({
      resumeSecret: issued.resumeSecret,
      intent: claimIntent,
      challengeId: challenge.challengeId,
      proof,
    })).toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
    const deleted = await rawPool.query<CountRow>(`
      SELECT ((SELECT count(*) FROM samurai_persistence.command_receipts)
            + (SELECT count(*) FROM samurai_persistence.domain_events)
            + (SELECT count(*) FROM samurai_persistence.progress_merges))::text AS count
    `);
    expect(deleted.rows[0]?.count).toBe("0");
  });

  it("recovers only the exact signed pending issuance, rotates once, and authenticates delivery acknowledgement", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    const publicKeyText = b58Encode(publicDer.subarray(publicDer.byteLength - 32), PrefixV2.Ed25519PublicKey);
    const account = getPkhfromPk(publicKeyText);
    const signChallenge = (challenge: unknown) => b58Encode(
      signMessage(
        null,
        blake2b(walletSigningBytes(challenge), { dkLen: 32 }),
        privateKey,
      ),
      PrefixV2.Ed25519Signature,
    );
    const claimCapability = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDQ";
    const intent = {
      claimId: "823e4567-e89b-42d3-a456-426614174000",
      guestClaimCommitment: claimCapability,
      createPlayer: true,
      guestRevision: 0,
      idempotencyKey: "923e4567-e89b-42d3-a456-426614174000",
      contentVersion: "content-v1",
      cosmeticSelections: {},
    } as const;
    const issued = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys,
      issueClaimCapability: () => claimCapability,
    }).issue({
      consentVersion: "consent-v1",
      contentVersion: intent.contentVersion,
      checkpointSchemaVersion: 1,
      checkpoint: { recovery: true },
    });
    const issueClaim = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 20 }, () => new Date("2026-07-24T21:00:00.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "a23e4567-e89b-42d3-a456-426614174000",
        issueNonce: () => "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEA",
      },
    );
    const claimChallenge = await issueClaim.issueClaimChallenge({
      resumeSecret: issued.resumeSecret,
      intent,
      account,
    });
    if ("code" in claimChallenge) throw new Error("Dynamic claim challenge failed.");
    const claimIds = [
      "b23e4567-e89b-42d3-a456-426614174000",
      "c23e4567-e89b-42d3-a456-426614174000",
      "d23e4567-e89b-42d3-a456-426614174000",
    ];
    const claimService = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 24 }, () => new Date("2026-07-24T21:00:01.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => claimIds.shift()!,
        issuePlayerSecret: () => "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFA",
      },
    );
    const claimed = await claimService.claimGuest({
      resumeSecret: issued.resumeSecret,
      intent,
      challengeId: claimChallenge.challengeId,
      proof: {
        challenge: claimChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(claimChallenge.challenge),
      },
    });
    if ("code" in claimed) throw new Error(`Dynamic claim failed: ${claimed.code}`);
    expect(claimed.deliveryGeneration).toBe(1);
    const before = await rawPool.query<{ readonly expires_at: Date }>(
      "SELECT expires_at FROM samurai_persistence.player_sessions WHERE id=$1",
      [claimed.sessionId],
    );

    const recoveryIntent = {
      recoverClaimId: intent.claimId,
      idempotencyKey: "e23e4567-e89b-42d3-a456-426614174000",
    };
    const issueRecovery = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 16 }, () => new Date("2026-08-01T21:01:00.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "f23e4567-e89b-42d3-a456-426614174000",
        issueNonce: () => "GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGA",
      },
    );
    const recoveryChallenge = await issueRecovery.issueRecoveryChallenge({ recoveryIntent, account });
    if ("code" in recoveryChallenge) throw new Error("Recovery challenge issue failed.");
    const recoveryService = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 40 }, () => new Date("2026-08-01T21:01:01.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issuePlayerSecret: () => "HHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHHA",
      },
    );
    const recoveryInput = {
      recoveryIntent,
      challengeId: recoveryChallenge.challengeId,
      proof: {
        challenge: recoveryChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(recoveryChallenge.challenge),
      },
    };
    await expect(recoveryService.acknowledgeClaimDelivery(
      claimed.playerId,
      intent.claimId,
      claimed.sessionSecret,
      claimed.deliveryGeneration,
    )).resolves.toEqual(ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE);
    const attempts = await Promise.all([
      recoveryService.recoverClaimSession(recoveryInput),
      recoveryService.recoverClaimSession(recoveryInput),
    ]);
    const recovered = attempts.find((item) => !("code" in item));
    expect(attempts.filter((item) => "code" in item)).toHaveLength(1);
    if (!recovered || "code" in recovered) throw new Error("Exactly one recovery should succeed.");
    expect(recovered).toMatchObject({
      playerId: claimed.playerId,
      claimId: intent.claimId,
      sessionId: claimed.sessionId,
      deliveryGeneration: 2,
    });
    expect(recovered.sessionSecret).not.toBe(claimed.sessionSecret);
    const after = await rawPool.query<{ readonly expires_at: Date }>(
      "SELECT expires_at FROM samurai_persistence.player_sessions WHERE id=$1",
      [claimed.sessionId],
    );
    expect(after.rows[0]?.expires_at).toEqual(before.rows[0]?.expires_at);
    await expect(recoveryService.acknowledgeClaimDelivery(
      claimed.playerId,
      intent.claimId,
      "IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIA",
      recovered.deliveryGeneration,
    )).resolves.toEqual(ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE);
    await expect(recoveryService.acknowledgeClaimDelivery(
      claimed.playerId,
      intent.claimId,
      recovered.sessionSecret,
      recovered.deliveryGeneration,
    )).resolves.toBeUndefined();
    expect(await recoveryService.recoverClaimSession(recoveryInput)).toEqual(ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE);

    const blindIssueRecovery = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => new Date("2026-08-01T21:02:00.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "123e4567-e89b-42d3-a456-426614174997",
        issueNonce: () => "JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJA",
      },
    );
    const nonexistent = await blindIssueRecovery.issueRecoveryChallenge({
      recoveryIntent: {
        recoverClaimId: "123e4567-e89b-42d3-a456-426614174999",
        idempotencyKey: "123e4567-e89b-42d3-a456-426614174998",
      },
      account,
    });
    expect(nonexistent).not.toHaveProperty("code");

    const lifecycle = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 40 }, () => new Date("2026-08-01T21:01:02.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issuePlayerSecret: () => "KKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKA",
      },
    );
    await expect(lifecycle.authenticatePlayerSession(recovered.sessionSecret)).resolves.toMatchObject({
      playerId: claimed.playerId,
      credentialKind: "current",
      rotationRequired: false,
    });
    const rotated = await lifecycle.rotatePlayerSession(recovered.sessionSecret);
    if ("code" in rotated) throw new Error("Current player session failed rotation.");
    expect(rotated).toMatchObject({ credentialKind: "current", rotationRequired: false });
    const convergedRetries = await Promise.all([
      lifecycle.rotatePlayerSession(recovered.sessionSecret),
      lifecycle.rotatePlayerSession(recovered.sessionSecret),
    ]);
    for (const retry of convergedRetries) {
      if ("code" in retry) throw new Error("Pending rotation retry did not converge.");
      expect(retry.sessionSecret).toBe(rotated.sessionSecret);
      expect(retry.deliveryGeneration).toBe(rotated.deliveryGeneration);
    }
    await expect(lifecycle.authenticatePlayerSession(recovered.sessionSecret)).resolves.toEqual(
      ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE,
    );
    await expect(lifecycle.acknowledgeClaimDeliveryExact(
      rotated.playerId, rotated.claimId, rotated.sessionId, rotated.sessionSecret, rotated.deliveryGeneration,
    )).resolves.toBeUndefined();
    await expect(lifecycle.acknowledgeClaimDeliveryExact(
      rotated.playerId, rotated.claimId, rotated.sessionId, rotated.sessionSecret, rotated.deliveryGeneration,
    )).resolves.toBeUndefined();
    await expect(lifecycle.authenticatePlayerSession(rotated.sessionSecret)).resolves.toMatchObject({
      credentialKind: "current",
    });
    await expect(lifecycle.authenticatePlayerSession(recovered.sessionSecret)).resolves.toMatchObject({
      credentialKind: "predecessor",
      rotationRequired: false,
    });
    await expect(lifecycle.rotatePlayerSession(recovered.sessionSecret)).resolves.toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);
    await expect(lifecycle.rotatePlayerSession(rotated.sessionSecret)).resolves.toEqual(
      ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED,
    );
    const predecessor = await rawPool.query<{ readonly valid_until: Date }>(
      "SELECT valid_until FROM samurai_persistence.player_session_digests WHERE player_session_id=$1 AND slot='predecessor'",
      [claimed.sessionId],
    );
    const predecessorExpiry = predecessor.rows[0]!.valid_until;
    const beforeExpiry = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => new Date(predecessorExpiry.getTime() - 1))),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    const atExpiry = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 24 }, () => predecessorExpiry)),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issuePlayerSecret: () => Buffer.alloc(32, 91).toString("base64url"),
      },
    );
    await expect(beforeExpiry.authenticatePlayerSession(recovered.sessionSecret)).resolves.toMatchObject({
      credentialKind: "predecessor",
    });
    await expect(atExpiry.authenticatePlayerSession(recovered.sessionSecret)).resolves.toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);
    await expect(beforeExpiry.rotatePlayerSession(rotated.sessionSecret)).resolves.toEqual(
      ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED,
    );
    const rotatedAtExpiry = await atExpiry.rotatePlayerSession(rotated.sessionSecret);
    if ("code" in rotatedAtExpiry) throw new Error("Current player session failed rotation at predecessor equality.");
    await expect(atExpiry.authenticatePlayerSession(rotated.sessionSecret)).resolves.toEqual(
      ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE,
    );
    await expect(atExpiry.acknowledgeClaimDeliveryExact(
      rotatedAtExpiry.playerId, rotatedAtExpiry.claimId, rotatedAtExpiry.sessionId,
      rotatedAtExpiry.sessionSecret, rotatedAtExpiry.deliveryGeneration,
    )).resolves.toBeUndefined();
    await expect(atExpiry.authenticatePlayerSession(rotated.sessionSecret)).resolves.toMatchObject({
      credentialKind: "predecessor",
    });

    const compromisedAt = new Date(predecessorExpiry.getTime() + 1);
    const compromisedSessionRing = new PlayerSessionKeyring({
      ...hmacKey("player-session", 7, 7),
      compromisedAt,
    });
    const deletionAuthority = new AccountClaimAuthority(pool, authority, guestClaimKeys, compromisedSessionRing);
    await deletionAuthority.bootstrap();
    const compromisedCleanup = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 24 }, () => compromisedAt)),
      deletionAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(compromisedCleanup.purgeUnavailablePlayerSessionDigests()).resolves.toBe(2);
    const postRetention = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 32 }, () => new Date("2026-09-01T21:01:00.000Z"))),
      deletionAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(postRetention.deleteExpiredMergeReceipts()).resolves.toBe(1);
    await expect(postRetention.deleteExpiredPlayerSessions()).resolves.toBe(0);
    const retainedPlayer = await rawPool.query<{ readonly sessions: string; readonly digests: string; readonly merges: string;
      readonly players: string; readonly wallets: string; readonly progress: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.player_sessions) AS sessions,
        (SELECT count(*)::text FROM samurai_persistence.player_session_digests) AS digests,
        (SELECT count(*)::text FROM samurai_persistence.progress_merges) AS merges,
        (SELECT count(*)::text FROM samurai_persistence.players) AS players,
        (SELECT count(*)::text FROM samurai_persistence.wallet_credentials) AS wallets,
        (SELECT count(*)::text FROM samurai_persistence.player_progress) AS progress
    `);
    expect(retainedPlayer.rows[0]).toMatchObject({
      sessions: "0", digests: "0", merges: "0", players: "1", wallets: "1", progress: "1",
    });
    const deletionIntent = {
      deleteClaimId: intent.claimId,
      idempotencyKey: "123e4567-e89b-42d3-a456-426614174995",
    };
    const crossRecoveryIssue = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 16 }, () => new Date("2026-09-01T21:01:59.000Z"))),
      deletionAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "323e4567-e89b-42d3-a456-426614174995",
        issueNonce: () => "RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRA",
      },
    );
    const crossRecoveryChallenge = await crossRecoveryIssue.issueRecoveryChallenge({
      recoveryIntent: {
        recoverClaimId: deletionIntent.deleteClaimId,
        idempotencyKey: deletionIntent.idempotencyKey,
      },
      account,
    });
    if ("code" in crossRecoveryChallenge) throw new Error("Cross-operation recovery challenge issue failed.");
    const issueDeletion = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 16 }, () => new Date("2026-09-01T21:02:00.000Z"))),
      deletionAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "123e4567-e89b-42d3-a456-426614174996",
        issueNonce: () => "QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQA",
      },
    );
    const deletionChallenge = await issueDeletion.issuePlayerDeletionChallenge({
      deletionIntent,
      account,
    });
    if ("code" in deletionChallenge) throw new Error("Player deletion challenge issue failed.");
    const deletionService = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 40 }, () => new Date("2026-09-01T21:02:01.000Z"))),
      deletionAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(deletionService.deletePlayerWithWalletProof({
      deletionIntent,
      challengeId: crossRecoveryChallenge.challengeId,
      proof: {
        challenge: crossRecoveryChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(crossRecoveryChallenge.challenge),
      },
    })).resolves.toMatchObject({ code: "PLAYER_DELETION_REJECTED" });
    await expect(deletionService.recoverClaimSession({
      recoveryIntent: {
        recoverClaimId: deletionIntent.deleteClaimId,
        idempotencyKey: deletionIntent.idempotencyKey,
      },
      challengeId: deletionChallenge.challengeId,
      proof: {
        challenge: deletionChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(deletionChallenge.challenge),
      },
    })).resolves.toEqual(ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE);
    await rawPool.query(
      "UPDATE samurai_persistence.claim_challenges SET purpose='recovery' WHERE challenge_id=$1::uuid",
      [deletionChallenge.challengeId],
    );
    await expect(deletionService.deletePlayerWithWalletProof({
      deletionIntent,
      challengeId: deletionChallenge.challengeId,
      proof: {
        challenge: deletionChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(deletionChallenge.challenge),
      },
    })).resolves.toMatchObject({ code: "PLAYER_DELETION_REJECTED" });
    await rawPool.query(
      "UPDATE samurai_persistence.claim_challenges SET purpose='delete' WHERE challenge_id=$1::uuid",
      [deletionChallenge.challengeId],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.domain_events
        (event_id,player_id,event_type,schema_version,payload,committed_revision,created_at)
       VALUES ('wallet-delete-late-lock-event',$1,'player.native',1,'{}',1,'2026-09-01T21:02:00Z')`,
      [claimed.playerId],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.outbox_deliveries (event_id,available_at)
       VALUES ('wallet-delete-late-lock-event','2026-09-01T21:02:00Z')`,
    );
    const beforeLateDeletionTombstones = (await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.deletion_tombstones",
    )).rows[0]!.count;
    const outboxAttempted = deferred<number>();
    const outboxAcquired = deferred<number>();
    const releaseOutbox = deferred<void>();
    const observedDeletionPool = new ObservedQueryLockPool(
      pool,
      (sql) => sql.includes("FROM samurai_persistence.outbox_deliveries o"),
      outboxAttempted,
      outboxAcquired,
      releaseOutbox.promise,
    );
    const expiryDeletion = new AccountClaimService(
      new ControlledClockPool(observedDeletionPool, [new Date("2026-09-01T21:07:00.000Z")]),
      deletionAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    const expiredWhileWaiting = expiryDeletion.deletePlayerWithWalletProof({
      deletionIntent,
      challengeId: deletionChallenge.challengeId,
      proof: {
        challenge: deletionChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(deletionChallenge.challenge),
      },
    });
    await outboxAttempted.promise;
    await outboxAcquired.promise;
    releaseOutbox.resolve();
    await expect(expiredWhileWaiting).resolves.toMatchObject({ code: "PLAYER_DELETION_REJECTED" });
    const rolledBackDeletion = await rawPool.query<{ readonly players: string; readonly consumed: string;
      readonly tombstones: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.players WHERE id=$1) AS players,
        (SELECT count(*)::text FROM samurai_persistence.claim_challenges
          WHERE challenge_id=$2::uuid AND consumed_at IS NOT NULL) AS consumed,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones) AS tombstones
    `, [claimed.playerId, deletionChallenge.challengeId]);
    expect(rolledBackDeletion.rows[0]).toEqual({
      players: "1", consumed: "0", tombstones: beforeLateDeletionTombstones,
    });
    await expect(deletionService.deletePlayerWithWalletProof({
      deletionIntent,
      challengeId: deletionChallenge.challengeId,
      proof: {
        challenge: deletionChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(deletionChallenge.challenge),
      },
    })).resolves.toEqual({ disposition: "deleted" });
    await expect(deletionService.deletePlayerWithWalletProof({
      deletionIntent,
      challengeId: deletionChallenge.challengeId,
      proof: {
        challenge: deletionChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(deletionChallenge.challenge),
      },
    })).resolves.toEqual({ disposition: "already-deleted" });
    await expect(deletionService.deletePlayerWithWalletProof({
      deletionIntent: { ...deletionIntent, idempotencyKey: "423e4567-e89b-42d3-a456-426614174997" },
      challengeId: deletionChallenge.challengeId,
      proof: {
        challenge: deletionChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(deletionChallenge.challenge),
      },
    })).resolves.toMatchObject({ code: "PLAYER_DELETION_REJECTED" });
    await expect(lifecycle.authenticatePlayerSession(rotated.sessionSecret)).resolves.toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);
    const cleanup = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => new Date("2026-09-01T21:07:00.000Z"))),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(cleanup.deleteExpiredChallenges()).resolves.toBe(1);
    const deleted = await rawPool.query<{ readonly players: string; readonly wallets: string; readonly sessions: string;
      readonly merges: string; readonly challenges: string; readonly commands: string; readonly events: string;
      readonly outbox: string; readonly tombstones: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.players) AS players,
        (SELECT count(*)::text FROM samurai_persistence.wallet_credentials) AS wallets,
        (SELECT count(*)::text FROM samurai_persistence.player_sessions) AS sessions,
        (SELECT count(*)::text FROM samurai_persistence.progress_merges) AS merges,
        (SELECT count(*)::text FROM samurai_persistence.claim_challenges) AS challenges,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts) AS commands,
        (SELECT count(*)::text FROM samurai_persistence.domain_events) AS events,
        (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries) AS outbox,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones
          WHERE kind IN ('player-session','wallet-credential','claim-challenge','claim-id','claim-idempotency')) AS tombstones
    `);
    expect(deleted.rows[0]).toMatchObject({
      players: "0", wallets: "0", sessions: "0", merges: "0", challenges: "0",
      commands: "0", events: "0", outbox: "0",
    });
    expect(Number(deleted.rows[0]!.tombstones)).toBeGreaterThanOrEqual(5);

    const replacementCapability = "NNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNNA";
    const replacementGuest = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys,
      issueClaimCapability: () => replacementCapability,
    }).issue({
      consentVersion: "consent-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { relink: true },
    });
    const relinkIntent = {
      claimId: "223e4567-e89b-42d3-a456-426614174991",
      guestClaimCommitment: replacementCapability,
      createPlayer: true,
      guestRevision: 0,
      idempotencyKey: "223e4567-e89b-42d3-a456-426614174992",
      contentVersion: "content-v1",
      cosmeticSelections: {},
    } as const;
    const relinkIssue = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 12 }, () => new Date("2026-08-01T23:00:00.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "223e4567-e89b-42d3-a456-426614174993",
        issueNonce: () => "OOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOOA",
      },
    );
    const relinkChallenge = await relinkIssue.issueClaimChallenge({
      resumeSecret: replacementGuest.resumeSecret,
      intent: relinkIntent,
      account,
    });
    if ("code" in relinkChallenge) throw new Error("Wallet relink challenge issue failed.");
    const relink = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 20 }, () => new Date("2026-08-01T23:00:01.000Z"))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "223e4567-e89b-42d3-a456-426614174994",
      },
    );
    await expect(relink.claimGuest({
      resumeSecret: replacementGuest.resumeSecret,
      intent: relinkIntent,
      challengeId: relinkChallenge.challengeId,
      proof: {
        challenge: relinkChallenge.challenge,
        publicKey: publicKeyText,
        signature: signChallenge(relinkChallenge.challenge),
      },
    })).resolves.toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
  });

  it("logs out an exact pending session idempotently while preserving the player and a sibling session", async () => {
    const fixture = await stage3Fixture();
    const service = stage3Service();
    const claimed = await service.claimGuest(fixture.claimInput);
    if ("code" in claimed) throw new Error("Logout fixture claim failed.");
    const clock = await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
    const dbNow = clock.rows[0]!.now;
    const siblingSecret = Buffer.alloc(32, 103).toString("base64url");
    const siblingDigest = playerSessionKeys.digest(siblingSecret, dbNow);
    const siblingSessionId = randomUUID();
    const siblingClaimId = randomUUID();
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
       VALUES ($1,$2,'claim',$3,'active',1,$4,$4,$5,$6)`,
      [siblingSessionId, claimed.playerId, siblingClaimId, dbNow,
        new Date(dbNow.getTime() + 30 * 24 * 60 * 60 * 1_000),
        new Date(dbNow.getTime() + 7 * 24 * 60 * 60 * 1_000)],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_session_digests
        (player_session_id,slot,digest_key_version,digest_key_identity,digest,valid_until)
       VALUES ($1,'current',$2,$3,$4,NULL)`,
      [siblingSessionId, siblingDigest.keyVersion, keyIdentityBytes(siblingDigest.keyIdentity), siblingDigest.digest],
    );

    const beforeFaultTombstones = (await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.deletion_tombstones",
    )).rows[0]!.count;
    const faultedLogout = stage3Service(new FailOnQueryPool(
      pool, "SET state = 'revoked', revoked_at = $2", true,
    ));
    await expect(faultedLogout.logoutPlayerSession(claimed.sessionSecret)).resolves.toEqual(
      ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE,
    );
    const afterFault = await rawPool.query<{ readonly state: string; readonly digests: string; readonly tombstones: string }>(`
      SELECT
        (SELECT state FROM samurai_persistence.player_sessions WHERE id=$1) AS state,
        (SELECT count(*)::text FROM samurai_persistence.player_session_digests WHERE player_session_id=$1) AS digests,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones) AS tombstones
    `, [claimed.sessionId]);
    expect(afterFault.rows[0]).toEqual({ state: "pending-delivery", digests: "1", tombstones: beforeFaultTombstones });

    await expect(service.logoutPlayerSession(claimed.sessionSecret)).resolves.toEqual({ disposition: "logged-out" });
    await expect(service.logoutPlayerSession(claimed.sessionSecret)).resolves.toEqual({ disposition: "already-logged-out" });
    await expect(service.authenticatePlayerSession(claimed.sessionSecret)).resolves.toEqual(
      ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE,
    );
    await expect(service.authenticatePlayerSession(siblingSecret)).resolves.toMatchObject({
      playerId: claimed.playerId,
      sessionId: siblingSessionId,
    });
    const state = await rawPool.query<{ readonly players: string; readonly wallets: string; readonly progress: string;
      readonly revoked: string; readonly sibling: string; readonly logged_out_digests: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.players WHERE id=$1) AS players,
        (SELECT count(*)::text FROM samurai_persistence.wallet_credentials WHERE player_id=$1) AS wallets,
        (SELECT count(*)::text FROM samurai_persistence.player_progress WHERE player_id=$1) AS progress,
        (SELECT count(*)::text FROM samurai_persistence.player_sessions WHERE id=$2 AND state='revoked' AND revoked_at IS NOT NULL) AS revoked,
        (SELECT count(*)::text FROM samurai_persistence.player_sessions WHERE id=$3 AND state='active') AS sibling,
        (SELECT count(*)::text FROM samurai_persistence.player_session_digests WHERE player_session_id=$2) AS logged_out_digests
    `, [claimed.playerId, claimed.sessionId, siblingSessionId]);
    expect(state.rows[0]).toEqual({
      players: "1", wallets: "1", progress: "1", revoked: "1", sibling: "1", logged_out_digests: "0",
    });
  });

  it("serializes logout with rotation in both player-parent winner orders and converges observed predecessor retries", async () => {
    for (const winner of ["logout", "rotate"] as const) {
      await resetStage3Rows();
      const fixture = await stage3Fixture();
      const claimed = await stage3Service().claimGuest(fixture.claimInput);
      if ("code" in claimed) throw new Error("Logout/rotation fixture claim failed.");
      await expect(stage3Service().acknowledgeClaimDelivery(
        claimed.playerId, claimed.claimId, claimed.sessionSecret, claimed.deliveryGeneration,
      )).resolves.toBeUndefined();
      const blocker = await rawPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM samurai_persistence.players WHERE id=$1 FOR UPDATE", [claimed.playerId]);
      const firstAttempted = deferred<number>();
      const firstAcquired = deferred<number>();
      const secondAttempted = deferred<number>();
      const secondAcquired = deferred<number>();
      const releaseFirst = deferred<void>();
      const matchesParent = (sql: string) => sql.includes(
        "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
      );
      const firstService = stage3Service(new ObservedQueryLockPool(
        pool, matchesParent, firstAttempted, firstAcquired, releaseFirst.promise,
      ));
      const secondService = stage3Service(new ObservedQueryLockPool(
        pool, matchesParent, secondAttempted, secondAcquired,
      ));
      const launch = (service: AccountClaimService, operation: "logout" | "rotate") => operation === "logout"
        ? service.logoutPlayerSession(claimed.sessionSecret)
        : service.rotatePlayerSession(claimed.sessionSecret);
      const first = launch(firstService, winner);
      await firstAttempted.promise;
      await blocker.query("COMMIT");
      blocker.release();
      await firstAcquired.promise;
      const secondOperation = winner === "logout" ? "rotate" : "logout";
      const second = launch(secondService, secondOperation);
      await expectLockWait(rawPool, await secondAttempted.promise);
      releaseFirst.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      await secondAcquired.promise;
      if (winner === "logout") {
        expect(firstResult).toEqual({ disposition: "logged-out" });
        expect(secondResult).toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);
      } else {
        expect(firstResult).toMatchObject({ credentialKind: "current", deliveryGeneration: 2 });
        expect(secondResult).toEqual({ disposition: "logged-out" });
      }
      await expect(stage3Service().logoutPlayerSession(claimed.sessionSecret)).resolves.toEqual(
        { disposition: "already-logged-out" },
      );
      const state = await rawPool.query<{ readonly player: string; readonly state: string; readonly digests: string;
        readonly tombstones: string }>(`
        SELECT
          (SELECT count(*)::text FROM samurai_persistence.players WHERE id=$1) AS player,
          (SELECT state FROM samurai_persistence.player_sessions WHERE id=$2) AS state,
          (SELECT count(*)::text FROM samurai_persistence.player_session_digests WHERE player_session_id=$2) AS digests,
          (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind='player-session') AS tombstones
      `, [claimed.playerId, claimed.sessionId]);
      expect(state.rows[0]).toEqual({
        player: "1", state: "revoked", digests: "0", tombstones: winner === "logout" ? "2" : "4",
      });
    }

    await resetStage3Rows();
    const fixture = await stage3Fixture();
    const claimed = await stage3Service().claimGuest(fixture.claimInput);
    if ("code" in claimed) throw new Error("Observed retry fixture claim failed.");
    await stage3Service().acknowledgeClaimDelivery(
      claimed.playerId, claimed.claimId, claimed.sessionSecret, claimed.deliveryGeneration,
    );
    const rotated = await stage3Service().rotatePlayerSession(claimed.sessionSecret);
    if ("code" in rotated) throw new Error("Initial observed rotation failed.");
    const blocker = await rawPool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM samurai_persistence.players WHERE id=$1 FOR UPDATE", [claimed.playerId]);
    const firstAttempted = deferred<number>(); const firstAcquired = deferred<number>();
    const secondAttempted = deferred<number>(); const secondAcquired = deferred<number>();
    const matchesParent = (sql: string) => sql.includes("SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE");
    const first = stage3Service(new ObservedQueryLockPool(pool, matchesParent, firstAttempted, firstAcquired))
      .rotatePlayerSession(claimed.sessionSecret);
    await firstAttempted.promise;
    const second = stage3Service(new ObservedQueryLockPool(pool, matchesParent, secondAttempted, secondAcquired))
      .rotatePlayerSession(claimed.sessionSecret);
    await secondAttempted.promise;
    await blocker.query("COMMIT"); blocker.release();
    await firstAcquired.promise;
    const retries = await Promise.all([first, second]);
    await secondAcquired.promise;
    expect(retries).toEqual([rotated, rotated]);
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.player_session_digests WHERE player_session_id=$1",
      [claimed.sessionId],
    )).rows[0]?.count).toBe("2");
  });

  it("serializes logout with wallet deletion in both player-parent winner orders", async () => {
    for (const winner of ["logout", "deletion"] as const) {
      await resetStage3Rows();
      const fixture = await stage3Fixture();
      const claimed = await stage3Service().claimGuest(fixture.claimInput);
      if ("code" in claimed) throw new Error("Logout/deletion fixture claim failed.");
      const deletionIntent = { deleteClaimId: claimed.claimId, idempotencyKey: randomUUID() };
      const issued = await stage3Service().issuePlayerDeletionChallenge({ deletionIntent, account: fixture.wallet.account });
      if ("code" in issued) throw new Error("Logout/deletion challenge failed.");
      const deletionInput = {
        deletionIntent,
        challengeId: issued.challengeId,
        proof: {
          challenge: issued.challenge,
          publicKey: fixture.wallet.publicKey,
          signature: b58Encode(
            signMessage(null, blake2b(walletSigningBytes(issued.challenge), { dkLen: 32 }), fixture.wallet.privateKey),
            PrefixV2.Ed25519Signature,
          ),
        },
      };
      const releaseFirst = deferred<void>();
      const firstAttempted = deferred<number>(); const firstAcquired = deferred<number>();
      const secondAttempted = deferred<number>(); const secondAcquired = deferred<number>();
      const matchesParent = (sql: string) => sql.includes("SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE");
      const firstService = stage3Service(new ObservedQueryLockPool(
        pool, matchesParent, firstAttempted, firstAcquired, releaseFirst.promise,
      ));
      const secondService = stage3Service(new ObservedQueryLockPool(pool, matchesParent, secondAttempted, secondAcquired));
      const launch = (service: AccountClaimService, operation: "logout" | "deletion") => operation === "logout"
        ? service.logoutPlayerSession(claimed.sessionSecret)
        : service.deletePlayerWithWalletProof(deletionInput);
      const first = launch(firstService, winner);
      await firstAcquired.promise;
      const second = launch(secondService, winner === "logout" ? "deletion" : "logout");
      await expectLockWait(rawPool, await secondAttempted.promise);
      releaseFirst.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      await secondAcquired.promise;
      if (winner === "logout") {
        expect(firstResult).toEqual({ disposition: "logged-out" });
        expect(secondResult).toEqual({ disposition: "deleted" });
        await expect(stage3Service().logoutPlayerSession(claimed.sessionSecret)).resolves.toEqual(
          { disposition: "already-logged-out" },
        );
      } else {
        expect(firstResult).toEqual({ disposition: "deleted" });
        expect(secondResult).toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);
      }
      expect((await rawPool.query<CountRow>(
        "SELECT count(*)::text AS count FROM samurai_persistence.players WHERE id=$1", [claimed.playerId],
      )).rows[0]?.count).toBe("0");
      await expect(stage3Service().deletePlayerWithWalletProof(deletionInput)).resolves.toEqual(
        { disposition: "already-deleted" },
      );
    }
  });

  it("serializes logout with expired-session cleanup in both player-parent winner orders", async () => {
    for (const winner of ["logout", "cleanup"] as const) {
      await resetStage3Rows();
      const fixture = await stage3Fixture();
      const claimed = await stage3Service().claimGuest(fixture.claimInput);
      if ("code" in claimed) throw new Error("Logout/cleanup fixture claim failed.");
      const session = await rawPool.query<{ readonly created_at: Date }>(
        "SELECT created_at FROM samurai_persistence.player_sessions WHERE id=$1", [claimed.sessionId],
      );
      const expiresAt = new Date(session.rows[0]!.created_at.getTime() + 60 * 60 * 1_000);
      await rawPool.query(
        "UPDATE samurai_persistence.player_sessions SET expires_at=$2,rotate_after=$2 WHERE id=$1",
        [claimed.sessionId, expiresAt],
      );
      const releaseFirst = deferred<void>();
      const firstAttempted = deferred<number>(); const firstAcquired = deferred<number>();
      const secondAttempted = deferred<number>(); const secondAcquired = deferred<number>();
      const matchesParent = (sql: string) => sql.includes("SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE");
      const logoutPool = new ControlledClockPool(
        new ObservedQueryLockPool(pool, matchesParent,
          winner === "logout" ? firstAttempted : secondAttempted,
          winner === "logout" ? firstAcquired : secondAcquired,
          winner === "logout" ? releaseFirst.promise : undefined),
        Array.from({ length: 20 }, () => new Date(expiresAt.getTime() - 1)),
      );
      const cleanupPool = new ControlledClockPool(
        new ObservedQueryLockPool(pool, matchesParent,
          winner === "cleanup" ? firstAttempted : secondAttempted,
          winner === "cleanup" ? firstAcquired : secondAcquired,
          winner === "cleanup" ? releaseFirst.promise : undefined),
        Array.from({ length: 20 }, () => expiresAt),
      );
      const logout = () => stage3Service(logoutPool).logoutPlayerSession(claimed.sessionSecret);
      const cleanup = () => stage3Service(cleanupPool).deleteExpiredPlayerSessions();
      const first = winner === "logout" ? logout() : cleanup();
      await firstAcquired.promise;
      const second = winner === "logout" ? cleanup() : logout();
      await expectLockWait(rawPool, await secondAttempted.promise);
      releaseFirst.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      await secondAcquired.promise;
      if (winner === "logout") {
        expect(firstResult).toEqual({ disposition: "logged-out" });
        expect(secondResult).toBe(0);
      } else {
        expect(firstResult).toBe(1);
        expect(secondResult).toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);
      }
      const state = await rawPool.query<{ readonly player: string; readonly state: string; readonly digests: string;
        readonly tombstones: string }>(`
        SELECT
          (SELECT count(*)::text FROM samurai_persistence.players WHERE id=$1) AS player,
          (SELECT state FROM samurai_persistence.player_sessions WHERE id=$2) AS state,
          (SELECT count(*)::text FROM samurai_persistence.player_session_digests WHERE player_session_id=$2) AS digests,
          (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind='player-session') AS tombstones
      `, [claimed.playerId, claimed.sessionId]);
      expect(state.rows[0]).toEqual({
        player: "1", state: "revoked", digests: "0", tombstones: winner === "logout" ? "2" : "1",
      });
    }
  });

  it("retries a live challenge nonce collision and rejects nonce resurrection after tombstoned cleanup", async () => {
    const firstNonce = Buffer.alloc(32, 70).toString("base64url");
    const freshNonce = Buffer.alloc(32, 71).toString("base64url");
    const account = "tz1MsZxMSJdiUV9hVs4UKAMrXtksDvxWAZe2";
    const firstIntent = {
      recoverClaimId: "923e4567-e89b-42d3-a456-426614174400",
      idempotencyKey: "923e4567-e89b-42d3-a456-426614174401",
    };
    const issuedAt = new Date("2026-08-01T22:30:00.000Z");
    const first = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => issuedAt)),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "923e4567-e89b-42d3-a456-426614174402",
        issueNonce: () => firstNonce,
      },
    );
    const firstChallenge = await first.issueRecoveryChallenge({ recoveryIntent: firstIntent, account });
    if ("code" in firstChallenge) throw new Error("First nonce fixture challenge failed.");

    const nonces = [firstNonce, freshNonce];
    const ids = [
      "923e4567-e89b-42d3-a456-426614174403",
      "923e4567-e89b-42d3-a456-426614174404",
    ];
    const retrying = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 12 }, () => issuedAt)),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => ids.shift()!,
        issueNonce: () => nonces.shift()!,
      },
    );
    const retriedChallenge = await retrying.issueRecoveryChallenge({
      recoveryIntent: { ...firstIntent, idempotencyKey: "923e4567-e89b-42d3-a456-426614174405" },
      account,
    });
    if ("code" in retriedChallenge) throw new Error("Fresh nonce retry did not succeed.");
    expect(retriedChallenge.challenge.nonce).toBe(freshNonce);
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.claim_challenges",
    )).rows[0]?.count).toBe("2");

    const expiresAt = new Date(issuedAt.getTime() + 5 * 60 * 1_000);
    const cleanup = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 16 }, () => new Date(expiresAt.getTime() + 1))),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(cleanup.deleteExpiredChallenges()).resolves.toBe(2);
    const resurrecting = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => new Date(expiresAt.getTime() + 1))),
      claimAuthority,
      {
        origin: "https://game.samurai-sushi.example",
        chainId: "NetXdQprcVkpaWU",
        issueUuid: () => "923e4567-e89b-42d3-a456-426614174406",
        issueNonce: () => firstNonce,
      },
    );
    await expect(resurrecting.issueRecoveryChallenge({
      recoveryIntent: {
        recoverClaimId: "923e4567-e89b-42d3-a456-426614174407",
        idempotencyKey: "923e4567-e89b-42d3-a456-426614174408",
      },
      account,
    })).resolves.toEqual(ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE);
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.claim_challenges",
    )).rows[0]?.count).toBe("0");
  });

  it("increments the maximum safe existing-player revision exactly and rejects the unincrementable boundary atomically", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicDer = publicKey.export({ format: "der", type: "spki" });
    const publicKeyText = b58Encode(publicDer.subarray(publicDer.byteLength - 32), PrefixV2.Ed25519PublicKey);
    const account = getPkhfromPk(publicKeyText);
    const signChallenge = (challenge: unknown) => b58Encode(
      signMessage(null, blake2b(walletSigningBytes(challenge), { dkLen: 32 }), privateKey),
      PrefixV2.Ed25519Signature,
    );
    const targetPlayerId = "max-safe-existing-player";
    const beforeRevision = Number.MAX_SAFE_INTEGER - 1;
    await rawPool.query(
      "INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ($1,'2026-08-01','2026-08-01')",
      [targetPlayerId],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.wallet_credentials
        (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
       VALUES ('723e4567-e89b-42d3-a456-426614174300',$1,'NetXdQprcVkpaWU',$2,$3,'tz1',
               '723e4567-e89b-42d3-a456-426614174301','2026-08-01')`,
      [targetPlayerId, account, publicKeyText],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_progress
        (player_id,revision,content_version,checkpoint_schema_version,checkpoint,created_at,updated_at)
       VALUES ($1,$2,'content-v1',1,'{"target":true}','2026-08-01','2026-08-01')`,
      [targetPlayerId, beforeRevision],
    );

    const claimExisting = async (
      marker: number,
      claimId: string,
      idempotencyKey: string,
      playerRevision: number,
    ) => {
      const claimCapability = Buffer.alloc(32, marker).toString("base64url");
      const guest = await new GuestSessionService(pool, authority, {
        claimKeys: guestClaimKeys,
        issueClaimCapability: () => claimCapability,
      }).issue({
        consentVersion: "consent-v1",
        contentVersion: "content-v1",
        checkpointSchemaVersion: 1,
        checkpoint: { guest: marker },
      });
      const intent = {
        claimId,
        guestClaimCommitment: claimCapability,
        targetPlayerId,
        createPlayer: false,
        guestRevision: 0,
        playerRevision,
        idempotencyKey,
        contentVersion: "content-v1",
        cosmeticSelections: {},
      } as const;
      const issue = new AccountClaimService(
        new ControlledClockPool(pool, Array.from({ length: 20 }, () => new Date("2026-08-01T22:00:00.000Z"))),
        claimAuthority,
        {
          origin: "https://game.samurai-sushi.example",
          chainId: "NetXdQprcVkpaWU",
          issueUuid: () => `723e4567-e89b-42d3-a456-4266141743${marker.toString().padStart(2, "0")}`,
          issueNonce: () => Buffer.alloc(32, marker + 30).toString("base64url"),
        },
      );
      const challenge = await issue.issueClaimChallenge({ resumeSecret: guest.resumeSecret, intent, account });
      if ("code" in challenge) throw new Error("Existing-player challenge issue failed.");
      const claim = new AccountClaimService(
        new ControlledClockPool(pool, Array.from({ length: 24 }, () => new Date("2026-08-01T22:00:01.000Z"))),
        claimAuthority,
        {
          origin: "https://game.samurai-sushi.example",
          chainId: "NetXdQprcVkpaWU",
          issueUuid: () => `823e4567-e89b-42d3-a456-4266141743${marker.toString().padStart(2, "0")}`,
          issuePlayerSecret: () => Buffer.alloc(32, marker + 60).toString("base64url"),
        },
      );
      return {
        result: await claim.claimGuest({
          resumeSecret: guest.resumeSecret,
          intent,
          challengeId: challenge.challengeId,
          proof: { challenge: challenge.challenge, publicKey: publicKeyText, signature: signChallenge(challenge.challenge) },
        }),
        guestId: guest.session.id,
        challengeId: challenge.challengeId,
      };
    };

    const accepted = await claimExisting(
      21,
      "723e4567-e89b-42d3-a456-426614174310",
      "723e4567-e89b-42d3-a456-426614174311",
      beforeRevision,
    );
    expect(accepted.result).toMatchObject({ playerId: targetPlayerId, playerRevision: Number.MAX_SAFE_INTEGER });
    const rejected = await claimExisting(
      22,
      "723e4567-e89b-42d3-a456-426614174312",
      "723e4567-e89b-42d3-a456-426614174313",
      Number.MAX_SAFE_INTEGER,
    );
    expect(rejected.result).toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
    const state = await rawPool.query<{ readonly revision: string; readonly guest: string;
      readonly consumed: Date | null; readonly merges: string }>(`
      SELECT
        (SELECT revision::text FROM samurai_persistence.player_progress WHERE player_id=$1) AS revision,
        (SELECT count(*)::text FROM samurai_persistence.guest_sessions WHERE id=$2) AS guest,
        (SELECT consumed_at FROM samurai_persistence.claim_challenges WHERE challenge_id=$3::uuid) AS consumed,
        (SELECT count(*)::text FROM samurai_persistence.progress_merges WHERE player_id=$1) AS merges
    `, [targetPlayerId, rejected.guestId, rejected.challengeId]);
    expect(state.rows[0]).toEqual({
      revision: Number.MAX_SAFE_INTEGER.toString(), guest: "1", consumed: null, merges: "1",
    });
  });

  it("rolls back challenge consumption and every guest ownership rewrite, revocation, and deletion boundary", async () => {
    const boundaries = [
      "UPDATE samurai_persistence.claim_challenges",
      "UPDATE samurai_persistence.command_receipts",
      "UPDATE samurai_persistence.domain_events",
      "DELETE FROM samurai_persistence.claim_challenges WHERE guest_session_id",
      "DELETE FROM samurai_persistence.save_exports WHERE guest_session_id",
      "DELETE FROM samurai_persistence.recovery_imports WHERE guest_session_id",
      "DELETE FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id",
      "DELETE FROM samurai_persistence.guest_sessions WHERE id",
    ];
    for (const boundary of boundaries) {
      await resetStage3Rows();
      const fixture = await stage3Fixture();
      const before = await stage3Matrix();
      const result = await stage3Service(new FailAfterStatementPool(pool, boundary)).claimGuest(fixture.claimInput);
      expect(result).toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
      expect(await stage3Matrix()).toEqual(before);
    }
  });

  it("rejects at exact challenge expiry after waiting on the final player-session replay fence", async () => {
    const fixture = await stage3Fixture();
    const before = await stage3Matrix();
    const expiry = new Date(fixture.challenge.challenge.expiresAt);
    const justBefore = new Date(expiry.getTime() - 1);
    const forcedSecret = randomBytes(32).toString("base64url");
    const forcedDigest = playerSessionKeys.digest(forcedSecret, justBefore);
    const scope = `player-session-replay:player-session:v${forcedDigest.keyVersion}:${Buffer.from(forcedDigest.digest).toString("base64url")}`;
    const blocker = await rawPool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [scope]);
    const attempted = deferred<number>();
    const acquired = deferred<number>();
    const observedPool = new ObservedScopeClockPool(
      pool,
      scope,
      attempted,
      acquired,
      [justBefore, justBefore, justBefore, justBefore, expiry, expiry],
    );
    const claim = stage3Service(observedPool, { issuePlayerSecret: () => forcedSecret }).claimGuest(fixture.claimInput);
    const pid = await attempted.promise;
    await expectAdvisoryWait(rawPool, pid);
    await blocker.query("COMMIT");
    blocker.release();
    await acquired.promise;
    await expect(claim).resolves.toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
    expect(await stage3Matrix()).toEqual(before);
  });

  it("serializes concurrent create-player claims for one wallet in both observed winner orders", async () => {
    for (const reverse of [false, true]) {
      await resetStage3Rows();
      const wallet = stage3Wallet();
      const fixtures = [await stage3Fixture(wallet), await stage3Fixture(wallet)];
      if (reverse) fixtures.reverse();
      const scope = `wallet:NetXdQprcVkpaWU:${wallet.account}`;
      const blocker = await rawPool.connect();
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [scope]);
      const firstAttempted = deferred<number>();
      const firstAcquired = deferred<number>();
      const secondAttempted = deferred<number>();
      const secondAcquired = deferred<number>();
      const firstClaim = stage3Service(new ObservedScopeClockPool(
        pool, scope, firstAttempted, firstAcquired,
      )).claimGuest(fixtures[0]!.claimInput);
      await expectAdvisoryWait(rawPool, await firstAttempted.promise);
      const secondClaim = stage3Service(new ObservedScopeClockPool(
        pool, scope, secondAttempted, secondAcquired,
      )).claimGuest(fixtures[1]!.claimInput);
      await expectAdvisoryWait(rawPool, await secondAttempted.promise);
      await blocker.query("COMMIT");
      blocker.release();
      const first = await firstClaim;
      const second = await secondClaim;
      expect(first).toMatchObject({ disposition: "claimed", claimId: fixtures[0]!.intent.claimId });
      expect(second).toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
      const matrix = await stage3Matrix();
      expect(matrix).toEqual({
        guests: 1,
        guest_progress: 1,
        claim_capabilities: 1,
        guest_digests: 1,
        players: 1,
        player_progress: 1,
        wallets: 1,
        player_sessions: 1,
        player_digests: 1,
        commands: 2,
        events: 2,
        outbox: 2,
        exports: 1,
        imports: 1,
        challenges: 2,
        virgin_challenges: 1,
        merges: 1,
        tombstones: {
          "claim-challenge": 2,
          "claim-id": 1,
          "claim-idempotency": 1,
          "guest-claim": 1,
          "guest-session": 3,
          "save-export": 3,
          "save-import": 2,
        },
      });
    }
  });

  it("serializes claim against import and explicit deletion in both guest-parent winner orders", async () => {
    for (const operation of ["import", "delete"] as const) {
      for (const claimFirst of [true, false]) {
        await resetStage3Rows();
        const fixture = await stage3Fixture();
        let deletionSecret = fixture.resumeSecret;
        if (operation === "delete") {
          await rawPool.query(
            "UPDATE samurai_persistence.guest_sessions SET rotate_after=clock_timestamp()-interval '1 millisecond' WHERE id=$1",
            [fixture.guest.session.id],
          );
          deletionSecret = (await sessionService.rotate(fixture.resumeSecret)).rotatedResumeSecret;
        }
        const claimAttempted = deferred<number>();
        const claimAcquired = deferred<number>();
        const otherAttempted = deferred<number>();
        const otherAcquired = deferred<number>();
        const releaseWinner = deferred<void>();
        const claimMatcher = (text: string) => text.includes("FOR UPDATE OF s");
        const otherMatcher = operation === "import"
          ? (text: string) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE")
          : claimMatcher;
        const runClaim = (observedPool: SqlPool) => stage3Service(observedPool).claimGuest(fixture.claimInput);
        const runOther = (observedPool: SqlPool) => operation === "import"
          ? new PortableRecoveryService(
              observedPool,
              authority,
              recoveryAuthority,
              { async describe() { return recoveryContent; } },
            ).import({ importId: randomUUID(), envelope: fixture.liveExport })
          : new GuestSessionService(
              observedPool,
              authority,
            ).delete(deletionSecret);
        const first = claimFirst
          ? runClaim(new ObservedQueryLockPool(pool, claimMatcher, claimAttempted, claimAcquired, releaseWinner.promise))
          : runOther(new ObservedQueryLockPool(pool, otherMatcher, otherAttempted, otherAcquired, releaseWinner.promise));
        await (claimFirst ? claimAcquired.promise : otherAcquired.promise);
        const second = claimFirst
          ? runOther(new ObservedQueryLockPool(pool, otherMatcher, otherAttempted, otherAcquired))
          : runClaim(new ObservedQueryLockPool(pool, claimMatcher, claimAttempted, claimAcquired));
        await expectLockWait(rawPool, await (claimFirst ? otherAttempted.promise : claimAttempted.promise));
        releaseWinner.resolve();
        const [firstResult, secondResult] = await Promise.allSettled([first, second]);
        const claimResult = claimFirst ? firstResult : secondResult;
        const otherResult = claimFirst ? secondResult : firstResult;
        if (claimFirst) {
          expect(claimResult).toMatchObject({ status: "fulfilled", value: { disposition: "claimed" } });
          expect(otherResult.status).toBe("rejected");
          expect(await stage3Matrix()).toEqual({
            guests: 0, guest_progress: 0, claim_capabilities: 0, guest_digests: 0,
            players: 1, player_progress: 1, wallets: 1, player_sessions: 1, player_digests: 1,
            commands: 1, events: 1, outbox: 1, exports: 0, imports: 0,
            challenges: 1, virgin_challenges: 0, merges: 1,
            tombstones: {
              "claim-challenge": 2,
              "claim-id": 1,
              "claim-idempotency": 1,
              "guest-claim": 1,
              "guest-session": operation === "delete" ? 3 : 2,
              "save-export": 2,
              "save-import": 1,
            },
          });
        } else if (operation === "import") {
          expect(otherResult).toMatchObject({ status: "fulfilled", value: { disposition: "committed" } });
          expect(claimResult).toMatchObject({ status: "fulfilled", value: ACCOUNT_CLAIM_PUBLIC_FAILURE });
          expect(await stage3Matrix()).toEqual({
            guests: 1, guest_progress: 1, claim_capabilities: 1, guest_digests: 1,
            players: 0, player_progress: 0, wallets: 0, player_sessions: 0, player_digests: 0,
            commands: 1, events: 1, outbox: 1, exports: 0, imports: 2,
            challenges: 1, virgin_challenges: 1, merges: 0,
            tombstones: {
              "guest-session": 2,
              "save-export": 2,
              "save-import": 2,
            },
          });
        } else {
          expect(otherResult).toMatchObject({ status: "fulfilled", value: undefined });
          expect(claimResult).toMatchObject({ status: "fulfilled", value: ACCOUNT_CLAIM_PUBLIC_FAILURE });
          expect(await stage3Matrix()).toEqual({
            guests: 0, guest_progress: 0, claim_capabilities: 0, guest_digests: 0,
            players: 0, player_progress: 0, wallets: 0, player_sessions: 0, player_digests: 0,
            commands: 0, events: 0, outbox: 0, exports: 0, imports: 0,
            challenges: 0, virgin_challenges: 0, merges: 0,
            tombstones: {
              "claim-challenge": 2,
              command: 1,
              "guest-claim": 1,
              "guest-session": 4,
              "save-export": 2,
              "save-import": 1,
            },
          });
        }
      }
    }
  }, 20_000);

  it("serializes claim against expiry deletion in both guest-parent winner orders", async () => {
    for (const claimWinsParent of [true, false]) {
      await resetStage3Rows();
      const fixture = await stage3Fixture();
      await rawPool.query(
        `UPDATE samurai_persistence.guest_sessions
            SET created_at=clock_timestamp()-interval '31 days',
                last_seen_at=clock_timestamp()-interval '31 days',
                rotate_after=clock_timestamp()-interval '30 days',
                expires_at=clock_timestamp()-interval '1 millisecond'
          WHERE id=$1`,
        [fixture.guest.session.id],
      );
      if (claimWinsParent) {
        const attempted = deferred<number>();
        const acquired = deferred<number>();
        const release = deferred<void>();
        const claim = stage3Service(new ObservedQueryLockPool(
          pool,
          (text) => text.includes("FOR UPDATE OF s"),
          attempted,
          acquired,
          release.promise,
        )).claimGuest(fixture.claimInput);
        await acquired.promise;
        await expect(new GuestSessionService(pool, authority).deleteExpired()).resolves.toBe(0);
        release.resolve();
        await expect(claim).resolves.toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
        await expect(new GuestSessionService(pool, authority).deleteExpired()).resolves.toBe(1);
      } else {
        const attempted = deferred<number>();
        const acquired = deferred<number>();
        const release = deferred<void>();
        const cleanup = new GuestSessionService(new ObservedQueryLockPool(
          pool,
          (text) => text.includes("FROM samurai_persistence.guest_resume_digests WHERE guest_session_id"),
          attempted,
          acquired,
          release.promise,
        ), authority).deleteExpired();
        await acquired.promise;
        const claimAttempted = deferred<number>();
        const claimAcquired = deferred<number>();
        const claim = stage3Service(new ObservedSessionLockPool(
          pool, claimAttempted, claimAcquired,
        )).claimGuest(fixture.claimInput);
        await expectLockWait(rawPool, await claimAttempted.promise);
        release.resolve();
        await expect(cleanup).resolves.toBe(1);
        await expect(claim).resolves.toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
      }
      const matrix = await stage3Matrix();
      expect(matrix).toEqual({
        guests: 0, guest_progress: 0, claim_capabilities: 0, guest_digests: 0,
        players: 0, player_progress: 0, wallets: 0, player_sessions: 0, player_digests: 0,
        commands: 0, events: 0, outbox: 0, exports: 0, imports: 0,
        challenges: 0, virgin_challenges: 0, merges: 0,
        tombstones: {
          "claim-challenge": 2,
          command: 1,
          "guest-claim": 1,
          "guest-session": 2,
          "save-export": 2,
          "save-import": 1,
        },
      });
    }
  });

  it("revalidates the exact target-player revision after an observed parent-lock wait", async () => {
    const wallet = stage3Wallet();
    const ownerFixture = await stage3Fixture(wallet);
    const owner = await stage3Service().claimGuest(ownerFixture.claimInput);
    if ("code" in owner) throw new Error("Owner fixture claim failed.");
    const contender = await stage3Fixture(wallet);
    const existingIntent = {
      ...contender.intent,
      createPlayer: false,
      targetPlayerId: owner.playerId,
      playerRevision: owner.playerRevision,
    } as const;
    const challenge = await stage3Service().issueClaimChallenge({
      resumeSecret: contender.resumeSecret,
      intent: existingIntent,
      account: wallet.account,
    });
    if ("code" in challenge) throw new Error("Existing-player challenge issuance failed.");
    const proof = {
      challenge: challenge.challenge,
      publicKey: wallet.publicKey,
      signature: b58Encode(
        signMessage(null, blake2b(walletSigningBytes(challenge.challenge), { dkLen: 32 }), wallet.privateKey),
        PrefixV2.Ed25519Signature,
      ),
    };
    const blocker = await rawPool.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM samurai_persistence.players WHERE id=$1 FOR UPDATE", [owner.playerId]);
    const attempted = deferred<number>();
    const acquired = deferred<number>();
    const claim = stage3Service(new ObservedQueryLockPool(
      pool,
      (text) => text.includes("SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE"),
      attempted,
      acquired,
    )).claimGuest({
      resumeSecret: contender.resumeSecret,
      intent: existingIntent,
      challengeId: challenge.challengeId,
      proof,
    });
    await expectLockWait(rawPool, await attempted.promise);
    await blocker.query(
      "UPDATE samurai_persistence.player_progress SET revision=revision+1,updated_at=clock_timestamp() WHERE player_id=$1",
      [owner.playerId],
    );
    await blocker.query("COMMIT");
    blocker.release();
    await expect(claim).resolves.toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
    const matrix = await stage3Matrix();
    expect(matrix).toEqual({
      guests: 1, guest_progress: 1, claim_capabilities: 1, guest_digests: 1,
      players: 1, player_progress: 1, wallets: 1,
      player_sessions: 1, player_digests: 1, merges: 1,
      commands: 2, events: 2, outbox: 2, exports: 1, imports: 1,
      challenges: 3, virgin_challenges: 2,
      tombstones: {
        "claim-challenge": 2,
        "claim-id": 1,
        "claim-idempotency": 1,
        "guest-claim": 1,
        "guest-session": 3,
        "save-export": 3,
        "save-import": 2,
      },
    });
    expect((await rawPool.query<{ readonly revision: string }>(
      "SELECT revision::text FROM samurai_persistence.player_progress WHERE player_id=$1",
      [owner.playerId],
    )).rows[0]?.revision).toBe(String(owner.playerRevision + 1));
  });

  it("enforces the seven-day player-session idle boundary, touches accepted use, and cleans at equality", async () => {
    const secret = Buffer.alloc(32, 61).toString("base64url");
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const beforeIdleExpiry = new Date("2026-08-07T23:59:59.999Z");
    const idleExpiry = new Date("2026-08-08T00:00:00.000Z");
    const absoluteExpiry = new Date("2026-08-31T00:00:00.000Z");
    const digest = playerSessionKeys.digest(secret, createdAt);
    await rawPool.query(
      "INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ('idle-player-subject',$1,$1)",
      [createdAt],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
       VALUES ('123e4567-e89b-42d3-a456-426614174321','idle-player-subject','claim',
               '123e4567-e89b-42d3-a456-426614174322','active',1,$1,$1,$2,'2026-08-15T00:00:00Z')`,
      [createdAt, absoluteExpiry],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_session_digests
        (player_session_id,slot,digest_key_version,digest_key_identity,digest,valid_until)
       VALUES ('123e4567-e89b-42d3-a456-426614174321','current',$1,$2,$3,NULL)`,
      [digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
    );
    const beforeBoundary = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => beforeIdleExpiry)),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(beforeBoundary.authenticatePlayerSession(secret)).resolves.toMatchObject({
      credentialKind: "current",
    });
    const touched = await rawPool.query<{ readonly last_seen_at: Date; readonly expires_at: Date }>(
      "SELECT last_seen_at, expires_at FROM samurai_persistence.player_sessions WHERE id='123e4567-e89b-42d3-a456-426614174321'",
    );
    expect(touched.rows[0]).toEqual({ last_seen_at: beforeIdleExpiry, expires_at: absoluteExpiry });
    await rawPool.query(
      "UPDATE samurai_persistence.player_sessions SET last_seen_at=$2 WHERE id=$1::uuid",
      ["123e4567-e89b-42d3-a456-426614174321", createdAt],
    );

    const release = deferred<void>();
    const attempted = deferred<number>();
    const acquired = deferred<number>();
    const observed = new ObservedQueryLockPool(
      pool,
      (text) => text.includes("FROM samurai_persistence.player_sessions WHERE id = $1::uuid FOR UPDATE"),
      attempted,
      acquired,
      release.promise,
    );
    const crossingBoundary = new AccountClaimService(
      new ControlledClockPool(observed, [beforeIdleExpiry, idleExpiry]),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    const crossingAuthentication = crossingBoundary.authenticatePlayerSession(secret);
    await acquired.promise;
    release.resolve(undefined);
    await expect(crossingAuthentication).resolves.toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);

    const atBoundary = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 16 }, () => idleExpiry)),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(atBoundary.deleteExpiredPlayerSessions()).resolves.toBe(1);
    await expect(atBoundary.deleteExpiredPlayerSessions()).resolves.toBe(0);
    const cleaned = await rawPool.query<{ readonly sessions: string; readonly digests: string; readonly players: string;
      readonly tombstones: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.player_sessions WHERE player_id='idle-player-subject') AS sessions,
        (SELECT count(*)::text FROM samurai_persistence.player_session_digests) AS digests,
        (SELECT count(*)::text FROM samurai_persistence.players WHERE id='idle-player-subject') AS players,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones WHERE kind='player-session') AS tombstones
    `);
    expect(cleaned.rows[0]).toEqual({ sessions: "0", digests: "0", players: "1", tombstones: "1" });

    const pendingSecret = Buffer.alloc(32, 62).toString("base64url");
    const pendingDigest = playerSessionKeys.digest(pendingSecret, createdAt);
    await rawPool.query(
      "INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ('idle-pending-player',$1,$1)",
      [createdAt],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
       VALUES ('123e4567-e89b-42d3-a456-426614174323','idle-pending-player','claim',
               '123e4567-e89b-42d3-a456-426614174324','pending-delivery',1,$1,$1,$2,'2026-08-15T00:00:00Z')`,
      [createdAt, absoluteExpiry],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_session_digests
        (player_session_id,slot,digest_key_version,digest_key_identity,digest,valid_until)
       VALUES ('123e4567-e89b-42d3-a456-426614174323','current',$1,$2,$3,NULL)`,
      [pendingDigest.keyVersion, keyIdentityBytes(pendingDigest.keyIdentity), pendingDigest.digest],
    );
    await expect(atBoundary.acknowledgeClaimDelivery(
      "idle-pending-player",
      "123e4567-e89b-42d3-a456-426614174324",
      pendingSecret,
      1,
    )).resolves.toEqual(ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE);
    expect((await rawPool.query<{ readonly state: string }>(
      "SELECT state FROM samurai_persistence.player_sessions WHERE id='123e4567-e89b-42d3-a456-426614174323'",
    )).rows[0]?.state).toBe("pending-delivery");
  });

  it("cleans an expired player session once, preserves history, and rejects exact digest resurrection", async () => {
    const secret = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMA";
    const createdAt = new Date("2026-08-01T00:00:00.000Z");
    const expiresAt = new Date("2026-08-02T00:00:00.000Z");
    const digest = playerSessionKeys.digest(secret, createdAt);
    await rawPool.query(
      "INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ('expired-player-subject',$1,$1)",
      [createdAt],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
       VALUES ('123e4567-e89b-42d3-a456-426614174311','expired-player-subject','claim',
               '123e4567-e89b-42d3-a456-426614174312','active',1,$1,$1,$2,'2026-08-01T12:00:00Z')`,
      [createdAt, expiresAt],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_session_digests
        (player_session_id,slot,digest_key_version,digest_key_identity,digest,valid_until)
       VALUES ('123e4567-e89b-42d3-a456-426614174311','current',$1,$2,$3,NULL)`,
      [digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.domain_events
        (event_id,player_id,event_type,schema_version,payload,committed_revision,created_at)
       VALUES ('expired-player-event','expired-player-subject','player.native',1,'{}',1,$1)`,
      [createdAt],
    );
    const cleanup = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 16 }, () => new Date(expiresAt.getTime() + 1))),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(cleanup.deleteExpiredPlayerSessions()).resolves.toBe(1);
    await expect(cleanup.deleteExpiredPlayerSessions()).resolves.toBe(0);
    expect((await rawPool.query<CountRow>(
      "SELECT count(*)::text AS count FROM samurai_persistence.domain_events WHERE player_id='expired-player-subject'",
    )).rows[0]?.count).toBe("1");

    const laterSecret = "PPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPPA";
    const laterDigest = playerSessionKeys.digest(laterSecret, createdAt);
    await rawPool.query(
      "INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ('z-live-expired-player',$1,$1)",
      [createdAt],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
       VALUES ('123e4567-e89b-42d3-a456-426614174313','z-live-expired-player','claim',
               '123e4567-e89b-42d3-a456-426614174314','active',1,$1,$1,$2,'2026-08-01T12:00:00Z')`,
      [createdAt, expiresAt],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_session_digests
        (player_session_id,slot,digest_key_version,digest_key_identity,digest,valid_until)
       VALUES ('123e4567-e89b-42d3-a456-426614174313','current',$1,$2,$3,NULL)`,
      [laterDigest.keyVersion, keyIdentityBytes(laterDigest.keyIdentity), laterDigest.digest],
    );
    await expect(cleanup.deleteExpiredPlayerSessions(1)).resolves.toBe(1);
    await expect(cleanup.deleteExpiredPlayerSessions(1)).resolves.toBe(0);

    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,
         created_at,last_seen_at,expires_at,rotate_after)
       VALUES ('123e4567-e89b-42d3-a456-426614174311','expired-player-subject','claim',
               '123e4567-e89b-42d3-a456-426614174312','active',1,
               '2026-08-01T00:00:00Z','2026-08-01T00:00:00Z',
               '2026-08-03T00:00:00Z','2026-08-02T12:00:00Z')`,
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_session_digests
        (player_session_id,slot,digest_key_version,digest_key_identity,digest,valid_until)
       VALUES ('123e4567-e89b-42d3-a456-426614174311','current',$1,$2,$3,NULL)`,
      [digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
    );
    const resurrected = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 8 }, () => new Date("2026-08-02T00:00:00.001Z"))),
      claimAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(resurrected.authenticatePlayerSession(secret)).resolves.toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);
  });

  it("purges guest claim capabilities when the entire claim-key inventory is unavailable", async () => {
    const claimCapability = Buffer.alloc(32, 31).toString("base64url");
    const issued = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys,
      issueClaimCapability: () => claimCapability,
    }).issue({
      consentVersion: "consent-v1",
      contentVersion: "content-v1",
      checkpointSchemaVersion: 1,
      checkpoint: { claimInventory: "missing" },
    });
    const unavailable = new GuestSessionService(pool, authority);
    await expect(unavailable.rotateClaimCapability(issued.resumeSecret)).rejects.toMatchObject({
      code: "GUEST_CLAIM_UNAVAILABLE",
    });
    await expect(unavailable.purgeUnavailableClaimCapabilities()).resolves.toBe(1);
    await expect(unavailable.purgeUnavailableClaimCapabilities()).resolves.toBe(0);
    const state = await rawPool.query<{ readonly guests: string; readonly progress: string; readonly resumes: string;
      readonly capabilities: string; readonly tombstones: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.guest_sessions WHERE id=$1) AS guests,
        (SELECT count(*)::text FROM samurai_persistence.guest_progress WHERE guest_session_id=$1) AS progress,
        (SELECT count(*)::text FROM samurai_persistence.guest_resume_digests WHERE guest_session_id=$1) AS resumes,
        (SELECT count(*)::text FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id=$1) AS capabilities,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones
          WHERE kind='guest-claim' AND capability_key_purpose='guest-claim') AS tombstones
    `, [issued.session.id]);
    expect(state.rows[0]).toEqual({
      guests: "1", progress: "1", resumes: "1", capabilities: "0", tombstones: "1",
    });
    await expect(unavailable.resume(issued.resumeSecret)).resolves.toMatchObject({
      session: { id: issued.session.id },
    });
  });

  it("purges a compromised player-session key without blocking retention or erasing player history", async () => {
    const compromisedAt = new Date("2026-08-01T21:00:00.000Z");
    const retired = { ...hmacKey("player-session", 17, 17, true), compromisedAt } as const;
    const compromisedRing = new PlayerSessionKeyring(hmacKey("player-session", 18, 18), [retired]);
    const secret = "LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLA";
    const issuedDigest = compromisedRing.digest(secret, new Date(compromisedAt.getTime() - 1), 17);
    await rawPool.query(
      "INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ('compromised-player-subject','2026-07-31','2026-07-31')",
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
       VALUES ('123e4567-e89b-42d3-a456-426614174301','compromised-player-subject','claim',
               '123e4567-e89b-42d3-a456-426614174302','active',1,'2026-07-31','2026-07-31',
               '2026-08-30','2026-08-01')`,
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_session_digests
        (player_session_id,slot,digest_key_version,digest_key_identity,digest,valid_until)
       VALUES ('123e4567-e89b-42d3-a456-426614174301','current',$1,$2,$3,NULL)`,
      [issuedDigest.keyVersion, keyIdentityBytes(issuedDigest.keyIdentity), issuedDigest.digest],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.domain_events
        (event_id,player_id,event_type,schema_version,payload,committed_revision,created_at)
       VALUES ('compromised-player-event','compromised-player-subject','player.native',1,'{}',1,'2026-07-31')`,
    );
    const compromisedAuthority = new AccountClaimAuthority(pool, authority, guestClaimKeys, compromisedRing);
    await compromisedAuthority.bootstrap();
    const cleanup = new AccountClaimService(
      new ControlledClockPool(pool, Array.from({ length: 12 }, () => new Date(compromisedAt.getTime() + 1))),
      compromisedAuthority,
      { origin: "https://game.samurai-sushi.example", chainId: "NetXdQprcVkpaWU" },
    );
    await expect(cleanup.authenticatePlayerSession(secret)).resolves.toEqual(ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE);
    await expect(cleanup.purgeUnavailablePlayerSessionDigests()).resolves.toBe(1);
    const state = await rawPool.query<{ readonly sessions: string; readonly digests: string;
      readonly events: string; readonly tombstones: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.player_sessions WHERE state='revoked') AS sessions,
        (SELECT count(*)::text FROM samurai_persistence.player_session_digests) AS digests,
        (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE player_id='compromised-player-subject') AS events,
        (SELECT count(*)::text FROM samurai_persistence.deletion_tombstones
          WHERE kind='player-session' AND capability_key_version=17) AS tombstones
    `);
    expect(state.rows[0]).toEqual({ sessions: "0", digests: "0", events: "1", tombstones: "1" });
    await expect(compromisedAuthority.assertSafeToDestroy("player-session", 17)).rejects.toMatchObject({
      code: "KEY_DESTRUCTION_UNSAFE",
    });
  });

  it("rejects impossible Stage 3 challenge and credential states in PostgreSQL", async () => {
    const insertChallenge = (
      id: string,
      nonce: string,
      hash: string,
      issuedAt: string,
      expiresAt: string,
      consumedAt: string | null = null,
      consumedClaimId: string | null = null,
    ) => rawPool.query(
      `INSERT INTO samurai_persistence.claim_challenges
        (challenge_id,purpose,guest_session_id,claim_id,nonce_digest,challenge_hash,intent_hash,
         issued_at,expires_at,consumed_at,consumed_claim_id)
       VALUES ($1,'recovery',NULL,'123e4567-e89b-42d3-a456-426614174000',decode($2,'hex'),decode($3,'hex'),
               decode(repeat('33',32),'hex'),$4,$5,$6,$7::uuid)`,
      [id, nonce, hash, issuedAt, expiresAt, consumedAt, consumedClaimId],
    );
    await expect(insertChallenge(
      "123e4567-e89b-42d3-a456-426614174100", "11".repeat(32), "22".repeat(32),
      "2026-08-01T20:30:00Z", "2026-08-01T20:35:00.001Z",
    )).rejects.toMatchObject({ code: "23514" });
    await expect(insertChallenge(
      "123e4567-e89b-42d3-a456-426614174101", "12".repeat(32), "23".repeat(32),
      "infinity", "infinity",
    )).rejects.toMatchObject({ code: "23514" });
    await expect(insertChallenge(
      "123e4567-e89b-42d3-a456-426614174102", "13".repeat(32), "24".repeat(32),
      "2026-08-01T20:30:00Z", "2026-08-01T20:35:00Z", "2026-08-01T20:31:00Z", null,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(insertChallenge(
      "123e4567-e89b-12d3-a456-426614174103", "14".repeat(32), "25".repeat(32),
      "2026-08-01T20:30:00Z", "2026-08-01T20:35:00Z",
    )).rejects.toMatchObject({ code: "23514" });
    await expect(insertChallenge(
      "123e4567-e89b-42d3-a456-426614174104", "15".repeat(31), "26".repeat(32),
      "2026-08-01T20:30:00Z", "2026-08-01T20:35:00Z",
    )).rejects.toMatchObject({ code: "23514" });
    await insertChallenge(
      "123e4567-e89b-42d3-a456-426614174105", "16".repeat(32), "27".repeat(32),
      "2026-08-01T20:30:00Z", "2026-08-01T20:35:00Z",
    );
    await expect(insertChallenge(
      "123e4567-e89b-42d3-a456-426614174106", "16".repeat(32), "28".repeat(32),
      "2026-08-01T20:30:00Z", "2026-08-01T20:35:00Z",
    )).rejects.toMatchObject({ code: "23505" });
    await expect(insertChallenge(
      "123e4567-e89b-42d3-a456-426614174108", "18".repeat(32), "27".repeat(32),
      "2026-08-01T20:30:00Z", "2026-08-01T20:35:00Z",
    )).rejects.toMatchObject({ code: "23505" });
    await expect(insertChallenge(
      "123e4567-e89b-42d3-a456-426614174107", "17".repeat(32), "29".repeat(32),
      "2026-08-01T20:30:00Z", "2026-08-01T20:35:00Z", "2026-08-01T20:31:00Z",
      "223e4567-e89b-42d3-a456-426614174000",
    )).rejects.toMatchObject({ code: "23514" });

    await rawPool.query(
      `INSERT INTO samurai_persistence.players (id,created_at,updated_at)
       VALUES ('hostile-player-0001','2026-08-01T20:00:00Z','2026-08-01T20:00:00Z')`,
    );
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,
         created_at,last_seen_at,expires_at,rotate_after)
       VALUES ('223e4567-e89b-42d3-a456-426614174100','hostile-player-0001','wallet-proof',
               '423e4567-e89b-42d3-a456-426614174100','active',1,
               '2026-08-01T20:00:00Z','2026-08-01T20:00:00Z',
               '2026-08-02T20:00:00Z','2026-08-02T08:00:00Z')`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.wallet_credentials
        (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
       VALUES ('323e4567-e89b-42d3-a456-426614174100','hostile-player-0001',
               'Net111111111111','tz1${"1".repeat(33)}','edpk','tz1',
               '423e4567-e89b-42d3-a456-426614174100','2026-08-01T20:00:00Z')`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.player_progress
        (player_id,revision,content_version,checkpoint_schema_version,checkpoint,created_at,updated_at)
       VALUES ('hostile-player-0001',9007199254740992,'content-v1',1,'{}',
               '2026-08-01T20:00:00Z','2026-08-01T20:00:00Z')`,
    )).rejects.toMatchObject({ code: "23514" });
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_progress
        (player_id,revision,content_version,checkpoint_schema_version,checkpoint,created_at,updated_at)
       VALUES ('hostile-player-0001',0,$1,2,$2::jsonb,
               '2026-08-01T20:00:00Z','2026-08-01T20:00:00Z')`,
      [FIRST_EVENING_CONTENT_VERSION, JSON.stringify(createInitialEveningServiceCheckpoint())],
    );
    await expect(rawPool.query(
      `UPDATE samurai_persistence.player_progress
          SET revision=1,checkpoint=$1::jsonb
        WHERE player_id='hostile-player-0001'`,
      [JSON.stringify(createInitialEveningServiceCheckpoint())],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(rawPool.query(
      `UPDATE samurai_persistence.player_progress
          SET checkpoint=$1::jsonb
        WHERE player_id='hostile-player-0001'`,
      [JSON.stringify({ ...createInitialEveningServiceCheckpoint(), generation: Number.MAX_SAFE_INTEGER + 1 })],
    )).rejects.toMatchObject({ code: "23514" });
    const { generation: _legacyGeneration, ...legacyCheckpoint } = createInitialEveningServiceCheckpoint();
    await expect(rawPool.query(
      `UPDATE samurai_persistence.player_progress
          SET checkpoint_schema_version=1,checkpoint=$1::jsonb
        WHERE player_id='hostile-player-0001'`,
      [JSON.stringify({ ...legacyCheckpoint, schemaVersion: 1 })],
    )).rejects.toMatchObject({ code: "23514" });
    const hostileGuest = await sessionService.issue({
      consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
    });
    await expect(rawPool.query(
      `UPDATE samurai_persistence.guest_progress
          SET revision=1,content_version=$2,checkpoint=$3::jsonb
        WHERE guest_session_id=$1`,
      [hostileGuest.session.id, FIRST_EVENING_CONTENT_VERSION, JSON.stringify(createInitialEveningServiceCheckpoint())],
    )).rejects.toMatchObject({ code: "23514" });
    await rawPool.query(
      `INSERT INTO samurai_persistence.wallet_credentials
        (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
       VALUES ('323e4567-e89b-42d3-a456-426614174101','hostile-player-0001','NetXdQprcVkpaWU',
               'tz1MsZxMSJdiUV9hVs4UKAMrXtksDvxWAZe2',
               'edpkuZpp81M8NmaFbueXY8bk7EP9V54XTnwsFFt77Z5FTPs2QzLU9r','tz1',
               '423e4567-e89b-42d3-a456-426614174101','2026-08-01T20:00:00Z')`,
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.players (id,created_at,updated_at)
       VALUES ('hostile-player-0002','2026-08-01T20:00:00Z','2026-08-01T20:00:00Z')`,
    );
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.wallet_credentials
        (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
       VALUES ('323e4567-e89b-42d3-a456-426614174102','hostile-player-0002','NetXdQprcVkpaWU',
               'tz2MTdHKt5pvb1qkJz52j9ywzsDkSS2tr5xN',
               'sppk7bnE8ihKrWKnxZ3a3yGrnwXJNSWv3MVUMm7dimvKRkL1DSBuQbg','tz2',
               '423e4567-e89b-42d3-a456-426614174101','2026-08-01T20:00:00Z')`,
    )).rejects.toMatchObject({ code: "23505" });
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_sessions
        (id,player_id,issuance_kind,issuance_id,state,delivery_generation,
         created_at,last_seen_at,expires_at,rotate_after)
       VALUES ('523e4567-e89b-42d3-a456-426614174100','hostile-player-0001','claim',
               '623e4567-e89b-42d3-a456-426614174100','active',1,
               '2026-08-01T20:00:00Z','2026-08-01T20:00:00Z',
               '2026-08-02T20:00:00Z','2026-08-02T08:00:00Z')`,
    );
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.progress_merges
        (claim_id,idempotency_key,request_hash,claim_intent_hash,challenge_hash,
         guest_origin_commitment,player_id,create_player,target_player_id,guest_revision,
         player_revision_before,player_revision_after,content_version,cosmetic_selections,
         session_id,session_issuance_id,result_hash,created_at,expires_at)
       VALUES ('623e4567-e89b-42d3-a456-426614174100','hostile-merge-idempotency',
               decode(repeat('31',32),'hex'),decode(repeat('32',32),'hex'),decode(repeat('33',32),'hex'),
               decode(repeat('34',32),'hex'),'hostile-player-0001',true,NULL,0,NULL,1,
               'content-v1','{}','523e4567-e89b-42d3-a456-426614174100',
               '623e4567-e89b-42d3-a456-426614174100',decode(repeat('35',32),'hex'),
               '2026-08-01T20:00:00Z','2026-08-02T20:00:00Z')`,
    )).rejects.toMatchObject({ code: "23514" });
    await expect(rawPool.query(
      `INSERT INTO samurai_persistence.progress_merges
        (claim_id,idempotency_key,request_hash,claim_intent_hash,challenge_hash,
         guest_origin_commitment,player_id,create_player,target_player_id,guest_revision,
         player_revision_before,player_revision_after,content_version,cosmetic_selections,
         session_id,session_issuance_id,result_hash,created_at,expires_at)
       VALUES ('623e4567-e89b-42d3-a456-426614174100','hostile-max-revision',
               decode(repeat('41',32),'hex'),decode(repeat('42',32),'hex'),decode(repeat('43',32),'hex'),
               decode(repeat('44',32),'hex'),'hostile-player-0001',false,'hostile-player-0001',0,
               9007199254740991,9007199254740992,'content-v1','{}',
               '523e4567-e89b-42d3-a456-426614174100','623e4567-e89b-42d3-a456-426614174100',
               decode(repeat('45',32),'hex'),'2026-08-01T20:00:00Z','2026-08-02T20:00:00Z')`,
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("executes guest service commands with exact revision-neutral corrective replay and subject-scoped idempotency", async () => {
    const guest = await sessionService.issue({
      consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
    });
    const service = new EveningServiceAuthority(pool, authority, stage3Service());
    const credential = { kind: "guest", resumeSecret: guest.resumeSecret } as const;
    await expect(service.query(credential)).resolves.toMatchObject({ revision: 0, checkpoint: { phase: "IDLE", revision: 0 } });
    let hostile: Record<string, unknown> = {};
    for (let index = 0; index < 40; index += 1) hostile = { nested: hostile };
    await expect(service.execute(credential, hostile)).rejects.toMatchObject({ code: "SERVICE_REQUEST_INVALID" });

    const startKey = randomUUID();
    const started = await service.execute(credential, {
      idempotencyKey: startKey, expectedRevision: 0, commandName: "service.start", payload: {},
    });
    expect(started).toMatchObject({ disposition: "committed", checkpointAdvanced: true, committedRevision: 1, response: { accepted: true } });
    await expect(service.execute(credential, {
      idempotencyKey: startKey, expectedRevision: 0, commandName: "service.start", payload: {},
    })).resolves.toMatchObject({ disposition: "replayed", committedRevision: 1, response: started.response });
    await expect(service.execute(credential, {
      idempotencyKey: startKey, expectedRevision: 0, commandName: "service.prepare-rice", payload: { beat: "wash" },
    })).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);

    const correctionKey = randomUUID();
    const correction = await service.execute(credential, {
      idempotencyKey: correctionKey, expectedRevision: 1, commandName: "service.prepare-rice", payload: { beat: "steam" },
    });
    expect(correction).toMatchObject({ disposition: "committed", checkpointAdvanced: false, committedRevision: 1,
      response: { accepted: false, correctiveCueId: "cue.rice.expected.wash", checkpoint: { revision: 1 } } });
    await expect(service.execute(credential, {
      idempotencyKey: correctionKey, expectedRevision: 1, commandName: "service.prepare-rice", payload: { beat: "steam" },
    })).resolves.toMatchObject({ disposition: "replayed", checkpointAdvanced: false, committedRevision: 1, response: correction.response });
    await expect(service.query(credential)).resolves.toMatchObject({ revision: 1, checkpoint: { phase: "OPEN", riceBeatIndex: 0 } });

    const matrix = await rawPool.query<{ readonly receipts: string; readonly advanced: string; readonly events: string; readonly outbox: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1 AND checkpoint_advanced) AS advanced,
        (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
        (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id) WHERE e.guest_session_id=$1) AS outbox
    `, [guest.session.id]);
    expect(matrix.rows[0]).toEqual({ receipts: "2", advanced: "1", events: "1", outbox: "1" });
  });

  it("starts canonical fresh runs for the same guest and acknowledged player with exact replay", async () => {
    const guest = await sessionService.issue({
      consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
    });
    const guestCredential = { kind: "guest", resumeSecret: guest.resumeSecret } as const;
    const service = new EveningServiceAuthority(pool, authority, stage3Service());
    const started = await service.execute(guestCredential, {
      idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {},
    });
    const abandoned = await service.execute(guestCredential, {
      idempotencyKey: randomUUID(), expectedRevision: started.committedRevision, commandName: "service.abandon", payload: {},
    });
    const durableAbandoned = decodeEveningServiceCheckpoint({
      ...abandoned.response.checkpoint, revision: 12, generation: 7,
      storyFlags: [FIRST_EVENING_SERVICE_DEFINITION.orders[0]!.storyFlagId], unlocks: [SALMON_SASHIMI_UNLOCK_ID],
    });
    await rawPool.query(
      `UPDATE samurai_persistence.guest_progress
          SET revision=12,content_version=$2,checkpoint_schema_version=2,checkpoint=$3::jsonb,updated_at=clock_timestamp()
        WHERE guest_session_id=$1`,
      [guest.session.id, FIRST_EVENING_CONTENT_VERSION, JSON.stringify(durableAbandoned)],
    );
    const key = randomUUID();
    const fresh = await service.execute(guestCredential, {
      idempotencyKey: key, expectedRevision: 12, commandName: "service.start-new", payload: {},
    });
    expect(fresh).toMatchObject({ disposition: "committed", committedRevision: 13, response: { accepted: true,
      feedbackRef: "feedback.service.new-shift", checkpoint: { phase: "OPEN", generation: 8, revision: 13,
        storyFlags: durableAbandoned.storyFlags, unlocks: durableAbandoned.unlocks } } });
    expect(fresh.response.checkpoint.orders).toEqual(createInitialEveningServiceCheckpoint().orders);
    expect(fresh.response.checkpoint.components).toEqual(createInitialEveningServiceCheckpoint().components);
    await expect(service.execute(guestCredential, {
      idempotencyKey: key, expectedRevision: 12, commandName: "service.start-new", payload: {},
    })).resolves.toMatchObject({ disposition: "replayed", committedRevision: 13, response: fresh.response });
    await expect(service.execute(guestCredential, {
      idempotencyKey: key, expectedRevision: 12, commandName: "service.start-new", payload: { changed: true },
    })).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    await expect(service.execute(guestCredential, {
      idempotencyKey: randomUUID(), expectedRevision: 12, commandName: "service.start-new", payload: {},
    })).rejects.toBeInstanceOf(RevisionConflictError);

    const wallet = stage3Wallet();
    const claimCapability = randomBytes(32).toString("base64url");
    const playerGuest = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys, issueClaimCapability: () => claimCapability,
    }).issue({ consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true } });
    const playerGuestCredential = { kind: "guest", resumeSecret: playerGuest.resumeSecret } as const;
    const beforeClaimService = new EveningServiceAuthority(pool, authority, stage3Service());
    await beforeClaimService.execute(playerGuestCredential, {
      idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {},
    });
    await beforeClaimService.execute(playerGuestCredential, {
      idempotencyKey: randomUUID(), expectedRevision: 1, commandName: "service.abandon", payload: {},
    });
    const intent = { claimId: randomUUID(), guestClaimCommitment: claimCapability, createPlayer: true, guestRevision: 2,
      idempotencyKey: randomUUID(), contentVersion: FIRST_EVENING_CONTENT_VERSION, cosmeticSelections: {} } as const;
    const accountService = stage3Service();
    const challenge = await accountService.issueClaimChallenge({ resumeSecret: playerGuest.resumeSecret, intent, account: wallet.account });
    if ("code" in challenge) throw new Error("Fresh-run player challenge failed.");
    const proof = { challenge: challenge.challenge, publicKey: wallet.publicKey,
      signature: b58Encode(signMessage(null, blake2b(walletSigningBytes(challenge.challenge), { dkLen: 32 }), wallet.privateKey), PrefixV2.Ed25519Signature) };
    const claimed = await accountService.claimGuest({ resumeSecret: playerGuest.resumeSecret, intent, challengeId: challenge.challengeId, proof });
    if ("code" in claimed) throw new Error(`Fresh-run player claim failed: ${claimed.code}`);
    await accountService.acknowledgeClaimDeliveryExact(
      claimed.playerId, claimed.claimId, claimed.sessionId, claimed.sessionSecret, claimed.deliveryGeneration,
    );
    const playerCredential = { kind: "player", sessionSecret: claimed.sessionSecret } as const;
    const playerService = new EveningServiceAuthority(pool, authority, accountService);
    await expect(playerService.query(playerCredential)).resolves.toMatchObject({ revision: 2, checkpoint: { phase: "ABANDONED", generation: 0 } });
    await expect(playerService.execute(playerCredential, {
      idempotencyKey: randomUUID(), expectedRevision: 2, commandName: "service.start-new", payload: {},
    })).resolves.toMatchObject({ disposition: "committed", committedRevision: 3,
      response: { checkpoint: { phase: "OPEN", generation: 1, revision: 3 } } });
  });

  it("rolls back a fresh-run transition at every service write boundary", async () => {
    for (const boundary of ["checkpoint", "event", "outbox", "receipt"] as const) {
      const guest = await sessionService.issue({
        consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
      });
      const credential = { kind: "guest", resumeSecret: guest.resumeSecret } as const;
      const ordinary = new EveningServiceAuthority(pool, authority, stage3Service());
      await ordinary.execute(credential, { idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {} });
      await ordinary.execute(credential, { idempotencyKey: randomUUID(), expectedRevision: 1, commandName: "service.abandon", payload: {} });
      const state = () => rawPool.query<{ readonly revision: string; readonly checkpoint: unknown; readonly receipts: string; readonly events: string; readonly outbox: string }>(`
        SELECT p.revision::text,p.checkpoint,
          (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
          (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
          (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id) WHERE e.guest_session_id=$1) AS outbox
        FROM samurai_persistence.guest_progress p WHERE p.guest_session_id=$1`, [guest.session.id]);
      const before = (await state()).rows[0];
      const faulting = new EveningServiceAuthority(pool, authority, stage3Service(), {
        afterWriteBoundary(current) { if (current === boundary) throw new Error(`Injected fresh-run failure after ${boundary}.`); },
      });
      await expect(faulting.execute(credential, {
        idempotencyKey: randomUUID(), expectedRevision: 2, commandName: "service.start-new", payload: {},
      })).rejects.toThrow(`Injected fresh-run failure after ${boundary}.`);
      expect((await state()).rows[0]).toEqual(before);
    }
  });

  it("rolls back every service checkpoint, event, outbox, and receipt boundary", async () => {
    for (const boundary of ["checkpoint", "event", "outbox", "receipt"] as const) {
      const guest = await sessionService.issue({
        consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
      });
      const service = new EveningServiceAuthority(pool, authority, stage3Service(), {
        afterWriteBoundary(current) { if (current === boundary) throw new Error(`Injected service failure after ${boundary}.`); },
      });
      await expect(service.execute({ kind: "guest", resumeSecret: guest.resumeSecret }, {
        idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {},
      })).rejects.toThrow(`Injected service failure after ${boundary}.`);
      const matrix = await rawPool.query<{ readonly revision: string; readonly content_version: string; readonly receipts: string; readonly events: string; readonly outbox: string }>(`
        SELECT p.revision::text,p.content_version,
          (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
          (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
          (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id) WHERE e.guest_session_id=$1) AS outbox
        FROM samurai_persistence.guest_progress p WHERE p.guest_session_id=$1
      `, [guest.session.id]);
      expect(matrix.rows[0]).toEqual({ revision: "0", content_version: "bootstrap-v1", receipts: "0", events: "0", outbox: "0" });
    }
  });

  it("rolls back settlement and its one-time unlock at every write boundary", async () => {
    const commandsBeforeSettlement: Array<{ readonly commandName: string; readonly payload: JsonObject }> = [
      { commandName: "service.start", payload: {} },
      ...FIRST_EVENING_SERVICE_DEFINITION.riceBeats.map((beat) => ({ commandName: "service.prepare-rice", payload: { beat } })),
    ];
    FIRST_EVENING_SERVICE_DEFINITION.orders.forEach((order, orderIndex) => {
      commandsBeforeSettlement.push({ commandName: "service.accept-order", payload: { orderId: order.id } });
      order.steps.forEach((step) => commandsBeforeSettlement.push({ commandName: "service.perform-step", payload: { orderId: order.id, stepId: step.id } }));
      if (orderIndex === 0) commandsBeforeSettlement.push({ commandName: "service.choose-presentation", payload: { orderId: order.id, choice: "indigo-rim" } });
      commandsBeforeSettlement.push({ commandName: "service.plate-order", payload: { orderId: order.id } });
      commandsBeforeSettlement.push({ commandName: "service.serve-order", payload: { orderId: order.id } });
    });
    commandsBeforeSettlement.push({ commandName: "service.close-ledger", payload: {} });

    for (const boundary of ["checkpoint", "settlement-unlock", "event", "outbox", "receipt"] as const) {
      const guest = await sessionService.issue({
        consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
      });
      const credential = { kind: "guest", resumeSecret: guest.resumeSecret } as const;
      const authorityWithoutFault = new EveningServiceAuthority(pool, authority, stage3Service());
      let revision = 0;
      for (const command of commandsBeforeSettlement) {
        const executed = await authorityWithoutFault.execute(credential, {
          idempotencyKey: randomUUID(), expectedRevision: revision, ...command,
        });
        revision = executed.committedRevision;
      }
      expect(revision).toBe(28);
      const before = await rawPool.query<{ readonly revision: string; readonly checkpoint: unknown;
        readonly receipts: string; readonly events: string; readonly outbox: string }>(`SELECT
          p.revision::text,p.checkpoint,
          (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
          (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
          (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id)
            WHERE e.guest_session_id=$1) AS outbox
        FROM samurai_persistence.guest_progress p WHERE p.guest_session_id=$1`, [guest.session.id]);
      const finalKey = randomUUID();
      const faulting = new EveningServiceAuthority(pool, authority, stage3Service(), {
        afterWriteBoundary(current) { if (current === boundary) throw new Error(`Injected settlement failure after ${boundary}.`); },
      });
      await expect(faulting.execute(credential, {
        idempotencyKey: finalKey, expectedRevision: 28, commandName: "service.choose-restoration",
        payload: { choice: "mend-counter-stool" },
      })).rejects.toThrow(`Injected settlement failure after ${boundary}.`);
      const afterFailure = await rawPool.query<{ readonly revision: string; readonly checkpoint: unknown;
        readonly receipts: string; readonly events: string; readonly outbox: string }>(`SELECT
          p.revision::text,p.checkpoint,
          (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
          (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
          (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id)
            WHERE e.guest_session_id=$1) AS outbox
        FROM samurai_persistence.guest_progress p WHERE p.guest_session_id=$1`, [guest.session.id]);
      expect(afterFailure.rows[0]).toEqual(before.rows[0]);

      const committed = await authorityWithoutFault.execute(credential, {
        idempotencyKey: finalKey, expectedRevision: 28, commandName: "service.choose-restoration",
        payload: { choice: "mend-counter-stool" },
      });
      expect(committed).toMatchObject({ disposition: "committed", committedRevision: 29,
        response: { settledNow: true, unlockedNow: ["atlantic-salmon-sashimi@1"], checkpoint: {
          phase: "SETTLED", revision: 29, unlocks: ["atlantic-salmon-sashimi@1"],
        } } });
      await expect(authorityWithoutFault.execute(credential, {
        idempotencyKey: finalKey, expectedRevision: 28, commandName: "service.choose-restoration",
        payload: { choice: "mend-counter-stool" },
      })).resolves.toMatchObject({ disposition: "replayed", committedRevision: 29,
        response: { unlockedNow: ["atlantic-salmon-sashimi@1"] } });
      const terminal = await rawPool.query<{ readonly receipts: string; readonly events: string; readonly outbox: string }>(`SELECT
          (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
          (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
          (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id)
            WHERE e.guest_session_id=$1) AS outbox`, [guest.session.id]);
      expect(terminal.rows[0]).toEqual({ receipts: "29", events: "29", outbox: "29" });
    }
  }, 30_000);

  it("serializes concurrent same-subject service commands at an observed PostgreSQL idempotency barrier", async () => {
    const guest = await sessionService.issue({
      consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
    });
    const attempted = deferred<number>();
    const acquired = deferred<number>();
    const release = deferred<void>();
    const observedPool = new ObservedQueryLockPool(pool, (text) => text.includes("pg_advisory_xact_lock"), attempted, acquired, release.promise);
    const key = randomUUID();
    const first = new EveningServiceAuthority(observedPool, authority, stage3Service(observedPool)).execute(
      { kind: "guest", resumeSecret: guest.resumeSecret },
      { idempotencyKey: key, expectedRevision: 0, commandName: "service.start", payload: {} },
    );
    await attempted.promise;
    await acquired.promise;
    const changed = new EveningServiceAuthority(pool, authority, stage3Service()).execute(
      { kind: "guest", resumeSecret: guest.resumeSecret },
      { idempotencyKey: key, expectedRevision: 0, commandName: "service.prepare-rice", payload: { beat: "wash" } },
    );
    release.resolve();
    await expect(first).resolves.toMatchObject({ disposition: "committed", committedRevision: 1 });
    await expect(changed).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    await expect(new EveningServiceAuthority(pool, authority, stage3Service()).query({ kind: "guest", resumeSecret: guest.resumeSecret }))
      .resolves.toMatchObject({ revision: 1, checkpoint: { phase: "OPEN" } });
  });

  it("rejects an observed new-key stale revision and the opposite same-key corrective winner exactly", async () => {
    const parentLock = (text: string) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE");

    const staleGuest = await sessionService.issue({
      consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
    });
    const winnerAttempted = deferred<number>();
    const winnerAcquired = deferred<number>();
    const staleAttempted = deferred<number>();
    const staleAcquired = deferred<number>();
    const releaseWinner = deferred<void>();
    const winnerPool = new ObservedQueryLockPool(pool, parentLock, winnerAttempted, winnerAcquired, releaseWinner.promise);
    const stalePool = new ObservedQueryLockPool(pool, parentLock, staleAttempted, staleAcquired);
    const winner = new EveningServiceAuthority(winnerPool, authority, stage3Service(winnerPool)).execute(
      { kind: "guest", resumeSecret: staleGuest.resumeSecret },
      { idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {} },
    );
    await winnerAcquired.promise;
    const stale = new EveningServiceAuthority(stalePool, authority, stage3Service(stalePool)).execute(
      { kind: "guest", resumeSecret: staleGuest.resumeSecret },
      { idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {} },
    );
    await staleAttempted.promise;
    releaseWinner.resolve();
    await expect(winner).resolves.toMatchObject({ committedRevision: 1 });
    await expect(stale).rejects.toBeInstanceOf(RevisionConflictError);
    const staleMatrix = await rawPool.query<{ readonly revision: string; readonly unlocks: unknown;
      readonly receipts: string; readonly events: string; readonly outbox: string }>(`SELECT
        p.revision::text,p.checkpoint->'unlocks' AS unlocks,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
        (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
        (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id) WHERE e.guest_session_id=$1) AS outbox
      FROM samurai_persistence.guest_progress p WHERE p.guest_session_id=$1`, [staleGuest.session.id]);
    expect(staleMatrix.rows[0]).toEqual({ revision: "1", unlocks: [], receipts: "1", events: "1", outbox: "1" });

    const correctiveGuest = await sessionService.issue({
      consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
    });
    const correctionAttempted = deferred<number>();
    const correctionAcquired = deferred<number>();
    const changedAttempted = deferred<number>();
    const changedAcquired = deferred<number>();
    const releaseCorrection = deferred<void>();
    const correctionPool = new ObservedQueryLockPool(pool, parentLock, correctionAttempted, correctionAcquired, releaseCorrection.promise);
    const changedPool = new ObservedQueryLockPool(pool, parentLock, changedAttempted, changedAcquired);
    const key = randomUUID();
    const correction = new EveningServiceAuthority(correctionPool, authority, stage3Service(correctionPool)).execute(
      { kind: "guest", resumeSecret: correctiveGuest.resumeSecret },
      { idempotencyKey: key, expectedRevision: 0, commandName: "service.prepare-rice", payload: { beat: "steam" } },
    );
    await correctionAcquired.promise;
    const changedStart = new EveningServiceAuthority(changedPool, authority, stage3Service(changedPool)).execute(
      { kind: "guest", resumeSecret: correctiveGuest.resumeSecret },
      { idempotencyKey: key, expectedRevision: 0, commandName: "service.start", payload: {} },
    );
    await changedAttempted.promise;
    releaseCorrection.resolve();
    await expect(correction).resolves.toMatchObject({ checkpointAdvanced: false, committedRevision: 0,
      response: { accepted: false, correctiveCueId: "cue.rice.expected.wash" } });
    await expect(changedStart).rejects.toBeInstanceOf(IdempotencyPayloadMismatchError);
    await expect(new EveningServiceAuthority(pool, authority, stage3Service()).query({
      kind: "guest", resumeSecret: correctiveGuest.resumeSecret,
    })).resolves.toMatchObject({ revision: 0, checkpoint: { phase: "IDLE", revision: 0, unlocks: [] } });
    const correctiveMatrix = await rawPool.query<{ readonly revision: string; readonly phase: string; readonly unlocks: unknown;
      readonly receipts: string; readonly events: string; readonly outbox: string }>(`SELECT
        p.revision::text,p.checkpoint->>'phase' AS phase,p.checkpoint->'unlocks' AS unlocks,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
        (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
        (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id) WHERE e.guest_session_id=$1) AS outbox
      FROM samurai_persistence.guest_progress p WHERE p.guest_session_id=$1`, [correctiveGuest.session.id]);
    expect(correctiveMatrix.rows[0]).toEqual({ revision: "0", phase: null, unlocks: null, receipts: "1", events: "0", outbox: "0" });
  });

  it("serializes service commands and guest deletion in both observed parent-lock winners without resurrection", async () => {
    const serviceParent = (text: string) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE");
    const deletionParent = (text: string) => text.includes("JOIN samurai_persistence.guest_sessions s") && text.includes("FOR UPDATE OF s");

    for (const winner of ["command", "deletion"] as const) {
      const guest = await sessionService.issue({
        consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
      });
      const commandAttempted = deferred<number>();
      const commandAcquired = deferred<number>();
      const deletionAttempted = deferred<number>();
      const deletionAcquired = deferred<number>();
      const releaseWinner = deferred<void>();
      const commandPool = new ObservedQueryLockPool(
        pool, serviceParent, commandAttempted, commandAcquired, winner === "command" ? releaseWinner.promise : undefined,
      );
      const deletionPool = new ObservedQueryLockPool(
        pool, deletionParent, deletionAttempted, deletionAcquired, winner === "deletion" ? releaseWinner.promise : undefined,
      );
      const command = () => new EveningServiceAuthority(commandPool, authority, stage3Service(commandPool)).execute(
        { kind: "guest", resumeSecret: guest.resumeSecret },
        { idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {} },
      );
      const deletion = () => new GuestSessionService(deletionPool, authority).delete(guest.resumeSecret);

      const first = winner === "command" ? command() : deletion();
      await (winner === "command" ? commandAcquired.promise : deletionAcquired.promise);
      const second = winner === "command" ? deletion() : command();
      await (winner === "command" ? deletionAttempted.promise : commandAttempted.promise);
      releaseWinner.resolve();

      if (winner === "command") {
        await expect(first).resolves.toMatchObject({ disposition: "committed", committedRevision: 1 });
        await expect(second).resolves.toBeUndefined();
      } else {
        await expect(first).resolves.toBeUndefined();
        await expect(second).rejects.toBeInstanceOf(CommandAuthenticationError);
      }
      const matrix = await rawPool.query<{ readonly guests: string; readonly progress: string; readonly receipts: string; readonly events: string; readonly outbox: string }>(`
        SELECT
          (SELECT count(*)::text FROM samurai_persistence.guest_sessions WHERE id=$1) AS guests,
          (SELECT count(*)::text FROM samurai_persistence.guest_progress WHERE guest_session_id=$1) AS progress,
          (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id=$1) AS receipts,
          (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE guest_session_id=$1) AS events,
          (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id) WHERE e.guest_session_id=$1) AS outbox
      `, [guest.session.id]);
      expect(matrix.rows[0]).toEqual({ guests: "0", progress: "0", receipts: "0", events: "0", outbox: "0" });
    }
  });

  it("transfers an observed command-first corrective receipt through claim and rejects the stale command when claim wins", async () => {
    const serviceParent = (text: string) => text.includes("FROM samurai_persistence.guest_sessions WHERE id = $1 FOR UPDATE");
    const claimParent = (text: string) => text.includes("JOIN samurai_persistence.guest_sessions s") && text.includes("FOR UPDATE OF s");

    for (const winner of ["command", "claim"] as const) {
      const wallet = stage3Wallet();
      const claimCapability = randomBytes(32).toString("base64url");
      const guest = await new GuestSessionService(pool, authority, {
        claimKeys: guestClaimKeys, issueClaimCapability: () => claimCapability,
      }).issue({
        consentVersion: "service-v1", contentVersion: FIRST_EVENING_CONTENT_VERSION,
        checkpointSchemaVersion: 2, checkpoint: createInitialEveningServiceCheckpoint(),
      });
      const intent = {
        claimId: randomUUID(), guestClaimCommitment: claimCapability, createPlayer: true, guestRevision: 0,
        idempotencyKey: randomUUID(), contentVersion: FIRST_EVENING_CONTENT_VERSION, cosmeticSelections: {},
      } as const;
      const challenge = await stage3Service().issueClaimChallenge({ resumeSecret: guest.resumeSecret, intent, account: wallet.account });
      if ("code" in challenge) throw new Error("Service race challenge issuance failed.");
      const proof = {
        challenge: challenge.challenge,
        publicKey: wallet.publicKey,
        signature: b58Encode(signMessage(null, blake2b(walletSigningBytes(challenge.challenge), { dkLen: 32 }), wallet.privateKey), PrefixV2.Ed25519Signature),
      };
      const correctionKey = randomUUID();
      const commandAttempted = deferred<number>();
      const commandAcquired = deferred<number>();
      const claimAttempted = deferred<number>();
      const claimAcquired = deferred<number>();
      const releaseWinner = deferred<void>();
      const commandPool = new ObservedQueryLockPool(
        pool, serviceParent, commandAttempted, commandAcquired, winner === "command" ? releaseWinner.promise : undefined,
      );
      const claimPool = new ObservedQueryLockPool(
        pool, claimParent, claimAttempted, claimAcquired, winner === "claim" ? releaseWinner.promise : undefined,
      );
      const command = () => new EveningServiceAuthority(commandPool, authority, stage3Service(commandPool)).execute(
        { kind: "guest", resumeSecret: guest.resumeSecret },
        { idempotencyKey: correctionKey, expectedRevision: 0, commandName: "service.prepare-rice", payload: { beat: "steam" } },
      );
      const claim = () => stage3Service(claimPool).claimGuest({
        resumeSecret: guest.resumeSecret, intent, challengeId: challenge.challengeId, proof,
      });

      let claimedResult: Awaited<ReturnType<AccountClaimService["claimGuest"]>>;
      if (winner === "command") {
        const commandFirst = command();
        await commandAcquired.promise;
        const claimSecond = claim();
        await claimAttempted.promise;
        releaseWinner.resolve();
        await expect(commandFirst).resolves.toMatchObject({ disposition: "committed", checkpointAdvanced: false, committedRevision: 0 });
        claimedResult = await claimSecond;
      } else {
        const claimFirst = claim();
        await claimAcquired.promise;
        const commandSecond = command();
        await commandAttempted.promise;
        releaseWinner.resolve();
        claimedResult = await claimFirst;
        await expect(commandSecond).rejects.toBeInstanceOf(CommandAuthenticationError);
      }
      if ("code" in claimedResult) throw new Error(`Service race claim failed: ${claimedResult.code}`);
      const claimed = claimedResult;
      const accountService = stage3Service();
      await accountService.acknowledgeClaimDeliveryExact(
        claimed.playerId, claimed.claimId, claimed.sessionId, claimed.sessionSecret, claimed.deliveryGeneration,
      );
      const playerCredential = { kind: "player", sessionSecret: claimed.sessionSecret } as const;
      const playerService = new EveningServiceAuthority(pool, authority, accountService);
      await expect(playerService.query(playerCredential)).resolves.toMatchObject({ revision: 0, checkpoint: { phase: "IDLE", revision: 0 } });
      const receipts = await rawPool.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM samurai_persistence.command_receipts WHERE player_id=$1 AND idempotency_key=$2",
        [claimed.playerId, correctionKey],
      );
      expect(receipts.rows[0]?.count).toBe(winner === "command" ? "1" : "0");
      if (winner === "command") {
        await expect(playerService.execute(playerCredential, {
          idempotencyKey: correctionKey, expectedRevision: 0, commandName: "service.prepare-rice", payload: { beat: "steam" },
        })).resolves.toMatchObject({ disposition: "replayed", checkpointAdvanced: false, committedRevision: 0,
          response: { correctiveCueId: "cue.rice.expected.wash", checkpoint: { phase: "IDLE", revision: 0 } } });
      }
    }
  });

  it("rebases unequal existing-player service revisions with guest-history precedence and monotonic unlocks", async () => {
    const throughKappaPresentation = (choice: "indigo-rim" | "sand-speckle") => {
      const order = FIRST_EVENING_SERVICE_DEFINITION.orders[0]!;
      return [
        { commandName: "service.start", payload: {} },
        ...FIRST_EVENING_SERVICE_DEFINITION.riceBeats.map((beat) => ({ commandName: "service.prepare-rice", payload: { beat } })),
        { commandName: "service.accept-order", payload: { orderId: order.id } },
        ...order.steps.map((step) => ({ commandName: "service.perform-step", payload: { orderId: order.id, stepId: step.id } })),
        { commandName: "service.choose-presentation", payload: { orderId: order.id, choice } },
      ];
    };
    const settledCommands = (restoration: "mend-counter-stool" | "refresh-menu-board") => [
      ...firstServiceCommandsBeforeSettlement(),
      { commandName: "service.choose-restoration", payload: { choice: restoration } },
    ];
    const scenarios = [
      {
        name: "guest-in-progress-player-settled",
        guestCommands: throughKappaPresentation("indigo-rim"),
        playerCheckpoint: { ...reduceServiceCommands(settledCommands("refresh-menu-board")), revision: 40,
          presentationChoice: "sand-speckle", restorationChoice: "refresh-menu-board" },
        playerRevision: 40,
        expected: { phase: "OPEN", presentationChoice: "indigo-rim", restorationChoice: null,
          unlocks: ["atlantic-salmon-sashimi@1"] },
        next: { commandName: "service.plate-order", payload: { orderId: "ceramicist-kappa" }, accepted: true },
      },
      {
        name: "guest-settled-player-in-progress",
        guestCommands: settledCommands("mend-counter-stool"),
        playerCheckpoint: { ...reduceServiceCommands(throughKappaPresentation("sand-speckle")), revision: 17 },
        playerRevision: 17,
        expected: { phase: "SETTLED", presentationChoice: "indigo-rim", restorationChoice: "mend-counter-stool",
          unlocks: ["atlantic-salmon-sashimi@1"] },
        next: { commandName: "service.start", payload: {}, accepted: false },
      },
    ] as const;

    for (const scenario of scenarios) {
      const wallet = stage3Wallet();
      const playerId = `existing-${scenario.name}`;
      await rawPool.query("INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ($1,clock_timestamp(),clock_timestamp())", [playerId]);
      await rawPool.query(
        `INSERT INTO samurai_persistence.wallet_credentials
          (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
         VALUES ($1,$2,'NetXdQprcVkpaWU',$3,$4,'tz1',$5,clock_timestamp())`,
        [randomUUID(), playerId, wallet.account, wallet.publicKey, randomUUID()],
      );
      await rawPool.query(
        `INSERT INTO samurai_persistence.player_progress
          (player_id,revision,content_version,checkpoint_schema_version,checkpoint,created_at,updated_at)
         VALUES ($1,$2,$3,2,$4::jsonb,clock_timestamp(),clock_timestamp())`,
        [playerId, scenario.playerRevision, FIRST_EVENING_CONTENT_VERSION, JSON.stringify(scenario.playerCheckpoint)],
      );

      const claimCapability = randomBytes(32).toString("base64url");
      const guest = await new GuestSessionService(pool, authority, {
        claimKeys: guestClaimKeys, issueClaimCapability: () => claimCapability,
      }).issue({ consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true } });
      const guestCredential = { kind: "guest", resumeSecret: guest.resumeSecret } as const;
      const guestService = new EveningServiceAuthority(pool, authority, stage3Service());
      let guestRevision = 0;
      for (const command of scenario.guestCommands) {
        const result = await guestService.execute(guestCredential, {
          idempotencyKey: randomUUID(), expectedRevision: guestRevision, ...command,
        });
        guestRevision = result.committedRevision;
      }
      const guestBeforeClaim = await guestService.query(guestCredential);
      expect(guestRevision).not.toBe(scenario.playerRevision + 1);

      const intent = {
        claimId: randomUUID(), guestClaimCommitment: claimCapability, createPlayer: false,
        targetPlayerId: playerId, guestRevision, playerRevision: scenario.playerRevision,
        idempotencyKey: randomUUID(), contentVersion: FIRST_EVENING_CONTENT_VERSION, cosmeticSelections: {},
      } as const;
      const claimService = stage3Service();
      const challenge = await claimService.issueClaimChallenge({ resumeSecret: guest.resumeSecret, intent, account: wallet.account });
      if ("code" in challenge) throw new Error(`Existing service challenge failed: ${challenge.code}`);
      const proof = {
        challenge: challenge.challenge,
        publicKey: wallet.publicKey,
        signature: b58Encode(signMessage(null, blake2b(walletSigningBytes(challenge.challenge), { dkLen: 32 }), wallet.privateKey), PrefixV2.Ed25519Signature),
      };
      const claimed = await claimService.claimGuest({ resumeSecret: guest.resumeSecret, intent, challengeId: challenge.challengeId, proof });
      if ("code" in claimed) throw new Error(`Existing service claim failed: ${claimed.code}`);
      const committedRevision = scenario.playerRevision + 1;
      expect(claimed.playerRevision).toBe(committedRevision);
      await claimService.acknowledgeClaimDeliveryExact(
        claimed.playerId, claimed.claimId, claimed.sessionId, claimed.sessionSecret, claimed.deliveryGeneration,
      );
      const playerCredential = { kind: "player", sessionSecret: claimed.sessionSecret } as const;
      const playerService = new EveningServiceAuthority(pool, authority, claimService);
      const query = await playerService.query(playerCredential);
      expect(query).toMatchObject({ revision: committedRevision, checkpoint: { revision: committedRevision, ...scenario.expected } });
      expect({
        activeOrderIndex: query.checkpoint.activeOrderIndex,
        components: query.checkpoint.components,
        orders: query.checkpoint.orders,
        presentationChoice: query.checkpoint.presentationChoice,
        restorationChoice: query.checkpoint.restorationChoice,
        riceBeatIndex: query.checkpoint.riceBeatIndex,
        storyFlags: query.checkpoint.storyFlags,
      }).toEqual({
        activeOrderIndex: guestBeforeClaim.checkpoint.activeOrderIndex,
        components: guestBeforeClaim.checkpoint.components,
        orders: guestBeforeClaim.checkpoint.orders,
        presentationChoice: guestBeforeClaim.checkpoint.presentationChoice,
        restorationChoice: guestBeforeClaim.checkpoint.restorationChoice,
        riceBeatIndex: guestBeforeClaim.checkpoint.riceBeatIndex,
        storyFlags: guestBeforeClaim.checkpoint.storyFlags,
      });
      const continued = await playerService.execute(playerCredential, {
        idempotencyKey: randomUUID(), expectedRevision: query.revision, commandName: scenario.next.commandName, payload: scenario.next.payload,
      });
      expect(continued.response.accepted).toBe(scenario.next.accepted);
      const matrix = await rawPool.query<{ readonly outer_revision: string; readonly inner_revision: string; readonly merge_revision: string;
        readonly receipts: string; readonly events: string; readonly outbox: string }>(`
        SELECT p.revision::text AS outer_revision,p.checkpoint->>'revision' AS inner_revision,
          (SELECT player_revision_after::text FROM samurai_persistence.progress_merges WHERE player_id=$1 ORDER BY created_at DESC LIMIT 1) AS merge_revision,
          (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE player_id=$1) AS receipts,
          (SELECT count(*)::text FROM samurai_persistence.domain_events WHERE player_id=$1) AS events,
          (SELECT count(*)::text FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id) WHERE e.player_id=$1) AS outbox
        FROM samurai_persistence.player_progress p WHERE p.player_id=$1`, [playerId]);
      expect(matrix.rows[0]).toMatchObject({
        outer_revision: continued.committedRevision.toString(), inner_revision: continued.committedRevision.toString(),
        merge_revision: committedRevision.toString(), receipts: (scenario.guestCommands.length + 1).toString(),
        events: (scenario.guestCommands.length + (scenario.next.accepted ? 1 : 0)).toString(),
        outbox: (scenario.guestCommands.length + (scenario.next.accepted ? 1 : 0)).toString(),
      });
    }
  });

  it("rolls back an existing-player service rebase after the progress rewrite", async () => {
    const wallet = stage3Wallet();
    const playerId = "existing-service-rollback";
    const playerCheckpoint = { ...createInitialEveningServiceCheckpoint(), revision: 12 };
    await rawPool.query("INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ($1,clock_timestamp(),clock_timestamp())", [playerId]);
    await rawPool.query(
      `INSERT INTO samurai_persistence.wallet_credentials
        (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
       VALUES ($1,$2,'NetXdQprcVkpaWU',$3,$4,'tz1',$5,clock_timestamp())`,
      [randomUUID(), playerId, wallet.account, wallet.publicKey, randomUUID()],
    );
    await rawPool.query(
      `INSERT INTO samurai_persistence.player_progress
        (player_id,revision,content_version,checkpoint_schema_version,checkpoint,created_at,updated_at)
       VALUES ($1,12,$2,2,$3::jsonb,clock_timestamp(),clock_timestamp())`,
      [playerId, FIRST_EVENING_CONTENT_VERSION, JSON.stringify(playerCheckpoint)],
    );
    const claimCapability = randomBytes(32).toString("base64url");
    const guest = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys, issueClaimCapability: () => claimCapability,
    }).issue({ consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true } });
    const guestService = new EveningServiceAuthority(pool, authority, stage3Service());
    await guestService.execute({ kind: "guest", resumeSecret: guest.resumeSecret }, {
      idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {},
    });
    const intent = {
      claimId: randomUUID(), guestClaimCommitment: claimCapability, createPlayer: false,
      targetPlayerId: playerId, guestRevision: 1, playerRevision: 12,
      idempotencyKey: randomUUID(), contentVersion: FIRST_EVENING_CONTENT_VERSION, cosmeticSelections: {},
    } as const;
    const claimService = stage3Service();
    const challenge = await claimService.issueClaimChallenge({ resumeSecret: guest.resumeSecret, intent, account: wallet.account });
    if ("code" in challenge) throw new Error(`Rollback challenge failed: ${challenge.code}`);
    const proof = {
      challenge: challenge.challenge,
      publicKey: wallet.publicKey,
      signature: b58Encode(signMessage(null, blake2b(walletSigningBytes(challenge.challenge), { dkLen: 32 }), wallet.privateKey), PrefixV2.Ed25519Signature),
    };
    const state = () => rawPool.query<{ readonly player_revision: string; readonly player_checkpoint: unknown;
      readonly guests: string; readonly guest_revision: string; readonly consumed_at: Date | null;
      readonly merges: string; readonly sessions: string }>(`
      SELECT p.revision::text AS player_revision,p.checkpoint AS player_checkpoint,
        (SELECT count(*)::text FROM samurai_persistence.guest_sessions WHERE id=$2) AS guests,
        (SELECT revision::text FROM samurai_persistence.guest_progress WHERE guest_session_id=$2) AS guest_revision,
        (SELECT consumed_at FROM samurai_persistence.claim_challenges WHERE challenge_id=$3) AS consumed_at,
        (SELECT count(*)::text FROM samurai_persistence.progress_merges WHERE player_id=$1) AS merges,
        (SELECT count(*)::text FROM samurai_persistence.player_sessions WHERE player_id=$1) AS sessions
      FROM samurai_persistence.player_progress p WHERE p.player_id=$1`, [playerId, guest.session.id, challenge.challengeId]);
    const before = (await state()).rows[0];
    const result = await stage3Service(new FailAfterStatementPool(pool, "UPDATE samurai_persistence.player_progress")).claimGuest({
      resumeSecret: guest.resumeSecret, intent, challengeId: challenge.challengeId, proof,
    });
    expect(result).toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
    expect((await state()).rows[0]).toEqual(before);
  });

  it("rejects a claim against a migrated player checkpoint with outer and inner revision drift", async () => {
    const wallet = stage3Wallet();
    const playerId = "historical-drift-player-0001";
    const historicalClient = await rawPool.connect();
    try {
      await historicalClient.query("BEGIN");
      await historicalClient.query(
        "ALTER TABLE samurai_persistence.player_progress DROP CONSTRAINT player_progress_service_revision_check",
      );
      await historicalClient.query(
        "ALTER TABLE samurai_persistence.player_progress DROP CONSTRAINT player_progress_service_generation_check",
      );
      await historicalClient.query(
        "INSERT INTO samurai_persistence.players (id,created_at,updated_at) VALUES ($1,clock_timestamp(),clock_timestamp())",
        [playerId],
      );
      await historicalClient.query(
        `INSERT INTO samurai_persistence.wallet_credentials
          (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
         VALUES ($1,$2,'NetXdQprcVkpaWU',$3,$4,'tz1',$5,clock_timestamp())`,
        [randomUUID(), playerId, wallet.account, wallet.publicKey, randomUUID()],
      );
      await historicalClient.query(
        `INSERT INTO samurai_persistence.player_progress
          (player_id,revision,content_version,checkpoint_schema_version,checkpoint,created_at,updated_at)
         VALUES ($1,2,$2,1,$3::jsonb,clock_timestamp(),clock_timestamp())`,
        [playerId, FIRST_EVENING_CONTENT_VERSION, JSON.stringify(createInitialEveningServiceCheckpoint())],
      );
      await historicalClient.query(`
        ALTER TABLE samurai_persistence.player_progress
          ADD CONSTRAINT player_progress_service_revision_check CHECK (
            content_version <> 'phase-1-evening-service-v1'
            OR (jsonb_typeof(checkpoint -> 'revision') = 'number'
              AND checkpoint ->> 'revision' ~ '^(0|[1-9][0-9]{0,15})$'
              AND (checkpoint ->> 'revision')::numeric = revision)
          ) NOT VALID
      `);
      await historicalClient.query(`
        ALTER TABLE samurai_persistence.player_progress
          ADD CONSTRAINT player_progress_service_generation_check CHECK (
            content_version <> 'phase-1-evening-service-v1'
            OR (checkpoint_schema_version = 2
              AND jsonb_typeof(checkpoint -> 'generation') = 'number'
              AND checkpoint ->> 'generation' ~ '^(0|[1-9][0-9]{0,15})$'
              AND (checkpoint ->> 'generation')::numeric <= 9007199254740991)
          ) NOT VALID
      `);
      await historicalClient.query("COMMIT");
    } catch (error) {
      await historicalClient.query("ROLLBACK");
      throw error;
    } finally {
      historicalClient.release();
    }

    const constraint = await rawPool.query<{ readonly validated: boolean }>(
      "SELECT convalidated AS validated FROM pg_constraint WHERE conname='player_progress_service_revision_check'",
    );
    expect(constraint.rows[0]).toEqual({ validated: false });

    const claimCapability = randomBytes(32).toString("base64url");
    const guest = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys, issueClaimCapability: () => claimCapability,
    }).issue({
      consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
    });
    await new EveningServiceAuthority(pool, authority, stage3Service()).execute(
      { kind: "guest", resumeSecret: guest.resumeSecret },
      { idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {} },
    );
    const intent = {
      claimId: randomUUID(), guestClaimCommitment: claimCapability, createPlayer: false,
      targetPlayerId: playerId, guestRevision: 1, playerRevision: 2,
      idempotencyKey: randomUUID(), contentVersion: FIRST_EVENING_CONTENT_VERSION, cosmeticSelections: {},
    } as const;
    const claimService = stage3Service();
    const challenge = await claimService.issueClaimChallenge({ resumeSecret: guest.resumeSecret, intent, account: wallet.account });
    if ("code" in challenge) throw new Error(`Historical-drift challenge failed: ${challenge.code}`);
    const proof = {
      challenge: challenge.challenge,
      publicKey: wallet.publicKey,
      signature: b58Encode(
        signMessage(null, blake2b(walletSigningBytes(challenge.challenge), { dkLen: 32 }), wallet.privateKey),
        PrefixV2.Ed25519Signature,
      ),
    };
    const state = async () => (await rawPool.query<{
      readonly player: string | null; readonly player_progress: string | null; readonly wallets: string;
      readonly guest: string | null; readonly guest_progress: string | null; readonly guest_digests: string;
      readonly claim_capability: string | null; readonly challenge: string | null; readonly player_sessions: string;
      readonly player_session_digests: string; readonly merges: string; readonly receipts: string;
      readonly events: string; readonly outbox: string;
    }>(`
      SELECT
        (SELECT to_jsonb(p)::text FROM samurai_persistence.players p WHERE p.id=$1) AS player,
        (SELECT to_jsonb(p)::text FROM samurai_persistence.player_progress p WHERE p.player_id=$1) AS player_progress,
        COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.credential_id) FROM samurai_persistence.wallet_credentials w
          WHERE w.player_id=$1),'[]'::jsonb)::text AS wallets,
        (SELECT to_jsonb(g)::text FROM samurai_persistence.guest_sessions g WHERE g.id=$2) AS guest,
        (SELECT to_jsonb(g)::text FROM samurai_persistence.guest_progress g WHERE g.guest_session_id=$2) AS guest_progress,
        COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.slot) FROM samurai_persistence.guest_resume_digests d
          WHERE d.guest_session_id=$2),'[]'::jsonb)::text AS guest_digests,
        (SELECT to_jsonb(c)::text FROM samurai_persistence.guest_claim_capabilities c WHERE c.guest_session_id=$2) AS claim_capability,
        (SELECT to_jsonb(c)::text FROM samurai_persistence.claim_challenges c WHERE c.challenge_id=$3) AS challenge,
        COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.id) FROM samurai_persistence.player_sessions s
          WHERE s.player_id=$1),'[]'::jsonb)::text AS player_sessions,
        COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.player_session_id,d.slot)
          FROM samurai_persistence.player_session_digests d JOIN samurai_persistence.player_sessions s
            ON s.id=d.player_session_id WHERE s.player_id=$1),'[]'::jsonb)::text AS player_session_digests,
        COALESCE((SELECT jsonb_agg(to_jsonb(m) ORDER BY m.claim_id) FROM samurai_persistence.progress_merges m
          WHERE m.player_id=$1 OR m.target_player_id=$1),'[]'::jsonb)::text AS merges,
        COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.subject_kind,r.subject_id,r.idempotency_key)
          FROM samurai_persistence.command_receipts r
          WHERE (r.guest_session_id=$2 OR r.player_id=$1)),'[]'::jsonb)::text AS receipts,
        COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e.event_id) FROM samurai_persistence.domain_events e
          WHERE (e.guest_session_id=$2 OR e.player_id=$1)),'[]'::jsonb)::text AS events,
        COALESCE((SELECT jsonb_agg(to_jsonb(o) ORDER BY o.event_id)
          FROM samurai_persistence.outbox_deliveries o JOIN samurai_persistence.domain_events e USING(event_id)
          WHERE (e.guest_session_id=$2 OR e.player_id=$1)),'[]'::jsonb)::text AS outbox
    `, [playerId, guest.session.id, challenge.challengeId])).rows[0];
    const before = await state();
    expect(await claimService.claimGuest({ resumeSecret: guest.resumeSecret, intent, challengeId: challenge.challengeId, proof }))
      .toEqual(ACCOUNT_CLAIM_PUBLIC_FAILURE);
    expect(await state()).toEqual(before);
  });

  it("continues the identical service checkpoint through claim and admits only the acknowledged player session", async () => {
    const wallet = stage3Wallet();
    const claimCapability = randomBytes(32).toString("base64url");
    const guest = await new GuestSessionService(pool, authority, {
      claimKeys: guestClaimKeys, issueClaimCapability: () => claimCapability,
    }).issue({
      consentVersion: "service-v1", contentVersion: "bootstrap-v1", checkpointSchemaVersion: 1, checkpoint: { bootstrap: true },
    });
    const guestAuthority = new EveningServiceAuthority(pool, authority, stage3Service());
    await guestAuthority.execute({ kind: "guest", resumeSecret: guest.resumeSecret }, {
      idempotencyKey: randomUUID(), expectedRevision: 0, commandName: "service.start", payload: {},
    });
    const intent = {
      claimId: randomUUID(), guestClaimCommitment: claimCapability, createPlayer: true, guestRevision: 1,
      idempotencyKey: randomUUID(), contentVersion: FIRST_EVENING_CONTENT_VERSION, cosmeticSelections: {},
    } as const;
    const claimService = stage3Service();
    const challenge = await claimService.issueClaimChallenge({ resumeSecret: guest.resumeSecret, intent, account: wallet.account });
    if ("code" in challenge) throw new Error("Service-continuity challenge failed.");
    const proof = {
      challenge: challenge.challenge,
      publicKey: wallet.publicKey,
      signature: b58Encode(signMessage(null, blake2b(walletSigningBytes(challenge.challenge), { dkLen: 32 }), wallet.privateKey), PrefixV2.Ed25519Signature),
    };
    const claimed = await claimService.claimGuest({ resumeSecret: guest.resumeSecret, intent, challengeId: challenge.challengeId, proof });
    if ("code" in claimed) throw new Error(`Service-continuity claim failed: ${claimed.code}`);
    const playerCredential = { kind: "player", sessionSecret: claimed.sessionSecret } as const;
    const playerAuthority = new EveningServiceAuthority(pool, authority, claimService);
    await expect(playerAuthority.query(playerCredential)).rejects.toMatchObject({ code: expect.any(String) });
    await expect(claimService.acknowledgeClaimDeliveryExact(
      claimed.playerId, claimed.claimId, claimed.sessionId, claimed.sessionSecret, claimed.deliveryGeneration,
    )).resolves.toBeUndefined();
    await expect(playerAuthority.query(playerCredential)).resolves.toMatchObject({ revision: 1, checkpoint: { phase: "OPEN", riceBeatIndex: 0, revision: 1 } });
    const continued = await playerAuthority.execute(playerCredential, {
      idempotencyKey: randomUUID(), expectedRevision: 1, commandName: "service.prepare-rice", payload: { beat: "wash" },
    });
    expect(continued).toMatchObject({ committedRevision: 2, response: { checkpoint: { revision: 2, riceBeatIndex: 1 } } });
    const ownership = await rawPool.query<{ readonly guests: string; readonly players: string; readonly guest_receipts: string; readonly player_receipts: string }>(`
      SELECT
        (SELECT count(*)::text FROM samurai_persistence.guest_progress) AS guests,
        (SELECT count(*)::text FROM samurai_persistence.player_progress WHERE player_id=$1) AS players,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE guest_session_id IS NOT NULL) AS guest_receipts,
        (SELECT count(*)::text FROM samurai_persistence.command_receipts WHERE player_id=$1) AS player_receipts
    `, [claimed.playerId]);
    expect(ownership.rows[0]).toEqual({ guests: "0", players: "1", guest_receipts: "0", player_receipts: "2" });
  });
});
