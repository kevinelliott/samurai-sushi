import { createHash, generateKeyPairSync, sign as signMessage } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { b58Encode, getPkhfromPk, PrefixV2 } from "@taquito/utils";
import { canonicalJson } from "@samurai-sushi/domain";
import { walletLinkSigningBytes } from "@samurai-sushi/wallet-link";
import { RECEIPT_AUTHORITY_MANIFEST_HASH } from "@samurai-sushi/receipt-authority";
import type { ReceiptPermitSigner } from "@samurai-sushi/receipt-authority/server";
import { deterministicSettledCheckpointFixture } from "../../receipt-authority/src/test-fixture";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ConnectedSqlClient, QueryResult, SqlPool, SqlValue } from "../src/database";
import { TransactionRunner } from "../src/database";
import { applyMigrations } from "../src/migrations";
import { ReceiptLifecycleAuthority } from "../src/receipt-lifecycle-authority";
import { ReceiptReviewWalletAuthority } from "../src/receipt-review-wallet-authority";
import type { EveningServiceAuthority, SettledServiceTransactionContext } from "../src/service-authority";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; receipt review wallet integration must never skip silently.");

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

const PLAYER = "player_phase2c_test_001";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CLAIM = "33333333-3333-4333-8333-333333333333";
const CREDENTIAL = "44444444-4444-4444-8444-444444444444";
const ACCOUNT = "tz1MsZxMSJdiUV9hVs4UKAMrXtksDvxWAZe2";
const PUBLIC_KEY = "edpkuZpp81M8NmaFbueXY8bk7EP9V54XTnwsFFt77Z5FTPs2QzLU9r";
const SECRET = Buffer.from("0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", "hex");
const signer: ReceiptPermitSigner = (payloadHash) => b58Encode(ed25519.sign(blake2b(Buffer.from(payloadHash, "hex"), { dkLen: 32 }), SECRET), PrefixV2.Ed25519Signature);

describe("Phase 2C receipt review wallet authority", () => {
  const raw = new Pool({ connectionString: databaseUrl }); const pool = new PgPoolAdapter(raw); const runner = new TransactionRunner(pool);
  let review: ReceiptReviewWalletAuthority;
  let authorityNow: Date | null;
  beforeEach(async () => {
    authorityNow = null;
    await raw.query("DROP SCHEMA IF EXISTS samurai_persistence CASCADE"); await applyMigrations(pool);
    const now = (await raw.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await raw.query("INSERT INTO samurai_persistence.players (id,state,created_at,updated_at) VALUES ($1,'active',$2,$2)", [PLAYER, now]);
    await raw.query(`INSERT INTO samurai_persistence.player_sessions
      (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
      VALUES ($1,$2,'claim',$3,'active',1,$4,$4,$5,$6)`, [SESSION, PLAYER, CLAIM, now,
      new Date(now.getTime() + 86_400_000), new Date(now.getTime() + 43_200_000)]);
    const service = { runSettledTransaction: async <T>(_credential: unknown, _scope: string,
      operation: (context: SettledServiceTransactionContext) => Promise<T>) => runner.run(async (client) => {
        const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
        const operationClient = authorityNow === null ? client : {
          query: <Row extends object>(text: string, values?: readonly SqlValue[]) => text.includes("receipt-review-final-authority-clock")
            ? Promise.resolve({ rows: [{ now: authorityNow }] as Row[], rowCount: 1 })
            : client.query<Row>(text, values),
        };
        return operation({ client: operationClient, subjectKind: "player", subjectId: PLAYER, playerSessionId: SESSION,
          playerSessionDeliveryGeneration: 1, checkpoint: deterministicSettledCheckpointFixture(), now: authorityNow ?? clock.rows[0]!.now });
      }) } as unknown as EveningServiceAuthority;
    const receipts = new ReceiptLifecycleAuthority(pool, service, { reconciliationDelayMs: 1, maximumConsecutiveFailures: 2 });
    review = new ReceiptReviewWalletAuthority(pool, service, receipts, { canonicalOrigin: "https://game.samurai-sushi.example",
      destination: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton", issuerKeyId: "localnet-issuer-2026-01",
      issuerPolicyVersion: "1", signer });
  });
  afterAll(async () => raw.end());

  const runtime = { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc", account: ACCOUNT, permissionScopes: ["account"] as const };
  const credential = { kind: "player", sessionSecret: "fixture" } as const;

  it("keeps permission-only runtime unverified and creates no receipt or credential", async () => {
    const access = await review.syncRuntime(credential, { idempotencyKey: "phase2c-runtime-0001", runtimeGeneration: 1, sessionRevision: 0, runtime });
    expect(access).toMatchObject({ state: "ACCOUNT_PROOF_UNAVAILABLE", credentialMatch: false, reason: "ACCOUNT_PROOF_UNAVAILABLE" });
    await expect(review.prepareReview(credential, { idempotencyKey: "phase2c-prepare-0001", walletLinkRef: access.walletLinkRef,
      runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision })).rejects.toMatchObject({ code: "WALLET_LINK_REQUIRED" });
    expect((await raw.query<{ credentials: string; intents: string }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.wallet_credentials) credentials,
      (SELECT count(*)::text FROM samurai_persistence.receipt_intents) intents`)).rows[0]).toEqual({ credentials: "0", intents: "0" });
  });

  it("consumes a deterministic purpose proof once and replays only its exact committed public result", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    const publicKeyText = b58Encode(der.subarray(der.byteLength - 32), PrefixV2.Ed25519PublicKey);
    const account = getPkhfromPk(publicKeyText);
    const fixtureRuntime = { ...runtime, account };
    const access = await review.syncRuntime(credential, { idempotencyKey: "phase2c-proof-runtime-01",
      runtimeGeneration: 2, sessionRevision: 3, runtime: fixtureRuntime });
    const issued = await review.issueChallenge(credential, { idempotencyKey: "phase2c-proof-challenge-1",
      walletLinkRef: access.walletLinkRef, runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision });
    const proof = { challenge: issued.challenge, publicKey: publicKeyText,
      signature: b58Encode(signMessage(null, blake2b(walletLinkSigningBytes(issued.challenge), { dkLen: 32 }), privateKey),
        PrefixV2.Ed25519Signature) };
    const input = { idempotencyKey: "phase2c-proof-consume-001", walletLinkRef: access.walletLinkRef,
      challengeId: issued.challengeId, proof };
    const linked = await review.consumeProof(credential, input);
    expect(linked).toMatchObject({ state: "ACTIVE_CREDENTIAL_MATCH", credentialMatch: true, account });
    expect(await review.consumeProof(credential, input)).toEqual(linked);
    await expect(review.consumeProof(credential, { ...input, idempotencyKey: "phase2c-proof-consume-002" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    expect((await raw.query<{ count: string }>("SELECT count(*)::text AS count FROM samurai_persistence.wallet_credentials")).rows[0]?.count)
      .toBe("1");
  });

  it("prepares and restores only an exact active credential match and fences stale or expired preflight", async () => {
    const now = (await raw.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await raw.query(`INSERT INTO samurai_persistence.wallet_credentials
      (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
      VALUES ($1,$2,'NetXtJqPyJGB6Pc',$3,$4,'tz1',$5,$6)`, [CREDENTIAL, PLAYER, ACCOUNT, PUBLIC_KEY, CLAIM, now]);
    const access = await review.syncRuntime(credential, { idempotencyKey: "phase2c-runtime-0002", runtimeGeneration: 4, sessionRevision: 8, runtime });
    expect(access).toMatchObject({ state: "ACTIVE_CREDENTIAL_MATCH", credentialMatch: true, runtimeGeneration: 4, sessionRevision: 9 });
    const input = { idempotencyKey: "phase2c-prepare-0002", walletLinkRef: access.walletLinkRef,
      runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision };
    const projection = await review.prepareReview(credential, input);
    expect(await review.restoreLatestReview(credential)).toEqual(projection);
    await expect(review.restoreReviewState(credential)).resolves.toMatchObject({ projection,
      walletAccess: { walletLinkRef: access.walletLinkRef, state: "ACTIVE_CREDENTIAL_MATCH", credentialMatch: true } });
    expect(projection.reviewFacts).toMatchObject({ owner: ACCOUNT, source: ACCOUNT,
      network: { deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH }, entrypoint: "submit_receipt", attachedMutez: "0" });
    const reviewDigest = createHash("sha256").update(canonicalJson(projection)).digest("hex");
    await expect(review.preflight(credential, { ...input, idempotencyKey: "phase2c-flight-0001", publicIntentRef: projection.intent.intentRef,
      expectedProjectionRevision: projection.projectionRevision, reviewDigest })).resolves.toMatchObject({ status: "REVIEW_READY", reviewDigest });
    await expect(review.preflight(credential, { ...input, idempotencyKey: "phase2c-flight-0002", sessionRevision: access.sessionRevision + 1,
      publicIntentRef: projection.intent.intentRef, expectedProjectionRevision: projection.projectionRevision, reviewDigest }))
      .resolves.toEqual({ schemaVersion: 1, status: "NOT_READY", reason: "WALLET_SESSION_REVISION_STALE" });
    authorityNow = new Date(projection.intent.expiresAt);
    await expect(review.preflight(credential, { ...input, idempotencyKey: "phase2c-flight-0003", publicIntentRef: projection.intent.intentRef,
      expectedProjectionRevision: projection.projectionRevision, reviewDigest })).resolves.toMatchObject({ status: "NOT_READY", reason: "INTENT_EXPIRED" });
    authorityNow = null;
    await review.disconnect(credential, { idempotencyKey: "phase2c-disconnect-0001", walletLinkRef: access.walletLinkRef,
      runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision });
    const reconnected = await review.syncRuntime(credential, { idempotencyKey: "phase2c-runtime-0004",
      runtimeGeneration: 5, sessionRevision: 10, runtime });
    await expect(review.preflight(credential, { idempotencyKey: "phase2c-flight-0004", walletLinkRef: reconnected.walletLinkRef,
      runtimeGeneration: reconnected.runtimeGeneration, sessionRevision: reconnected.sessionRevision,
      publicIntentRef: projection.intent.intentRef, expectedProjectionRevision: projection.projectionRevision, reviewDigest }))
      .resolves.toEqual({ schemaVersion: 1, status: "NOT_READY", reason: "PROVIDER_CHANGED" });
  });

  it("rejects illegal credential and runtime state shapes at the SQL boundary", async () => {
    const now = (await raw.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await raw.query(`INSERT INTO samurai_persistence.wallet_credentials
      (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
      VALUES ($1,$2,'NetXtJqPyJGB6Pc',$3,$4,'tz1',$5,$6)`, [CREDENTIAL, PLAYER, ACCOUNT, PUBLIC_KEY, CLAIM, now]);
    await expect(raw.query("UPDATE samurai_persistence.wallet_credentials SET state='revoked' WHERE credential_id=$1", [CREDENTIAL]))
      .rejects.toMatchObject({ code: "23514" });
    const access = await review.syncRuntime(credential, { idempotencyKey: "phase2c-runtime-0003", runtimeGeneration: 1, sessionRevision: 0, runtime });
    await expect(review.syncRuntime(credential, { idempotencyKey: "phase2c-runtime-boundary", runtimeGeneration: Number.MAX_SAFE_INTEGER,
      sessionRevision: 0, runtime })).rejects.toMatchObject({ code: "WALLET_RUNTIME_INVALID" });
    await expect(raw.query("UPDATE samurai_persistence.wallet_runtime_links SET permission_scopes=ARRAY['account','sign'] WHERE public_link_ref=$1", [access.walletLinkRef]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(raw.query("UPDATE samurai_persistence.wallet_runtime_links SET state='DISCONNECTED' WHERE public_link_ref=$1", [access.walletLinkRef]))
      .rejects.toMatchObject({ code: "23514" });
    await raw.query(`UPDATE samurai_persistence.wallet_runtime_links
      SET runtime_generation=9007199254740991,session_revision=9007199254740991 WHERE public_link_ref=$1`, [access.walletLinkRef]);
    await expect(raw.query("UPDATE samurai_persistence.player_sessions SET delivery_generation=2 WHERE id=$1", [SESSION])).resolves.toMatchObject({ rowCount: 1 });
    expect((await raw.query<{ state: string; runtime_generation: string; session_revision: string }>(`SELECT state,runtime_generation::text,
      session_revision::text FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1`, [access.walletLinkRef])).rows[0])
      .toEqual({ state: "REVOKED", runtime_generation: String(Number.MAX_SAFE_INTEGER), session_revision: String(Number.MAX_SAFE_INTEGER) });
  });
});
