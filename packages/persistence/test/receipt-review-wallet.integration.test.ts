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

async function waitForDatabaseLock(pool: Pool, queryFragment: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const waiting = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM pg_stat_activity
      WHERE datname=current_database() AND pid <> pg_backend_pid() AND wait_event_type='Lock' AND query LIKE $1`, [`%${queryFragment}%`]);
    if (waiting.rows[0]?.count !== "0") return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`database lock barrier was not reached: ${queryFragment}`);
}

describe("Phase 2C receipt review wallet authority", () => {
  const raw = new Pool({ connectionString: databaseUrl }); const pool = new PgPoolAdapter(raw); const runner = new TransactionRunner(pool);
  let review: ReceiptReviewWalletAuthority;
  let authorityNow: Date | null;
  let contextNow: Date | null;
  beforeEach(async () => {
    authorityNow = null; contextNow = null;
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
          playerSessionDeliveryGeneration: 1, checkpoint: deterministicSettledCheckpointFixture(), now: contextNow ?? clock.rows[0]!.now });
      }) } as unknown as EveningServiceAuthority;
    const receipts = new ReceiptLifecycleAuthority(pool, service, { reconciliationDelayMs: 1, maximumConsecutiveFailures: 2 });
    review = new ReceiptReviewWalletAuthority(pool, service, receipts, { canonicalOrigin: "https://game.samurai-sushi.example",
      destination: "KT1RJ6PbjHpwc3M5rw5s2Nbmefwbuwbdxton", issuerKeyId: "localnet-issuer-2026-01",
      issuerPolicyVersion: "1", signer });
  });
  afterAll(async () => raw.end());

  const runtime = { providerId: "deterministic-wallet", chainId: "NetXtJqPyJGB6Pc", account: ACCOUNT, permissionScopes: ["account"] as const } as const;
  const credential = { kind: "player", sessionSecret: "fixture" } as const;

  it("returns settled guests a display-only proof-unavailable result without durable wallet authority", async () => {
    const guestService = { runSettledTransaction: async <T>(_credential: unknown, _scope: string,
      operation: (context: SettledServiceTransactionContext) => Promise<T>) => runner.run(async (client) => {
        const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
        return operation({ client, subjectKind: "guest", subjectId: "guest_phase2c_test_001", playerSessionId: null,
          playerSessionDeliveryGeneration: null, checkpoint: deterministicSettledCheckpointFixture(), now: clock.rows[0]!.now });
      }) } as unknown as EveningServiceAuthority;
    const guestReview = new ReceiptReviewWalletAuthority(pool, guestService, review.receipts, review.policy);
    const access = await guestReview.syncRuntime({ kind: "guest", resumeSecret: "fixture" }, {
      idempotencyKey: "phase2c-guest-runtime-0001", runtimeGeneration: 3, sessionRevision: 7, runtime,
    });
    expect(access).toEqual({ schemaVersion: 1, accessScope: "DISPLAY_ONLY", state: "ACCOUNT_PROOF_UNAVAILABLE",
      providerId: runtime.providerId, chainId: runtime.chainId, account: runtime.account, permissionScopes: ["account"],
      credentialMatch: false, reason: "ACCOUNT_PROOF_UNAVAILABLE",
      presentation: expect.objectContaining({ ref: "wallet.access.account-proof-unavailable" }) });
    expect(access).not.toHaveProperty("walletLinkRef"); expect(access).not.toHaveProperty("runtimeGeneration");
    const counts = (await raw.query<{ credentials: string; links: string; challenges: string; intents: string }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.wallet_credentials) AS credentials,
      (SELECT count(*)::text FROM samurai_persistence.wallet_runtime_links) AS links,
      (SELECT count(*)::text FROM samurai_persistence.wallet_link_challenges) AS challenges,
      (SELECT count(*)::text FROM samurai_persistence.receipt_intents) AS intents`)).rows[0]!;
    expect(counts).toEqual({ credentials: "0", links: "0", challenges: "0", intents: "0" });
  });

  it("keeps permission-only runtime unverified and creates no receipt or credential", async () => {
    const access = await review.syncRuntime(credential, { idempotencyKey: "phase2c-runtime-0001", runtimeGeneration: 1, sessionRevision: 0, runtime });
    expect(access).toMatchObject({ state: "ACCOUNT_PROOF_UNAVAILABLE", credentialMatch: false, reason: "ACCOUNT_PROOF_UNAVAILABLE" });
    await expect(review.restoreReviewState(credential)).resolves.toMatchObject({ projection: null,
      accessPresentation: { ref: "wallet.access.account-proof-unavailable", recoveryAction: null },
      walletAccess: { walletLinkRef: access.walletLinkRef, state: "ACCOUNT_PROOF_UNAVAILABLE" } });
    await expect(review.prepareReview(credential, { idempotencyKey: "phase2c-prepare-0001", walletLinkRef: access.walletLinkRef,
      runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision })).rejects.toMatchObject({ code: "WALLET_LINK_REQUIRED" });
    const issued = await review.issueChallenge(credential, { idempotencyKey: "phase2c-disconnect-challenge",
      walletLinkRef: access.walletLinkRef, runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision });
    const disconnected = await review.disconnect(credential, { idempotencyKey: "phase2c-disconnect-issued",
      walletLinkRef: access.walletLinkRef, runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision + 1 });
    expect(disconnected).toMatchObject({ state: "DISCONNECTED", credentialMatch: false });
    expect((await raw.query<{ state: string }>("SELECT state FROM samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1",
      [issued.challengeRef])).rows[0]).toEqual({ state: "REVOKED" });
    expect((await raw.query<{ linked_challenge_id: string | null; linked_challenge_state: string | null }>(`SELECT
      linked_challenge_id::text,linked_challenge_state FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1`,
    [access.walletLinkRef])).rows[0]).toEqual({ linked_challenge_id: null, linked_challenge_state: null });
    expect((await raw.query<{ credentials: string; intents: string }>(`SELECT
      (SELECT count(*)::text FROM samurai_persistence.wallet_credentials) credentials,
      (SELECT count(*)::text FROM samurai_persistence.receipt_intents) intents`)).rows[0]).toEqual({ credentials: "0", intents: "0" });
  });

  it("revokes a pending same-account proof generation without crossing the subject namespace", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    const proofPublicKey = b58Encode(der.subarray(der.byteLength - 32), PrefixV2.Ed25519PublicKey);
    const proofAccount = getPkhfromPk(proofPublicKey); const proofRuntime = { ...runtime, account: proofAccount };
    const access = await review.syncRuntime(credential, { idempotencyKey: "phase2c-revoke-pending-runtime",
      runtimeGeneration: 2, sessionRevision: 2, runtime: proofRuntime });
    const issued = await review.issueChallenge(credential, { idempotencyKey: "phase2c-revoke-pending-challenge",
      walletLinkRef: access.walletLinkRef, runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision });
    const proof = { challenge: issued.challenge, publicKey: proofPublicKey,
      signature: b58Encode(signMessage(null, blake2b(walletLinkSigningBytes(issued.challenge), { dkLen: 32 }), privateKey), PrefixV2.Ed25519Signature) };

    const otherPlayer = "player_phase2c_test_002"; const otherSession = "55555555-5555-4555-8555-555555555555";
    const now = (await raw.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await raw.query("INSERT INTO samurai_persistence.players (id,state,created_at,updated_at) VALUES ($1,'active',$2,$2)", [otherPlayer, now]);
    await raw.query(`INSERT INTO samurai_persistence.player_sessions
      (id,player_id,issuance_kind,issuance_id,state,delivery_generation,created_at,last_seen_at,expires_at,rotate_after)
      VALUES ($1,$2,'claim',$3,'active',1,$4,$4,$5,$6)`, [otherSession, otherPlayer,
      "66666666-6666-4666-8666-666666666666", now, new Date(now.getTime() + 86_400_000), new Date(now.getTime() + 43_200_000)]);
    const otherService = { runSettledTransaction: async <T>(_credential: unknown, _scope: string,
      operation: (context: SettledServiceTransactionContext) => Promise<T>) => runner.run(async (client) => {
        const clock = await client.query<{ now: Date }>("SELECT clock_timestamp() AS now");
        return operation({ client, subjectKind: "player", subjectId: otherPlayer, playerSessionId: otherSession,
          playerSessionDeliveryGeneration: 1, checkpoint: deterministicSettledCheckpointFixture(), now: clock.rows[0]!.now });
      }) } as unknown as EveningServiceAuthority;
    const otherReview = new ReceiptReviewWalletAuthority(pool, otherService, review.receipts, review.policy);
    const otherAccess = await otherReview.syncRuntime({ kind: "player", sessionSecret: "other" }, {
      idempotencyKey: "phase2c-other-pending-runtime", runtimeGeneration: 4, sessionRevision: 4, runtime: proofRuntime });
    const otherChallenge = await otherReview.issueChallenge({ kind: "player", sessionSecret: "other" }, {
      idempotencyKey: "phase2c-other-pending-challenge", walletLinkRef: otherAccess.walletLinkRef,
      runtimeGeneration: otherAccess.runtimeGeneration, sessionRevision: otherAccess.sessionRevision });

    const revokedCredential = "77777777-7777-4777-8777-777777777777";
    await raw.query(`INSERT INTO samurai_persistence.wallet_credentials
      (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
      VALUES ($1,$2,'NetXtJqPyJGB6Pc',$3,$4,'tz1',$5,$6)`, [revokedCredential, PLAYER, proofAccount, proofPublicKey,
      "88888888-8888-4888-8888-888888888888", now]);
    const revokedAt = new Date(now.getTime() + 1_000);
    await expect(raw.query(`UPDATE samurai_persistence.wallet_credentials SET player_id=$2,state='revoked',
      credential_revision=credential_revision+1,updated_at=$3,revoked_at=$3 WHERE credential_id=$1`,
    [revokedCredential, otherPlayer, revokedAt])).rejects.toMatchObject({ code: "23514" });
    expect((await raw.query<{ state: string }>("SELECT state FROM samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1",
      [issued.challengeRef])).rows[0]).toEqual({ state: "ISSUED" });
    expect((await raw.query<{ state: string }>("SELECT state FROM samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1",
      [otherChallenge.challengeRef])).rows[0]).toEqual({ state: "ISSUED" });
    await raw.query(`UPDATE samurai_persistence.wallet_credentials SET state='revoked',credential_revision=credential_revision+1,
      updated_at=$2,revoked_at=$2 WHERE credential_id=$1`, [revokedCredential, revokedAt]);

    await expect(review.consumeProof(credential, { idempotencyKey: "phase2c-revoke-pending-proof",
      walletLinkRef: access.walletLinkRef, challengeRef: issued.challengeRef, proof })).rejects.toMatchObject({ code: "WALLET_PROOF_REJECTED" });
    expect((await raw.query<{ state: string }>("SELECT state FROM samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1",
      [issued.challengeRef])).rows[0]).toEqual({ state: "REVOKED" });
    expect((await raw.query<{ state: string }>("SELECT state FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1",
      [access.walletLinkRef])).rows[0]).toEqual({ state: "REVOKED" });
    expect((await raw.query<{ state: string }>("SELECT state FROM samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1",
      [otherChallenge.challengeRef])).rows[0]).toEqual({ state: "ISSUED" });
    expect((await raw.query<{ state: string }>("SELECT state FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1",
      [otherAccess.walletLinkRef])).rows[0]).toEqual({ state: "CHALLENGE_ISSUED" });
    expect((await raw.query<{ active: string; total: string }>(`SELECT
      count(*) FILTER (WHERE state='active')::text AS active,count(*)::text AS total
      FROM samurai_persistence.wallet_credentials WHERE player_id=$1 AND chain_id='NetXtJqPyJGB6Pc' AND account=$2`,
    [PLAYER, proofAccount])).rows[0]).toEqual({ active: "0", total: "1" });
  });

  it("keeps revoked credentials terminal and requires a distinct credential for a fresh proof", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    const proofPublicKey = b58Encode(der.subarray(der.byteLength - 32), PrefixV2.Ed25519PublicKey);
    const proofAccount = getPkhfromPk(proofPublicKey); const proofRuntime = { ...runtime, account: proofAccount };
    const signChallenge = (challenge: Parameters<typeof walletLinkSigningBytes>[0]) => ({ challenge,
      publicKey: proofPublicKey, signature: b58Encode(signMessage(null,
        blake2b(walletLinkSigningBytes(challenge), { dkLen: 32 }), privateKey), PrefixV2.Ed25519Signature) });

    const firstAccess = await review.syncRuntime(credential, { idempotencyKey: "phase2c-terminal-runtime-1",
      runtimeGeneration: 40, sessionRevision: 40, runtime: proofRuntime });
    const firstChallenge = await review.issueChallenge(credential, { idempotencyKey: "phase2c-terminal-challenge-1",
      walletLinkRef: firstAccess.walletLinkRef, runtimeGeneration: firstAccess.runtimeGeneration,
      sessionRevision: firstAccess.sessionRevision });
    const firstLinked = await review.consumeProof(credential, { idempotencyKey: "phase2c-terminal-proof-1",
      walletLinkRef: firstAccess.walletLinkRef, challengeRef: firstChallenge.challengeRef,
      proof: signChallenge(firstChallenge.challenge) });
    const firstCredential = (await raw.query<{ credential_id: string }>(`SELECT credential_id::text FROM
      samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1`, [firstChallenge.challengeRef])).rows[0]!.credential_id;
    await review.revokeCredential(credential, { idempotencyKey: "phase2c-terminal-revoke-1",
      walletLinkRef: firstLinked.walletLinkRef, runtimeGeneration: firstLinked.runtimeGeneration,
      sessionRevision: firstLinked.sessionRevision });

    await expect(raw.query(`UPDATE samurai_persistence.wallet_credentials SET state='active',revoked_at=NULL
      WHERE credential_id=$1`, [firstCredential])).rejects.toMatchObject({ code: "23514" });
    await expect(raw.query(`UPDATE samurai_persistence.wallet_credentials SET credential_revision=credential_revision+1,
      updated_at=updated_at + interval '1 second',revoked_at=revoked_at + interval '1 second'
      WHERE credential_id=$1`, [firstCredential])).rejects.toMatchObject({ code: "23514" });
    const afterHostile = (await raw.query<{ state: string; credential_revision: string; revoked_at: Date }>(`SELECT
      state,credential_revision::text,revoked_at FROM samurai_persistence.wallet_credentials WHERE credential_id=$1`,
    [firstCredential])).rows[0]!;
    expect(afterHostile).toMatchObject({ state: "revoked", credential_revision: "2", revoked_at: expect.any(Date) });

    const secondAccess = await review.syncRuntime(credential, { idempotencyKey: "phase2c-terminal-runtime-2",
      runtimeGeneration: 41, sessionRevision: 43, runtime: proofRuntime });
    expect(secondAccess).toMatchObject({ state: "ACCOUNT_PROOF_UNAVAILABLE", credentialMatch: false,
      reason: "ACCOUNT_PROOF_UNAVAILABLE" });
    const secondChallenge = await review.issueChallenge(credential, { idempotencyKey: "phase2c-terminal-challenge-2",
      walletLinkRef: secondAccess.walletLinkRef, runtimeGeneration: secondAccess.runtimeGeneration,
      sessionRevision: secondAccess.sessionRevision });
    const secondLinked = await review.consumeProof(credential, { idempotencyKey: "phase2c-terminal-proof-2",
      walletLinkRef: secondAccess.walletLinkRef, challengeRef: secondChallenge.challengeRef,
      proof: signChallenge(secondChallenge.challenge) });
    expect(secondLinked).toMatchObject({ state: "ACTIVE_CREDENTIAL_MATCH", credentialMatch: true });
    const credentials = (await raw.query<{ credential_id: string; state: string; credential_revision: string }>(`SELECT
      credential_id::text,state,credential_revision::text FROM samurai_persistence.wallet_credentials
      WHERE player_id=$1 AND chain_id=$2 AND account=$3 ORDER BY linked_at,credential_id`,
    [PLAYER, proofRuntime.chainId, proofAccount])).rows;
    expect(credentials).toHaveLength(2);
    expect(credentials).toContainEqual({ credential_id: firstCredential, state: "revoked", credential_revision: "2" });
    expect(credentials).toContainEqual({ credential_id: expect.not.stringMatching(new RegExp(`^${firstCredential}$`, "u")),
      state: "active", credential_revision: "1" });
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
    expect(issued.challengeRef).toMatch(/^wc_[A-Za-z0-9_-]{22}$/);
    expect(JSON.stringify(issued)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/);
    const driftCases: readonly [string, string][] = [
      ["player_id", "'player_phase2c_other'"],
      ["player_session_id", "'77777777-7777-4777-8777-777777777777'::uuid"],
      ["player_session_delivery_generation", "2"],
      ["chain_id", "'NetXsqzbfFenSTS'"],
      ["account", "'tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6'"],
      ["provider_id", "'localnet-wallet'"],
      ["permission_scope_digest", "decode(repeat('ab',32),'hex')"],
      ["runtime_generation", "3"],
      ["session_revision", "7"],
    ];
    for (const [column, replacement] of driftCases) {
      await expect(raw.query(`UPDATE samurai_persistence.wallet_link_challenges SET ${column}=${replacement}
        WHERE public_challenge_ref=$1`, [issued.challengeRef])).rejects.toMatchObject({ code: "23503" });
    }
    for (const partial of [
      "proof_hash=decode(repeat('ab',32),'hex')",
      "proof_idempotency_key='phase2c-partial-proof-01'",
      "proof_request_hash=decode(repeat('ab',32),'hex')",
      "result_hash=decode(repeat('ab',32),'hex')",
      "public_result='{}'::jsonb",
      "consumed_at=clock_timestamp()",
      "revoked_at=clock_timestamp()",
    ]) {
      await expect(raw.query(`UPDATE samurai_persistence.wallet_link_challenges SET ${partial}
        WHERE public_challenge_ref=$1`, [issued.challengeRef])).rejects.toMatchObject({ code: "23514" });
    }
    await expect(raw.query(`UPDATE samurai_persistence.wallet_link_challenges SET state='CONSUMED',consumed_at=clock_timestamp()
      WHERE public_challenge_ref=$1`, [issued.challengeRef])).rejects.toMatchObject({ code: "23514" });
    await expect(raw.query(`UPDATE samurai_persistence.wallet_link_challenges SET state='REVOKED'
      WHERE public_challenge_ref=$1`, [issued.challengeRef])).rejects.toMatchObject({ code: "23514" });
    await expect(raw.query(`UPDATE samurai_persistence.wallet_link_challenges SET state='EXPIRED'
      WHERE public_challenge_ref=$1`, [issued.challengeRef])).rejects.toMatchObject({ code: "23503" });
    await expect(raw.query(`UPDATE samurai_persistence.wallet_link_challenges SET state='REVOKED',revoked_at=clock_timestamp()
      WHERE public_challenge_ref=$1`, [issued.challengeRef])).rejects.toMatchObject({ code: "23503" });
    const proofCredentialId = "55555555-5555-4555-8555-555555555555";
    const proofNow = (await raw.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await raw.query(`INSERT INTO samurai_persistence.wallet_credentials
      (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
      VALUES ($1,$2,$3,$4,$5,'tz1',$6,$7)`, [proofCredentialId, PLAYER, issued.challenge.chainId, issued.challenge.account,
      publicKeyText, "66666666-6666-4666-8666-666666666666", proofNow]);
    await expect(raw.query(`UPDATE samurai_persistence.wallet_runtime_links
      SET credential_id=$2,state='LINKED',linked_challenge_state='CONSUMED'
      WHERE public_link_ref=$1`, [access.walletLinkRef, proofCredentialId])).rejects.toMatchObject({ code: "23503" });
    const proof = { challenge: issued.challenge, publicKey: publicKeyText,
      signature: b58Encode(signMessage(null, blake2b(walletLinkSigningBytes(issued.challenge), { dkLen: 32 }), privateKey),
        PrefixV2.Ed25519Signature) };
    const input = { idempotencyKey: "phase2c-proof-consume-001", walletLinkRef: access.walletLinkRef,
      challengeRef: issued.challengeRef, proof };
    const linked = await review.consumeProof(credential, input);
    expect(linked).toMatchObject({ state: "ACTIVE_CREDENTIAL_MATCH", credentialMatch: true, account });
    expect(await review.consumeProof(credential, input)).toEqual(linked);
    await expect(review.consumeProof(credential, { ...input, idempotencyKey: "phase2c-proof-consume-002" }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    expect((await raw.query<{ count: string }>("SELECT count(*)::text AS count FROM samurai_persistence.wallet_credentials")).rows[0]?.count)
      .toBe("1");
    const consumed = (await raw.query<{ challenge_id: string; public_result: unknown; state: string; credential_id: string | null }>(
      "SELECT challenge_id::text,public_result,state,credential_id::text FROM samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1",
      [issued.challengeRef])).rows[0]!;
    expect(consumed).toMatchObject({ state: "CONSUMED", credential_id: expect.any(String) });
    expect(JSON.stringify(consumed.public_result)).not.toContain(consumed.challenge_id);
    await raw.query(`UPDATE samurai_persistence.wallet_link_challenges
      SET public_result=jsonb_set(public_result,'{sessionRevision}',to_jsonb((public_result->>'sessionRevision')::bigint+1))
      WHERE public_challenge_ref=$1`, [issued.challengeRef]);
    await expect(review.consumeProof(credential, input)).rejects.toMatchObject({ code: "WALLET_PROOF_REPLAY_INVALID" });
    await raw.query("UPDATE samurai_persistence.wallet_link_challenges SET public_result=$2::jsonb WHERE public_challenge_ref=$1",
      [issued.challengeRef, canonicalJson(consumed.public_result)]);
    const revokeNow = new Date(proofNow.getTime() + 1_000);
    await raw.query(`UPDATE samurai_persistence.wallet_credentials SET state='revoked',credential_revision=credential_revision+1,
      updated_at=$2,revoked_at=$2 WHERE credential_id=$1`, [proofCredentialId, revokeNow]);
    await expect(review.consumeProof(credential, input)).rejects.toMatchObject({ code: "WALLET_PROOF_REJECTED" });
    await expect(review.restoreRuntime(credential, access.walletLinkRef)).resolves.toMatchObject({ state: "REVOKED", credentialMatch: false });
    await expect(raw.query("UPDATE samurai_persistence.player_sessions SET delivery_generation=2 WHERE id=$1", [SESSION]))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it("rejects a purpose proof when its credential namespace lock crosses exact expiry", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    const publicKeyText = b58Encode(der.subarray(der.byteLength - 32), PrefixV2.Ed25519PublicKey);
    const account = getPkhfromPk(publicKeyText); const fixtureRuntime = { ...runtime, account };
    const base = new Date("2026-08-02T12:00:00.000Z"); contextNow = base; authorityNow = base;
    const access = await review.syncRuntime(credential, { idempotencyKey: "phase2c-expiry-runtime-1",
      runtimeGeneration: 40, sessionRevision: 40, runtime: fixtureRuntime });
    const issued = await review.issueChallenge(credential, { idempotencyKey: "phase2c-expiry-challenge",
      walletLinkRef: access.walletLinkRef, runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision });
    const proof = { challenge: issued.challenge, publicKey: publicKeyText,
      signature: b58Encode(signMessage(null, blake2b(walletLinkSigningBytes(issued.challenge), { dkLen: 32 }), privateKey),
        PrefixV2.Ed25519Signature) };
    const accountFence = `wallet-account:${fixtureRuntime.chainId}:${fixtureRuntime.account}`;
    const blocker = await raw.connect(); await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [accountFence]);
    authorityNow = new Date(Date.parse(issued.challenge.expiresAt) - 1);
    const consuming = review.consumeProof(credential, { idempotencyKey: "phase2c-expiry-proof-01",
      walletLinkRef: access.walletLinkRef, challengeRef: issued.challengeRef, proof });
    await waitForDatabaseLock(raw, "pg_advisory_xact_lock"); authorityNow = new Date(issued.challenge.expiresAt);
    await blocker.query("COMMIT"); blocker.release();
    await expect(consuming).rejects.toMatchObject({ code: "WALLET_PROOF_REJECTED" });
    expect((await raw.query<{ state: string }>("SELECT state FROM samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1",
      [issued.challengeRef])).rows[0]).toEqual({ state: "ISSUED" });
    expect((await raw.query<{ count: string }>("SELECT count(*)::text AS count FROM samurai_persistence.wallet_credentials")).rows[0]?.count)
      .toBe("0");
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
      accessPresentation: { ref: "wallet.access.disconnected", recoveryAction: { ref: "wallet.access.reconnect" } },
      walletAccess: { walletLinkRef: access.walletLinkRef, state: "ACTIVE_CREDENTIAL_MATCH", credentialMatch: true } });
    expect(projection.reviewFacts).toMatchObject({ owner: ACCOUNT, source: ACCOUNT,
      network: { deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH }, entrypoint: "submit_receipt", attachedMutez: "0" });
    const reviewDigest = createHash("sha256").update(canonicalJson(projection)).digest("hex");
    await expect(review.preflight(credential, { ...input, idempotencyKey: "phase2c-flight-0001", publicIntentRef: projection.intent.intentRef,
      expectedProjectionRevision: projection.projectionRevision, reviewDigest })).resolves.toMatchObject({ status: "REVIEW_READY", reviewDigest });
    await expect(review.preflight(credential, { ...input, idempotencyKey: "phase2c-flight-0002", sessionRevision: access.sessionRevision + 1,
      publicIntentRef: projection.intent.intentRef, expectedProjectionRevision: projection.projectionRevision, reviewDigest }))
      .resolves.toMatchObject({ schemaVersion: 1, status: "NOT_READY", reason: "WALLET_SESSION_REVISION_STALE",
        presentation: { reasonRef: "receipt.preflight.session-revision-stale" } });
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
      .resolves.toMatchObject({ schemaVersion: 1, status: "NOT_READY", reason: "PROVIDER_CHANGED",
        presentation: { reasonRef: "receipt.preflight.provider-changed" } });
  });

  it("atomically propagates credential revocation and serializes restore behind the revocation writer", async () => {
    const now = (await raw.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    await raw.query(`INSERT INTO samurai_persistence.wallet_credentials
      (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
      VALUES ($1,$2,'NetXtJqPyJGB6Pc',$3,$4,'tz1',$5,$6)`, [CREDENTIAL, PLAYER, ACCOUNT, PUBLIC_KEY, CLAIM, now]);
    const access = await review.syncRuntime(credential, { idempotencyKey: "phase2c-revoke-runtime-1",
      runtimeGeneration: 7, sessionRevision: 9, runtime });
    await review.prepareReview(credential, { idempotencyKey: "phase2c-revoke-prepare-1", walletLinkRef: access.walletLinkRef,
      runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision });
    const blocker = await raw.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT credential_id FROM samurai_persistence.wallet_credentials WHERE credential_id=$1 FOR UPDATE", [CREDENTIAL]);
    const revokeInput = { idempotencyKey: "phase2c-credential-revoke-1", walletLinkRef: access.walletLinkRef,
      runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision };
    const revoking = review.revokeCredential(credential, revokeInput);
    await waitForDatabaseLock(raw, "wallet_credentials");
    const restoring = review.restoreRuntime(credential, access.walletLinkRef);
    await waitForDatabaseLock(raw, "wallet_runtime_links");
    await blocker.query("COMMIT"); blocker.release();
    await expect(revoking).resolves.toMatchObject({ state: "REVOKED", credentialMatch: false,
      runtimeGeneration: access.runtimeGeneration + 1, sessionRevision: access.sessionRevision + 1 });
    await expect(restoring).resolves.toMatchObject({ state: "REVOKED", credentialMatch: false });
    await expect(review.revokeCredential(credential, revokeInput)).resolves.toMatchObject({ state: "REVOKED" });
    await expect(review.revokeCredential(credential, { ...revokeInput, runtimeGeneration: revokeInput.runtimeGeneration + 1 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
    await expect(review.restoreReviewState(credential)).resolves.toMatchObject({ walletAccess: null,
      accessPresentation: { ref: "wallet.access.disconnected", recoveryAction: { ref: "wallet.access.reconnect" } } });

    const directCredential = "77777777-7777-4777-8777-777777777777";
    const directAccount = "tz1aSkwEot3L2kmUvcoxzjMomb9mvBNuzFK6";
    await raw.query(`INSERT INTO samurai_persistence.wallet_credentials
      (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,linked_at)
      VALUES ($1,$2,'NetXtJqPyJGB6Pc',$3,$4,'tz1',$5,$6)`,
    [directCredential, PLAYER, directAccount, PUBLIC_KEY, "88888888-8888-4888-8888-888888888888", now]);
    const directRuntime = { ...runtime, account: directAccount };
    const direct = await review.syncRuntime(credential, { idempotencyKey: "phase2c-direct-revoke-runtime",
      runtimeGeneration: 20, sessionRevision: 20, runtime: directRuntime });
    const directRevokedAt = new Date(now.getTime() + 2_000);
    await raw.query(`UPDATE samurai_persistence.wallet_credentials SET state='revoked',credential_revision=credential_revision+1,
      updated_at=$2,revoked_at=$2 WHERE credential_id=$1`, [directCredential, directRevokedAt]);
    await expect(review.restoreRuntime(credential, direct.walletLinkRef)).resolves.toMatchObject({ state: "REVOKED", credentialMatch: false });

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ format: "der", type: "spki" });
    const sessionFirstPublicKey = b58Encode(der.subarray(der.byteLength - 32), PrefixV2.Ed25519PublicKey);
    const sessionFirstAccount = getPkhfromPk(sessionFirstPublicKey);
    const sessionFirstAccess = await review.syncRuntime(credential, { idempotencyKey: "phase2c-session-first-runtime",
      runtimeGeneration: 24, sessionRevision: 24, runtime: { ...runtime, account: sessionFirstAccount } });
    const sessionFirstChallenge = await review.issueChallenge(credential, { idempotencyKey: "phase2c-session-first-challenge",
      walletLinkRef: sessionFirstAccess.walletLinkRef, runtimeGeneration: sessionFirstAccess.runtimeGeneration,
      sessionRevision: sessionFirstAccess.sessionRevision });
    const sessionFirstProof = { challenge: sessionFirstChallenge.challenge, publicKey: sessionFirstPublicKey,
      signature: b58Encode(signMessage(null, blake2b(walletLinkSigningBytes(sessionFirstChallenge.challenge), { dkLen: 32 }), privateKey),
        PrefixV2.Ed25519Signature) };
    await review.consumeProof(credential, { idempotencyKey: "phase2c-session-first-proof",
      walletLinkRef: sessionFirstAccess.walletLinkRef, challengeRef: sessionFirstChallenge.challengeRef, proof: sessionFirstProof });
    const sessionFirstCredential = (await raw.query<{ credential_id: string }>(`SELECT credential_id::text FROM
      samurai_persistence.wallet_link_challenges WHERE public_challenge_ref=$1`, [sessionFirstChallenge.challengeRef])).rows[0]!.credential_id;
    await expect(raw.query("UPDATE samurai_persistence.player_sessions SET delivery_generation=2 WHERE id=$1", [SESSION]))
      .resolves.toMatchObject({ rowCount: 1 });
    const sessionFirstRevokedAt = new Date(now.getTime() + 3_000);
    await expect(raw.query(`UPDATE samurai_persistence.wallet_credentials SET state='revoked',credential_revision=credential_revision+1,
      updated_at=$2,revoked_at=$2 WHERE credential_id=$1`, [sessionFirstCredential, sessionFirstRevokedAt]))
      .resolves.toMatchObject({ rowCount: 1 });
  });

  it("refreshes the authority clock after blocked sync, disconnect, and challenge locks", async () => {
    const base = new Date("2026-08-02T12:00:00.000Z"); contextNow = base; authorityNow = base;
    const accountFence = `wallet-account:${runtime.chainId}:${runtime.account}`;
    const syncBlocker = await raw.connect(); await syncBlocker.query("BEGIN");
    await syncBlocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [accountFence]);
    const syncing = review.syncRuntime(credential, { idempotencyKey: "phase2c-clock-sync-0001",
      runtimeGeneration: 30, sessionRevision: 30, runtime });
    await waitForDatabaseLock(raw, "pg_advisory_xact_lock"); authorityNow = new Date(base.getTime() + 60_000);
    await syncBlocker.query("COMMIT"); syncBlocker.release();
    const access = await syncing;
    const syncedTime = await raw.query<{ changed_at: Date }>("SELECT changed_at FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1", [access.walletLinkRef]);
    expect(syncedTime.rows[0]!.changed_at.toISOString()).toBe(authorityNow.toISOString());

    const disconnectBlocker = await raw.connect(); await disconnectBlocker.query("BEGIN");
    await disconnectBlocker.query("SELECT id FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1 FOR UPDATE", [access.walletLinkRef]);
    contextNow = new Date(base.getTime() + 120_000); authorityNow = contextNow;
    const disconnecting = review.disconnect(credential, { idempotencyKey: "phase2c-clock-disconnect",
      walletLinkRef: access.walletLinkRef, runtimeGeneration: access.runtimeGeneration, sessionRevision: access.sessionRevision });
    await waitForDatabaseLock(raw, "wallet_runtime_links"); authorityNow = new Date(base.getTime() + 180_000);
    await disconnectBlocker.query("COMMIT"); disconnectBlocker.release();
    const disconnected = await disconnecting;
    const disconnectedTime = await raw.query<{ changed_at: Date }>("SELECT changed_at FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1", [access.walletLinkRef]);
    expect(disconnectedTime.rows[0]!.changed_at.toISOString()).toBe(authorityNow.toISOString());

    const reconnected = await review.syncRuntime(credential, { idempotencyKey: "phase2c-clock-sync-0002",
      runtimeGeneration: disconnected.runtimeGeneration + 1, sessionRevision: disconnected.sessionRevision + 1, runtime });
    const challengeBlocker = await raw.connect(); await challengeBlocker.query("BEGIN");
    await challengeBlocker.query("SELECT id FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1 FOR UPDATE", [reconnected.walletLinkRef]);
    contextNow = new Date(base.getTime() + 240_000); authorityNow = contextNow;
    const issuing = review.issueChallenge(credential, { idempotencyKey: "phase2c-clock-challenge",
      walletLinkRef: reconnected.walletLinkRef, runtimeGeneration: reconnected.runtimeGeneration, sessionRevision: reconnected.sessionRevision });
    await waitForDatabaseLock(raw, "wallet_runtime_links"); authorityNow = new Date(contextNow.getTime() + 300_001);
    await challengeBlocker.query("COMMIT"); challengeBlocker.release();
    const issued = await issuing;
    expect(issued.challenge.issuedAt).toBe(authorityNow.toISOString());
    expect(Date.parse(issued.challenge.expiresAt) - Date.parse(issued.challenge.issuedAt)).toBe(300_000);
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
    await expect(raw.query("UPDATE samurai_persistence.wallet_runtime_links SET state='PERMISSIONED' WHERE public_link_ref=$1", [access.walletLinkRef]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(raw.query("UPDATE samurai_persistence.wallet_runtime_links SET state='LINKED',linked_challenge_id=NULL WHERE public_link_ref=$1", [access.walletLinkRef]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(raw.query("UPDATE samurai_persistence.wallet_runtime_links SET terminal_reason='WRONG_NETWORK' WHERE public_link_ref=$1", [access.walletLinkRef]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(raw.query("UPDATE samurai_persistence.wallet_runtime_links SET disconnected_at=clock_timestamp() WHERE public_link_ref=$1", [access.walletLinkRef]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(raw.query(`UPDATE samurai_persistence.wallet_runtime_links
      SET runtime_generation=9007199254740991,session_revision=9007199254740991 WHERE public_link_ref=$1`, [access.walletLinkRef]))
      .rejects.toMatchObject({ code: "23514" });
    await raw.query(`UPDATE samurai_persistence.wallet_runtime_links
      SET runtime_generation=9007199254740990,session_revision=9007199254740990 WHERE public_link_ref=$1`, [access.walletLinkRef]);
    await expect(raw.query("UPDATE samurai_persistence.player_sessions SET delivery_generation=2 WHERE id=$1", [SESSION])).resolves.toMatchObject({ rowCount: 1 });
    expect((await raw.query<{ state: string; runtime_generation: string; session_revision: string }>(`SELECT state,runtime_generation::text,
      session_revision::text FROM samurai_persistence.wallet_runtime_links WHERE public_link_ref=$1`, [access.walletLinkRef])).rows[0])
      .toEqual({ state: "REVOKED", runtime_generation: String(Number.MAX_SAFE_INTEGER), session_revision: String(Number.MAX_SAFE_INTEGER) });
  });
});
