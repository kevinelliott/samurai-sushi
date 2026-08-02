import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { b58Encode, PrefixV2 } from "@taquito/utils";
import {
  RECEIPT_AUTHORITY_MANIFEST_HASH,
} from "@samurai-sushi/receipt-authority";
import type { ReceiptPermitSigner } from "@samurai-sushi/receipt-authority/server";
import { FIXTURE_SETTLED_COMMITMENT_NONCE, deterministicSettledCheckpointFixture } from "../../receipt-authority/src/test-fixture";
import type { NormalizedOperationObservation } from "@samurai-sushi/receipt-lifecycle";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConnectedSqlClient, QueryResult, SqlPool, SqlValue } from "../src/database";
import { TransactionRunner } from "../src/database";
import { ReceiptWorkerClaimLostError } from "../src/errors";
import { applyMigrations } from "../src/migrations";
import { ReceiptLifecycleAuthority } from "../src/receipt-lifecycle-authority";
import type { EveningServiceAuthority, SettledServiceTransactionContext } from "../src/service-authority";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; receipt lifecycle integration must never skip silently.");

class PgClientAdapter implements ConnectedSqlClient {
  constructor(private readonly client: PoolClient) {}
  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.client.query(text, values ? [...values] : undefined) as unknown as QueryResult<Row>;
  }
  release(): void { this.client.release(); }
}

class PgPoolAdapter implements SqlPool {
  constructor(readonly pool: Pool) {}
  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    return this.pool.query(text, values ? [...values] : undefined) as unknown as QueryResult<Row>;
  }
  async connect(): Promise<ConnectedSqlClient> { return new PgClientAdapter(await this.pool.connect()); }
}

const OWNER = "tz1VSUr8wwNhLAzempoch5d6hLRiTh8Cjcjb";
const CONTRACT = "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton";
const OPERATION = `o${"1".repeat(50)}`;
const SECRET_KEY = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex");
const PUBLIC_KEY = ed25519.getPublicKey(SECRET_KEY);
const signer: ReceiptPermitSigner = (payloadHash) => b58Encode(
  ed25519.sign(blake2b(Buffer.from(payloadHash, "hex"), { dkLen: 32 }), SECRET_KEY),
  PrefixV2.Ed25519Signature,
);

describe("Phase 2B durable receipt lifecycle authority", () => {
  const rawPool = new Pool({ connectionString: databaseUrl });
  const pool = new PgPoolAdapter(rawPool);
  const runner = new TransactionRunner(pool);
  let authority: ReceiptLifecycleAuthority;
  let service: EveningServiceAuthority;

  beforeAll(() => {
    expect(b58Encode(PUBLIC_KEY, PrefixV2.Ed25519PublicKey)).toBe("edpkuZpp81M8NmaFbueXY8bk7EP9V54XTnwsFFt77Z5FTPs2QzLU9r");
  });

  beforeEach(async () => {
    await rawPool.query("DROP SCHEMA IF EXISTS samurai_persistence CASCADE");
    await applyMigrations(pool);
    const now = (await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await rawPool.query(
      `INSERT INTO samurai_persistence.players (id,state,created_at,updated_at)
       VALUES ('player_phase2b_test_001','active',$1,$1)`,
      [now],
    );
    service = {
      runSettledTransaction: async <T>(
        _credential: unknown,
        _scope: string,
        operation: (context: SettledServiceTransactionContext) => Promise<T>,
      ): Promise<T> => runner.run(async (client) => {
        const clock = await client.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
        return operation({
          client,
          subjectKind: "player",
          subjectId: "player_phase2b_test_001",
          checkpoint: deterministicSettledCheckpointFixture(),
          now: clock.rows[0]!.now,
        });
      }),
    } as unknown as EveningServiceAuthority;
    authority = new ReceiptLifecycleAuthority(pool, service, { reconciliationDelayMs: 1, maximumConsecutiveFailures: 2 });
  });

  afterAll(async () => { await rawPool.end(); });

  async function prepare(nonceByte = "22", idempotencyKey = "phase2b-intent-0001") {
    const clock = await rawPool.query<{ readonly now: Date }>("SELECT date_trunc('second', clock_timestamp()) AS now");
    const issuedAt = Math.floor(clock.rows[0]!.now.getTime() / 1000);
    return authority.prepareSettledReceiptIntent({ kind: "player", sessionSecret: "server-fixture" }, {
      idempotencyKey,
      commitmentNonce: FIXTURE_SETTLED_COMMITMENT_NONCE,
      chainId: "NetXtJqPyJGB6Pc",
      account: OWNER,
      destination: CONTRACT,
      nonce: nonceByte.repeat(32),
      issuedAt: String(issuedAt),
      expiry: String(issuedAt + 600),
      deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
      issuerKeyId: "localnet-issuer-2026-01",
      issuerPolicyVersion: "1",
    }, signer);
  }

  function includedObservation(
    sourceSequence: number,
    headLevel: number,
    sourceObservationId: string,
    payloadHash: string,
  ): NormalizedOperationObservation {
    return {
      observer: "fake-rpc",
      sourceObservationId,
      sourceSequence,
      disposition: "INCLUDED",
      chainId: "NetXtJqPyJGB6Pc",
      operationHash: OPERATION,
      sourceAccount: OWNER,
      contractAddress: CONTRACT,
      deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
      headLevel,
      headBlockHash: headLevel === 100 ? "Bbcdefghijkmnpqr" : "Bbcdefghijkmnprs",
      includedBlockHash: "Babcdefghijkmnpq",
      includedLevel: 100,
      operationIndex: 0,
      failureCode: null,
      receiptEvent: {
        owner: OWNER,
        contractAddress: CONTRACT,
        serviceCommitment: "638fa458d3a31c7449121e698a4ea9fec9bc135cd83ad4ac87f61254dcf29e30",
        contentVersion: "phase-1-evening-service-v1",
        nonce: "22".repeat(32),
        payloadHash,
        deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
      },
    };
  }

  async function submittedAttempt() {
    const projection = await prepare();
    await authority.markAwaitingSignature({ kind: "player", sessionSecret: "server-fixture" }, projection.intent.intentRef);
    const attempt = await authority.registerSubmittedAttempt({ kind: "player", sessionSecret: "server-fixture" }, {
      publicIntentRef: projection.intent.intentRef,
      operationHash: OPERATION,
      counter: 7,
    });
    return { projection, attempt };
  }

  it("prepares one server-only reviewed intent idempotently without persisting or projecting private settlement inputs", async () => {
    const first = await prepare();
    const replay = await prepare();
    expect(replay).toEqual(first);
    expect(first.intent.intentRef).toMatch(/^ri_[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(first)).not.toMatch(/commitmentNonce|checkpoint|signature|player_phase2b|server-fixture/i);
    expect(first.reviewFacts.network).toEqual({
      profile: "localnet",
      chainId: "NetXtJqPyJGB6Pc",
      networkLabelRef: "network.localnet-rehearsal",
      deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
    });
    const matrix = await rawPool.query<{
      readonly intents: string; readonly events: string; readonly outbox: string; readonly audits: string;
      readonly private_columns: string;
    }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.receipt_intents) AS intents,
      (SELECT count(*)::text FROM samurai_persistence.receipt_lifecycle_events) AS events,
      (SELECT count(*)::text FROM samurai_persistence.receipt_outbox_deliveries) AS outbox,
      (SELECT count(*)::text FROM samurai_persistence.receipt_security_audit) AS audits,
      (SELECT count(*)::text FROM information_schema.columns WHERE table_schema='samurai_persistence'
        AND table_name LIKE 'receipt%' AND column_name IN ('checkpoint','commitment_nonce','signer','private_key')) AS private_columns`);
    expect(matrix.rows[0]).toEqual({ intents: "1", events: "2", outbox: "2", audits: "1", private_columns: "0" });
  });

  it("persists inclusion then exact-boundary confirmation and finality as ordered atomic transitions", async () => {
    const { attempt, projection } = await submittedAttempt();
    const firstClaim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(firstClaim, includedObservation(1, 100, "rpc:included:1", projection.reviewFacts.payloadHash))).resolves.toBe("applied");
    const included = await rawPool.query<{ readonly attempt_state: string; readonly intent_state: string; readonly receipt_state: string }>(
      `SELECT attempt.state AS attempt_state,intent.state AS intent_state,receipt.state AS receipt_state
         FROM samurai_persistence.operation_attempts attempt
         JOIN samurai_persistence.receipt_intents intent ON intent.id=attempt.intent_id
         JOIN samurai_persistence.service_receipts receipt ON receipt.attempt_id=attempt.id
        WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(included.rows[0]).toEqual({ attempt_state: "INCLUDED", intent_state: "INCLUDED", receipt_state: "INCLUDED" });
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    const secondClaim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(secondClaim, includedObservation(2, 101, "rpc:included:2", projection.reviewFacts.payloadHash))).resolves.toBe("applied");
    const final = await rawPool.query<{ readonly state: string; readonly confirmations: number; readonly policy_evidence: string; readonly events: string }>(
      `SELECT attempt.state,attempt.confirmations,attempt.policy_evidence,
        (SELECT count(*)::text FROM samurai_persistence.receipt_lifecycle_events WHERE intent_id=attempt.intent_id) AS events
       FROM samurai_persistence.operation_attempts attempt WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(final.rows[0]).toMatchObject({ state: "FINALIZED", confirmations: 2, events: "7" });
    expect(final.rows[0]!.policy_evidence).toContain("localnet-two-confirmation-rehearsal-v1:100:");
  });

  it("keeps finalized state on contradiction, emits one incident, and fences an expired worker", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, includedObservation(1, 101, "rpc:final:1", projection.reviewFacts.payloadHash));
    await authority.scheduleReconciliation(claim.attemptId);
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    const contradiction = {
      ...includedObservation(2, 102, "rpc:reorg:1", projection.reviewFacts.payloadHash),
      disposition: "REORGED",
      headBlockHash: "Bbcdefghijkmnprt",
      receiptEvent: null,
    };
    await expect(authority.observeOperation(claim, contradiction)).resolves.toBe("incident");
    const incident = await rawPool.query<{ readonly attempt_state: string; readonly receipt_state: string; readonly incidents: string }>(
      `SELECT attempt.state AS attempt_state,receipt.state AS receipt_state,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE state='OPEN') AS incidents
       FROM samurai_persistence.operation_attempts attempt JOIN samurai_persistence.service_receipts receipt ON receipt.attempt_id=attempt.id
       WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(incident.rows[0]).toEqual({ attempt_state: "FINALIZED", receipt_state: "FINALIZED", incidents: "1" });
    await authority.scheduleReconciliation(claim.attemptId);
    const staleClaim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET claim_expires_at=clock_timestamp() WHERE attempt_id=$1", [staleClaim.attemptId]);
    await expect(authority.observeOperation(staleClaim, { ...contradiction, sourceObservationId: "rpc:reorg:2", sourceSequence: 3 })).rejects.toBeInstanceOf(ReceiptWorkerClaimLostError);
    const observationCount = await rawPool.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM samurai_persistence.receipt_chain_observations");
    expect(observationCount.rows[0]?.count).toBe("2");
  });

  it("enforces immutable hashes, public-ref shapes, replacement lineage, and same-chain hash uniqueness in SQL", async () => {
    const { attempt } = await submittedAttempt();
    await expect(rawPool.query("UPDATE samurai_persistence.operation_attempts SET operation_hash=$2 WHERE public_attempt_ref=$1", [attempt.publicAttemptRef, `o${"2".repeat(50)}`])).rejects.toMatchObject({ code: "23514" });
    await expect(rawPool.query("UPDATE samurai_persistence.operation_attempts SET public_attempt_ref=$2 WHERE public_attempt_ref=$1", [attempt.publicAttemptRef, "00000000-0000-4000-8000-000000000000"])).rejects.toMatchObject({ code: "23514" });
    const predecessor = await rawPool.query<{ readonly id: string }>("SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [attempt.publicAttemptRef]);
    await expect(rawPool.query(`INSERT INTO samurai_persistence.operation_attempts
      (id,public_attempt_ref,intent_id,chain_id,operation_hash,source_account,contract_address,deployment_manifest_hash,counter,state,submitted_at,last_observed_at)
      SELECT '11111111-1111-4111-8111-111111111111', $2, intent_id, chain_id, $3, source_account, contract_address,
             deployment_manifest_hash,counter,'SUBMITTED',submitted_at,last_observed_at
        FROM samurai_persistence.operation_attempts WHERE id=$1`,
    [predecessor.rows[0]!.id, `ra_${"C".repeat(22)}`, `o${"4".repeat(50)}`])).rejects.toMatchObject({ code: "23505" });
    const replacement = await authority.replaceAttempt(predecessor.rows[0]!.id, { operationHash: `o${"2".repeat(50)}`, counter: 7 });
    expect(replacement.publicAttemptRef).toMatch(/^ra_[A-Za-z0-9_-]{22}$/);
    const lineage = await rawPool.query<{ readonly old_state: string; readonly replaces_attempt_id: string }>(
      `SELECT old.state AS old_state,new.replaces_attempt_id::text FROM samurai_persistence.operation_attempts old
       JOIN samurai_persistence.operation_attempts new ON new.replaces_attempt_id=old.id WHERE old.id=$1`, [predecessor.rows[0]!.id]);
    expect(lineage.rows[0]).toEqual({ old_state: "REPLACED", replaces_attempt_id: predecessor.rows[0]!.id });
  });

  it("persists expiry at the exact database boundary before returning the stable error", async () => {
    const projection = await prepare();
    await rawPool.query(`UPDATE samurai_persistence.receipt_intents
      SET issued_at=date_trunc('second',clock_timestamp())-interval '1 second',expires_at=date_trunc('second',clock_timestamp())
      WHERE public_intent_ref=$1`, [projection.intent.intentRef]);
    await expect(authority.markAwaitingSignature({ kind: "player", sessionSecret: "server-fixture" }, projection.intent.intentRef))
      .rejects.toMatchObject({ code: "RECEIPT_EXPIRED" });
    const row = await rawPool.query<{ readonly state: string; readonly concluded: boolean; readonly events: string }>(
      `SELECT state,concluded_at IS NOT NULL AS concluded,
        (SELECT count(*)::text FROM samurai_persistence.receipt_lifecycle_events event WHERE event.intent_id=intent.id) AS events
       FROM samurai_persistence.receipt_intents intent WHERE public_intent_ref=$1`, [projection.intent.intentRef],
    );
    expect(row.rows[0]).toEqual({ state: "EXPIRED", concluded: true, events: "3" });
  });

  it("reorgs and re-includes the same durable attempt without creating a second receipt", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, includedObservation(1, 100, "rpc:reinclude:1", projection.reviewFacts.payloadHash));
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, {
      ...includedObservation(2, 101, "rpc:reinclude:2", projection.reviewFacts.payloadHash),
      disposition: "REORGED",
      headBlockHash: "Bbcdefghijkmnprt",
      receiptEvent: null,
    });
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, {
      ...includedObservation(3, 102, "rpc:reinclude:3", projection.reviewFacts.payloadHash),
      includedLevel: 102,
      includedBlockHash: "Babcdefghijkmnpr",
    });
    const rows = await rawPool.query<{ readonly attempt_state: string; readonly receipt_state: string; readonly receipts: string; readonly observations: string }>(
      `SELECT attempt.state AS attempt_state,receipt.state AS receipt_state,
        (SELECT count(*)::text FROM samurai_persistence.service_receipts WHERE intent_id=attempt.intent_id) AS receipts,
        (SELECT count(*)::text FROM samurai_persistence.receipt_chain_observations WHERE attempt_id=attempt.id) AS observations
       FROM samurai_persistence.operation_attempts attempt JOIN samurai_persistence.service_receipts receipt ON receipt.attempt_id=attempt.id
       WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef],
    );
    expect(rows.rows[0]).toEqual({ attempt_state: "INCLUDED", receipt_state: "INCLUDED", receipts: "1", observations: "3" });
  });

  it("separates claim generations from consecutive failures and dead-letters only failed polls", async () => {
    const { attempt } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.recordReconciliationFailure(claim, "FAKE_RPC_UNAVAILABLE")).resolves.toBe("pending");
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    expect(claim.claimGeneration).toBe(2);
    await expect(authority.recordReconciliationFailure(claim, "FAKE_RPC_UNAVAILABLE")).resolves.toBe("dead-letter");
    const row = await rawPool.query<{ readonly state: string; readonly generation: string; readonly failures: number; readonly incidents: string }>(
      `SELECT job.state,job.claim_generation::text AS generation,job.consecutive_failure_count AS failures,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=job.attempt_id AND kind='RECONCILIATION_EXHAUSTED') AS incidents
       FROM samurai_persistence.receipt_reconciliation_jobs job
       JOIN samurai_persistence.operation_attempts attempt ON attempt.id=job.attempt_id WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef],
    );
    expect(row.rows[0]).toEqual({ state: "dead-letter", generation: "2", failures: 2, incidents: "1" });
  });

  it("records normalized identity drift as incident evidence with no attempt mutation", async () => {
    const { attempt, projection } = await submittedAttempt();
    const claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, {
      ...includedObservation(1, 100, "rpc:drift:1", projection.reviewFacts.payloadHash),
      chainId: "NetXdQprcVkpaWU",
    })).resolves.toBe("incident");
    const row = await rawPool.query<{ readonly state: string; readonly incidents: string; readonly observations: string; readonly outbox: string }>(
      `SELECT attempt.state,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='CHAIN_OR_MANIFEST_DRIFT') AS incidents,
        (SELECT count(*)::text FROM samurai_persistence.receipt_chain_observations WHERE attempt_id=attempt.id) AS observations,
        (SELECT count(*)::text FROM samurai_persistence.receipt_outbox_deliveries outbox
          JOIN samurai_persistence.receipt_lifecycle_events event ON event.event_id=outbox.event_id WHERE event.attempt_id=attempt.id) AS outbox
       FROM samurai_persistence.operation_attempts attempt WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef],
    );
    expect(row.rows[0]).toEqual({ state: "SUBMITTED", incidents: "1", observations: "0", outbox: "2" });
  });

  it("serializes two replacement workers at an explicit post-lock barrier", async () => {
    const { attempt } = await submittedAttempt();
    const predecessor = await rawPool.query<{ readonly id: string }>(
      "SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [attempt.publicAttemptRef],
    );
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const atBoundary = new Promise<void>((resolve) => { reached = resolve; });
    let firstBoundary = true;
    const controlled = new ReceiptLifecycleAuthority(pool, service, {
      afterWriteBoundary: async (boundary) => {
        if (boundary === "attempt" && firstBoundary) {
          firstBoundary = false;
          reached();
          await blocked;
        }
      },
    });
    const first = controlled.replaceAttempt(predecessor.rows[0]!.id, { operationHash: `o${"2".repeat(50)}`, counter: 7 });
    await atBoundary;
    const second = controlled.replaceAttempt(predecessor.rows[0]!.id, { operationHash: `o${"3".repeat(50)}`, counter: 7 });
    release();
    await expect(first).resolves.toMatchObject({ publicAttemptRef: expect.stringMatching(/^ra_/) });
    await expect(second).rejects.toMatchObject({ code: "REPLACEMENT_LINEAGE_MISMATCH" });
    const rows = await rawPool.query<{ readonly replacements: string; readonly old_state: string }>(
      `SELECT count(*)::text AS replacements,max(old.state) AS old_state
         FROM samurai_persistence.operation_attempts old
         JOIN samurai_persistence.operation_attempts replacement ON replacement.replaces_attempt_id=old.id
        WHERE old.id=$1`, [predecessor.rows[0]!.id],
    );
    expect(rows.rows[0]).toEqual({ replacements: "1", old_state: "REPLACED" });
  });
});
