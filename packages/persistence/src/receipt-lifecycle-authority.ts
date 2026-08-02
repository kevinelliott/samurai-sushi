import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "@samurai-sushi/domain";
import {
  RECEIPT_AUTHORITY_MANIFEST,
  receiptOwnerCommitmentKey,
  receiptPayloadPackedHex,
  type ReceiptPermitV1,
} from "@samurai-sushi/receipt-authority";
import { admitSettledReceiptPermit, issueSettledReceiptPermit, type ReceiptPermitSigner } from "@samurai-sushi/receipt-authority/server";
import {
  GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY,
  normalizeOperationObservation,
  parseBrowserSafeReceiptReviewProjection,
  reduceOperationObservation,
  type AttemptObservationState,
  type BrowserSafeReceiptReviewProjectionV1,
  type ChainObserver,
  type NormalizedOperationObservation,
  type OperationAttemptState,
} from "@samurai-sushi/receipt-lifecycle";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import { IdempotencyPayloadMismatchError, ReceiptLifecycleError, ReceiptWorkerClaimLostError } from "./errors";
import type { ServiceSubjectCredential, EveningServiceAuthority } from "./service-authority";

const PUBLIC_NETWORK = GENERATED_REGISTERED_RECEIPT_NETWORK_INVENTORY[0]!;

export type ReceiptLifecycleWriteBoundary = "intent" | "event" | "outbox" | "audit" | "attempt" | "observation" | "projection" | "incident" | "terminal-fence";

export interface ReceiptLifecycleAuthorityOptions {
  readonly afterWriteBoundary?: (boundary: ReceiptLifecycleWriteBoundary) => void | Promise<void>;
  readonly reconciliationDelayMs?: number;
  readonly maximumConsecutiveFailures?: number;
}

export interface PrepareSettledReceiptIntentInput {
  readonly idempotencyKey: string;
  readonly commitmentNonce: string;
  readonly chainId: string;
  readonly account: string;
  readonly destination: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiry: string;
  readonly deploymentManifestHash: string;
  readonly issuerKeyId: string;
  readonly issuerPolicyVersion: string;
}

export interface ReconciliationClaim {
  readonly attemptId: string;
  readonly claimToken: string;
  readonly claimGeneration: number;
  readonly claimExpiresAt: string;
  readonly identity: {
    readonly chainId: string;
    readonly operationHash: string;
    readonly sourceAccount: string;
    readonly contractAddress: string;
    readonly deploymentManifestHash: string;
  };
}

interface ExistingIntentRow {
  readonly id: string;
  readonly public_intent_ref: string;
  readonly request_hash: Uint8Array;
  readonly state: string;
  readonly projection_revision: string;
  readonly created_at: Date;
}

interface IntentRow {
  readonly id: string;
  readonly public_intent_ref: string;
  readonly subject_kind: "guest" | "player";
  readonly subject_id: string;
  readonly state: string;
  readonly chain_id: string;
  readonly account: string;
  readonly contract_address: string;
  readonly service_commitment: Uint8Array;
  readonly content_version: string;
  readonly nonce: Uint8Array;
  readonly payload_hash: Uint8Array;
  readonly deployment_manifest_hash: Uint8Array;
  readonly issuer_key_id: string;
  readonly issuer_policy_version: string;
  readonly confirmation_threshold: number;
  readonly finality_policy_id: string;
  readonly expires_at: Date;
  readonly projection_revision: string;
}

interface AttemptRow {
  readonly id: string;
  readonly public_attempt_ref: string;
  readonly intent_id: string;
  readonly chain_id: string;
  readonly operation_hash: string;
  readonly source_account: string;
  readonly contract_address: string;
  readonly deployment_manifest_hash: Uint8Array;
  readonly counter: string;
  readonly state: OperationAttemptState;
  readonly last_rpc_source_sequence: string | null;
  readonly last_indexer_source_sequence: string | null;
  readonly last_head_level: string | null;
  readonly last_head_block_hash: string | null;
  readonly canonical_block_level: string | null;
  readonly canonical_block_hash: string | null;
  readonly confirmations: number;
  readonly submitted_at: Date;
}

interface ClaimRow extends AttemptRow {
  readonly claim_token: string;
  readonly claim_generation: string;
  readonly claim_expires_at: Date;
}

interface DatabaseClockRow { readonly now: Date }

function digest(value: string | Uint8Array): Uint8Array {
  return createHash("sha256").update(value).digest();
}

function digestCanonical(value: unknown): Uint8Array {
  return digest(canonicalJson(value));
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function bytes(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", `${label} must be 32 lowercase hexadecimal bytes.`);
  return Buffer.from(value, "hex");
}

function uuidV4(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", `${label} must be UUIDv4.`);
}

function positiveInteger(value: number, label: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", `${label} is invalid.`);
}

function publicRef(prefix: "ri" | "ra"): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

function epochSeconds(date: Date): string {
  return String(Math.floor(date.getTime() / 1000));
}

function dateFromEpoch(value: string, label: string): Date {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", `${label} is invalid.`);
  const millis = Number(BigInt(value) * 1000n);
  if (!Number.isSafeInteger(millis)) throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", `${label} is outside the supported range.`);
  return new Date(millis);
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function reviewedProjection(
  permit: ReceiptPermitV1,
  publicIntentRef: string,
  createdAt: Date,
  revision: number,
): BrowserSafeReceiptReviewProjectionV1 {
  return parseBrowserSafeReceiptReviewProjection({
    schemaVersion: 1,
    projectionRevision: String(revision),
    intent: { intentRef: publicIntentRef, state: "REVIEWED", createdAt: createdAt.toISOString(), expiresAt: dateFromEpoch(permit.payload.expiry, "receipt expiry").toISOString() },
    status: {
      displayState: "REVIEWED",
      titleRef: "receipt.status.reviewed.title",
      messageRef: "receipt.status.reviewed.message",
      nextActionRef: "receipt.action.review-details",
      tone: "neutral",
    },
    reviewFacts: {
      domain: permit.payload.domain,
      payloadSchemaVersion: permit.payload.schemaVersion,
      network: PUBLIC_NETWORK,
      owner: permit.payload.owner,
      source: permit.payload.source,
      destination: permit.payload.destination,
      entrypoint: permit.payload.entrypoint,
      attachedMutez: permit.payload.attachedMutez,
      serviceCommitment: permit.payload.serviceCommitment,
      contentVersion: permit.payload.contentVersion,
      nonce: permit.payload.nonce,
      issuedAt: dateFromEpoch(permit.payload.issuedAt, "receipt issuedAt").toISOString(),
      expiry: dateFromEpoch(permit.payload.expiry, "receipt expiry").toISOString(),
      issuerKeyId: permit.payload.issuerKeyId,
      issuerPolicyVersion: permit.payload.issuerPolicyVersion,
      packedPayloadHex: receiptPayloadPackedHex(permit.payload),
      payloadHash: permit.payloadHash,
    },
    policy: {
      confirmationThreshold: String(RECEIPT_AUTHORITY_MANIFEST.confirmationThreshold),
      finalityPolicyRef: RECEIPT_AUTHORITY_MANIFEST.finalityPolicy,
    },
    activeAttempt: null,
    canonicalReceipt: null,
    incident: null,
  });
}

function eventId(intentId: string, sequence: number, kind: string): string {
  return `receipt:${createHash("sha256").update("samurai-sushi:receipt-event:v1\n").update(intentId).update("\0").update(String(sequence)).update("\0").update(kind).digest("hex")}`;
}

export class ReceiptLifecycleAuthority {
  readonly #runner: TransactionRunner;
  readonly #delayMs: number;
  readonly #maxFailures: number;

  constructor(
    pool: SqlPool,
    readonly service: EveningServiceAuthority,
    readonly options: ReceiptLifecycleAuthorityOptions = {},
  ) {
    this.#runner = new TransactionRunner(pool);
    this.#delayMs = options.reconciliationDelayMs ?? 1_000;
    this.#maxFailures = options.maximumConsecutiveFailures ?? 5;
    positiveInteger(this.#delayMs, "Reconciliation delay", 15 * 60 * 1_000);
    positiveInteger(this.#maxFailures, "Maximum reconciliation failures", 100);
  }

  async prepareSettledReceiptIntent(
    credential: ServiceSubjectCredential,
    input: PrepareSettledReceiptIntentInput,
    signer: ReceiptPermitSigner,
  ): Promise<BrowserSafeReceiptReviewProjectionV1> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(input.idempotencyKey)) throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", "Receipt idempotency key is invalid.");
    if (input.chainId !== PUBLIC_NETWORK.chainId || input.deploymentManifestHash !== PUBLIC_NETWORK.deploymentManifestHash) {
      throw new ReceiptLifecycleError("CHAIN_OR_MANIFEST_DRIFT", "Receipt preparation does not match the registered network tuple.");
    }
    return this.service.runSettledTransaction(credential, input.idempotencyKey, async ({ client, subjectKind, subjectId, checkpoint, now }) => {
      const permit = issueSettledReceiptPermit({
        checkpoint,
        commitmentNonce: input.commitmentNonce,
        chainId: input.chainId,
        owner: input.account,
        destination: input.destination,
        nonce: input.nonce,
        issuedAt: input.issuedAt,
        expiry: input.expiry,
        deploymentManifestHash: input.deploymentManifestHash,
        issuerKeyId: input.issuerKeyId,
        issuerPolicyVersion: input.issuerPolicyVersion,
      }, signer);
      const requestHash = digestCanonical({ payload: permit.payload, signature: permit.signature });
      const existing = await client.query<ExistingIntentRow>(
        `SELECT id, public_intent_ref, request_hash, state, projection_revision, created_at
           FROM samurai_persistence.receipt_intents
          WHERE subject_kind = $1 AND subject_id = $2 AND idempotency_key = $3 FOR UPDATE`,
        [subjectKind, subjectId, input.idempotencyKey],
      );
      const replay = existing.rows[0];
      if (replay) {
        if (!sameDigest(replay.request_hash, requestHash)) throw new IdempotencyPayloadMismatchError();
        if (replay.state !== "REVIEWED") throw new ReceiptLifecycleError("RECEIPT_INTENT_ADVANCED", "The exact prepared intent has advanced beyond its review projection.");
        return reviewedProjection(permit, replay.public_intent_ref, replay.created_at, Number(replay.projection_revision));
      }
      const used = await client.query<{ readonly account: string; readonly service_commitment: Uint8Array; readonly nonce: Uint8Array }>(
        `SELECT account, service_commitment, nonce FROM samurai_persistence.receipt_intents
          WHERE chain_id = $1 AND contract_address = $2 FOR SHARE`,
        [input.chainId, input.destination],
      );
      admitSettledReceiptPermit(permit, {
        now: epochSeconds(now),
        sender: input.account,
        chainId: input.chainId,
        destination: input.destination,
        entrypoint: "submit_receipt",
        attachedMutez: "0",
        deploymentManifestHash: input.deploymentManifestHash,
        contentVersion: RECEIPT_AUTHORITY_MANIFEST.contentVersion,
        paused: false,
        issuerPolicies: new Map(RECEIPT_AUTHORITY_MANIFEST.issuerPolicies.map((policy) => [policy.keyId, policy])),
        usedNonces: new Set(used.rows.map((row) => hex(row.nonce))),
        usedOwnerCommitments: new Set(used.rows.map((row) => receiptOwnerCommitmentKey(row.account, hex(row.service_commitment)))),
      }, checkpoint, input.commitmentNonce);
      const intentId = randomUUID();
      const publicIntentRef = publicRef("ri");
      const projection = reviewedProjection(permit, publicIntentRef, now, 1);
      const resultHash = digestCanonical(projection);
      await client.query(
        `INSERT INTO samurai_persistence.receipt_intents
          (id, public_intent_ref, guest_session_id, player_id, idempotency_key, request_hash, result_hash,
           chain_id, profile, network_label_ref, account, owner, source, contract_address, entrypoint, attached_mutez,
           service_commitment, content_version, nonce, issued_at, expires_at, payload_hash, deployment_manifest_hash,
           issuer_key_id, issuer_policy_version, packed_payload, issuer_signature, confirmation_threshold,
           finality_policy_id, state, projection_revision, created_at, state_changed_at, reviewed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'localnet','network.localnet-rehearsal',$9,$9,$9,$10,'submit_receipt',0,
           $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'REVIEWED',1,$24,$24,$24)`,
        [intentId, publicIntentRef, subjectKind === "guest" ? subjectId : null, subjectKind === "player" ? subjectId : null,
          input.idempotencyKey, requestHash, resultHash, permit.payload.chainId, permit.payload.owner, permit.payload.destination,
          bytes(permit.payload.serviceCommitment, "service commitment"), permit.payload.contentVersion, bytes(permit.payload.nonce, "receipt nonce"),
          dateFromEpoch(permit.payload.issuedAt, "issuedAt"), dateFromEpoch(permit.payload.expiry, "expiry"), bytes(permit.payloadHash, "payload hash"),
          bytes(permit.payload.deploymentManifestHash, "manifest hash"), permit.payload.issuerKeyId, permit.payload.issuerPolicyVersion,
          Buffer.from(receiptPayloadPackedHex(permit.payload), "hex"), permit.signature, RECEIPT_AUTHORITY_MANIFEST.confirmationThreshold,
          RECEIPT_AUTHORITY_MANIFEST.finalityPolicy, now],
      );
      await this.options.afterWriteBoundary?.("intent");
      await this.#writeEvent(client, intentId, 0, "INTENT_CREATED", null, "DRAFT", null, null, { intentRef: publicIntentRef }, now);
      await this.#writeEvent(client, intentId, 1, "INTENT_REVIEWED", "DRAFT", "REVIEWED", null, null, { intentRef: publicIntentRef }, now);
      await client.query(
        `INSERT INTO samurai_persistence.receipt_security_audit
          (id, issuer_key_id, issuer_policy_version, nonce_digest, outcome, created_at, purge_at)
         VALUES ($1,$2,$3,$4,'PREPARED',$5::timestamptz,$5::timestamptz + interval '30 days')`,
        [randomUUID(), permit.payload.issuerKeyId, permit.payload.issuerPolicyVersion, digest(bytes(permit.payload.nonce, "receipt nonce")), now],
      );
      await this.options.afterWriteBoundary?.("audit");
      return projection;
    });
  }

  async markAwaitingSignature(credential: ServiceSubjectCredential, publicIntentRef: string): Promise<void> {
    const advanced = await this.service.runSettledTransaction(credential, `awaiting:${publicIntentRef}`, async ({ client, subjectKind, subjectId, now }) => {
      const intent = await this.#lockIntentByPublicRef(client, publicIntentRef, subjectKind, subjectId);
      if (now.getTime() >= intent.expires_at.getTime()) {
        await this.#expireLockedIntent(client, intent, now);
        return false;
      }
      if (intent.state !== "REVIEWED") throw new ReceiptLifecycleError("ILLEGAL_INTENT_TRANSITION", "Only a reviewed receipt can await signature.");
      const revision = Number(intent.projection_revision) + 1;
      await client.query(`UPDATE samurai_persistence.receipt_intents SET state='AWAITING_SIGNATURE', projection_revision=$2,
        state_changed_at=$3, awaiting_signature_at=$3 WHERE id=$1`, [intent.id, revision, now]);
      await this.#writeEvent(client, intent.id, revision, "INTENT_AWAITING_SIGNATURE", "REVIEWED", "AWAITING_SIGNATURE", null, null, { intentRef: intent.public_intent_ref }, now);
      return true;
    });
    if (!advanced) throw new ReceiptLifecycleError("RECEIPT_EXPIRED", "The prepared receipt expired at the exact database-clock boundary.");
  }

  async registerSubmittedAttempt(
    credential: ServiceSubjectCredential,
    input: { readonly publicIntentRef: string; readonly operationHash: string; readonly counter: number },
  ): Promise<{ readonly publicAttemptRef: string }> {
    if (!/^o[1-9A-HJ-NP-Za-km-z]{50}$/.test(input.operationHash) || !Number.isSafeInteger(input.counter) || input.counter < 0) throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", "Operation identity is invalid.");
    const result = await this.service.runSettledTransaction(credential, `submitted:${input.publicIntentRef}:${input.operationHash}`, async ({ client, subjectKind, subjectId, now }) => {
      const intent = await this.#lockIntentByPublicRef(client, input.publicIntentRef, subjectKind, subjectId);
      if (now.getTime() >= intent.expires_at.getTime()) {
        await this.#expireLockedIntent(client, intent, now);
        return null;
      }
      if (intent.state !== "AWAITING_SIGNATURE") throw new ReceiptLifecycleError("ILLEGAL_INTENT_TRANSITION", "Receipt intent is not awaiting signature.");
      const attemptId = randomUUID();
      const publicAttemptRef = publicRef("ra");
      await client.query(
        `INSERT INTO samurai_persistence.operation_attempts
          (id, public_attempt_ref, intent_id, chain_id, operation_hash, source_account, contract_address,
           deployment_manifest_hash, counter, state, submitted_at, last_observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTED',$10,$10)`,
        [attemptId, publicAttemptRef, intent.id, intent.chain_id, input.operationHash, intent.account, intent.contract_address,
          intent.deployment_manifest_hash, input.counter, now],
      );
      await client.query(`INSERT INTO samurai_persistence.receipt_reconciliation_jobs (attempt_id,state,available_at)
        VALUES ($1,'pending',$2)`, [attemptId, now]);
      const revision = Number(intent.projection_revision) + 1;
      await client.query(`UPDATE samurai_persistence.receipt_intents SET state='SUBMITTED', projection_revision=$2,
        state_changed_at=$3, submitted_at=$3 WHERE id=$1`, [intent.id, revision, now]);
      await this.options.afterWriteBoundary?.("attempt");
      await this.#writeEvent(client, intent.id, revision, "ATTEMPT_SUBMITTED", "AWAITING_SIGNATURE", "SUBMITTED", attemptId, null,
        { intentRef: intent.public_intent_ref, attemptRef: publicAttemptRef, operationHash: input.operationHash }, now);
      return { publicAttemptRef };
    });
    if (!result) throw new ReceiptLifecycleError("RECEIPT_EXPIRED", "The prepared receipt expired before submission.");
    return result;
  }

  async replaceAttempt(
    predecessorId: string,
    input: { readonly operationHash: string; readonly counter: number },
  ): Promise<{ readonly attemptId: string; readonly publicAttemptRef: string }> {
    uuidV4(predecessorId, "predecessor attempt ID");
    if (!/^o[1-9A-HJ-NP-Za-km-z]{50}$/.test(input.operationHash) || !Number.isSafeInteger(input.counter) || input.counter < 0) {
      throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", "Replacement operation identity is invalid.");
    }
    return this.#runner.run(async (client) => {
      const identity = await client.query<{ readonly intent_id: string }>(`SELECT intent_id FROM samurai_persistence.operation_attempts WHERE id=$1`, [predecessorId]);
      if (!identity.rows[0]) throw new ReceiptLifecycleError("REPLACEMENT_LINEAGE_MISMATCH", "Replacement predecessor is invalid.");
      const intentResult = await client.query<IntentRow>(`SELECT * FROM samurai_persistence.receipt_intents WHERE id=$1 FOR UPDATE`, [identity.rows[0].intent_id]);
      const intent = intentResult.rows[0];
      if (!intent) throw new ReceiptLifecycleError("RECEIPT_INTENT_NOT_FOUND", "Receipt intent is unavailable.");
      await client.query(`SELECT id FROM samurai_persistence.operation_attempts WHERE intent_id=$1 ORDER BY id FOR UPDATE`, [intent.id]);
      const predecessorResult = await client.query<AttemptRow>(`SELECT * FROM samurai_persistence.operation_attempts WHERE id=$1`, [predecessorId]);
      const predecessor = predecessorResult.rows[0];
      if (!predecessor || predecessor.state !== "SUBMITTED" || Number(predecessor.counter) !== input.counter) throw new ReceiptLifecycleError("REPLACEMENT_LINEAGE_MISMATCH", "Replacement predecessor is invalid.");
      const now = await this.#databaseNow(client);
      const id = randomUUID();
      const ref = publicRef("ra");
      await client.query(`UPDATE samurai_persistence.operation_attempts SET state='REPLACED', last_observed_at=$2 WHERE id=$1`, [predecessor.id, now]);
      await this.options.afterWriteBoundary?.("attempt");
      await client.query(`INSERT INTO samurai_persistence.operation_attempts
        (id,public_attempt_ref,intent_id,chain_id,operation_hash,source_account,contract_address,deployment_manifest_hash,counter,state,replaces_attempt_id,submitted_at,last_observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTED',$10,$11,$11)`,
        [id, ref, predecessor.intent_id, predecessor.chain_id, input.operationHash, predecessor.source_account,
          predecessor.contract_address, predecessor.deployment_manifest_hash, input.counter, predecessor.id, now],
      );
      await client.query(`INSERT INTO samurai_persistence.receipt_reconciliation_jobs (attempt_id,state,available_at) VALUES ($1,'pending',$2)`, [id, now]);
      const revision = Number(intent.projection_revision) + 1;
      await client.query(`UPDATE samurai_persistence.receipt_intents SET projection_revision=$2,state_changed_at=$3 WHERE id=$1`, [intent.id, revision, now]);
      await this.#writeEvent(client, intent.id, revision, "ATTEMPT_REPLACED", "SUBMITTED", "SUBMITTED", id, null,
        { predecessorAttemptRef: predecessor.public_attempt_ref, replacementAttemptRef: ref, predecessorHash: predecessor.operation_hash, replacementHash: input.operationHash }, now);
      return { attemptId: id, publicAttemptRef: ref };
    });
  }

  async retryAttempt(
    predecessorId: string,
    input: { readonly operationHash: string; readonly counter: number },
  ): Promise<{ readonly attemptId: string; readonly publicAttemptRef: string }> {
    uuidV4(predecessorId, "predecessor attempt ID");
    if (!/^o[1-9A-HJ-NP-Za-km-z]{50}$/.test(input.operationHash) || !Number.isSafeInteger(input.counter) || input.counter < 0) {
      throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", "Retry operation identity is invalid.");
    }
    return this.#runner.run(async (client) => {
      const identity = await client.query<{ readonly intent_id: string }>(`SELECT intent_id FROM samurai_persistence.operation_attempts WHERE id=$1`, [predecessorId]);
      if (!identity.rows[0]) throw new ReceiptLifecycleError("RETRY_LINEAGE_MISMATCH", "Retry predecessor is invalid.");
      const intentResult = await client.query<IntentRow>(`SELECT * FROM samurai_persistence.receipt_intents WHERE id=$1 FOR UPDATE`, [identity.rows[0].intent_id]);
      const intent = intentResult.rows[0];
      if (!intent) throw new ReceiptLifecycleError("RECEIPT_INTENT_NOT_FOUND", "Receipt intent is unavailable.");
      await client.query(`SELECT id FROM samurai_persistence.operation_attempts WHERE intent_id=$1 ORDER BY id FOR UPDATE`, [intent.id]);
      const predecessorResult = await client.query<AttemptRow>(`SELECT * FROM samurai_persistence.operation_attempts WHERE id=$1`, [predecessorId]);
      const predecessor = predecessorResult.rows[0];
      if (!predecessor || !["FAILED", "DROPPED"].includes(predecessor.state) || input.counter < Number(predecessor.counter)) {
        throw new ReceiptLifecycleError("RETRY_LINEAGE_MISMATCH", "Retry predecessor is invalid.");
      }
      const now = await this.#databaseNow(client);
      const id = randomUUID();
      const ref = publicRef("ra");
      await client.query(`INSERT INTO samurai_persistence.operation_attempts
        (id,public_attempt_ref,intent_id,chain_id,operation_hash,source_account,contract_address,deployment_manifest_hash,counter,state,retry_of_attempt_id,submitted_at,last_observed_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUBMITTED',$10,$11,$11)`,
        [id, ref, predecessor.intent_id, predecessor.chain_id, input.operationHash, predecessor.source_account,
          predecessor.contract_address, predecessor.deployment_manifest_hash, input.counter, predecessor.id, now]);
      await client.query(`INSERT INTO samurai_persistence.receipt_reconciliation_jobs (attempt_id,state,available_at) VALUES ($1,'pending',$2)`, [id, now]);
      const revision = Number(intent.projection_revision) + 1;
      await client.query(`UPDATE samurai_persistence.receipt_intents SET state='SUBMITTED',projection_revision=$2,state_changed_at=$3 WHERE id=$1`, [intent.id, revision, now]);
      await this.options.afterWriteBoundary?.("attempt");
      await this.#writeEvent(client, intent.id, revision, "ATTEMPT_RETRIED", predecessor.state, "SUBMITTED", id, null,
        { predecessorAttemptRef: predecessor.public_attempt_ref, retryAttemptRef: ref, predecessorHash: predecessor.operation_hash, retryHash: input.operationHash }, now);
      return { attemptId: id, publicAttemptRef: ref };
    });
  }

  async claimReconciliation(limit = 25, leaseMs = 30_000): Promise<readonly ReconciliationClaim[]> {
    positiveInteger(limit, "Reconciliation claim limit", 1000);
    positiveInteger(leaseMs, "Reconciliation lease", 15 * 60 * 1000);
    const token = randomUUID();
    return this.#runner.run(async (client) => {
      const result = await client.query<ClaimRow>(
        `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now), candidates AS (
           SELECT job.attempt_id FROM samurai_persistence.receipt_reconciliation_jobs job, clock
            WHERE (job.state='pending' AND job.available_at <= clock.now)
               OR (job.state='processing' AND job.claim_expires_at <= clock.now)
            ORDER BY job.available_at, job.attempt_id LIMIT $1 FOR UPDATE SKIP LOCKED
         ), claimed AS (
           UPDATE samurai_persistence.receipt_reconciliation_jobs job
              SET state='processing', claim_token=$2, claim_generation=claim_generation+1,
                  claim_expires_at=clock.now + ($3::text || ' milliseconds')::interval, last_claimed_at=clock.now
             FROM candidates, clock WHERE job.attempt_id=candidates.attempt_id RETURNING job.*
         )
         SELECT attempt.*, claimed.claim_token, claimed.claim_generation, claimed.claim_expires_at
           FROM claimed JOIN samurai_persistence.operation_attempts attempt ON attempt.id=claimed.attempt_id
          ORDER BY claimed.available_at, claimed.attempt_id`,
        [limit, token, leaseMs],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        attemptId: row.id,
        claimToken: row.claim_token,
        claimGeneration: Number(row.claim_generation),
        claimExpiresAt: row.claim_expires_at.toISOString(),
        identity: Object.freeze({ chainId: row.chain_id, operationHash: row.operation_hash, sourceAccount: row.source_account,
          contractAddress: row.contract_address, deploymentManifestHash: hex(row.deployment_manifest_hash) }),
      })));
    });
  }

  async reconcileAttempt(claim: ReconciliationClaim, observer: ChainObserver): Promise<"applied" | "hint" | "duplicate" | "stale" | "incident"> {
    const raw = await observer.observe(claim.identity);
    if (raw === null) throw new ReceiptLifecycleError("OBSERVER_NO_EVIDENCE", "The deterministic observer returned no evidence.");
    return this.observeOperation(claim, raw);
  }

  /** Explicit server reconciliation hook; it performs no fetch and grants no network authority. */
  async scheduleReconciliation(attemptId: string): Promise<void> {
    uuidV4(attemptId, "attempt ID");
    await this.#runner.run(async (client) => {
      const now = await this.#databaseNow(client);
      const result = await client.query(`UPDATE samurai_persistence.receipt_reconciliation_jobs
        SET state='pending',available_at=$2,claim_token=NULL,claim_expires_at=NULL,completed_at=NULL,dead_lettered_at=NULL,
            last_error_code=NULL WHERE attempt_id=$1 AND state IN ('complete','pending')`, [attemptId, now]);
      if (result.rowCount !== 1) throw new ReceiptLifecycleError("RECONCILIATION_NOT_SCHEDULABLE", "Receipt reconciliation cannot be scheduled in its current state.");
    });
  }

  async observeOperation(claim: ReconciliationClaim, raw: unknown): Promise<"applied" | "hint" | "duplicate" | "stale" | "incident"> {
    const observation = normalizeOperationObservation(raw);
    const normalizedDigest = digestCanonical(observation);
    return this.#runner.run(async (client) => this.#applyObservation(client, claim, observation, normalizedDigest));
  }

  async confirmReceiptProjection(claim: ReconciliationClaim, raw: unknown): Promise<void> {
    await this.observeOperation(claim, raw);
  }

  async finalizeReceiptProjection(claim: ReconciliationClaim, raw: unknown): Promise<void> {
    await this.observeOperation(claim, raw);
  }

  async #applyObservation(
    client: SqlClient,
    claim: ReconciliationClaim,
    observation: NormalizedOperationObservation,
    normalizedDigest: Uint8Array,
  ): Promise<"applied" | "hint" | "duplicate" | "stale" | "incident"> {
    const job = await client.query<{ readonly claim_expires_at: Date }>(
      `SELECT claim_expires_at FROM samurai_persistence.receipt_reconciliation_jobs
        WHERE attempt_id=$1 AND state='processing' AND claim_token=$2 AND claim_generation=$3 FOR UPDATE`,
      [claim.attemptId, claim.claimToken, claim.claimGeneration],
    );
    if (!job.rows[0]) throw new ReceiptWorkerClaimLostError();
    const identity = await client.query<{ readonly intent_id: string }>(`SELECT intent_id FROM samurai_persistence.operation_attempts WHERE id=$1`, [claim.attemptId]);
    if (!identity.rows[0]) throw new ReceiptLifecycleError("RECEIPT_ATTEMPT_NOT_FOUND", "Receipt attempt is unavailable.");
    const intentResult = await client.query<IntentRow>(`SELECT * FROM samurai_persistence.receipt_intents WHERE id=$1 FOR UPDATE`, [identity.rows[0].intent_id]);
    const intent = intentResult.rows[0];
    if (!intent) throw new ReceiptLifecycleError("RECEIPT_INTENT_NOT_FOUND", "Receipt intent is unavailable.");
    await client.query(`SELECT id FROM samurai_persistence.operation_attempts WHERE intent_id=$1 ORDER BY id FOR UPDATE`, [intent.id]);
    const attemptResult = await client.query<AttemptRow>(`SELECT * FROM samurai_persistence.operation_attempts WHERE id=$1`, [claim.attemptId]);
    const attempt = attemptResult.rows[0];
    if (!attempt) throw new ReceiptLifecycleError("RECEIPT_ATTEMPT_NOT_FOUND", "Receipt attempt is unavailable.");
    await client.query(`SELECT id FROM samurai_persistence.service_receipts WHERE intent_id=$1 FOR UPDATE`, [intent.id]);
    const now = await this.#databaseNow(client);
    if (job.rows[0].claim_expires_at.getTime() <= now.getTime()) throw new ReceiptWorkerClaimLostError();
    const current: AttemptObservationState = {
      chainId: attempt.chain_id,
      operationHash: attempt.operation_hash,
      sourceAccount: attempt.source_account,
      contractAddress: attempt.contract_address,
      deploymentManifestHash: hex(attempt.deployment_manifest_hash),
      state: attempt.state,
      lastRpcSourceSequence: attempt.last_rpc_source_sequence === null ? null : Number(attempt.last_rpc_source_sequence),
      lastIndexerSourceSequence: attempt.last_indexer_source_sequence === null ? null : Number(attempt.last_indexer_source_sequence),
      lastHeadLevel: attempt.last_head_level === null ? null : Number(attempt.last_head_level),
      lastHeadBlockHash: attempt.last_head_block_hash,
      canonicalBlockHash: attempt.canonical_block_hash,
      canonicalBlockLevel: attempt.canonical_block_level === null ? null : Number(attempt.canonical_block_level),
      confirmations: attempt.confirmations,
    };
    const existing = await client.query<{ readonly id: string; readonly normalized_digest: Uint8Array }>(
      `SELECT id, normalized_digest FROM samurai_persistence.receipt_chain_observations
        WHERE (source_kind=$1 AND source_observation_id=$2)
           OR (attempt_id=$3 AND source_kind=$1 AND source_sequence=$4)
           OR (attempt_id=$3 AND normalized_digest=$5) FOR UPDATE`,
      [observation.observer, observation.sourceObservationId, attempt.id, observation.sourceSequence, normalizedDigest],
    );
    if (existing.rows.length > 0) {
      if (!existing.rows.every((row) => sameDigest(row.normalized_digest, normalizedDigest))) {
        await this.#recordIncident(client, intent, attempt, "OBSERVATION_HISTORY_CONTRADICTION", normalizedDigest, now);
        await this.#finishSuccessfulClaim(client, claim, now, attempt.state === "FINALIZED");
        return "incident";
      }
      await this.#finishSuccessfulClaim(client, claim, now, attempt.state === "FINALIZED");
      return "duplicate";
    }
    let decision = null;
    let reducerIncidentKind: "CHAIN_OR_MANIFEST_DRIFT" | "RPC_INDEXER_DIVERGENCE" | "OBSERVATION_HISTORY_CONTRADICTION" | null = null;
    try {
      decision = reduceOperationObservation(current, observation, intent.finality_policy_id);
    } catch {
      if (current.lastHeadLevel === observation.headLevel && current.lastHeadBlockHash !== null
        && current.lastHeadBlockHash !== observation.headBlockHash) {
        const comparable = await client.query<{ readonly source_kind: string }>(
          `SELECT source_kind FROM samurai_persistence.receipt_chain_observations
            WHERE attempt_id=$1 AND head_level=$2 AND head_block_hash<>$3 ORDER BY observed_at DESC LIMIT 1`,
          [attempt.id, observation.headLevel, observation.headBlockHash],
        );
        reducerIncidentKind = comparable.rows[0] && comparable.rows[0].source_kind !== observation.observer
          ? "RPC_INDEXER_DIVERGENCE" : "OBSERVATION_HISTORY_CONTRADICTION";
      } else {
        reducerIncidentKind = "CHAIN_OR_MANIFEST_DRIFT";
      }
    }
    if (reducerIncidentKind) {
      await this.#recordIncident(client, intent, attempt, reducerIncidentKind, normalizedDigest, now);
      await this.#finishSuccessfulClaim(client, claim, now, attempt.state === "FINALIZED");
      return "incident";
    }
    if (!decision) throw new ReceiptLifecycleError("OBSERVATION_REDUCER_FAILED", "The operation observation reducer produced no decision.");
    const observationId = randomUUID();
    const event = observation.receiptEvent;
    const crossSourceDivergence = await client.query<{ readonly id: string }>(
      `SELECT id FROM samurai_persistence.receipt_chain_observations
        WHERE attempt_id=$1 AND source_kind=$2 AND head_level=$3 AND head_block_hash<>$4 LIMIT 1`,
      [attempt.id, observation.observer === "fake-rpc" ? "fake-indexer" : "fake-rpc", observation.headLevel, observation.headBlockHash],
    );
    const hasCrossSourceDivergence = crossSourceDivergence.rows.length > 0;
    const applyResult = hasCrossSourceDivergence || ["FINALIZED_CONTRADICTION", "ATTEMPT_CONTRADICTION"].includes(decision.disposition) ? "INCIDENT"
      : decision.disposition === "HINT" ? "RECORDED_HINT"
      : decision.disposition === "STALE" ? "IGNORED_STALE" : decision.disposition === "DUPLICATE" ? "DUPLICATE" : "APPLIED";
    await client.query(
      `INSERT INTO samurai_persistence.receipt_chain_observations
        (id,attempt_id,chain_id,operation_hash,source_kind,source_observation_id,source_sequence,normalized_digest,
         disposition,apply_result,head_level,head_block_hash,included_level,included_block_hash,operation_index,failure_code,canonical_chain_proof,
         receipt_owner,receipt_contract,receipt_service_commitment,receipt_content_version,receipt_nonce,receipt_payload_hash,
         receipt_manifest_hash,observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [observationId, attempt.id, observation.chainId, observation.operationHash, observation.observer, observation.sourceObservationId,
        observation.sourceSequence, normalizedDigest, observation.disposition, applyResult, observation.headLevel, observation.headBlockHash,
        observation.includedLevel, observation.includedBlockHash, observation.operationIndex, observation.failureCode,
        observation.canonicalChainProof === null ? null : canonicalJson(observation.canonicalChainProof),
        event?.owner ?? null, event?.contractAddress ?? null, event ? bytes(event.serviceCommitment, "event commitment") : null,
        event?.contentVersion ?? null, event ? bytes(event.nonce, "event nonce") : null, event ? bytes(event.payloadHash, "event payload") : null,
        event ? bytes(event.deploymentManifestHash, "event manifest") : null, now],
    );
    await this.options.afterWriteBoundary?.("observation");
    if (decision.disposition === "HINT") {
      await client.query(`UPDATE samurai_persistence.operation_attempts SET last_indexer_source_sequence=$2,last_observed_at=$3 WHERE id=$1`,
        [attempt.id, observation.sourceSequence, now]);
      if (hasCrossSourceDivergence) {
        await this.#recordIncident(client, intent, attempt, "RPC_INDEXER_DIVERGENCE", normalizedDigest, now, observationId);
        await this.#finishSuccessfulClaim(client, claim, now, false);
        return "incident";
      }
      await this.#finishSuccessfulClaim(client, claim, now, false);
      return "hint";
    }
    if (hasCrossSourceDivergence) {
      await this.#recordIncident(client, intent, attempt, "RPC_INDEXER_DIVERGENCE", normalizedDigest, now, observationId);
      await this.#finishSuccessfulClaim(client, claim, now, attempt.state === "FINALIZED");
      return "incident";
    }
    if (decision.disposition === "STALE") {
      await this.#finishSuccessfulClaim(client, claim, now, false);
      return "stale";
    }
    if (decision.disposition === "DUPLICATE") {
      await this.#finishSuccessfulClaim(client, claim, now, attempt.state === "FINALIZED");
      return "duplicate";
    }
    if (decision.disposition === "FINALIZED_CONTRADICTION") {
      const incidentId = await this.#openIncident(client, intent.id, attempt.id, "FINALIZED_CHAIN_CONTRADICTION", normalizedDigest, now, observationId);
      const revision = Number(intent.projection_revision) + 1;
      await client.query(`UPDATE samurai_persistence.receipt_intents SET projection_revision=$2,state_changed_at=$3 WHERE id=$1`, [intent.id, revision, now]);
      await this.#writeEvent(client, intent.id, revision, "FINALIZED_CHAIN_CONTRADICTION", "FINALIZED", "FINALIZED",
        attempt.id, observationId, { attemptRef: attempt.public_attempt_ref, incidentRef: incidentId }, now);
      await this.#finishSuccessfulClaim(client, claim, now, true);
      return "incident";
    }
    if (decision.disposition === "ATTEMPT_CONTRADICTION") {
      const kind = attempt.state === "REPLACED" && observation.disposition === "INCLUDED"
        ? "CANONICAL_ATTEMPT_CONFLICT" : "CHAIN_OR_MANIFEST_DRIFT";
      await this.#recordIncident(client, intent, attempt, kind, normalizedDigest, now, observationId);
      await this.#finishSuccessfulClaim(client, claim, now, attempt.state === "FINALIZED");
      return "incident";
    }
    if (event && (event.owner !== intent.account || event.contractAddress !== intent.contract_address
      || event.serviceCommitment !== hex(intent.service_commitment) || event.contentVersion !== intent.content_version
      || event.nonce !== hex(intent.nonce) || event.payloadHash !== hex(intent.payload_hash)
      || event.deploymentManifestHash !== hex(intent.deployment_manifest_hash))) {
      await this.#recordIncident(client, intent, attempt, "RECEIPT_EVENT_IDENTITY_MISMATCH", normalizedDigest, now, observationId);
      await this.#finishSuccessfulClaim(client, claim, now, false);
      return "incident";
    }
    if (decision.transitions.includes("INCLUDED")) {
      const conflict = await client.query<{ readonly attempt_id: string }>(`SELECT attempt_id FROM samurai_persistence.service_receipts WHERE intent_id=$1`, [intent.id]);
      if (conflict.rows[0] && conflict.rows[0].attempt_id !== attempt.id) {
        await this.#recordIncident(client, intent, attempt, "CANONICAL_ATTEMPT_CONFLICT", normalizedDigest, now, observationId);
        await this.#finishSuccessfulClaim(client, claim, now, false);
        return "incident";
      }
    }
    let revision = Number(intent.projection_revision);
    let fromState = attempt.state;
    for (const transition of decision.transitions) {
      revision += 1;
      await this.#applyTransition(client, intent, attempt, transition, observation,
        decision.disposition === "APPLY" ? decision.policyEvidence : null, now);
      await this.#writeEvent(client, intent.id, revision, `ATTEMPT_${transition}`, fromState, transition, attempt.id, observationId,
        { attemptRef: attempt.public_attempt_ref, operationHash: attempt.operation_hash, confirmations: String(decision.next.confirmations) }, now);
      fromState = transition;
    }
    if (decision.transitions.length === 0) {
      await client.query(`UPDATE samurai_persistence.operation_attempts SET last_rpc_source_sequence=$2,last_head_level=$3,
        last_head_block_hash=$4,last_observed_at=$5 WHERE id=$1`, [attempt.id, observation.sourceSequence, observation.headLevel, observation.headBlockHash, now]);
    }
    await client.query(`UPDATE samurai_persistence.receipt_intents SET projection_revision=$2,state_changed_at=$3 WHERE id=$1`, [intent.id, revision, now]);
    await this.#finishSuccessfulClaim(client, claim, now, decision.next.state === "FINALIZED" || ["FAILED","DROPPED","REPLACED"].includes(decision.next.state));
    return "applied";
  }

  async #applyTransition(client: SqlClient, intent: IntentRow, attempt: AttemptRow, transition: OperationAttemptState,
    observation: NormalizedOperationObservation, policyEvidence: string | null, now: Date): Promise<void> {
    const terminal = transition === "FINALIZED";
    if (transition === "INCLUDED") {
      await client.query(`UPDATE samurai_persistence.operation_attempts SET state='INCLUDED',canonical_block_level=$2,
        canonical_block_hash=$3,included_operation_index=$4,last_head_level=$5,last_head_block_hash=$6,confirmations=$7,
        included_at=COALESCE(included_at,$8),last_observed_at=$8,last_rpc_source_sequence=$9,failure_code=NULL,
        orphaned_block_level=NULL,orphaned_block_hash=NULL,orphaned_at=NULL WHERE id=$1`,
        [attempt.id, observation.includedLevel, observation.includedBlockHash, observation.operationIndex, observation.headLevel,
          observation.headBlockHash, Math.min(observation.headLevel - observation.includedLevel! + 1, 1), now, observation.sourceSequence]);
      const event = observation.receiptEvent!;
      await client.query(`INSERT INTO samurai_persistence.service_receipts
        (id,intent_id,attempt_id,chain_id,contract_address,owner,service_commitment,content_version,nonce,payload_hash,
         deployment_manifest_hash,issuer_key_id,issuer_policy_version,operation_hash,state,canonical_block_level,canonical_block_hash,recorded_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'INCLUDED',$15,$16,$17,$17)
        ON CONFLICT (intent_id) DO UPDATE SET state='INCLUDED',attempt_id=EXCLUDED.attempt_id,operation_hash=EXCLUDED.operation_hash,
          canonical_block_level=EXCLUDED.canonical_block_level,canonical_block_hash=EXCLUDED.canonical_block_hash,
          orphaned_block_level=NULL,orphaned_block_hash=NULL,updated_at=EXCLUDED.updated_at`,
        [randomUUID(), intent.id, attempt.id, intent.chain_id, intent.contract_address, intent.account, bytes(event.serviceCommitment, "commitment"),
          intent.content_version, intent.nonce, intent.payload_hash, intent.deployment_manifest_hash, intent.issuer_key_id,
          intent.issuer_policy_version, attempt.operation_hash, observation.includedLevel, observation.includedBlockHash, now]);
      await client.query(`UPDATE samurai_persistence.receipt_intents SET state='INCLUDED',included_at=COALESCE(included_at,$2) WHERE id=$1`, [intent.id, now]);
    } else if (transition === "CONFIRMED") {
      await client.query(`UPDATE samurai_persistence.operation_attempts SET state='CONFIRMED',confirmations=$2,confirmed_at=COALESCE(confirmed_at,$3),
        policy_evidence=$4,last_observed_at=$3 WHERE id=$1`, [attempt.id, observation.headLevel - observation.includedLevel! + 1, now, policyEvidence]);
      await client.query(`UPDATE samurai_persistence.service_receipts SET state='CONFIRMED',updated_at=$2 WHERE attempt_id=$1`, [attempt.id, now]);
      await client.query(`UPDATE samurai_persistence.receipt_intents SET state='CONFIRMED',confirmed_at=COALESCE(confirmed_at,$2) WHERE id=$1`, [intent.id, now]);
    } else if (transition === "FINALIZED") {
      await client.query(`UPDATE samurai_persistence.operation_attempts SET state='FINALIZED',policy_evidence=$2,finalized_at=$3,last_observed_at=$3 WHERE id=$1`, [attempt.id, policyEvidence, now]);
      await client.query(`UPDATE samurai_persistence.service_receipts SET state='FINALIZED',finalized_at=$2,updated_at=$2 WHERE attempt_id=$1`, [attempt.id, now]);
      await client.query(`UPDATE samurai_persistence.receipt_intents SET state='FINALIZED',finalized_at=$2 WHERE id=$1`, [intent.id, now]);
    } else if (transition === "REORGED") {
      await client.query(`UPDATE samurai_persistence.operation_attempts SET state='REORGED',orphaned_block_level=canonical_block_level,
        orphaned_block_hash=canonical_block_hash,orphaned_at=$2,canonical_block_level=NULL,canonical_block_hash=NULL,
        included_operation_index=NULL,confirmations=0,policy_evidence=NULL,last_head_level=$3,last_head_block_hash=$4,last_rpc_source_sequence=$5,last_observed_at=$2 WHERE id=$1`,
        [attempt.id, now, observation.headLevel, observation.headBlockHash, observation.sourceSequence]);
      await client.query(`UPDATE samurai_persistence.service_receipts SET state='REORGED',orphaned_block_level=canonical_block_level,
        orphaned_block_hash=canonical_block_hash,canonical_block_level=NULL,canonical_block_hash=NULL,updated_at=$2 WHERE attempt_id=$1`, [attempt.id, now]);
      await client.query(`UPDATE samurai_persistence.receipt_intents SET state='REORGED' WHERE id=$1`, [intent.id]);
    } else if (transition === "FAILED" || transition === "DROPPED") {
      await client.query(`UPDATE samurai_persistence.operation_attempts SET state=$2,failure_code=$3,canonical_block_level=NULL,
        canonical_block_hash=NULL,included_operation_index=NULL,confirmations=0,policy_evidence=NULL,orphaned_block_level=NULL,
        orphaned_block_hash=NULL,orphaned_at=NULL,included_at=NULL,confirmed_at=NULL,finalized_at=NULL,
        last_head_level=$4,last_head_block_hash=$5,last_rpc_source_sequence=$6,last_observed_at=$7 WHERE id=$1`,
        [attempt.id, transition, observation.failureCode, observation.headLevel, observation.headBlockHash, observation.sourceSequence, now]);
      await client.query(`DELETE FROM samurai_persistence.service_receipts WHERE attempt_id=$1`, [attempt.id]);
      await client.query(`UPDATE samurai_persistence.receipt_intents SET state='SUBMITTED',included_at=NULL,confirmed_at=NULL WHERE id=$1`, [intent.id]);
    }
    await this.options.afterWriteBoundary?.("projection");
    if (terminal) await this.options.afterWriteBoundary?.("projection");
  }

  async #finishSuccessfulClaim(client: SqlClient, claim: ReconciliationClaim, now: Date, complete: boolean): Promise<void> {
    const result = await client.query(
      `UPDATE samurai_persistence.receipt_reconciliation_jobs
          SET state=CASE WHEN $4 THEN 'complete' ELSE 'pending' END,
              available_at=CASE WHEN $4 THEN available_at ELSE $5::timestamptz + ($6::text || ' milliseconds')::interval END,
              claim_token=NULL,claim_expires_at=NULL,consecutive_failure_count=0,last_success_at=$5::timestamptz,
              completed_at=CASE WHEN $4 THEN $5::timestamptz ELSE NULL END,last_error_code=NULL
        WHERE attempt_id=$1 AND state='processing' AND claim_token=$2 AND claim_generation=$3 AND claim_expires_at > clock_timestamp()`,
      [claim.attemptId, claim.claimToken, claim.claimGeneration, complete, now, this.#delayMs],
    );
    if (result.rowCount !== 1) throw new ReceiptWorkerClaimLostError();
    await this.options.afterWriteBoundary?.("terminal-fence");
  }

  async recordReconciliationFailure(claim: ReconciliationClaim, errorCode: string): Promise<"pending" | "dead-letter"> {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode)) throw new ReceiptLifecycleError("RECEIPT_INPUT_INVALID", "Reconciliation error code is invalid.");
    return this.#runner.run(async (client) => {
      const row = await client.query<{ readonly consecutive_failure_count: number; readonly claim_expires_at: Date; readonly intent_id: string }>(
        `SELECT job.consecutive_failure_count,job.claim_expires_at,attempt.intent_id
           FROM samurai_persistence.receipt_reconciliation_jobs job
          JOIN samurai_persistence.operation_attempts attempt ON attempt.id=job.attempt_id
          WHERE job.attempt_id=$1 AND job.state='processing' AND job.claim_token=$2 AND job.claim_generation=$3 FOR UPDATE OF job`,
        [claim.attemptId, claim.claimToken, claim.claimGeneration],
      );
      const current = row.rows[0];
      const now = await this.#databaseNow(client);
      if (!current || current.claim_expires_at.getTime() <= now.getTime()) throw new ReceiptWorkerClaimLostError();
      const intentResult = await client.query<IntentRow>(`SELECT * FROM samurai_persistence.receipt_intents WHERE id=$1 FOR UPDATE`, [current.intent_id]);
      const intent = intentResult.rows[0];
      if (!intent) throw new ReceiptLifecycleError("RECEIPT_INTENT_NOT_FOUND", "Receipt intent is unavailable.");
      await client.query(`SELECT id FROM samurai_persistence.operation_attempts WHERE intent_id=$1 ORDER BY id FOR UPDATE`, [intent.id]);
      const attemptResult = await client.query<AttemptRow>(`SELECT * FROM samurai_persistence.operation_attempts WHERE id=$1`, [claim.attemptId]);
      const attempt = attemptResult.rows[0];
      if (!attempt) throw new ReceiptLifecycleError("RECEIPT_ATTEMPT_NOT_FOUND", "Receipt attempt is unavailable.");
      const failures = current.consecutive_failure_count + 1;
      const dead = failures >= this.#maxFailures;
      const result = await client.query(`UPDATE samurai_persistence.receipt_reconciliation_jobs SET
        state=CASE WHEN $4 THEN 'dead-letter' ELSE 'pending' END,available_at=$5::timestamptz + ($6::text || ' milliseconds')::interval,
        claim_token=NULL,claim_expires_at=NULL,consecutive_failure_count=$7,dead_lettered_at=CASE WHEN $4 THEN $5 ELSE NULL END,
        last_error_code=$8 WHERE attempt_id=$1 AND claim_token=$2 AND claim_generation=$3 AND claim_expires_at > clock_timestamp()`,
        [claim.attemptId, claim.claimToken, claim.claimGeneration, dead, now, this.#delayMs, failures, errorCode]);
      if (result.rowCount !== 1) throw new ReceiptWorkerClaimLostError();
      if (dead) await this.#recordIncident(client, intent, attempt, "RECONCILIATION_EXHAUSTED", digest(errorCode), now);
      return dead ? "dead-letter" : "pending";
    });
  }

  async #openIncident(client: SqlClient, intentId: string, attemptId: string, kind: string, scopeDigest: Uint8Array, now: Date, observationId?: string): Promise<string> {
    const exactScopeDigest = digestCanonical({ intentId, attemptId, kind, evidenceDigest: hex(scopeDigest) });
    const existing = await client.query<{ readonly id: string }>(`SELECT id FROM samurai_persistence.receipt_incidents
      WHERE intent_id=$1 AND attempt_id=$2 AND kind=$3 AND scope_digest=$4 AND state='OPEN' FOR UPDATE`,
      [intentId, attemptId, kind, exactScopeDigest]);
    const id = existing.rows[0]?.id ?? randomUUID();
    if (existing.rows[0]) {
      await client.query(`UPDATE samurai_persistence.receipt_incidents SET occurrence_count=occurrence_count+1,last_seen_at=$2 WHERE id=$1`, [id, now]);
    } else {
      await client.query(`INSERT INTO samurai_persistence.receipt_incidents
        (id,kind,scope_digest,state,intent_id,attempt_id,first_observation_id,opened_at,last_seen_at)
        VALUES ($1,$2,$3,'OPEN',$4,$5,$6,$7,$7)`, [id, kind, exactScopeDigest, intentId, attemptId, observationId ?? null, now]);
    }
    await client.query(`INSERT INTO samurai_persistence.receipt_incident_occurrences
      (id,incident_id,evidence_digest,observation_id,observed_at) VALUES ($1,$2,$3,$4,$5)`,
      [randomUUID(), id, scopeDigest, observationId ?? null, now]);
    await this.options.afterWriteBoundary?.("incident");
    return id;
  }

  async #recordIncident(client: SqlClient, intent: IntentRow, attempt: AttemptRow, kind: string,
    scopeDigest: Uint8Array, now: Date, observationId?: string): Promise<string> {
    const incidentId = await this.#openIncident(client, intent.id, attempt.id, kind, scopeDigest, now, observationId);
    const revisionResult = await client.query<{ readonly projection_revision: string }>(
      `UPDATE samurai_persistence.receipt_intents SET projection_revision=projection_revision+1,state_changed_at=$2
        WHERE id=$1 RETURNING projection_revision`, [intent.id, now],
    );
    const revision = Number(revisionResult.rows[0]!.projection_revision);
    await this.#writeEvent(client, intent.id, revision, kind, attempt.state, attempt.state, attempt.id, observationId ?? null,
      { attemptRef: attempt.public_attempt_ref, incidentRef: incidentId }, now);
    return incidentId;
  }

  async #writeEvent(client: SqlClient, intentId: string, sequence: number, kind: string, from: string | null, to: string,
    attemptId: string | null, observationId: string | null, payload: Readonly<Record<string, unknown>>, now: Date): Promise<void> {
    const id = eventId(intentId, sequence, kind);
    const payloadText = canonicalJson(payload);
    await client.query(`INSERT INTO samurai_persistence.receipt_lifecycle_events
      (event_id,intent_id,intent_sequence,attempt_id,observation_id,event_kind,from_state,to_state,payload,payload_digest,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
      [id, intentId, sequence, attemptId, observationId, kind, from, to, payloadText, digest(payloadText), now]);
    await this.options.afterWriteBoundary?.("event");
    await client.query(`INSERT INTO samurai_persistence.receipt_outbox_deliveries (event_id,state,available_at) VALUES ($1,'pending',$2)`, [id, now]);
    await this.options.afterWriteBoundary?.("outbox");
  }

  async #lockIntentByPublicRef(client: SqlClient, publicRefValue: string, subjectKind: string, subjectId: string): Promise<IntentRow> {
    const result = await client.query<IntentRow>(`SELECT * FROM samurai_persistence.receipt_intents
      WHERE public_intent_ref=$1 AND subject_kind=$2 AND subject_id=$3 FOR UPDATE`, [publicRefValue, subjectKind, subjectId]);
    const intent = result.rows[0];
    if (!intent) throw new ReceiptLifecycleError("RECEIPT_INTENT_NOT_FOUND", "Receipt intent is unavailable to this subject.");
    return intent;
  }

  async #expireLockedIntent(client: SqlClient, intent: IntentRow, now: Date): Promise<void> {
    if (!["DRAFT","REVIEWED","AWAITING_SIGNATURE"].includes(intent.state) || now.getTime() < intent.expires_at.getTime()) return;
    const revision = Number(intent.projection_revision) + 1;
    await client.query(`UPDATE samurai_persistence.receipt_intents SET state='EXPIRED',projection_revision=$2,state_changed_at=$3,
      concluded_at=$3 WHERE id=$1`, [intent.id, revision, now]);
    await this.#writeEvent(client, intent.id, revision, "INTENT_EXPIRED", intent.state, "EXPIRED", null, null,
      { intentRef: intent.public_intent_ref }, now);
  }

  async #databaseNow(client: SqlClient): Promise<Date> {
    const result = await client.query<DatabaseClockRow>("SELECT clock_timestamp() AS now");
    const now = result.rows[0]?.now;
    if (!now) throw new ReceiptLifecycleError("DATABASE_CLOCK_UNAVAILABLE", "PostgreSQL did not return its authoritative clock.");
    return now;
  }
}
