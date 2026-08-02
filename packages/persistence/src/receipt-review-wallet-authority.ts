import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@samurai-sushi/domain";
import { verifyWalletLinkProof, type AccountProofInput } from "@samurai-sushi/account-proof-verifier";
import { RECEIPT_AUTHORITY_MANIFEST, RECEIPT_AUTHORITY_MANIFEST_HASH } from "@samurai-sushi/receipt-authority";
import type { ReceiptPermitSigner } from "@samurai-sushi/receipt-authority/server";
import { GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY, type BrowserSafeReceiptReviewProjectionV1 } from "@samurai-sushi/receipt-lifecycle";
import {
  parseWalletLinkChallenge,
  parseWalletAccessView,
  RECEIPT_REVIEW_DOORWAY,
  WALLET_REVIEW_COPY,
  type NormalizedWalletRuntime,
  type ReceiptReviewPreflightResult,
  type WalletAccessView,
  type WalletLinkChallengeV1,
} from "@samurai-sushi/wallet-link";
import type { SqlClient, SqlPool } from "./database";
import { IdempotencyPayloadMismatchError, PersistenceError, ReceiptLifecycleError } from "./errors";
import type { ReceiptLifecycleAuthority } from "./receipt-lifecycle-authority";
import type { EveningServiceAuthority, ServiceSubjectCredential, SettledServiceTransactionContext } from "./service-authority";

const NETWORK = GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0]!;
const LINK_REF = /^wl_[A-Za-z0-9_-]{22}$/;
const INTENT_REF = /^ri_[A-Za-z0-9_-]{22}$/;
const IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const DIGEST_HEX = /^[0-9a-f]{64}$/;
const CHALLENGE_LIFETIME_MS = 300_000;
const MAX_COORDINATE = Number.MAX_SAFE_INTEGER;

export interface ReceiptReviewWalletPolicy {
  readonly canonicalOrigin: string;
  readonly destination: string;
  readonly issuerKeyId: string;
  readonly issuerPolicyVersion: string;
  readonly signer: ReceiptPermitSigner;
}

export interface SyncWalletRuntimeInput {
  readonly idempotencyKey: string;
  readonly runtimeGeneration: number;
  readonly sessionRevision: number;
  readonly runtime: NormalizedWalletRuntime;
}

export interface PrepareReceiptReviewInput {
  readonly idempotencyKey: string;
  readonly walletLinkRef: string;
  readonly runtimeGeneration: number;
  readonly sessionRevision: number;
}

export interface ReceiptReviewPreflightInput extends PrepareReceiptReviewInput {
  readonly publicIntentRef: string;
  readonly expectedProjectionRevision: string;
  readonly reviewDigest: string;
}

interface RuntimeRow {
  readonly id: string;
  readonly public_link_ref: string;
  readonly player_id: string;
  readonly player_session_id: string;
  readonly player_session_delivery_generation: string;
  readonly credential_id: string | null;
  readonly chain_id: string;
  readonly account: string;
  readonly provider_id: string;
  readonly permission_scopes: string[];
  readonly runtime_generation: string;
  readonly session_revision: string;
  readonly state: string;
  readonly terminal_reason: string | null;
  readonly normalized_facts_digest: Uint8Array;
  readonly request_hash: Uint8Array;
  readonly result_hash: Uint8Array;
}

interface CredentialRow {
  readonly credential_id: string;
  readonly player_id: string;
  readonly chain_id: string;
  readonly account: string;
  readonly public_key: string;
  readonly scheme: "tz1" | "tz2" | "tz3" | "tz4";
  readonly credential_revision: string;
  readonly state: "active" | "revoked";
}

interface ChallengeRow {
  readonly challenge_id: string;
  readonly wallet_link_id: string;
  readonly player_id: string;
  readonly player_session_id: string;
  readonly player_session_delivery_generation: string;
  readonly purpose: "RECEIPT_WALLET_LINK";
  readonly canonical_origin: string;
  readonly chain_id: string;
  readonly account: string;
  readonly provider_id: string;
  readonly permission_scope_digest: Uint8Array;
  readonly runtime_generation: string;
  readonly session_revision: string;
  readonly privacy_policy_version: "receipt-wallet-privacy-v1";
  readonly challenge_hash: Uint8Array;
  readonly public_challenge: unknown;
  readonly request_hash: Uint8Array;
  readonly proof_hash: Uint8Array | null;
  readonly proof_idempotency_key: string | null;
  readonly proof_request_hash: Uint8Array | null;
  readonly result_hash: Uint8Array | null;
  readonly public_result: unknown | null;
  readonly state: "ISSUED" | "CONSUMED" | "EXPIRED" | "REVOKED";
  readonly issued_at: Date;
  readonly expires_at: Date;
}

function digest(value: string | Uint8Array): Uint8Array { return createHash("sha256").update(value).digest(); }
function digestCanonical(value: unknown): Uint8Array { return digest(canonicalJson(value)); }
function hex(value: Uint8Array): string { return Buffer.from(value).toString("hex"); }
function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
function safeCoordinate(value: number, reservedAuthoritySteps = 0): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COORDINATE - reservedAuthoritySteps) {
    throw new PersistenceError("WALLET_RUNTIME_INVALID", "Wallet runtime coordinates are invalid.");
  }
}
function exactIdempotency(value: string): void {
  if (!IDEMPOTENCY.test(value)) throw new PersistenceError("WALLET_RUNTIME_INVALID", "Wallet runtime request is invalid.");
}
function publicLinkRef(): string { return `wl_${randomBytes(16).toString("base64url")}`; }
function publicView(row: RuntimeRow): WalletAccessView {
  const match = row.credential_id !== null && ["LINKED_EXISTING", "LINKED"].includes(row.state);
  const state = row.state === "DISCONNECTED" ? "DISCONNECTED" : row.state === "REVOKED" ? "REVOKED"
    : match ? "ACTIVE_CREDENTIAL_MATCH" : row.terminal_reason === "ACCOUNT_PROOF_UNAVAILABLE"
      ? "ACCOUNT_PROOF_UNAVAILABLE" : "CONNECTED_UNVERIFIED";
  const presentation = state === "ACCOUNT_PROOF_UNAVAILABLE" ? WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"]
    : state === "DISCONNECTED" ? WALLET_REVIEW_COPY["wallet.access.disconnected"]
      : state === "REVOKED" ? WALLET_REVIEW_COPY["wallet.access.unavailable"] : WALLET_REVIEW_COPY["wallet.access.connected"];
  return Object.freeze({ schemaVersion: 1, walletLinkRef: row.public_link_ref, state,
    runtimeGeneration: Number(row.runtime_generation), sessionRevision: Number(row.session_revision),
    providerId: row.provider_id, chainId: row.chain_id, account: row.account,
    permissionScopes: Object.freeze(["account"] as const), credentialMatch: match,
    reason: state === "ACCOUNT_PROOF_UNAVAILABLE" ? "ACCOUNT_PROOF_UNAVAILABLE"
      : state === "DISCONNECTED" ? "DISCONNECTED" : state === "REVOKED" ? "REVOKED" : null,
    presentation });
}

export class ReceiptReviewWalletAuthority {
  constructor(
    _pool: SqlPool,
    readonly service: EveningServiceAuthority,
    readonly receipts: ReceiptLifecycleAuthority,
    readonly policy: ReceiptReviewWalletPolicy,
  ) {}

  async syncRuntime(credential: ServiceSubjectCredential, input: SyncWalletRuntimeInput): Promise<WalletAccessView> {
    exactIdempotency(input.idempotencyKey); safeCoordinate(input.runtimeGeneration, 1); safeCoordinate(input.sessionRevision, 4);
    const runtimeHash = digestCanonical(input.runtime);
    const requestHash = digestCanonical(input);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      this.#requirePlayerContext(context);
      await this.#lockScope(context.client, `wallet-account:${input.runtime.chainId}:${input.runtime.account}`);
      const replay = await context.client.query<RuntimeRow>(`SELECT * FROM samurai_persistence.wallet_runtime_links
        WHERE player_id=$1 AND idempotency_key=$2 FOR UPDATE`, [context.subjectId, input.idempotencyKey]);
      if (replay.rows[0]) {
        if (!same(replay.rows[0].request_hash, requestHash)) throw new IdempotencyPayloadMismatchError();
        return publicView(replay.rows[0]);
      }
      if (input.runtime.chainId !== NETWORK.chainId || input.runtime.permissionScopes.length !== 1
        || input.runtime.permissionScopes[0] !== "account") throw new PersistenceError("WALLET_RUNTIME_INVALID", "Wallet runtime facts do not match the registered review policy.");
      const active = await context.client.query<CredentialRow>(`SELECT * FROM samurai_persistence.wallet_credentials
        WHERE player_id=$1 AND chain_id=$2 AND account=$3 AND state='active' FOR UPDATE`,
      [context.subjectId, input.runtime.chainId, input.runtime.account]);
      const credentialRow = active.rows[0] ?? null;
      const state = credentialRow ? "LINKED_EXISTING" : "PERMISSIONED";
      const terminalReason = credentialRow ? null : "ACCOUNT_PROOF_UNAVAILABLE";
      const id = randomUUID(); const linkRef = publicLinkRef();
      const result = Object.freeze({ schemaVersion: 1, walletLinkRef: linkRef, state: credentialRow ? "ACTIVE_CREDENTIAL_MATCH" : "ACCOUNT_PROOF_UNAVAILABLE",
        runtimeGeneration: input.runtimeGeneration, sessionRevision: input.sessionRevision + 1, providerId: input.runtime.providerId,
        chainId: input.runtime.chainId, account: input.runtime.account, permissionScopes: ["account"] as const, credentialMatch: Boolean(credentialRow),
        reason: credentialRow ? null : "ACCOUNT_PROOF_UNAVAILABLE",
        presentation: credentialRow ? WALLET_REVIEW_COPY["wallet.access.connected"] : WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"] });
      await context.client.query(`INSERT INTO samurai_persistence.wallet_runtime_links
        (id,public_link_ref,player_id,player_session_id,player_session_delivery_generation,credential_id,chain_id,account,
         provider_id,permission_scopes,permission_scope_digest,runtime_generation,session_revision,state,terminal_reason,
         normalized_facts_digest,idempotency_key,request_hash,result_hash,created_at,changed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ARRAY['account'],$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19)`,
      [id, linkRef, context.subjectId, context.playerSessionId, context.playerSessionDeliveryGeneration,
        credentialRow?.credential_id ?? null, input.runtime.chainId, input.runtime.account, input.runtime.providerId,
        digest("account"), input.runtimeGeneration, input.sessionRevision + 1, state, terminalReason,
        runtimeHash, input.idempotencyKey, requestHash, digestCanonical(result), context.now]);
      await this.#event(context.client, id, 0, "RUNTIME_SYNCED", { state: result.state }, context.now);
      return result as WalletAccessView;
    });
  }

  async restoreRuntime(credential: ServiceSubjectCredential, walletLinkRef: string): Promise<WalletAccessView> {
    if (!LINK_REF.test(walletLinkRef)) throw new PersistenceError("WALLET_LINK_NOT_FOUND", "Wallet access is unavailable.");
    return this.service.runSettledTransaction(credential, `restore:${walletLinkRef}`, async (context) => {
      this.#requirePlayerContext(context);
      const row = await this.#lockRuntime(context.client, context.subjectId, walletLinkRef);
      if (row.player_session_id !== context.playerSessionId
        || Number(row.player_session_delivery_generation) !== context.playerSessionDeliveryGeneration) {
        throw new PersistenceError("WALLET_LINK_NOT_FOUND", "Wallet access is unavailable.");
      }
      return publicView(row);
    });
  }

  async disconnect(credential: ServiceSubjectCredential, input: Readonly<{ idempotencyKey: string; walletLinkRef: string;
    runtimeGeneration: number; sessionRevision: number }>): Promise<WalletAccessView> {
    exactIdempotency(input.idempotencyKey); safeCoordinate(input.runtimeGeneration, 1); safeCoordinate(input.sessionRevision, 1);
    const requestHash = digestCanonical(input);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      this.#requirePlayerContext(context);
      const row = await this.#lockRuntime(context.client, context.subjectId, input.walletLinkRef);
      const replay = await context.client.query<{ readonly public_payload: Record<string, unknown> }>(`SELECT public_payload
        FROM samurai_persistence.wallet_link_events WHERE wallet_link_id=$1 AND kind='DISCONNECTED'
          AND public_payload->>'idempotencyKey'=$2 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`, [row.id, input.idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].public_payload.requestHash !== hex(requestHash)) throw new IdempotencyPayloadMismatchError();
        return publicView(row);
      }
      if (Number(row.runtime_generation) !== input.runtimeGeneration || Number(row.session_revision) !== input.sessionRevision) {
        throw new PersistenceError("WALLET_RUNTIME_STALE", "Wallet runtime coordinates are stale.");
      }
      const generation = input.runtimeGeneration + 1; const revision = input.sessionRevision + 1;
      const updated = await context.client.query<RuntimeRow>(`UPDATE samurai_persistence.wallet_runtime_links
        SET state='DISCONNECTED',runtime_generation=$2,session_revision=$3,terminal_reason='PROVIDER_CANCELLED',
            normalized_facts_digest=$4,changed_at=$5,disconnected_at=$5
        WHERE id=$1 RETURNING *`, [row.id, generation, revision, digest(`disconnected:${generation}:${revision}`), context.now]);
      await this.#event(context.client, row.id, revision, "DISCONNECTED", {
        reason: "DISCONNECTED", idempotencyKey: input.idempotencyKey, requestHash: hex(requestHash),
      }, context.now);
      return publicView(updated.rows[0]!);
    });
  }

  async issueChallenge(credential: ServiceSubjectCredential, input: Readonly<{ idempotencyKey: string; walletLinkRef: string;
    runtimeGeneration: number; sessionRevision: number }>): Promise<Readonly<{ challengeId: string; challenge: WalletLinkChallengeV1 }>> {
    exactIdempotency(input.idempotencyKey); safeCoordinate(input.runtimeGeneration); safeCoordinate(input.sessionRevision, 1);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      this.#requirePlayerContext(context);
      const link = await this.#lockRuntime(context.client, context.subjectId, input.walletLinkRef);
      const replay = await context.client.query<ChallengeRow>(`SELECT * FROM samurai_persistence.wallet_link_challenges
        WHERE idempotency_key=$1 FOR UPDATE`, [input.idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].wallet_link_id !== link.id || replay.rows[0].player_id !== context.subjectId
          || !same(replay.rows[0].request_hash, digestCanonical(input))) throw new IdempotencyPayloadMismatchError();
        return { challengeId: replay.rows[0].challenge_id, challenge: this.#challengeFromRow(replay.rows[0], link.public_link_ref) };
      }
      if (Number(link.runtime_generation) !== input.runtimeGeneration || Number(link.session_revision) !== input.sessionRevision
        || link.state !== "PERMISSIONED" || link.credential_id !== null) throw new PersistenceError("WALLET_RUNTIME_STALE", "Wallet runtime cannot issue this proof challenge.");
      const nonce = randomBytes(32).toString("base64url");
      const challenge = parseWalletLinkChallenge({
        domain: "samurai-sushi:receipt-wallet-link:v1", schemaVersion: 1, purpose: "RECEIPT_WALLET_LINK",
        canonicalOrigin: this.policy.canonicalOrigin, publicLinkRef: link.public_link_ref, chainId: link.chain_id,
        account: link.account, providerId: link.provider_id, permissionScopeDigest: hex(digest("account")),
        runtimeGeneration: input.runtimeGeneration, sessionRevision: input.sessionRevision,
        privacyPolicyVersion: "receipt-wallet-privacy-v1", nonce, issuedAt: context.now.toISOString(),
        expiresAt: new Date(context.now.getTime() + CHALLENGE_LIFETIME_MS).toISOString(),
      });
      const challengeId = randomUUID(); const challengeHash = digestCanonical(challenge);
      await context.client.query(`INSERT INTO samurai_persistence.wallet_link_challenges
        (challenge_id,wallet_link_id,player_id,player_session_id,player_session_delivery_generation,purpose,canonical_origin,
         chain_id,account,provider_id,permission_scope_digest,runtime_generation,session_revision,privacy_policy_version,
         nonce_digest,challenge_hash,public_challenge,request_hash,idempotency_key,state,issued_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,'RECEIPT_WALLET_LINK',$6,$7,$8,$9,$10,$11,$12,'receipt-wallet-privacy-v1',$13,$14,$15,$16,$17,'ISSUED',$18,$19)`,
      [challengeId, link.id, context.subjectId, context.playerSessionId, context.playerSessionDeliveryGeneration,
        this.policy.canonicalOrigin, link.chain_id, link.account, link.provider_id, digest("account"), input.runtimeGeneration,
        input.sessionRevision, digest(nonce), challengeHash, canonicalJson(challenge), digestCanonical(input), input.idempotencyKey, context.now,
        new Date(context.now.getTime() + CHALLENGE_LIFETIME_MS)]);
      await context.client.query(`UPDATE samurai_persistence.wallet_runtime_links SET state='CHALLENGE_ISSUED',
        session_revision=session_revision+1,changed_at=$2 WHERE id=$1`, [link.id, context.now]);
      await this.#event(context.client, link.id, input.sessionRevision + 1, "CHALLENGE_ISSUED", {}, context.now);
      return Object.freeze({ challengeId, challenge });
    });
  }

  async consumeProof(credential: ServiceSubjectCredential, input: Readonly<{ idempotencyKey: string; walletLinkRef: string;
    challengeId: string; proof: AccountProofInput }>): Promise<WalletAccessView> {
    exactIdempotency(input.idempotencyKey);
    const verified = verifyWalletLinkProof(input.proof);
    const parsed = parseWalletLinkChallenge(input.proof.challenge);
    const proofHash = digestCanonical(input.proof);
    const proofRequestHash = digestCanonical(input);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      this.#requirePlayerContext(context);
      const link = await this.#lockRuntime(context.client, context.subjectId, input.walletLinkRef);
      const found = await context.client.query<ChallengeRow>(`SELECT * FROM samurai_persistence.wallet_link_challenges
        WHERE challenge_id=$1 AND wallet_link_id=$2 AND player_id=$3 FOR UPDATE`, [input.challengeId, link.id, context.subjectId]);
      const challenge = found.rows[0];
      if (challenge?.state === "CONSUMED") {
        if (challenge.proof_idempotency_key !== input.idempotencyKey || !challenge.proof_hash
          || !same(challenge.proof_hash, proofHash) || !challenge.proof_request_hash
          || !same(challenge.proof_request_hash, proofRequestHash) || challenge.public_result === null) {
          throw new IdempotencyPayloadMismatchError();
        }
        return this.#storedAccessView(challenge.public_result);
      }
      const authorityNow = await this.#finalAuthorityNow(context.client);
      if (!challenge || challenge.state !== "ISSUED" || authorityNow.getTime() >= challenge.expires_at.getTime()
        || verified.account !== link.account || parsed.publicLinkRef !== link.public_link_ref
        || !same(challenge.challenge_hash, digestCanonical(parsed)) || parsed.canonicalOrigin !== this.policy.canonicalOrigin
        || parsed.chainId !== link.chain_id || parsed.account !== link.account || parsed.providerId !== link.provider_id
        || challenge.player_session_id !== context.playerSessionId
        || Number(challenge.player_session_delivery_generation) !== context.playerSessionDeliveryGeneration
        || challenge.purpose !== "RECEIPT_WALLET_LINK" || challenge.privacy_policy_version !== "receipt-wallet-privacy-v1"
        || !same(challenge.permission_scope_digest, digest("account"))
        || parsed.runtimeGeneration !== Number(challenge.runtime_generation)
        || parsed.sessionRevision !== Number(challenge.session_revision)
        || Number(link.runtime_generation) !== parsed.runtimeGeneration
        || Number(link.session_revision) !== parsed.sessionRevision + 1
        || link.state !== "CHALLENGE_ISSUED") throw new PersistenceError("WALLET_PROOF_REJECTED", "Wallet proof could not be accepted.");
      const active = await context.client.query<CredentialRow>(`SELECT * FROM samurai_persistence.wallet_credentials
        WHERE chain_id=$1 AND account=$2 AND state='active' FOR UPDATE`, [link.chain_id, link.account]);
      let credentialRow = active.rows[0];
      if (credentialRow && credentialRow.player_id !== context.subjectId) throw new PersistenceError("WALLET_PROOF_REJECTED", "Wallet proof could not be accepted.");
      if (!credentialRow) {
        const credentialId = randomUUID();
        const inserted = await context.client.query<CredentialRow>(`INSERT INTO samurai_persistence.wallet_credentials
          (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,state,credential_revision,linked_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'active',1,$8,$8) RETURNING *`,
        [credentialId, context.subjectId, link.chain_id, link.account, verified.publicKey, verified.scheme, challenge.challenge_id, authorityNow]);
        credentialRow = inserted.rows[0]!;
      }
      const currentRevision = Number(link.session_revision); safeCoordinate(currentRevision, 1);
      const revision = currentRevision + 1;
      const resultSeed = { walletLinkRef: link.public_link_ref, runtimeGeneration: Number(link.runtime_generation),
        sessionRevision: revision, account: link.account, chainId: link.chain_id };
      const projected = publicView({ ...link, credential_id: credentialRow.credential_id, state: "LINKED",
        terminal_reason: null, session_revision: String(revision), normalized_facts_digest: digestCanonical(resultSeed) });
      await context.client.query(`UPDATE samurai_persistence.wallet_link_challenges SET state='CONSUMED',proof_hash=$2,
        proof_idempotency_key=$3,proof_request_hash=$4,result_hash=$5,public_result=$6::jsonb,consumed_at=$7 WHERE challenge_id=$1`,
      [challenge.challenge_id, proofHash, input.idempotencyKey, proofRequestHash, digestCanonical(projected),
        canonicalJson(projected), authorityNow]);
      const updated = await context.client.query<RuntimeRow>(`UPDATE samurai_persistence.wallet_runtime_links
        SET credential_id=$2,state='LINKED',terminal_reason=NULL,session_revision=$3,changed_at=$4,
            normalized_facts_digest=$5 WHERE id=$1 RETURNING *`,
      [link.id, credentialRow.credential_id, revision, authorityNow, digestCanonical(resultSeed)]);
      await this.#event(context.client, link.id, revision, "PROOF_CONSUMED", {}, authorityNow);
      return publicView(updated.rows[0]!);
    });
  }

  async prepareReview(credential: ServiceSubjectCredential, input: PrepareReceiptReviewInput): Promise<BrowserSafeReceiptReviewProjectionV1> {
    exactIdempotency(input.idempotencyKey);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      this.#requirePlayerContext(context);
      const link = await this.#readyRuntime(context, input);
      const requestHash = digestCanonical(input);
      const replay = await context.client.query<{ readonly request_hash: Uint8Array; readonly public_intent_ref: string }>(`
        SELECT p.request_hash,i.public_intent_ref FROM samurai_persistence.receipt_review_preparations p
        JOIN samurai_persistence.receipt_intents i ON i.id=p.receipt_intent_id
        WHERE p.player_id=$1 AND p.idempotency_key=$2 FOR UPDATE OF p,i`, [context.subjectId, input.idempotencyKey]);
      if (replay.rows[0]) {
        if (!same(replay.rows[0].request_hash, requestHash)) throw new IdempotencyPayloadMismatchError();
        return this.receipts.restoreSettledReceiptProjectionInTransaction(context, replay.rows[0].public_intent_ref);
      }
      const authorityNow = await this.#finalAuthorityNow(context.client);
      const issuedAt = Math.floor(authorityNow.getTime() / 1000);
      const policy = RECEIPT_AUTHORITY_MANIFEST.issuerPolicies.find((item) => item.keyId === this.policy.issuerKeyId);
      if (!policy || policy.policyVersion !== this.policy.issuerPolicyVersion) throw new PersistenceError("RECEIPT_POLICY_UNAVAILABLE", "Receipt review policy is unavailable.");
      const projection = await this.receipts.prepareSettledReceiptIntentInTransaction({ ...context, now: authorityNow }, {
        idempotencyKey: input.idempotencyKey, commitmentNonce: randomBytes(32).toString("hex"), chainId: NETWORK.chainId,
        account: link.account, destination: this.policy.destination, nonce: randomBytes(32).toString("hex"),
        issuedAt: String(issuedAt), expiry: String(issuedAt + 600), deploymentManifestHash: RECEIPT_AUTHORITY_MANIFEST_HASH,
        issuerKeyId: this.policy.issuerKeyId, issuerPolicyVersion: this.policy.issuerPolicyVersion,
      }, this.policy.signer);
      const intent = await context.client.query<{ readonly id: string }>(`SELECT id FROM samurai_persistence.receipt_intents
        WHERE public_intent_ref=$1 AND player_id=$2 FOR UPDATE`, [projection.intent.intentRef, context.subjectId]);
      await context.client.query(`INSERT INTO samurai_persistence.receipt_review_preparations
        (receipt_intent_id,wallet_link_id,player_id,idempotency_key,request_hash,result_hash,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`, [intent.rows[0]!.id, link.id, context.subjectId, input.idempotencyKey,
        requestHash, digestCanonical(projection), authorityNow]);
      return projection;
    });
  }

  async restoreReview(credential: ServiceSubjectCredential, publicIntentRef: string): Promise<BrowserSafeReceiptReviewProjectionV1> {
    if (!INTENT_REF.test(publicIntentRef)) throw new ReceiptLifecycleError("RECEIPT_INTENT_NOT_FOUND", "Receipt review is unavailable.");
    return this.receipts.restoreSettledReceiptProjection(credential, publicIntentRef);
  }

  async restoreLatestReview(credential: ServiceSubjectCredential): Promise<BrowserSafeReceiptReviewProjectionV1> {
    return this.service.runSettledTransaction(credential, "restore-latest-receipt-review", async (context) => {
      const found = await context.client.query<{ readonly public_intent_ref: string }>(`SELECT i.public_intent_ref
        FROM samurai_persistence.receipt_review_preparations p
        JOIN samurai_persistence.receipt_intents i ON i.id=p.receipt_intent_id
        WHERE p.player_id=$1 ORDER BY p.created_at DESC,p.receipt_intent_id DESC LIMIT 1 FOR UPDATE OF p,i`, [context.subjectId]);
      if (!found.rows[0]) throw new ReceiptLifecycleError("RECEIPT_INTENT_NOT_FOUND", "Receipt review is unavailable.");
      return this.receipts.restoreSettledReceiptProjectionInTransaction(context, found.rows[0].public_intent_ref);
    });
  }

  async restoreReviewState(credential: ServiceSubjectCredential): Promise<Readonly<{
    schemaVersion: 1; doorway: typeof RECEIPT_REVIEW_DOORWAY; projection: BrowserSafeReceiptReviewProjectionV1 | null;
    walletAccess: WalletAccessView | null }>> {
    return this.service.runSettledTransaction(credential, "restore-receipt-review-state", async (context) => {
      const found = await context.client.query<{ readonly public_intent_ref: string }>(`SELECT i.public_intent_ref
        FROM samurai_persistence.receipt_review_preparations p
        JOIN samurai_persistence.receipt_intents i ON i.id=p.receipt_intent_id
        WHERE p.player_id=$1 ORDER BY p.created_at DESC,p.receipt_intent_id DESC LIMIT 1 FOR UPDATE OF p,i`, [context.subjectId]);
      const projection = found.rows[0]
        ? await this.receipts.restoreSettledReceiptProjectionInTransaction(context, found.rows[0].public_intent_ref)
        : null;
      const runtime = await context.client.query<RuntimeRow>(`SELECT * FROM samurai_persistence.wallet_runtime_links
        WHERE player_id=$1 AND player_session_id=$2 AND player_session_delivery_generation=$3
          AND state NOT IN ('DISCONNECTED','REVOKED','EXPIRED','REJECTED','CANCELLED')
        ORDER BY changed_at DESC,id DESC LIMIT 1 FOR UPDATE`,
      [context.subjectId, context.playerSessionId, context.playerSessionDeliveryGeneration]);
      return Object.freeze({ schemaVersion: 1, doorway: RECEIPT_REVIEW_DOORWAY, projection,
        walletAccess: runtime.rows[0] ? publicView(runtime.rows[0]) : null });
    });
  }

  async preflight(credential: ServiceSubjectCredential, input: ReceiptReviewPreflightInput): Promise<ReceiptReviewPreflightResult> {
    try {
      exactIdempotency(input.idempotencyKey);
      return await this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
        this.#requirePlayerContext(context);
        const link = await this.#readyRuntime(context, input);
        const projection = await this.receipts.restoreSettledReceiptProjectionInTransaction(context, input.publicIntentRef);
        const preparation = await context.client.query<{ readonly wallet_link_id: string }>(`SELECT p.wallet_link_id::text
          FROM samurai_persistence.receipt_review_preparations p
          JOIN samurai_persistence.receipt_intents i ON i.id=p.receipt_intent_id
          WHERE i.public_intent_ref=$1 AND p.player_id=$2 FOR UPDATE OF p,i`, [input.publicIntentRef, context.subjectId]);
        const authorityNow = await this.#finalAuthorityNow(context.client);
        if (!preparation.rows[0]) return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: "NOT_FOUND" });
        if (preparation.rows[0].wallet_link_id !== link.id) {
          return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: "PROVIDER_CHANGED" });
        }
        if (projection.projectionRevision !== input.expectedProjectionRevision) return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: "PROJECTION_STALE" });
        if (!DIGEST_HEX.test(input.reviewDigest) || input.reviewDigest !== hex(digestCanonical(projection))) {
          return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: "REVIEW_FACTS_MISMATCH" });
        }
        if (authorityNow.getTime() >= new Date(projection.intent.expiresAt).getTime()) return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: "INTENT_EXPIRED" });
        const facts = projection.reviewFacts;
        if (facts.owner !== link.account || facts.source !== link.account) return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: "WALLET_ACCOUNT_CHANGED" });
        if (facts.network.chainId !== link.chain_id) return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: "WRONG_NETWORK" });
        if (facts.network.deploymentManifestHash !== RECEIPT_AUTHORITY_MANIFEST_HASH || facts.destination !== this.policy.destination
          || facts.entrypoint !== "submit_receipt" || facts.attachedMutez !== "0") {
          return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason: "POLICY_MISMATCH" });
        }
        return Object.freeze({ schemaVersion: 1, status: "REVIEW_READY", intentRef: projection.intent.intentRef,
          projectionRevision: projection.projectionRevision, walletLinkRef: link.public_link_ref,
          runtimeGeneration: Number(link.runtime_generation), sessionRevision: Number(link.session_revision),
          reviewDigest: input.reviewDigest, expiresAt: projection.intent.expiresAt });
      });
    } catch (error) {
      const code = error && typeof error === "object" ? String((error as { readonly code?: unknown }).code ?? "") : "";
      const mapped: Readonly<Record<string, Extract<ReceiptReviewPreflightResult, { status: "NOT_READY" }>["reason"]>> = {
        SERVICE_NOT_SETTLED: "SERVICE_NOT_SETTLED", RECEIPT_EXPIRED: "INTENT_EXPIRED", RECEIPT_INTENT_EXPIRED: "INTENT_EXPIRED",
        RUNTIME_GENERATION_STALE: "RUNTIME_GENERATION_STALE", WALLET_SESSION_REVISION_STALE: "WALLET_SESSION_REVISION_STALE",
        WALLET_LINK_REVOKED: "WALLET_LINK_REVOKED", WALLET_LINK_REQUIRED: "WALLET_LINK_REQUIRED",
      };
      const reason = mapped[code] ?? (code.includes("AUTH") ? "AUTHENTICATION_REQUIRED" : code.includes("NOT_FOUND") ? "NOT_FOUND" : "WALLET_LINK_REQUIRED");
      return Object.freeze({ schemaVersion: 1, status: "NOT_READY", reason }) as ReceiptReviewPreflightResult;
    }
  }

  #requirePlayerContext(context: SettledServiceTransactionContext): asserts context is SettledServiceTransactionContext & {
    subjectKind: "player"; playerSessionId: string; playerSessionDeliveryGeneration: number } {
    if (context.subjectKind !== "player" || !context.playerSessionId || !Number.isSafeInteger(context.playerSessionDeliveryGeneration)) {
      throw new PersistenceError("WALLET_LINK_REQUIRED", "An authenticated player credential is required for receipt review.");
    }
  }

  async #readyRuntime(context: SettledServiceTransactionContext & { subjectKind: "player"; playerSessionId: string;
    playerSessionDeliveryGeneration: number }, input: PrepareReceiptReviewInput): Promise<RuntimeRow> {
    const link = await this.#lockRuntime(context.client, context.subjectId, input.walletLinkRef);
    if (Number(link.runtime_generation) !== input.runtimeGeneration) throw new PersistenceError("RUNTIME_GENERATION_STALE", "Wallet runtime generation is stale.");
    if (Number(link.session_revision) !== input.sessionRevision) throw new PersistenceError("WALLET_SESSION_REVISION_STALE", "Wallet session revision is stale.");
    if (!link.credential_id || !["LINKED_EXISTING", "LINKED"].includes(link.state)) throw new PersistenceError("WALLET_LINK_REQUIRED", "An active verified wallet credential is required.");
    if (link.player_session_id !== context.playerSessionId
      || Number(link.player_session_delivery_generation) !== context.playerSessionDeliveryGeneration) throw new PersistenceError("WALLET_SESSION_REVISION_STALE", "Wallet session authority is stale.");
    const credential = await context.client.query<CredentialRow>(`SELECT * FROM samurai_persistence.wallet_credentials
      WHERE credential_id=$1 AND player_id=$2 AND chain_id=$3 AND account=$4 AND state='active' FOR UPDATE`,
    [link.credential_id, context.subjectId, link.chain_id, link.account]);
    if (!credential.rows[0]) throw new PersistenceError("WALLET_LINK_REVOKED", "The wallet credential is revoked.");
    return link;
  }

  async #lockRuntime(client: SqlClient, playerId: string, linkRef: string): Promise<RuntimeRow> {
    if (!LINK_REF.test(linkRef)) throw new PersistenceError("WALLET_LINK_NOT_FOUND", "Wallet access is unavailable.");
    const result = await client.query<RuntimeRow>(`SELECT * FROM samurai_persistence.wallet_runtime_links
      WHERE public_link_ref=$1 AND player_id=$2 FOR UPDATE`, [linkRef, playerId]);
    if (!result.rows[0]) throw new PersistenceError("WALLET_LINK_NOT_FOUND", "Wallet access is unavailable.");
    return result.rows[0];
  }

  async #lockScope(client: SqlClient, scope: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
  }

  async #finalAuthorityNow(client: SqlClient): Promise<Date> {
    const clock = await client.query<{ readonly now: Date }>(
      "SELECT clock_timestamp() AS now /* receipt-review-final-authority-clock */",
    );
    return clock.rows[0]!.now;
  }

  async #event(client: SqlClient, linkId: string, sequence: number, kind: string,
    payload: Readonly<Record<string, unknown>>, now: Date): Promise<void> {
    await client.query(`INSERT INTO samurai_persistence.wallet_link_events
      (wallet_link_id,sequence,kind,public_payload,created_at) VALUES ($1,$2,$3,$4::jsonb,$5)
      ON CONFLICT (wallet_link_id,sequence) DO NOTHING`, [linkId, sequence, kind, canonicalJson(payload), now]);
  }

  #challengeFromRow(row: ChallengeRow, publicLinkRefValue: string): WalletLinkChallengeV1 {
    const challenge = parseWalletLinkChallenge(row.public_challenge);
    if (challenge.publicLinkRef !== publicLinkRefValue || !same(row.challenge_hash, digestCanonical(challenge))) {
      throw new PersistenceError("WALLET_CHALLENGE_REPLAY_INVALID", "Stored wallet challenge is unavailable.");
    }
    return challenge;
  }

  #storedAccessView(value: unknown): WalletAccessView {
    try {
      const candidate = parseWalletAccessView(value);
      if (candidate.state !== "ACTIVE_CREDENTIAL_MATCH" || candidate.credentialMatch !== true) throw new Error("not linked");
      return candidate;
    } catch {
      throw new PersistenceError("WALLET_PROOF_REPLAY_INVALID", "Stored wallet proof result is unavailable.");
    }
  }
}
