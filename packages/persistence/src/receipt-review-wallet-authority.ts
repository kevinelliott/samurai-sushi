import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@samurai-sushi/domain";
import { verifyWalletLinkProof, type AccountProofInput } from "@samurai-sushi/account-proof-verifier";
import { RECEIPT_AUTHORITY_MANIFEST, RECEIPT_AUTHORITY_MANIFEST_HASH } from "@samurai-sushi/receipt-authority";
import type { ReceiptPermitSigner } from "@samurai-sushi/receipt-authority/server";
import { GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY, type BrowserSafeReceiptReviewProjectionV1 } from "@samurai-sushi/receipt-lifecycle";
import {
  parseWalletLinkChallenge,
  parseWalletAccessView,
  notReady,
  RECEIPT_REVIEW_DOORWAY,
  WALLET_REVIEW_COPY,
  type DisplayOnlyWalletAccessView,
  type NormalizedWalletRuntime,
  type ReceiptReviewPreflightResult,
  type WalletAccessView,
  type WalletRuntimeSyncView,
  type WalletLinkChallengeV1,
} from "@samurai-sushi/wallet-link";
import type { SqlClient, SqlPool } from "./database";
import { IdempotencyPayloadMismatchError, PersistenceError, ReceiptLifecycleError } from "./errors";
import type { ReceiptLifecycleAuthority } from "./receipt-lifecycle-authority";
import type { EveningServiceAuthority, ServiceSubjectCredential, SettledServiceTransactionContext } from "./service-authority";

const NETWORK = GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0]!;
const LINK_REF = /^wl_[A-Za-z0-9_-]{22}$/;
const CHALLENGE_REF = /^wc_[A-Za-z0-9_-]{22}$/;
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

export interface RevokeWalletCredentialInput {
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
  readonly linked_challenge_id: string | null;
  readonly linked_challenge_state: "ISSUED" | "CONSUMED" | "EXPIRED" | "REVOKED" | null;
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
  readonly public_challenge_ref: string;
  readonly wallet_link_id: string;
  readonly player_id: string;
  readonly player_session_id: string;
  readonly player_session_delivery_generation: string;
  readonly credential_id: string | null;
  readonly purpose: "RECEIPT_WALLET_LINK";
  readonly canonical_origin: string;
  readonly chain_id: string;
  readonly account: string;
  readonly provider_id: string;
  readonly permission_scope_digest: Uint8Array;
  readonly issued_runtime_generation: string;
  readonly runtime_generation: string;
  readonly issued_session_revision: string;
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
function publicChallengeRef(): string { return `wc_${randomBytes(16).toString("base64url")}`; }
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
    providerId: row.provider_id as "localnet-wallet" | "deterministic-wallet", chainId: row.chain_id, account: row.account,
    permissionScopes: Object.freeze(["account"] as const), credentialMatch: match,
    reason: state === "ACCOUNT_PROOF_UNAVAILABLE" ? "ACCOUNT_PROOF_UNAVAILABLE"
      : state === "DISCONNECTED" ? "DISCONNECTED" : state === "REVOKED" ? "REVOKED" : null,
    presentation });
}

function displayOnlyGuestView(runtime: NormalizedWalletRuntime): WalletRuntimeSyncView {
  return Object.freeze({ schemaVersion: 1, accessScope: "DISPLAY_ONLY", state: "ACCOUNT_PROOF_UNAVAILABLE",
    providerId: runtime.providerId, chainId: runtime.chainId, account: runtime.account,
    permissionScopes: Object.freeze(["account"] as const), credentialMatch: false,
    reason: "ACCOUNT_PROOF_UNAVAILABLE" as const,
    presentation: WALLET_REVIEW_COPY["wallet.access.account-proof-unavailable"] });
}

export class ReceiptReviewWalletAuthority {
  constructor(
    _pool: SqlPool,
    readonly service: EveningServiceAuthority,
    readonly receipts: ReceiptLifecycleAuthority,
    readonly policy: ReceiptReviewWalletPolicy,
  ) {}

  async syncRuntime(credential: Extract<ServiceSubjectCredential, { readonly kind: "guest" }>, input: SyncWalletRuntimeInput): Promise<DisplayOnlyWalletAccessView>;
  async syncRuntime(credential: Extract<ServiceSubjectCredential, { readonly kind: "player" }>, input: SyncWalletRuntimeInput): Promise<WalletAccessView>;
  async syncRuntime(credential: ServiceSubjectCredential, input: SyncWalletRuntimeInput): Promise<WalletRuntimeSyncView>;
  async syncRuntime(credential: ServiceSubjectCredential, input: SyncWalletRuntimeInput): Promise<WalletRuntimeSyncView> {
    exactIdempotency(input.idempotencyKey); safeCoordinate(input.runtimeGeneration, 1); safeCoordinate(input.sessionRevision, 4);
    const runtimeHash = digestCanonical(input.runtime);
    const requestHash = digestCanonical(input);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      if (input.runtime.chainId !== NETWORK.chainId || input.runtime.permissionScopes.length !== 1
        || input.runtime.permissionScopes[0] !== "account") throw new PersistenceError("WALLET_RUNTIME_INVALID", "Wallet runtime facts do not match the registered review policy.");
      if (context.subjectKind === "guest") return displayOnlyGuestView(input.runtime);
      this.#requirePlayerContext(context);
      await this.#lockScope(context.client, `wallet-account:${input.runtime.chainId}:${input.runtime.account}`);
      const replay = await context.client.query<RuntimeRow>(`SELECT * FROM samurai_persistence.wallet_runtime_links
        WHERE player_id=$1 AND idempotency_key=$2 FOR UPDATE`, [context.subjectId, input.idempotencyKey]);
      if (replay.rows[0]) {
        if (!same(replay.rows[0].request_hash, requestHash)) throw new IdempotencyPayloadMismatchError();
        return this.#validatedPublicView(context.client, context, replay.rows[0]);
      }
      const active = await context.client.query<CredentialRow>(`SELECT * FROM samurai_persistence.wallet_credentials
        WHERE player_id=$1 AND chain_id=$2 AND account=$3 AND state='active' FOR UPDATE`,
      [context.subjectId, input.runtime.chainId, input.runtime.account]);
      const credentialRow = active.rows[0] ?? null;
      const authorityNow = await this.#finalAuthorityNow(context.client);
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
        runtimeHash, input.idempotencyKey, requestHash, digestCanonical(result), authorityNow]);
      await this.#event(context.client, id, 0, "RUNTIME_SYNCED", { state: result.state }, authorityNow);
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
      return this.#validatedPublicView(context.client, context, row);
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
      const authorityNow = await this.#finalAuthorityNow(context.client);
      const generation = input.runtimeGeneration + 1; const revision = input.sessionRevision + 1;
      await context.client.query(`UPDATE samurai_persistence.wallet_link_challenges
        SET state=CASE WHEN state='ISSUED' THEN 'REVOKED' ELSE state END,
            revoked_at=CASE WHEN state='ISSUED' THEN $4 ELSE revoked_at END,
            runtime_generation=$2,session_revision=$3 WHERE wallet_link_id=$1`, [row.id, generation, revision, authorityNow]);
      const updated = await context.client.query<RuntimeRow>(`UPDATE samurai_persistence.wallet_runtime_links
        SET state='DISCONNECTED',runtime_generation=$2,session_revision=$3,terminal_reason='PROVIDER_DISCONNECTED',
            linked_challenge_id=CASE WHEN credential_id IS NULL THEN NULL ELSE linked_challenge_id END,
            linked_challenge_state=CASE WHEN credential_id IS NULL THEN NULL ELSE linked_challenge_state END,
            normalized_facts_digest=$4,changed_at=$5,disconnected_at=$5
        WHERE id=$1 RETURNING *`, [row.id, generation, revision, digest(`disconnected:${generation}:${revision}`), authorityNow]);
      await this.#event(context.client, row.id, revision, "DISCONNECTED", {
        reason: "DISCONNECTED", idempotencyKey: input.idempotencyKey, requestHash: hex(requestHash),
      }, authorityNow);
      return publicView(updated.rows[0]!);
    });
  }

  async revokeCredential(credential: ServiceSubjectCredential, input: RevokeWalletCredentialInput): Promise<WalletAccessView> {
    exactIdempotency(input.idempotencyKey); safeCoordinate(input.runtimeGeneration, 1); safeCoordinate(input.sessionRevision, 1);
    const requestHash = digestCanonical(input);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      this.#requirePlayerContext(context);
      const link = await this.#lockRuntime(context.client, context.subjectId, input.walletLinkRef);
      const replay = await context.client.query<{ readonly public_payload: Record<string, unknown> }>(`SELECT public_payload
        FROM samurai_persistence.wallet_link_events WHERE wallet_link_id=$1 AND kind='REVOKED'
          AND public_payload->>'idempotencyKey'=$2 ORDER BY sequence DESC LIMIT 1 FOR UPDATE`, [link.id, input.idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].public_payload.requestHash !== hex(requestHash)) throw new IdempotencyPayloadMismatchError();
        return publicView(link);
      }
      if (link.player_session_id !== context.playerSessionId
        || Number(link.player_session_delivery_generation) !== context.playerSessionDeliveryGeneration
        || Number(link.runtime_generation) !== input.runtimeGeneration || Number(link.session_revision) !== input.sessionRevision
        || !link.credential_id || !["LINKED_EXISTING", "LINKED"].includes(link.state)) {
        throw new PersistenceError("WALLET_LINK_REVOKED", "The wallet credential cannot be revoked from stale runtime authority.");
      }
      await this.#lockScope(context.client, `wallet-account:${link.chain_id}:${link.account}`);
      const active = await context.client.query<CredentialRow>(`SELECT * FROM samurai_persistence.wallet_credentials
        WHERE credential_id=$1 AND player_id=$2 AND chain_id=$3 AND account=$4 AND state='active' FOR UPDATE`,
      [link.credential_id, context.subjectId, link.chain_id, link.account]);
      if (!active.rows[0]) throw new PersistenceError("WALLET_LINK_REVOKED", "The wallet credential is already revoked.");
      const authorityNow = await this.#finalAuthorityNow(context.client);
      await context.client.query(`UPDATE samurai_persistence.wallet_credentials
        SET state='revoked',credential_revision=credential_revision+1,updated_at=$2,revoked_at=$2
        WHERE credential_id=$1`, [link.credential_id, authorityNow]);
      const updated = await this.#lockRuntime(context.client, context.subjectId, input.walletLinkRef);
      await this.#event(context.client, updated.id, Number(updated.session_revision), "REVOKED", {
        reason: "CREDENTIAL_REVOKED", idempotencyKey: input.idempotencyKey, requestHash: hex(requestHash),
      }, authorityNow);
      return publicView(updated);
    });
  }

  async issueChallenge(credential: ServiceSubjectCredential, input: Readonly<{ idempotencyKey: string; walletLinkRef: string;
    runtimeGeneration: number; sessionRevision: number }>): Promise<Readonly<{ challengeRef: string; challenge: WalletLinkChallengeV1 }>> {
    exactIdempotency(input.idempotencyKey); safeCoordinate(input.runtimeGeneration); safeCoordinate(input.sessionRevision, 1);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      this.#requirePlayerContext(context);
      const link = await this.#lockRuntime(context.client, context.subjectId, input.walletLinkRef);
      await this.#lockScope(context.client, `wallet-account:${link.chain_id}:${link.account}`);
      const replay = await context.client.query<ChallengeRow>(`SELECT * FROM samurai_persistence.wallet_link_challenges
        WHERE idempotency_key=$1 FOR UPDATE`, [input.idempotencyKey]);
      const authorityNow = await this.#finalAuthorityNow(context.client);
      if (replay.rows[0]) {
        if (replay.rows[0].wallet_link_id !== link.id || replay.rows[0].player_id !== context.subjectId
          || !same(replay.rows[0].request_hash, digestCanonical(input))) throw new IdempotencyPayloadMismatchError();
        if (replay.rows[0].state !== "ISSUED" || authorityNow.getTime() >= replay.rows[0].expires_at.getTime()
          || replay.rows[0].player_session_id !== context.playerSessionId
          || Number(replay.rows[0].player_session_delivery_generation) !== context.playerSessionDeliveryGeneration
          || Number(replay.rows[0].runtime_generation) !== Number(link.runtime_generation)
          || Number(replay.rows[0].session_revision) !== Number(link.session_revision)
          || link.state !== "CHALLENGE_ISSUED" || link.linked_challenge_state !== "ISSUED") {
          throw new PersistenceError("WALLET_CHALLENGE_REPLAY_INVALID", "Stored wallet challenge is unavailable.");
        }
        return { challengeRef: replay.rows[0].public_challenge_ref, challenge: this.#challengeFromRow(replay.rows[0], link.public_link_ref) };
      }
      if (Number(link.runtime_generation) !== input.runtimeGeneration || Number(link.session_revision) !== input.sessionRevision
        || link.state !== "PERMISSIONED" || link.credential_id !== null) throw new PersistenceError("WALLET_RUNTIME_STALE", "Wallet runtime cannot issue this proof challenge.");
      const nonce = randomBytes(32).toString("base64url");
      const challenge = parseWalletLinkChallenge({
        domain: "samurai-sushi:receipt-wallet-link:v1", schemaVersion: 1, purpose: "RECEIPT_WALLET_LINK",
        canonicalOrigin: this.policy.canonicalOrigin, publicLinkRef: link.public_link_ref, chainId: link.chain_id,
        account: link.account, providerId: link.provider_id, permissionScopeDigest: hex(digest("account")),
        runtimeGeneration: input.runtimeGeneration, sessionRevision: input.sessionRevision + 1,
        privacyPolicyVersion: "receipt-wallet-privacy-v1", nonce, issuedAt: authorityNow.toISOString(),
        expiresAt: new Date(authorityNow.getTime() + CHALLENGE_LIFETIME_MS).toISOString(),
      });
      const challengeId = randomUUID(); const challengeRef = publicChallengeRef(); const challengeHash = digestCanonical(challenge);
      await context.client.query(`INSERT INTO samurai_persistence.wallet_link_challenges
        (challenge_id,public_challenge_ref,wallet_link_id,player_id,player_session_id,player_session_delivery_generation,purpose,canonical_origin,
         chain_id,account,provider_id,permission_scope_digest,issued_runtime_generation,runtime_generation,issued_session_revision,session_revision,privacy_policy_version,
         nonce_digest,challenge_hash,public_challenge,request_hash,idempotency_key,state,issued_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,'RECEIPT_WALLET_LINK',$7,$8,$9,$10,$11,$12,$12,$13,$13,'receipt-wallet-privacy-v1',$14,$15,$16,$17,$18,'ISSUED',$19,$20)`,
      [challengeId, challengeRef, link.id, context.subjectId, context.playerSessionId, context.playerSessionDeliveryGeneration,
        this.policy.canonicalOrigin, link.chain_id, link.account, link.provider_id, digest("account"), input.runtimeGeneration,
        input.sessionRevision + 1, digest(nonce), challengeHash, canonicalJson(challenge), digestCanonical(input), input.idempotencyKey, authorityNow,
        new Date(authorityNow.getTime() + CHALLENGE_LIFETIME_MS)]);
      await context.client.query(`UPDATE samurai_persistence.wallet_runtime_links SET state='CHALLENGE_ISSUED',linked_challenge_id=$3,
        linked_challenge_state='ISSUED',terminal_reason=NULL,session_revision=session_revision+1,changed_at=$2 WHERE id=$1`, [link.id, authorityNow, challengeId]);
      await this.#event(context.client, link.id, input.sessionRevision + 1, "CHALLENGE_ISSUED", {}, authorityNow);
      return Object.freeze({ challengeRef, challenge });
    });
  }

  async consumeProof(credential: ServiceSubjectCredential, input: Readonly<{ idempotencyKey: string; walletLinkRef: string;
    challengeRef: string; proof: AccountProofInput }>): Promise<WalletAccessView> {
    exactIdempotency(input.idempotencyKey);
    if (!CHALLENGE_REF.test(input.challengeRef)) throw new PersistenceError("WALLET_PROOF_REJECTED", "Wallet proof could not be accepted.");
    const verified = verifyWalletLinkProof(input.proof);
    const parsed = parseWalletLinkChallenge(input.proof.challenge);
    const proofHash = digestCanonical(input.proof);
    const proofRequestHash = digestCanonical(input);
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async (context) => {
      this.#requirePlayerContext(context);
      const link = await this.#lockRuntime(context.client, context.subjectId, input.walletLinkRef);
      await this.#lockScope(context.client, `wallet-account:${link.chain_id}:${link.account}`);
      const found = await context.client.query<ChallengeRow>(`SELECT * FROM samurai_persistence.wallet_link_challenges
        WHERE public_challenge_ref=$1 AND wallet_link_id=$2 AND player_id=$3 FOR UPDATE`, [input.challengeRef, link.id, context.subjectId]);
      const challenge = found.rows[0];
      const coordinatesMatch = Boolean(challenge)
        && verified.account === link.account
        && parsed.publicLinkRef === link.public_link_ref
        && same(challenge!.challenge_hash, digestCanonical(parsed))
        && parsed.canonicalOrigin === this.policy.canonicalOrigin
        && parsed.chainId === link.chain_id && parsed.account === link.account && parsed.providerId === link.provider_id
        && challenge!.chain_id === link.chain_id && challenge!.account === link.account && challenge!.provider_id === link.provider_id
        && challenge!.player_session_id === context.playerSessionId
        && Number(challenge!.player_session_delivery_generation) === context.playerSessionDeliveryGeneration
        && link.player_session_id === context.playerSessionId
        && Number(link.player_session_delivery_generation) === context.playerSessionDeliveryGeneration
        && challenge!.purpose === "RECEIPT_WALLET_LINK" && challenge!.privacy_policy_version === "receipt-wallet-privacy-v1"
        && same(challenge!.permission_scope_digest, digest("account"))
        && parsed.runtimeGeneration === Number(challenge!.issued_runtime_generation)
        && parsed.sessionRevision === Number(challenge!.issued_session_revision)
        && Number(challenge!.runtime_generation) === Number(link.runtime_generation)
        && Number(challenge!.session_revision) === Number(link.session_revision)
        && Number(link.runtime_generation) === parsed.runtimeGeneration
        && link.linked_challenge_id === challenge!.challenge_id;
      if (challenge?.state === "CONSUMED") {
        if (challenge.proof_idempotency_key !== input.idempotencyKey || !challenge.proof_hash
          || !same(challenge.proof_hash, proofHash) || !challenge.proof_request_hash
          || !same(challenge.proof_request_hash, proofRequestHash)) {
          throw new IdempotencyPayloadMismatchError();
        }
        if (challenge.public_result === null || !challenge.result_hash
          || !same(challenge.result_hash, digestCanonical(challenge.public_result))) {
          throw new PersistenceError("WALLET_PROOF_REPLAY_INVALID", "Stored wallet proof result is unavailable.");
        }
        if (!coordinatesMatch || link.state !== "LINKED" || link.linked_challenge_state !== "CONSUMED"
          || !link.credential_id || challenge.credential_id !== link.credential_id) {
          throw new PersistenceError("WALLET_PROOF_REJECTED", "Wallet proof could not be accepted.");
        }
        const activeCredential = await context.client.query<CredentialRow>(`SELECT * FROM samurai_persistence.wallet_credentials
          WHERE credential_id=$1 AND player_id=$2 AND chain_id=$3 AND account=$4 AND state='active' FOR UPDATE`,
        [link.credential_id, context.subjectId, link.chain_id, link.account]);
        if (!activeCredential.rows[0]) throw new PersistenceError("WALLET_PROOF_REJECTED", "Wallet proof could not be accepted.");
        return this.#storedAccessView(challenge.public_result, link);
      }
      if (!challenge || challenge.state !== "ISSUED" || !coordinatesMatch || Number(link.session_revision) !== parsed.sessionRevision
        || link.state !== "CHALLENGE_ISSUED" || link.linked_challenge_state !== "ISSUED" || link.credential_id !== null) {
        throw new PersistenceError("WALLET_PROOF_REJECTED", "Wallet proof could not be accepted.");
      }
      const active = await context.client.query<CredentialRow>(`SELECT * FROM samurai_persistence.wallet_credentials
        WHERE chain_id=$1 AND account=$2 AND state='active' FOR UPDATE`, [link.chain_id, link.account]);
      let credentialRow = active.rows[0];
      if (credentialRow && credentialRow.player_id !== context.subjectId) throw new PersistenceError("WALLET_PROOF_REJECTED", "Wallet proof could not be accepted.");
      if (!credentialRow) {
        const credentialId = randomUUID();
        const credentialNow = await this.#finalAuthorityNow(context.client);
        const inserted = await context.client.query<CredentialRow>(`INSERT INTO samurai_persistence.wallet_credentials
          (credential_id,player_id,chain_id,account,public_key,scheme,linked_claim_id,state,credential_revision,linked_at,updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,'active',1,$8,$8) RETURNING *`,
        [credentialId, context.subjectId, link.chain_id, link.account, verified.publicKey, verified.scheme, challenge.challenge_id, credentialNow]);
        credentialRow = inserted.rows[0]!;
      }
      const authorityNow = await this.#finalAuthorityNow(context.client);
      if (authorityNow.getTime() >= challenge.expires_at.getTime()) {
        throw new PersistenceError("WALLET_PROOF_REJECTED", "Wallet proof could not be accepted.");
      }
      const currentRevision = Number(link.session_revision); safeCoordinate(currentRevision, 1);
      const revision = currentRevision + 1;
      const resultSeed = { walletLinkRef: link.public_link_ref, runtimeGeneration: Number(link.runtime_generation),
        sessionRevision: revision, account: link.account, chainId: link.chain_id };
      const projected = publicView({ ...link, credential_id: credentialRow.credential_id, state: "LINKED",
        terminal_reason: null, session_revision: String(revision), normalized_facts_digest: digestCanonical(resultSeed) });
      await context.client.query(`UPDATE samurai_persistence.wallet_link_challenges SET state='CONSUMED',credential_id=$2,session_revision=$9,proof_hash=$3,
        proof_idempotency_key=$4,proof_request_hash=$5,result_hash=$6,public_result=$7::jsonb,consumed_at=$8 WHERE challenge_id=$1`,
      [challenge.challenge_id, credentialRow.credential_id, proofHash, input.idempotencyKey, proofRequestHash, digestCanonical(projected),
        canonicalJson(projected), authorityNow, revision]);
      const updated = await context.client.query<RuntimeRow>(`UPDATE samurai_persistence.wallet_runtime_links
        SET credential_id=$2,state='LINKED',linked_challenge_id=$6,linked_challenge_state='CONSUMED',terminal_reason=NULL,session_revision=$3,changed_at=$4,
            normalized_facts_digest=$5 WHERE id=$1 RETURNING *`,
      [link.id, credentialRow.credential_id, revision, authorityNow, digestCanonical(resultSeed), challenge.challenge_id]);
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
      const walletAccess = runtime.rows[0] ? await this.#validatedPublicView(context.client, context, runtime.rows[0]) : null;
      return Object.freeze({ schemaVersion: 1, doorway: RECEIPT_REVIEW_DOORWAY, projection, walletAccess });
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
        if (!preparation.rows[0]) return notReady("NOT_FOUND");
        if (preparation.rows[0].wallet_link_id !== link.id) {
          return notReady("PROVIDER_CHANGED");
        }
        if (projection.projectionRevision !== input.expectedProjectionRevision) return notReady("PROJECTION_STALE");
        if (!DIGEST_HEX.test(input.reviewDigest) || input.reviewDigest !== hex(digestCanonical(projection))) {
          return notReady("REVIEW_FACTS_MISMATCH");
        }
        if (authorityNow.getTime() >= new Date(projection.intent.expiresAt).getTime()) return notReady("INTENT_EXPIRED");
        const facts = projection.reviewFacts;
        if (facts.owner !== link.account || facts.source !== link.account) return notReady("WALLET_ACCOUNT_CHANGED");
        if (facts.network.chainId !== link.chain_id) return notReady("WRONG_NETWORK");
        if (facts.network.deploymentManifestHash !== RECEIPT_AUTHORITY_MANIFEST_HASH || facts.destination !== this.policy.destination
          || facts.entrypoint !== "submit_receipt" || facts.attachedMutez !== "0") {
          return notReady("POLICY_MISMATCH");
        }
        return Object.freeze({ schemaVersion: 1, status: "REVIEW_READY", intentRef: projection.intent.intentRef,
          projectionRevision: projection.projectionRevision, walletLinkRef: link.public_link_ref,
          runtimeGeneration: Number(link.runtime_generation), sessionRevision: Number(link.session_revision),
          reviewDigest: input.reviewDigest, expiresAt: projection.intent.expiresAt,
          presentation: WALLET_REVIEW_COPY["receipt.preflight.ready"] });
      });
    } catch (error) {
      const code = error && typeof error === "object" ? String((error as { readonly code?: unknown }).code ?? "") : "";
      const mapped: Readonly<Record<string, Extract<ReceiptReviewPreflightResult, { status: "NOT_READY" }>["reason"]>> = {
        SERVICE_NOT_SETTLED: "SERVICE_NOT_SETTLED", RECEIPT_EXPIRED: "INTENT_EXPIRED", RECEIPT_INTENT_EXPIRED: "INTENT_EXPIRED",
        RUNTIME_GENERATION_STALE: "RUNTIME_GENERATION_STALE", WALLET_SESSION_REVISION_STALE: "WALLET_SESSION_REVISION_STALE",
        WALLET_LINK_REVOKED: "WALLET_LINK_REVOKED", WALLET_LINK_REQUIRED: "WALLET_LINK_REQUIRED",
      };
      const reason = mapped[code] ?? (code.includes("AUTH") ? "AUTHENTICATION_REQUIRED" : code.includes("NOT_FOUND") ? "NOT_FOUND" : "WALLET_LINK_REQUIRED");
      return notReady(reason);
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
    if (link.state === "LINKED") {
      const proof = await context.client.query<{ readonly challenge_id: string }>(`SELECT challenge_id::text
        FROM samurai_persistence.wallet_link_challenges WHERE challenge_id=$1 AND wallet_link_id=$2
          AND credential_id=$3 AND state='CONSUMED' FOR UPDATE`, [link.linked_challenge_id, link.id, link.credential_id]);
      if (!proof.rows[0] || link.linked_challenge_state !== "CONSUMED") {
        throw new PersistenceError("WALLET_LINK_REVOKED", "The wallet proof authority is unavailable.");
      }
    }
    return link;
  }

  async #validatedPublicView(client: SqlClient, context: SettledServiceTransactionContext, row: RuntimeRow): Promise<WalletAccessView> {
    if (!["LINKED_EXISTING", "LINKED"].includes(row.state) || !row.credential_id) return publicView(row);
    if (row.player_session_id !== context.playerSessionId
      || Number(row.player_session_delivery_generation) !== context.playerSessionDeliveryGeneration) {
      throw new PersistenceError("WALLET_LINK_NOT_FOUND", "Wallet access is unavailable.");
    }
    const credential = await client.query<CredentialRow>(`SELECT * FROM samurai_persistence.wallet_credentials
      WHERE credential_id=$1 AND player_id=$2 AND chain_id=$3 AND account=$4 AND state='active' FOR UPDATE`,
    [row.credential_id, context.subjectId, row.chain_id, row.account]);
    if (!credential.rows[0]) return publicView({ ...row, state: "REVOKED", terminal_reason: "CREDENTIAL_REVOKED" });
    if (row.state === "LINKED") {
      const proof = await client.query<{ readonly challenge_id: string }>(`SELECT challenge_id::text
        FROM samurai_persistence.wallet_link_challenges WHERE challenge_id=$1 AND wallet_link_id=$2
          AND credential_id=$3 AND state='CONSUMED' FOR UPDATE`, [row.linked_challenge_id, row.id, row.credential_id]);
      if (!proof.rows[0] || row.linked_challenge_state !== "CONSUMED") {
        return publicView({ ...row, state: "REVOKED", terminal_reason: "CREDENTIAL_REVOKED" });
      }
    }
    return publicView(row);
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

  #storedAccessView(value: unknown, link: RuntimeRow): WalletAccessView {
    try {
      const candidate = parseWalletAccessView(value);
      if (candidate.state !== "ACTIVE_CREDENTIAL_MATCH" || candidate.credentialMatch !== true
        || candidate.walletLinkRef !== link.public_link_ref || candidate.runtimeGeneration !== Number(link.runtime_generation)
        || candidate.sessionRevision !== Number(link.session_revision) || candidate.providerId !== link.provider_id
        || candidate.chainId !== link.chain_id || candidate.account !== link.account) throw new Error("not linked");
      return candidate;
    } catch {
      throw new PersistenceError("WALLET_PROOF_REPLAY_INVALID", "Stored wallet proof result is unavailable.");
    }
  }
}
