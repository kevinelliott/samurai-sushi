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

  async function prepare(nonceByte = "22", idempotencyKey = "phase2b-intent-0001", target = authority, account = OWNER, issuedAtOverride?: number) {
    const clock = await rawPool.query<{ readonly now: Date }>("SELECT date_trunc('second', clock_timestamp()) AS now");
    const issuedAt = issuedAtOverride ?? Math.floor(clock.rows[0]!.now.getTime() / 1000);
    return target.prepareSettledReceiptIntent({ kind: "player", sessionSecret: "server-fixture" }, {
      idempotencyKey,
      commitmentNonce: FIXTURE_SETTLED_COMMITMENT_NONCE,
      chainId: "NetXtJqPyJGB6Pc",
      account,
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
      headBlockHash: headLevel === 100 ? "Babcdefghijkmnpq" : "Bbcdefghijkmnprs",
      includedBlockHash: "Babcdefghijkmnpq",
      includedLevel: 100,
      operationIndex: 0,
      failureCode: null,
      canonicalChainProof: headLevel === 100
        ? [{ level: 100, blockHash: "Babcdefghijkmnpq", predecessorHash: null }]
        : [{ level: 100, blockHash: "Babcdefghijkmnpq", predecessorHash: null }, { level: 101, blockHash: "Bbcdefghijkmnprs", predecessorHash: "Babcdefghijkmnpq" }],
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
    const clock = await rawPool.query<{ readonly now: Date }>("SELECT date_trunc('second', clock_timestamp()) AS now");
    const issuedAt = Math.floor(clock.rows[0]!.now.getTime() / 1000);
    const first = await prepare("22", "phase2b-intent-0001", authority, OWNER, issuedAt);
    const replay = await prepare("22", "phase2b-intent-0001", authority, OWNER, issuedAt);
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
    const final = await rawPool.query<{ readonly state: string; readonly confirmations: number; readonly policy_evidence: string;
      readonly rpc_sequence: string; readonly head_level: string; readonly head_hash: string; readonly operation_index: number; readonly events: string }>(
      `SELECT attempt.state,attempt.confirmations,attempt.policy_evidence,attempt.last_rpc_source_sequence::text AS rpc_sequence,
        attempt.last_head_level::text AS head_level,attempt.last_head_block_hash AS head_hash,attempt.included_operation_index AS operation_index,
        (SELECT count(*)::text FROM samurai_persistence.receipt_lifecycle_events WHERE intent_id=attempt.intent_id) AS events
       FROM samurai_persistence.operation_attempts attempt WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(final.rows[0]).toMatchObject({ state: "FINALIZED", confirmations: 2, rpc_sequence: "2", head_level: "101",
      head_hash: "Bbcdefghijkmnprs", operation_index: 0, events: "7" });
    expect(final.rows[0]!.policy_evidence).toContain("localnet-two-confirmation-rehearsal-v1:100:");
  });

  it("binds later canonical inclusion to the durable tuple before and after finality", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    const first = includedObservation(1, 100, "rpc:continuity:first", projection.reviewFacts.payloadHash);
    await authority.observeOperation(claim, first);
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, { ...includedObservation(2, 100, "rpc:continuity:block", projection.reviewFacts.payloadHash),
      includedBlockHash: "B222222222222222", headBlockHash: "B222222222222222",
      canonicalChainProof: [{ level: 100, blockHash: "B222222222222222", predecessorHash: null }] })).resolves.toBe("incident");
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, { ...includedObservation(3, 100, "rpc:continuity:index", projection.reviewFacts.payloadHash), operationIndex: 1 })).resolves.toBe("incident");
    let row = await rawPool.query<{ readonly state: string; readonly block: string; readonly operation_index: number; readonly sequence: string; readonly incidents: string }>(
      `SELECT state,canonical_block_hash AS block,included_operation_index AS operation_index,last_rpc_source_sequence::text AS sequence,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='CHAIN_OR_MANIFEST_DRIFT') AS incidents
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(row.rows[0]).toEqual({ state: "INCLUDED", block: "Babcdefghijkmnpq", operation_index: 0, sequence: "1", incidents: "2" });

    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    const finalObservation = includedObservation(4, 101, "rpc:continuity:final", projection.reviewFacts.payloadHash);
    await authority.observeOperation(claim, finalObservation);
    await authority.scheduleReconciliation(claim.attemptId);
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, { ...includedObservation(5, 101, "rpc:continuity:final-block", projection.reviewFacts.payloadHash),
      includedBlockHash: "B222222222222222",
      canonicalChainProof: [{ level: 100, blockHash: "B222222222222222", predecessorHash: null },
        { level: 101, blockHash: "Bbcdefghijkmnprs", predecessorHash: "B222222222222222" }] })).resolves.toBe("incident");
    row = await rawPool.query<{ readonly state: string; readonly block: string; readonly operation_index: number; readonly sequence: string; readonly incidents: string }>(
      `SELECT state,canonical_block_hash AS block,included_operation_index AS operation_index,last_rpc_source_sequence::text AS sequence,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='FINALIZED_CHAIN_CONTRADICTION') AS incidents
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(row.rows[0]).toEqual({ state: "FINALIZED", block: "Babcdefghijkmnpq", operation_index: 0, sequence: "4", incidents: "1" });

    await authority.scheduleReconciliation(claim.attemptId);
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, { ...includedObservation(6, 101, "rpc:continuity:final-index", projection.reviewFacts.payloadHash), operationIndex: 1 })).resolves.toBe("incident");
    row = await rawPool.query<{ readonly state: string; readonly block: string; readonly operation_index: number; readonly sequence: string; readonly incidents: string }>(
      `SELECT state,canonical_block_hash AS block,included_operation_index AS operation_index,last_rpc_source_sequence::text AS sequence,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='FINALIZED_CHAIN_CONTRADICTION') AS incidents
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(row.rows[0]).toEqual({ state: "FINALIZED", block: "Babcdefghijkmnpq", operation_index: 0, sequence: "4", incidents: "2" });

    await authority.scheduleReconciliation(claim.attemptId);
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, finalObservation)).resolves.toBe("duplicate");
  });

  it("rejects a changed inclusion tuple from a durable confirmed state", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, includedObservation(1, 101, "rpc:confirmed:first", projection.reviewFacts.payloadHash));
    await rawPool.query(`UPDATE samurai_persistence.operation_attempts SET state='CONFIRMED',finalized_at=NULL WHERE id=$1`, [claim.attemptId]);
    await rawPool.query(`UPDATE samurai_persistence.service_receipts SET state='CONFIRMED',finalized_at=NULL WHERE attempt_id=$1`, [claim.attemptId]);
    await rawPool.query(`UPDATE samurai_persistence.receipt_intents SET state='CONFIRMED',finalized_at=NULL
      WHERE id=(SELECT intent_id FROM samurai_persistence.operation_attempts WHERE id=$1)`, [claim.attemptId]);
    await authority.scheduleReconciliation(claim.attemptId);
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, { ...includedObservation(2, 101, "rpc:confirmed:block", projection.reviewFacts.payloadHash),
      includedBlockHash: "B222222222222222", canonicalChainProof: [
        { level: 100, blockHash: "B222222222222222", predecessorHash: null },
        { level: 101, blockHash: "Bbcdefghijkmnprs", predecessorHash: "B222222222222222" },
      ] })).resolves.toBe("incident");
    const row = await rawPool.query<{ readonly state: string; readonly block: string; readonly incidents: string }>(
      `SELECT state,canonical_block_hash AS block,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='CHAIN_OR_MANIFEST_DRIFT') AS incidents
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(row.rows[0]).toEqual({ state: "CONFIRMED", block: "Babcdefghijkmnpq", incidents: "1" });
  });

  it("preserves finalized authority on regressed or discontinuous proofs and accepts exact continuation", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, includedObservation(1, 101, "rpc:terminal:first", projection.reviewFacts.payloadHash));

    await authority.scheduleReconciliation(claim.attemptId);
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, includedObservation(2, 100, "rpc:terminal:regressed", projection.reviewFacts.payloadHash))).resolves.toBe("incident");

    await authority.scheduleReconciliation(claim.attemptId);
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, { ...includedObservation(3, 102, "rpc:terminal:fork", projection.reviewFacts.payloadHash),
      headBlockHash: "B333333333333333", canonicalChainProof: [
        { level: 100, blockHash: "Babcdefghijkmnpq", predecessorHash: null },
        { level: 101, blockHash: "B222222222222222", predecessorHash: "Babcdefghijkmnpq" },
        { level: 102, blockHash: "B333333333333333", predecessorHash: "B222222222222222" },
      ] })).resolves.toBe("incident");

    await authority.scheduleReconciliation(claim.attemptId);
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, { ...includedObservation(4, 102, "rpc:terminal:continued", projection.reviewFacts.payloadHash),
      headBlockHash: "B333333333333333", canonicalChainProof: [
        { level: 100, blockHash: "Babcdefghijkmnpq", predecessorHash: null },
        { level: 101, blockHash: "Bbcdefghijkmnprs", predecessorHash: "Babcdefghijkmnpq" },
        { level: 102, blockHash: "B333333333333333", predecessorHash: "Bbcdefghijkmnprs" },
      ] })).resolves.toBe("applied");
    const row = await rawPool.query<{ readonly state: string; readonly confirmations: number; readonly sequence: string; readonly head: string; readonly incidents: string }>(
      `SELECT state,confirmations,last_rpc_source_sequence::text AS sequence,last_head_block_hash AS head,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='FINALIZED_CHAIN_CONTRADICTION') AS incidents
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [attempt.publicAttemptRef]);
    expect(row.rows[0]).toEqual({ state: "FINALIZED", confirmations: 3, sequence: "4", head: "B333333333333333", incidents: "2" });
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
      canonicalChainProof: [{ level: 100, blockHash: "B222222222222222", predecessorHash: null },
        { level: 101, blockHash: "B333333333333333", predecessorHash: "B222222222222222" },
        { level: 102, blockHash: "Bbcdefghijkmnprt", predecessorHash: "B333333333333333" }],
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
    await expect(authority.replaceAttempt(predecessor.rows[0]!.id, { operationHash: OPERATION, counter: 7 }))
      .rejects.toMatchObject({ code: "23505" });
    const hashIndex = await rawPool.query<{ readonly indexdef: string }>(`SELECT indexdef FROM pg_indexes
      WHERE schemaname='samurai_persistence' AND tablename='operation_attempts' AND indexdef LIKE '%(chain_id, operation_hash)%'`);
    expect(hashIndex.rows).toHaveLength(1);
    expect(hashIndex.rows[0]!.indexdef).toContain("UNIQUE INDEX");
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
      canonicalChainProof: [{ level: 100, blockHash: "B222222222222222", predecessorHash: null }, { level: 101, blockHash: "Bbcdefghijkmnprt", predecessorHash: "B222222222222222" }],
      receiptEvent: null,
    });
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, {
      ...includedObservation(3, 102, "rpc:reinclude:3", projection.reviewFacts.payloadHash),
      includedLevel: 102,
      includedBlockHash: "Babcdefghijkmnpr",
      headBlockHash: "Babcdefghijkmnpr",
      canonicalChainProof: [{ level: 102, blockHash: "Babcdefghijkmnpr", predecessorHash: null }],
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

  it("rejects a reorg proof that does not identify the exact current canonical block", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, includedObservation(1, 100, "rpc:reorg-proof:included", projection.reviewFacts.payloadHash));
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, {
      ...includedObservation(2, 101, "rpc:reorg-proof:mismatch", projection.reviewFacts.payloadHash),
      disposition: "REORGED",
      includedLevel: 99,
      includedBlockHash: "B444444444444444",
      headBlockHash: "B555555555555555",
      canonicalChainProof: [
        { level: 99, blockHash: "B666666666666666", predecessorHash: null },
        { level: 100, blockHash: "B777777777777777", predecessorHash: "B666666666666666" },
        { level: 101, blockHash: "B555555555555555", predecessorHash: "B777777777777777" },
      ],
      receiptEvent: null,
    })).resolves.toBe("incident");
    const row = await rawPool.query<{ readonly state: string; readonly block: string; readonly incidents: string }>(
      `SELECT attempt.state,attempt.canonical_block_hash AS block,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='CHAIN_OR_MANIFEST_DRIFT') AS incidents
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [attempt.publicAttemptRef],
    );
    expect(row.rows[0]).toEqual({ state: "INCLUDED", block: "Babcdefghijkmnpq", incidents: "1" });
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

  it("persists indexer hints without mutation and keeps high indexer ordering independent from canonical RPC", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    const hint = { ...includedObservation(999, 100, "indexer:hint:999", projection.reviewFacts.payloadHash), observer: "fake-indexer" as const, canonicalChainProof: null };
    await expect(authority.observeOperation(claim, hint)).resolves.toBe("hint");
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, includedObservation(1, 100, "rpc:canonical:1", projection.reviewFacts.payloadHash))).resolves.toBe("applied");
    const row = await rawPool.query<{ readonly state: string; readonly rpc: string; readonly indexer: string; readonly hints: string }>(
      `SELECT attempt.state,attempt.last_rpc_source_sequence::text AS rpc,attempt.last_indexer_source_sequence::text AS indexer,
        (SELECT count(*)::text FROM samurai_persistence.receipt_chain_observations WHERE attempt_id=attempt.id AND apply_result='RECORDED_HINT') AS hints
       FROM samurai_persistence.operation_attempts attempt WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef],
    );
    expect(row.rows[0]).toEqual({ state: "INCLUDED", rpc: "1", indexer: "999", hints: "1" });
  });

  it("opens RPC/indexer divergence without projection mutation in both source orders", async () => {
    const first = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, { ...includedObservation(900, 100, "indexer:diverge:first", first.projection.reviewFacts.payloadHash),
      observer: "fake-indexer", headBlockHash: "B999999999999999", canonicalChainProof: null });
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, includedObservation(1, 100, "rpc:diverge:second", first.projection.reviewFacts.payloadHash))).resolves.toBe("incident");
    let row = await rawPool.query<{ readonly state: string; readonly incidents: string }>(
      `SELECT state,(SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='RPC_INDEXER_DIVERGENCE') AS incidents
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [first.attempt.publicAttemptRef]);
    expect(row.rows[0]).toEqual({ state: "SUBMITTED", incidents: "1" });

    await rawPool.query("DROP SCHEMA IF EXISTS samurai_persistence CASCADE");
    await applyMigrations(pool);
    const now = (await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await rawPool.query("INSERT INTO samurai_persistence.players (id,state,created_at,updated_at) VALUES ('player_phase2b_test_001','active',$1,$1)", [now]);
    const second = await submittedAttempt();
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, includedObservation(1, 100, "rpc:diverge:first", second.projection.reviewFacts.payloadHash));
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, { ...includedObservation(900, 100, "indexer:diverge:second", second.projection.reviewFacts.payloadHash),
      observer: "fake-indexer", headBlockHash: "B999999999999999", canonicalChainProof: null })).resolves.toBe("incident");
    row = await rawPool.query<{ readonly state: string; readonly incidents: string }>(
      `SELECT state,(SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='RPC_INDEXER_DIVERGENCE') AS incidents
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [second.attempt.publicAttemptRef]);
    expect(row.rows[0]).toEqual({ state: "INCLUDED", incidents: "1" });
  });

  it("opens byte-exact source-sequence contradictions before reducer mutation", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    const original = includedObservation(1, 100, "rpc:exact:1", projection.reviewFacts.payloadHash);
    await authority.observeOperation(claim, original);
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, {
      ...original,
      sourceObservationId: "rpc:exact:changed-id",
      receiptEvent: { ...original.receiptEvent!, payloadHash: "f".repeat(64) },
    })).resolves.toBe("incident");
    const row = await rawPool.query<{ readonly state: string; readonly observations: string; readonly incidents: string; readonly occurrences: string }>(
      `SELECT attempt.state,
        (SELECT count(*)::text FROM samurai_persistence.receipt_chain_observations WHERE attempt_id=attempt.id) AS observations,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='OBSERVATION_HISTORY_CONTRADICTION') AS incidents,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incident_occurrences occurrence JOIN samurai_persistence.receipt_incidents incident ON incident.id=occurrence.incident_id WHERE incident.attempt_id=attempt.id) AS occurrences
       FROM samurai_persistence.operation_attempts attempt WHERE attempt.public_attempt_ref=$1`, [attempt.publicAttemptRef],
    );
    expect(row.rows[0]).toEqual({ state: "INCLUDED", observations: "1", incidents: "1", occurrences: "1" });
  });

  it("rejects every illegal raw-SQL attempt evidence shape", async () => {
    const { attempt } = await submittedAttempt();
    const illegal = [
      "confirmations=1",
      "canonical_block_level=1,canonical_block_hash='B111111111111111',included_operation_index=0",
      "included_at=clock_timestamp()",
      "orphaned_block_level=1,orphaned_block_hash='B111111111111111',orphaned_at=clock_timestamp()",
      "failure_code='PRETEND'",
      "state='FAILED',failure_code='CHAIN_REJECTED',canonical_block_level=1,canonical_block_hash='B111111111111111',included_operation_index=0",
      "state='DROPPED',failure_code='CHAIN_DROPPED',confirmations=2",
      "state='REPLACED',included_at=clock_timestamp()",
      "state='INCLUDED',included_at=clock_timestamp(),confirmations=1",
      "state='CONFIRMED',included_at=clock_timestamp(),confirmed_at=clock_timestamp(),confirmations=2",
      "state='FINALIZED',included_at=clock_timestamp(),confirmed_at=clock_timestamp(),finalized_at=clock_timestamp(),confirmations=2,policy_evidence='PRETEND'",
      "state='INCLUDED',canonical_block_level=1,canonical_block_hash='B111111111111111',included_operation_index=0,included_at=clock_timestamp(),confirmations=1,last_head_level=1,last_head_block_hash='B111111111111111'",
      "state='INCLUDED',canonical_block_level=1,canonical_block_hash='B111111111111111',included_operation_index=0,included_at=clock_timestamp(),confirmations=1,last_rpc_source_sequence=1,last_head_level=2,last_head_block_hash='B222222222222222'",
      "state='CONFIRMED',canonical_block_level=1,canonical_block_hash='B111111111111111',included_operation_index=0,included_at=clock_timestamp(),confirmed_at=clock_timestamp(),confirmations=3,policy_evidence='PRETEND',last_rpc_source_sequence=1,last_head_level=2,last_head_block_hash='B222222222222222'",
      "state='FINALIZED',canonical_block_level=1,canonical_block_hash='B111111111111111',included_operation_index=0,included_at=clock_timestamp(),confirmed_at=clock_timestamp(),finalized_at=clock_timestamp(),confirmations=2,policy_evidence='PRETEND',last_head_level=2,last_head_block_hash='B222222222222222'",
      "state='REORGED',included_at=clock_timestamp(),orphaned_block_level=1,orphaned_block_hash='B111111111111111',orphaned_at=clock_timestamp(),canonical_block_level=1,canonical_block_hash='B222222222222222',included_operation_index=0",
    ];
    for (const assignment of illegal) {
      await expect(rawPool.query(`UPDATE samurai_persistence.operation_attempts SET ${assignment} WHERE public_attempt_ref=$1`, [attempt.publicAttemptRef]))
        .rejects.toMatchObject({ code: "23514" });
    }
  });

  it("represents a later independent retry after failure without replacement lineage", async () => {
    const { attempt } = await submittedAttempt();
    const claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await authority.observeOperation(claim, {
      observer: "fake-rpc", sourceObservationId: "rpc:failed:1", sourceSequence: 1, disposition: "FAILED",
      chainId: claim.identity.chainId, operationHash: claim.identity.operationHash, sourceAccount: claim.identity.sourceAccount,
      contractAddress: claim.identity.contractAddress, deploymentManifestHash: claim.identity.deploymentManifestHash,
      headLevel: 100, headBlockHash: "B111111111111111", includedBlockHash: null, includedLevel: null, operationIndex: null,
      failureCode: "CHAIN_REJECTED", canonicalChainProof: null, receiptEvent: null,
    });
    const predecessor = await rawPool.query<{ readonly id: string }>("SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [attempt.publicAttemptRef]);
    const retry = await authority.retryAttempt(predecessor.rows[0]!.id, { operationHash: `o${"4".repeat(50)}`, counter: 8 });
    const row = await rawPool.query<{ readonly retries: string; readonly replacements: string; readonly prior: string; readonly next: string }>(
      `SELECT count(*) FILTER (WHERE retry_of_attempt_id=$1)::text AS retries,
        count(*) FILTER (WHERE replaces_attempt_id=$1)::text AS replacements,
        max(state) FILTER (WHERE id=$1) AS prior,max(state) FILTER (WHERE id=$2) AS next
       FROM samurai_persistence.operation_attempts WHERE intent_id=(SELECT intent_id FROM samurai_persistence.operation_attempts WHERE id=$1)`,
      [predecessor.rows[0]!.id, retry.attemptId],
    );
    expect(row.rows[0]).toEqual({ retries: "1", replacements: "0", prior: "FAILED", next: "SUBMITTED" });
  });

  it("treats canonical inclusion of a replaced predecessor as a durable conflict", async () => {
    const { attempt, projection } = await submittedAttempt();
    const predecessor = await rawPool.query<{ readonly id: string }>("SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [attempt.publicAttemptRef]);
    await authority.replaceAttempt(predecessor.rows[0]!.id, { operationHash: `o${"2".repeat(50)}`, counter: 7 });
    const claims = await authority.claimReconciliation(10, 30_000);
    const oldClaim = claims.find((value) => value.attemptId === predecessor.rows[0]!.id)!;
    await expect(authority.observeOperation(oldClaim, includedObservation(1, 100, "rpc:replaced:1", projection.reviewFacts.payloadHash))).resolves.toBe("incident");
    const row = await rawPool.query<{ readonly state: string; readonly incidents: string; readonly receipts: string }>(
      `SELECT state,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incidents WHERE attempt_id=attempt.id AND kind='CANONICAL_ATTEMPT_CONFLICT') AS incidents,
        (SELECT count(*)::text FROM samurai_persistence.service_receipts WHERE intent_id=attempt.intent_id) AS receipts
       FROM samurai_persistence.operation_attempts attempt WHERE id=$1`, [predecessor.rows[0]!.id],
    );
    expect(row.rows[0]).toEqual({ state: "REPLACED", incidents: "1", receipts: "0" });
  });

  it("fences a reclaimed worker before apply while the new generation commits", async () => {
    const { projection } = await submittedAttempt();
    const staleClaim = (await authority.claimReconciliation(1, 30_000))[0]!;
    let release!: () => void;
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const atFetch = new Promise<void>((resolve) => { reached = resolve; });
    const staleApply = authority.reconcileAttempt(staleClaim, {
      observe: async () => { reached(); await blocked; return includedObservation(1, 100, "rpc:stale-worker:1", projection.reviewFacts.payloadHash); },
    });
    await atFetch;
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET claim_expires_at=clock_timestamp() WHERE attempt_id=$1", [staleClaim.attemptId]);
    const liveClaim = (await authority.claimReconciliation(1, 30_000))[0]!;
    expect(liveClaim.claimGeneration).toBe(staleClaim.claimGeneration + 1);
    release();
    await expect(staleApply).rejects.toBeInstanceOf(ReceiptWorkerClaimLostError);
    await expect(authority.observeOperation(liveClaim, includedObservation(1, 100, "rpc:live-worker:1", projection.reviewFacts.payloadHash))).resolves.toBe("applied");
  });

  it("retries byte-exactly after a simulated lost response without duplicate projection", async () => {
    const { attempt, projection } = await submittedAttempt();
    let claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    const exact = includedObservation(1, 100, "rpc:commit-uncertainty:1", projection.reviewFacts.payloadHash);
    await authority.observeOperation(claim, exact); // committed response is deliberately ignored
    await rawPool.query("UPDATE samurai_persistence.receipt_reconciliation_jobs SET available_at=clock_timestamp() WHERE state='pending'");
    claim = (await authority.claimReconciliation(1, 30_000))[0]!;
    await expect(authority.observeOperation(claim, exact)).resolves.toBe("duplicate");
    const row = await rawPool.query<{ readonly observations: string; readonly receipts: string }>(
      `SELECT (SELECT count(*)::text FROM samurai_persistence.receipt_chain_observations WHERE attempt_id=attempt.id) AS observations,
        (SELECT count(*)::text FROM samurai_persistence.service_receipts WHERE attempt_id=attempt.id) AS receipts
       FROM samurai_persistence.operation_attempts attempt WHERE public_attempt_ref=$1`, [attempt.publicAttemptRef],
    );
    expect(row.rows[0]).toEqual({ observations: "1", receipts: "1" });
  });

  it("serializes inclusion-before-replacement and replacement-before-inclusion at explicit barriers", async () => {
    const first = await submittedAttempt();
    const firstId = (await rawPool.query<{ readonly id: string }>("SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [first.attempt.publicAttemptRef])).rows[0]!.id;
    const firstClaim = (await authority.claimReconciliation(1, 30_000))[0]!;
    let releaseObservation!: () => void;
    let reachedObservation!: () => void;
    const observationBlocked = new Promise<void>((resolve) => { releaseObservation = resolve; });
    const observationReached = new Promise<void>((resolve) => { reachedObservation = resolve; });
    let holdObservation = true;
    const observationFirst = new ReceiptLifecycleAuthority(pool, service, { afterWriteBoundary: async (boundary) => {
      if (boundary === "observation" && holdObservation) { holdObservation = false; reachedObservation(); await observationBlocked; }
    } });
    const inclusion = observationFirst.observeOperation(firstClaim, includedObservation(1, 100, "rpc:race:inclusion-first", first.projection.reviewFacts.payloadHash));
    await observationReached;
    const losingReplacement = observationFirst.replaceAttempt(firstId, { operationHash: `o${"5".repeat(50)}`, counter: 7 });
    releaseObservation();
    await expect(inclusion).resolves.toBe("applied");
    await expect(losingReplacement).rejects.toMatchObject({ code: "REPLACEMENT_LINEAGE_MISMATCH" });

    await rawPool.query("DROP SCHEMA IF EXISTS samurai_persistence CASCADE");
    await applyMigrations(pool);
    const now = (await rawPool.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await rawPool.query("INSERT INTO samurai_persistence.players (id,state,created_at,updated_at) VALUES ('player_phase2b_test_001','active',$1,$1)", [now]);
    const second = await submittedAttempt();
    const secondId = (await rawPool.query<{ readonly id: string }>("SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [second.attempt.publicAttemptRef])).rows[0]!.id;
    let releaseAttempt!: () => void;
    let reachedAttempt!: () => void;
    const attemptBlocked = new Promise<void>((resolve) => { releaseAttempt = resolve; });
    const attemptReached = new Promise<void>((resolve) => { reachedAttempt = resolve; });
    let holdAttempt = true;
    const replacementFirst = new ReceiptLifecycleAuthority(pool, service, { afterWriteBoundary: async (boundary) => {
      if (boundary === "attempt" && holdAttempt) { holdAttempt = false; reachedAttempt(); await attemptBlocked; }
    } });
    const replacement = replacementFirst.replaceAttempt(secondId, { operationHash: `o${"6".repeat(50)}`, counter: 7 });
    await attemptReached;
    const oldClaim = (await replacementFirst.claimReconciliation(10, 30_000)).find((value) => value.attemptId === secondId)!;
    const conflictingInclusion = replacementFirst.observeOperation(oldClaim, includedObservation(1, 100, "rpc:race:replacement-first", second.projection.reviewFacts.payloadHash));
    releaseAttempt();
    await expect(replacement).resolves.toMatchObject({ publicAttemptRef: expect.stringMatching(/^ra_/) });
    await expect(conflictingInclusion).resolves.toBe("incident");
  });

  it("binds reconciliation incidents to their exact intent and attempt", async () => {
    await rawPool.query("INSERT INTO samurai_persistence.players (id,state,created_at,updated_at) VALUES ('player_phase2b_test_002','active',clock_timestamp(),clock_timestamp())");
    const serviceFor = (subjectId: string): EveningServiceAuthority => ({
      runSettledTransaction: async <T>(_credential: unknown, _scope: string, operation: (context: SettledServiceTransactionContext) => Promise<T>): Promise<T> => runner.run(async (client) => {
        const clock = await client.query<{ readonly now: Date }>("SELECT clock_timestamp() AS now");
        return operation({ client, subjectKind: "player", subjectId, checkpoint: deterministicSettledCheckpointFixture(), now: clock.rows[0]!.now });
      }),
    } as unknown as EveningServiceAuthority);
    const firstAuthority = new ReceiptLifecycleAuthority(pool, serviceFor("player_phase2b_test_001"), { maximumConsecutiveFailures: 1 });
    const secondAuthority = new ReceiptLifecycleAuthority(pool, serviceFor("player_phase2b_test_002"), { maximumConsecutiveFailures: 1 });
    const firstProjection = await prepare("31", "incident-scope-first", firstAuthority, OWNER);
    await firstAuthority.markAwaitingSignature({ kind: "player", sessionSecret: "server-fixture" }, firstProjection.intent.intentRef);
    const firstAttempt = await firstAuthority.registerSubmittedAttempt({ kind: "player", sessionSecret: "server-fixture" }, { publicIntentRef: firstProjection.intent.intentRef, operationHash: `o${"7".repeat(50)}`, counter: 1 });
    const secondOwner = "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6";
    const secondProjection = await prepare("32", "incident-scope-second", secondAuthority, secondOwner);
    await secondAuthority.markAwaitingSignature({ kind: "player", sessionSecret: "server-fixture" }, secondProjection.intent.intentRef);
    const secondAttempt = await secondAuthority.registerSubmittedAttempt({ kind: "player", sessionSecret: "server-fixture" }, { publicIntentRef: secondProjection.intent.intentRef, operationHash: `o${"8".repeat(50)}`, counter: 1 });
    const allClaims = await firstAuthority.claimReconciliation(10, 30_000);
    for (const [target, ref] of [[firstAuthority, firstAttempt.publicAttemptRef], [secondAuthority, secondAttempt.publicAttemptRef]] as const) {
      const attemptId = (await rawPool.query<{ readonly id: string }>("SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [ref])).rows[0]!.id;
      const claim = allClaims.find((value) => value.attemptId === attemptId)!;
      await expect(target.recordReconciliationFailure(claim, "FAKE_RPC_UNAVAILABLE")).resolves.toBe("dead-letter");
    }
    const incidents = await rawPool.query<{ readonly count: string; readonly owners: string }>(
      `SELECT count(*)::text AS count,count(DISTINCT intent_id || ':' || attempt_id)::text AS owners
       FROM samurai_persistence.receipt_incidents WHERE kind='RECONCILIATION_EXHAUSTED'`,
    );
    expect(incidents.rows[0]).toEqual({ count: "2", owners: "2" });
    const firstAttemptId = (await rawPool.query<{ readonly id: string }>("SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [firstAttempt.publicAttemptRef])).rows[0]!.id;
    await rawPool.query(`UPDATE samurai_persistence.receipt_reconciliation_jobs SET state='pending',available_at=clock_timestamp(),
      claim_token=NULL,claim_expires_at=NULL,consecutive_failure_count=0,dead_lettered_at=NULL,last_error_code=NULL WHERE attempt_id=$1`, [firstAttemptId]);
    const retryClaim = (await firstAuthority.claimReconciliation(10, 30_000)).find((value) => value.attemptId === firstAttemptId)!;
    await expect(firstAuthority.recordReconciliationFailure(retryClaim, "FAKE_RPC_UNAVAILABLE")).resolves.toBe("dead-letter");
    const reused = await rawPool.query<{ readonly incidents: string; readonly occurrences: string; readonly occurrence_count: string }>(
      `SELECT count(*)::text AS incidents,
        (SELECT count(*)::text FROM samurai_persistence.receipt_incident_occurrences occurrence
          WHERE occurrence.incident_id=(SELECT scoped.id FROM samurai_persistence.receipt_incidents scoped
            WHERE scoped.attempt_id=$1 AND scoped.kind='RECONCILIATION_EXHAUSTED' LIMIT 1)) AS occurrences,
        max(incident.occurrence_count)::text AS occurrence_count
       FROM samurai_persistence.receipt_incidents incident WHERE attempt_id=$1 AND kind='RECONCILIATION_EXHAUSTED'`, [firstAttemptId],
    );
    expect(reused.rows[0]).toEqual({ incidents: "1", occurrences: "2", occurrence_count: "2" });
    const firstIds = await rawPool.query<{ readonly intent_id: string; readonly attempt_id: string }>(
      `SELECT intent_id::text, id::text AS attempt_id FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1`, [firstAttempt.publicAttemptRef],
    );
    await expect(rawPool.query(`INSERT INTO samurai_persistence.receipt_incidents
      (id,kind,scope_digest,state,intent_id,attempt_id,opened_at,last_seen_at)
      VALUES ('00000000-0000-4000-8000-000000000001','RECONCILIATION_EXHAUSTED',decode(repeat('aa',32),'hex'),'OPEN',$1,$2,clock_timestamp(),clock_timestamp())`,
      [firstIds.rows[0]!.intent_id, (await rawPool.query<{ readonly id: string }>("SELECT id::text FROM samurai_persistence.operation_attempts WHERE public_attempt_ref=$1", [secondAttempt.publicAttemptRef])).rows[0]!.id]))
      .rejects.toMatchObject({ code: "23503" });
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
