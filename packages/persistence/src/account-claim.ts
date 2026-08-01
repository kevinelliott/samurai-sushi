import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  canonicalClaimIntentBytes,
  hashClaimChallenge,
  hashClaimIntent,
  hashClaimSessionRecoveryIntent,
  hashPlayerDeletionIntent,
  parseClaimChallenge,
  parseClaimIntent,
  parseClaimSessionRecoveryIntent,
  parsePlayerDeletionIntent,
  type ClaimChallengeV1,
  type ClaimIntentV1,
} from "@samurai-sushi/domain/claim-protocol";
import {
  verifyAccountProof,
  type AccountProofInput,
  type TezosAccountScheme,
} from "@samurai-sushi/account-proof-verifier";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import {
  CapabilitySecretFormatError,
  constantTimeDigestEqual,
  type GuestClaimKeyring,
  GuestSecretFormatError,
  issueCapabilitySecret,
  keyIdentityBytes,
  keyIdentityFromBytes,
  type PlayerSessionKeyring,
  type HmacKeyMetadata,
  type TombstoneKind,
} from "./crypto";
import { GuestResumeError, PersistenceError } from "./errors";
import type { PersistenceAuthority } from "./key-inventory";
import { addMilliseconds, ADR_0003_PERSISTENCE_LIFECYCLE } from "./lifecycle";
import { GuestProgressRepository, GuestSessionRepository, type GuestProgressRecord } from "./repositories";

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1_000;
const PLAYER_SESSION_LIFETIME_MS = ADR_0003_PERSISTENCE_LIFECYCLE.sessionLifetimeMs;
const PLAYER_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;
const PLAYER_SESSION_ROTATE_MS = 7 * 24 * 60 * 60 * 1_000;
const RECEIPT_LIFETIME_MS = ADR_0003_PERSISTENCE_LIFECYCLE.tombstoneLifetimeMs;
const CHALLENGE_NONCE_DOMAIN = "samurai-sushi:claim-challenge-nonce:v1\n";
const CLAIM_REQUEST_DOMAIN = "samurai-sushi:claim-request:v1\n";
const CLAIM_RESULT_DOMAIN = "samurai-sushi:claim-result:v1\n";
const GUEST_ORIGIN_DOMAIN = "samurai-sushi:claim-guest-origin:v1\n";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ChallengePurpose = "claim" | "recovery" | "delete";
type CapabilityPurpose = "guest-claim" | "player-session";
type BaseAuthorityMode = "serving" | "retention";

interface DatabaseClockRow { readonly now: Date }
interface GuestCapabilityRow {
  readonly digest_key_version: number;
  readonly digest_key_identity: Uint8Array;
  readonly digest: Uint8Array;
  readonly expires_at: Date;
}
interface ChallengeRow {
  readonly challenge_id: string;
  readonly purpose: ChallengePurpose;
  readonly guest_session_id: string | null;
  readonly claim_id: string;
  readonly nonce_digest: Uint8Array;
  readonly challenge_hash: Uint8Array;
  readonly intent_hash: Uint8Array;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly consumed_claim_id: string | null;
}
interface ChallengeReplayRow {
  readonly challenge_id: string;
  readonly challenge_hash: Uint8Array;
  readonly nonce_digest: Uint8Array;
  readonly expires_at: Date;
}
interface PlayerProgressRow {
  readonly player_id: string;
  readonly revision: string;
  readonly content_version: string;
  readonly checkpoint_schema_version: number;
  readonly checkpoint: Readonly<Record<string, unknown>>;
  readonly created_at: Date;
  readonly updated_at: Date;
}
interface WalletRow {
  readonly credential_id: string;
  readonly player_id: string;
  readonly chain_id: string;
  readonly account: string;
  readonly public_key: string;
  readonly scheme: TezosAccountScheme;
  readonly linked_claim_id: string;
}
interface SessionRow {
  readonly id: string;
  readonly player_id: string;
  readonly issuance_kind: "claim";
  readonly issuance_id: string;
  readonly state: "pending-delivery" | "active" | "revoked";
  readonly delivery_generation: string;
  readonly last_seen_at: Date;
  readonly expires_at: Date;
}
interface SessionDigestRow {
  readonly digest_key_version: number;
  readonly digest_key_identity: Uint8Array;
  readonly digest: Uint8Array;
}
interface ResolvedPlayerSessionRow extends SessionRow, SessionDigestRow {
  readonly slot: "current" | "predecessor";
  readonly valid_until: Date | null;
}
interface KeyReferenceRow {
  readonly source: CapabilityPurpose;
  readonly key_version: number;
  readonly key_identity: Uint8Array;
  readonly required_until: Date;
}
interface ReferenceCountRow { readonly reference_count: string }

export type AccountClaimPublicErrorCode =
  | "CLAIM_REJECTED"
  | "CLAIM_RECOVERY_REJECTED"
  | "CLAIM_REAUTH_REQUIRED";

export const ACCOUNT_CLAIM_PUBLIC_FAILURE = Object.freeze({
  code: "CLAIM_REJECTED",
  message: "The guest progress claim could not be completed.",
} as const);
export const ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE = Object.freeze({
  code: "CLAIM_RECOVERY_REJECTED",
  message: "The claim session could not be recovered.",
} as const);
export const ACCOUNT_CLAIM_REAUTH_REQUIRED = Object.freeze({
  code: "CLAIM_REAUTH_REQUIRED",
  message: "Fresh wallet proof is required to recover this claim session.",
} as const);
export const ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE = Object.freeze({
  code: "PLAYER_SESSION_REJECTED",
  message: "The player session could not be authenticated.",
} as const);
export const ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED = Object.freeze({
  code: "PLAYER_SESSION_ROTATION_DEFERRED",
  message: "Player session rotation is deferred while the predecessor remains valid.",
} as const);
export const ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE = Object.freeze({
  code: "PLAYER_DELETION_REJECTED",
  message: "The player account could not be deleted.",
} as const);

export function accountClaimPublicFailure(_error: unknown): typeof ACCOUNT_CLAIM_PUBLIC_FAILURE {
  return ACCOUNT_CLAIM_PUBLIC_FAILURE;
}

export function accountClaimRecoveryPublicFailure(_error: unknown): typeof ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE {
  return ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE;
}

function invalid(code: string): never {
  throw new PersistenceError(code, "Account-claim authority rejected the operation.");
}

function hashBytes(domain: string, ...parts: readonly Uint8Array[]): Uint8Array {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function hashText(domain: string, value: string): Uint8Array {
  return createHash("sha256").update(domain, "utf8").update(value, "utf8").digest();
}

function protocolHashBytes(value: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) invalid("CLAIM_PROTOCOL_HASH_INVALID");
  return Buffer.from(value.slice("sha256:".length), "hex");
}

function base64url32(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) invalid("CLAIM_PROTOCOL_SECRET_INVALID");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value) invalid("CLAIM_PROTOCOL_SECRET_INVALID");
  return bytes;
}

function databaseNow(client: SqlClient): Promise<Date> {
  return client.query<DatabaseClockRow>("SELECT clock_timestamp() AS now").then((result) => {
    const now = result.rows[0]?.now;
    if (!now) invalid("DATABASE_CLOCK_UNAVAILABLE");
    return now;
  });
}

function metadataFor(
  source: CapabilityPurpose,
  version: number,
  guestClaimKeys: GuestClaimKeyring,
  playerSessionKeys: PlayerSessionKeyring,
): HmacKeyMetadata | undefined {
  switch (source) {
    case "guest-claim": return guestClaimKeys.metadata(version);
    case "player-session": return playerSessionKeys.metadata(version);
  }
}

async function capabilityReferences(client: SqlClient): Promise<readonly KeyReferenceRow[]> {
  const cleanup = ADR_0003_PERSISTENCE_LIFECYCLE.cleanupMaximumDelayMs;
  const result = await client.query<KeyReferenceRow>(`
    SELECT 'guest-claim'::text AS source, digest_key_version AS key_version,
           digest_key_identity AS key_identity,
           MAX(expires_at + ($1::bigint * interval '1 millisecond')) AS required_until
      FROM samurai_persistence.guest_claim_capabilities
     GROUP BY digest_key_version, digest_key_identity
    UNION ALL
    SELECT 'player-session'::text, d.digest_key_version, d.digest_key_identity,
           MAX((CASE WHEN d.slot = 'current' THEN s.expires_at
                     ELSE LEAST(s.expires_at, d.valid_until) END)
               + ($1::bigint * interval '1 millisecond'))
      FROM samurai_persistence.player_session_digests d
      JOIN samurai_persistence.player_sessions s ON s.id = d.player_session_id
     GROUP BY d.digest_key_version, d.digest_key_identity
    UNION ALL
    SELECT capability_key_purpose, capability_key_version, capability_key_identity,
           MAX(expires_at + ($1::bigint * interval '1 millisecond'))
      FROM samurai_persistence.deletion_tombstones
     WHERE capability_key_purpose IN ('guest-claim', 'player-session')
     GROUP BY capability_key_purpose, capability_key_version, capability_key_identity
     ORDER BY source, key_version
  `, [cleanup]);
  return result.rows;
}

export class AccountClaimAuthority {
  readonly #runner: TransactionRunner;
  #ready = false;

  constructor(
    pool: SqlPool,
    readonly persistence: PersistenceAuthority,
    readonly guestClaimKeys: GuestClaimKeyring,
    readonly playerSessionKeys: PlayerSessionKeyring,
  ) {
    this.#runner = new TransactionRunner(pool);
  }

  async bootstrap(): Promise<void> {
    await this.persistence.bootstrap();
    this.#ready = true;
  }

  async assertTransactionReady(
    client: SqlClient,
    purposes: readonly CapabilityPurpose[],
    baseMode: BaseAuthorityMode,
  ): Promise<Date> {
    if (!this.#ready) invalid("ACCOUNT_CLAIM_NOT_READY");
    const now = baseMode === "serving"
      ? await this.persistence.assertTransactionReady(client)
      : await this.persistence.assertRetentionTransactionReady(client);
    for (const purpose of purposes) {
      switch (purpose) {
        case "guest-claim": this.guestClaimKeys.assertActive(now); break;
        case "player-session": this.playerSessionKeys.assertActive(now); break;
      }
    }
    return now;
  }

  async assertRetentionTransactionReady(client: SqlClient): Promise<Date> {
    if (!this.#ready) invalid("ACCOUNT_CLAIM_NOT_READY");
    const now = await this.persistence.assertRetentionTransactionReady(client);
    this.persistence.tombstoneKeys.assertActive(now);
    return now;
  }

  async assertSafeToDestroy(source: CapabilityPurpose, version: number): Promise<void> {
    await this.#runner.run(async (client) => {
      const now = await databaseNow(client);
      const metadata = metadataFor(source, version, this.guestClaimKeys, this.playerSessionKeys);
      if (!metadata || metadata.retiredAtMs === null || (metadata.verifyUntilMs ?? Number.POSITIVE_INFINITY) > now.getTime()) {
        invalid("KEY_DESTRUCTION_UNSAFE");
      }
      const identity = keyIdentityBytes(metadata.keyIdentity);
      const table = source === "guest-claim" ? "guest_claim_capabilities" : "player_session_digests";
      const result = await client.query<ReferenceCountRow>(`
        SELECT COUNT(*)::text AS reference_count FROM (
          SELECT 1 FROM samurai_persistence.${table}
           WHERE digest_key_version = $1 AND digest_key_identity = $2
          UNION ALL
          SELECT 1 FROM samurai_persistence.deletion_tombstones
           WHERE capability_key_purpose = $3 AND capability_key_version = $1
             AND capability_key_identity = $2
        ) refs
      `, [version, identity, source]);
      if (Number(result.rows[0]?.reference_count ?? 0) !== 0) invalid("KEY_DESTRUCTION_UNSAFE");
    });
  }

  /** Explicit diagnostic; historical damage never turns this global scan into a serving gate. */
  async auditCapabilityInventory(client: SqlClient, now: Date): Promise<void> {
    this.guestClaimKeys.assertActive(now);
    this.playerSessionKeys.assertActive(now);
    for (const row of await capabilityReferences(client)) {
      const metadata = metadataFor(row.source, row.key_version, this.guestClaimKeys, this.playerSessionKeys);
      if (!metadata) invalid("KEY_VERSION_UNAVAILABLE");
      if (metadata.keyIdentity !== keyIdentityFromBytes(row.key_identity)) invalid("KEY_IDENTITY_MISMATCH");
      if (metadata.activatedAtMs > now.getTime()) invalid("KEY_VERSION_NOT_ACTIVE");
      if (metadata.compromisedAtMs !== null && metadata.compromisedAtMs <= now.getTime()) invalid("KEY_VERSION_COMPROMISED");
      if (metadata.verifyUntilMs !== null && metadata.verifyUntilMs < row.required_until.getTime()) {
        invalid("KEY_VERIFY_HORIZON_TOO_SHORT");
      }
    }
  }
}

export interface AccountClaimServiceOptions {
  readonly origin: string;
  readonly chainId: string;
  readonly issueUuid?: () => string;
  readonly issueNonce?: () => string;
  readonly issuePlayerSecret?: () => string;
  readonly mergeCheckpoint?: (
    guest: GuestProgressRecord<Readonly<Record<string, unknown>>>,
    player: PlayerProgressRow | null,
    intent: ClaimIntentV1,
  ) => Readonly<Record<string, unknown>>;
}

export interface IssueClaimChallengeInput {
  readonly resumeSecret: string;
  readonly intent: unknown;
  readonly account: string;
}

export interface IssueRecoveryChallengeInput {
  readonly recoveryIntent: unknown;
  readonly account: string;
}

export interface IssuePlayerDeletionChallengeInput {
  readonly deletionIntent: unknown;
  readonly account: string;
}

export interface IssuedClaimChallenge {
  readonly challengeId: string;
  readonly challenge: ClaimChallengeV1;
}

export interface ClaimGuestInput {
  readonly resumeSecret: string;
  readonly intent: unknown;
  readonly challengeId: string;
  readonly proof: AccountProofInput;
}

export interface ClaimedPlayerSession {
  readonly playerId: string;
  readonly claimId: string;
  readonly playerRevision: number;
  readonly sessionId: string;
  readonly sessionSecret: string;
  readonly deliveryGeneration: number;
  readonly disposition: "claimed";
}

export type ClaimGuestPublicResult =
  | ClaimedPlayerSession
  | typeof ACCOUNT_CLAIM_PUBLIC_FAILURE
  | typeof ACCOUNT_CLAIM_REAUTH_REQUIRED;
export type ClaimChallengePublicResult = IssuedClaimChallenge | typeof ACCOUNT_CLAIM_PUBLIC_FAILURE;
export type RecoveryChallengePublicResult = IssuedClaimChallenge | typeof ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE;
export type RecoverClaimSessionPublicResult = RecoveredPlayerSession | typeof ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE;
export type PlayerDeletionChallengePublicResult = IssuedClaimChallenge | typeof ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE;
export type DeletePlayerPublicResult = void | typeof ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE;

export interface RecoverClaimSessionInput {
  readonly recoveryIntent: unknown;
  readonly challengeId: string;
  readonly proof: AccountProofInput;
}

export interface DeletePlayerWithWalletProofInput {
  readonly deletionIntent: unknown;
  readonly challengeId: string;
  readonly proof: AccountProofInput;
}

export interface RecoveredPlayerSession {
  readonly playerId: string;
  readonly claimId: string;
  readonly sessionId: string;
  readonly sessionSecret: string;
  readonly deliveryGeneration: number;
}

export interface AuthenticatedPlayerSession {
  readonly playerId: string;
  readonly sessionId: string;
  readonly claimId: string;
  readonly deliveryGeneration: number;
  readonly credentialKind: "current" | "predecessor";
  readonly rotationRequired: boolean;
}

export interface RotatedPlayerSession extends AuthenticatedPlayerSession {
  readonly sessionSecret: string;
}

export class AccountClaimService {
  readonly #runner: TransactionRunner;
  readonly #guestRepository = new GuestSessionRepository();
  readonly #progressRepository = new GuestProgressRepository();
  readonly #issueUuid: () => string;
  readonly #issueNonce: () => string;
  readonly #issuePlayerSecret: () => string;
  readonly #mergeCheckpoint: NonNullable<AccountClaimServiceOptions["mergeCheckpoint"]>;

  constructor(
    pool: SqlPool,
    readonly authority: AccountClaimAuthority,
    readonly options: AccountClaimServiceOptions,
  ) {
    this.#runner = new TransactionRunner(pool);
    this.#issueUuid = options.issueUuid ?? randomUUID;
    this.#issueNonce = options.issueNonce ?? (() => randomBytes(32).toString("base64url"));
    this.#issuePlayerSecret = options.issuePlayerSecret ?? issueCapabilitySecret;
    this.#mergeCheckpoint = options.mergeCheckpoint ?? ((guest) => guest.checkpoint);
  }

  private async issueClaimChallengeInternal(input: IssueClaimChallengeInput): Promise<IssuedClaimChallenge> {
    const intent = parseClaimIntent(input.intent);
    if (intent.guestClaimCommitment.length !== 43) invalid("CLAIM_CAPABILITY_INVALID");
    return this.#runner.run(async (client) => {
      const guest = await this.authenticateGuest(client, input.resumeSecret, ["guest-claim"]);
      const progress = await this.#progressRepository.lock<Readonly<Record<string, unknown>>>(client, guest.id);
      if (!progress || progress.revision !== intent.guestRevision || progress.contentVersion !== intent.contentVersion) {
        invalid("CLAIM_REVISION_STALE");
      }
      await this.assertGuestClaimCapability(client, guest.id, intent.guestClaimCommitment);
      await this.lockScopes(client, [
        `challenge-claim:${intent.claimId}`,
        `claim-id:${intent.claimId}`,
        `claim-idempotency:${intent.idempotencyKey}`,
      ]);
      const now = await this.authority.assertTransactionReady(client, ["guest-claim"], "serving");
      await this.assertClaimIdentifiersNotTombstoned(client, intent.claimId, intent.idempotencyKey, now);
      await this.assertGuestClaimCapability(
        client,
        guest.id,
        intent.guestClaimCommitment,
        now,
        addMilliseconds(now, CHALLENGE_LIFETIME_MS),
      );
      return this.insertChallenge(
        client,
        "claim",
        guest.id,
        intent.claimId,
        await hashClaimIntent(intent),
        input.account,
        { capability: intent.guestClaimCommitment, guestId: guest.id },
      );
    });
  }

  private async issueRecoveryChallengeInternal(input: IssueRecoveryChallengeInput): Promise<IssuedClaimChallenge> {
    const intent = parseClaimSessionRecoveryIntent(input.recoveryIntent);
    return this.#runner.run(async (client) => {
      await this.lockScopes(client, [
        `challenge-claim:${intent.recoverClaimId}`,
        `recovery-issue:${intent.recoverClaimId}:${intent.idempotencyKey}`,
      ]);
      return this.insertChallenge(
        client,
        "recovery",
        null,
        intent.recoverClaimId,
        await hashClaimSessionRecoveryIntent(intent),
        input.account,
      );
    });
  }

  private async issuePlayerDeletionChallengeInternal(input: IssuePlayerDeletionChallengeInput): Promise<IssuedClaimChallenge> {
    const intent = parsePlayerDeletionIntent(input.deletionIntent);
    return this.#runner.run(async (client) => {
      await this.lockScopes(client, [
        `challenge-claim:${intent.deleteClaimId}`,
        `delete-issue:${intent.deleteClaimId}:${intent.idempotencyKey}`,
      ]);
      return this.insertChallenge(
        client,
        "delete",
        null,
        intent.deleteClaimId,
        await hashPlayerDeletionIntent(intent),
        input.account,
      );
    });
  }

  private async claimGuestInternal(input: ClaimGuestInput): Promise<ClaimedPlayerSession> {
    const intent = parseClaimIntent(input.intent);
    if (!intent.createPlayer && intent.playerRevision >= Number.MAX_SAFE_INTEGER) {
      invalid("CLAIM_REVISION_STALE");
    }
    if (!UUID_V4_PATTERN.test(input.challengeId)) invalid("CLAIM_CHALLENGE_INVALID");
    const challenge = parseClaimChallenge(input.proof.challenge);
    const verified = verifyAccountProof(input.proof);
    const intentHash = await hashClaimIntent(intent);
    const challengeHash = await hashClaimChallenge(challenge);
    if (challenge.claimIntentHash !== intentHash || challenge.account !== verified.account) invalid("CLAIM_PROOF_CONTEXT_INVALID");

    return this.#runner.run(async (client) => {
      const guest = await this.authenticateGuest(client, input.resumeSecret, ["guest-claim", "player-session"]);
      let target: { readonly id: string } | null = null;
      if (!intent.createPlayer) {
        const result = await client.query<{ readonly id: string }>(
          "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
          [intent.targetPlayerId],
        );
        target = result.rows[0] ?? null;
        if (!target) invalid("CLAIM_TARGET_INVALID");
      }
      await this.lockScopes(client, [
        `claim-id:${intent.claimId}`,
        `claim-idempotency:${intent.idempotencyKey}`,
        `challenge-claim:${intent.claimId}`,
        `wallet:${challenge.chainId}:${verified.account}`,
        ...(intent.createPlayer ? [`player:${intent.claimId}`] : []),
      ]);
      await this.authority.assertTransactionReady(client, ["guest-claim", "player-session"], "serving");
      const wallet = await this.lockWallet(client, challenge.chainId, verified.account);
      const linkedClaim = await client.query<{ readonly found: number }>(
        "SELECT 1 AS found FROM samurai_persistence.wallet_credentials WHERE linked_claim_id = $1::uuid FOR UPDATE",
        [intent.claimId],
      );
      const guestProgress = await this.#progressRepository.lock<Readonly<Record<string, unknown>>>(client, guest.id);
      const playerProgress = target ? await this.lockPlayerProgress(client, target.id) : null;
      await this.lockGuestOwnedRows(client, guest.id);
      const siblingChallenges = await this.lockChallengesForRemovalByGuestId(client, guest.id);
      const storedChallenge = siblingChallenges.find((row) => row.challenge_id === input.challengeId)
        ? await this.lockChallenge(client, input.challengeId)
        : invalid("CLAIM_CHALLENGE_INVALID");
      const issuedSession = await this.issueFreshPlayerSessionSecret(client, [], "serving");
      const now = issuedSession.now;
      await this.assertChallengeNotTombstoned(client, protocolHashBytes(challengeHash), now);
      await this.assertClaimIdentifiersNotTombstoned(client, intent.claimId, intent.idempotencyKey, now);
      if (linkedClaim.rows[0]) invalid("CLAIM_ID_CONFLICT");
      this.assertChallenge(storedChallenge, "claim", guest.id, intent.claimId, intentHash, challengeHash, challenge, now);
      if (!guestProgress || guestProgress.revision !== intent.guestRevision || guestProgress.contentVersion !== intent.contentVersion) {
        invalid("CLAIM_REVISION_STALE");
      }
      await this.assertGuestClaimCapability(client, guest.id, intent.guestClaimCommitment, now);
      if (intent.createPlayer) {
        if (wallet) invalid("CLAIM_WALLET_CONFLICT");
        await this.assertWalletNotTombstoned(client, challenge.chainId, verified.account, now);
      } else {
        if (!wallet || wallet.player_id !== intent.targetPlayerId
          || wallet.public_key !== verified.publicKey || wallet.scheme !== verified.scheme) invalid("CLAIM_WALLET_CONFLICT");
        if (!playerProgress || Number(playerProgress.revision) !== intent.playerRevision) invalid("CLAIM_REVISION_STALE");
      }

      const playerId = intent.createPlayer ? this.#issueUuid() : intent.targetPlayerId;
      const playerRevision = intent.createPlayer ? 0 : intent.playerRevision + 1;
      const sessionId = this.#issueUuid();
      const sessionSecret = issuedSession.secret;
      const sessionDigest = issuedSession.digest;
      const mergedCheckpoint = this.#mergeCheckpoint(guestProgress, playerProgress, intent);
      const requestHash = hashBytes(CLAIM_REQUEST_DOMAIN, canonicalClaimIntentBytes(intent), protocolHashBytes(challengeHash));
      const originSalt = randomBytes(32);
      const originCommitment = hashBytes(GUEST_ORIGIN_DOMAIN, originSalt, Buffer.from(guest.id, "utf8"));
      originSalt.fill(0);

      if (intent.createPlayer) {
        await client.query(
          "INSERT INTO samurai_persistence.players (id, created_at, updated_at) VALUES ($1, $2, $2)",
          [playerId, now],
        );
        await client.query(
          `INSERT INTO samurai_persistence.wallet_credentials
            (credential_id, player_id, chain_id, account, public_key, scheme, linked_claim_id, linked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [this.#issueUuid(), playerId, challenge.chainId, verified.account, verified.publicKey,
            verified.scheme, intent.claimId, now],
        );
        await client.query(
          `INSERT INTO samurai_persistence.player_progress
            (player_id, revision, content_version, checkpoint_schema_version, checkpoint, created_at, updated_at)
           VALUES ($1, 0, $2, $3, $4::jsonb, $5, $5)`,
          [playerId, intent.contentVersion, guestProgress.checkpointSchemaVersion, JSON.stringify(mergedCheckpoint), now],
        );
      } else {
        await client.query(
          `UPDATE samurai_persistence.player_progress
              SET revision = $2, content_version = $3, checkpoint_schema_version = $4,
                  checkpoint = $5::jsonb, updated_at = $6
            WHERE player_id = $1 AND revision = $7`,
          [playerId, playerRevision, intent.contentVersion, guestProgress.checkpointSchemaVersion,
            JSON.stringify(mergedCheckpoint), now, intent.playerRevision],
        );
        await client.query("UPDATE samurai_persistence.players SET updated_at = $2 WHERE id = $1", [playerId, now]);
      }

      await client.query(
        `INSERT INTO samurai_persistence.player_sessions
          (id, player_id, issuance_kind, issuance_id, state, delivery_generation,
           created_at, last_seen_at, expires_at, rotate_after)
         VALUES ($1, $2, 'claim', $3, 'pending-delivery', 1, $4, $4, $5, $6)`,
        [sessionId, playerId, intent.claimId, now, addMilliseconds(now, PLAYER_SESSION_LIFETIME_MS),
          addMilliseconds(now, PLAYER_SESSION_ROTATE_MS)],
      );
      await client.query(
        `INSERT INTO samurai_persistence.player_session_digests
          (player_session_id, slot, digest_key_version, digest_key_identity, digest, valid_until)
         VALUES ($1, 'current', $2, $3, $4, NULL)`,
        [sessionId, sessionDigest.keyVersion, keyIdentityBytes(sessionDigest.keyIdentity), sessionDigest.digest],
      );
      const resultHash = hashText(CLAIM_RESULT_DOMAIN, `${intent.claimId}:${playerId}:${playerRevision}:${sessionId}`);
      await client.query(
        `INSERT INTO samurai_persistence.progress_merges
          (claim_id, idempotency_key, request_hash, claim_intent_hash, challenge_hash,
           guest_origin_commitment, player_id, create_player, target_player_id, guest_revision,
           player_revision_before, player_revision_after, content_version, cosmetic_selections,
           session_id, session_issuance_id, result_hash, created_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$1,$16,$17,$18)`,
        [intent.claimId, intent.idempotencyKey, requestHash, protocolHashBytes(intentHash),
          protocolHashBytes(challengeHash), originCommitment, playerId, intent.createPlayer,
          intent.createPlayer ? null : intent.targetPlayerId, intent.guestRevision,
          intent.createPlayer ? null : intent.playerRevision, playerRevision, intent.contentVersion,
          JSON.stringify(intent.cosmeticSelections), sessionId, resultHash, now, addMilliseconds(now, RECEIPT_LIFETIME_MS)],
      );

      await this.consumeChallenge(client, storedChallenge, intent.claimId, now);
      await this.rewriteGuestRows(client, guest.id, playerId, intent.claimId);
      await this.revokeGuestPrivateRows(client, guest.id, intent, now, siblingChallenges);
      await client.query("DELETE FROM samurai_persistence.guest_sessions WHERE id = $1", [guest.id]);
      return { playerId, claimId: intent.claimId, playerRevision, sessionId, sessionSecret, deliveryGeneration: 1, disposition: "claimed" };
    });
  }

  async claimGuestPublic(input: ClaimGuestInput): Promise<ClaimGuestPublicResult> {
    try {
      return await this.claimGuestInternal(input);
    } catch {
      try {
        const intent = parseClaimIntent(input.intent);
        const challenge = parseClaimChallenge(input.proof.challenge);
        const verified = verifyAccountProof(input.proof);
        const intentHash = await hashClaimIntent(intent);
        const challengeHash = await hashClaimChallenge(challenge);
        const exact = await this.#runner.run(async (client) => client.query<{ readonly found: number }>(
          `WITH authority_time AS (SELECT clock_timestamp() AS now)
           SELECT 1 AS found
             FROM samurai_persistence.progress_merges m
             JOIN samurai_persistence.wallet_credentials w ON w.player_id = m.player_id
             JOIN samurai_persistence.player_sessions s
               ON s.id = m.session_id AND s.player_id = m.player_id
              AND s.issuance_kind = 'claim' AND s.issuance_id = m.claim_id
             CROSS JOIN authority_time t
            WHERE m.claim_id = $1::uuid AND m.idempotency_key = $2
              AND m.claim_intent_hash = $3 AND m.challenge_hash = $4
              AND w.chain_id = $5 AND w.account = $6 AND w.public_key = $7 AND w.scheme = $8
              AND s.state = 'pending-delivery' AND s.expires_at > t.now
              AND m.expires_at > t.now
            LIMIT 1`,
          [intent.claimId, intent.idempotencyKey, protocolHashBytes(intentHash), protocolHashBytes(challengeHash),
            challenge.chainId, verified.account, verified.publicKey, verified.scheme],
        ));
        if (exact.rows[0]) return ACCOUNT_CLAIM_REAUTH_REQUIRED;
      } catch {
        // All parser, proof, lookup, and mismatch distinctions collapse below.
      }
      return ACCOUNT_CLAIM_PUBLIC_FAILURE;
    }
  }

  async issueClaimChallenge(input: IssueClaimChallengeInput): Promise<ClaimChallengePublicResult> {
    try {
      return await this.issueClaimChallengeInternal(input);
    } catch {
      return ACCOUNT_CLAIM_PUBLIC_FAILURE;
    }
  }

  async issueRecoveryChallenge(input: IssueRecoveryChallengeInput): Promise<RecoveryChallengePublicResult> {
    try {
      return await this.issueRecoveryChallengeInternal(input);
    } catch {
      return ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE;
    }
  }

  async issuePlayerDeletionChallenge(input: IssuePlayerDeletionChallengeInput): Promise<PlayerDeletionChallengePublicResult> {
    try {
      return await this.issuePlayerDeletionChallengeInternal(input);
    } catch {
      return ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE;
    }
  }

  async claimGuest(input: ClaimGuestInput): Promise<ClaimGuestPublicResult> {
    return this.claimGuestPublic(input);
  }

  private async recoverClaimSessionInternal(input: RecoverClaimSessionInput): Promise<RecoveredPlayerSession> {
    const intent = parseClaimSessionRecoveryIntent(input.recoveryIntent);
    if (!UUID_V4_PATTERN.test(input.challengeId)) invalid("CLAIM_RECOVERY_INVALID");
    const challenge = parseClaimChallenge(input.proof.challenge);
    const verified = verifyAccountProof(input.proof);
    const intentHash = await hashClaimSessionRecoveryIntent(intent);
    const challengeHash = await hashClaimChallenge(challenge);
    if (challenge.claimIntentHash !== intentHash || challenge.account !== verified.account) invalid("CLAIM_RECOVERY_INVALID");

    return this.#runner.run(async (client) => {
      const resolved = await this.resolveWallet(client, challenge.chainId, verified.account);
      if (!resolved) invalid("CLAIM_RECOVERY_INVALID");
      const player = await client.query<{ readonly id: string }>(
        "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
        [resolved.player_id],
      );
      if (!player.rows[0]) invalid("CLAIM_RECOVERY_INVALID");
      await this.authority.assertTransactionReady(client, ["player-session"], "retention");
      const wallet = await this.lockWallet(client, challenge.chainId, verified.account);
      if (!wallet || wallet.player_id !== resolved.player_id
        || wallet.public_key !== verified.publicKey || wallet.scheme !== verified.scheme) invalid("CLAIM_RECOVERY_INVALID");
      await this.lockScopes(client, [`recovery:${intent.recoverClaimId}:${intent.idempotencyKey}`]);
      const storedChallenge = await this.lockChallenge(client, input.challengeId);
      const sessionResult = await client.query<SessionRow>(
        `SELECT id::text, player_id, issuance_kind, issuance_id::text, state,
                delivery_generation::text, last_seen_at, expires_at
           FROM samurai_persistence.player_sessions
          WHERE player_id = $1 AND issuance_kind = 'claim' AND issuance_id = $2::uuid
          FOR UPDATE`,
        [wallet.player_id, intent.recoverClaimId],
      );
      const session = sessionResult.rows[0];
      if (!session) invalid("CLAIM_RECOVERY_INVALID");
      const old = await client.query<SessionDigestRow>(
        `SELECT digest_key_version, digest_key_identity, digest
           FROM samurai_persistence.player_session_digests
          WHERE player_session_id = $1 AND slot = 'current' FOR UPDATE`,
        [session.id],
      );
      const oldDigest = old.rows[0];
      if (!oldDigest) invalid("CLAIM_RECOVERY_INVALID");
      const issuedSession = await this.issueFreshPlayerSessionSecret(client, [oldDigest]);
      const now = issuedSession.now;
      await this.assertChallengeNotTombstoned(client, protocolHashBytes(challengeHash), now);
      this.assertChallenge(storedChallenge, "recovery", null, intent.recoverClaimId, intentHash, challengeHash, challenge, now);
      if (!session || session.state !== "pending-delivery" || session.expires_at.getTime() <= now.getTime()) {
        invalid("CLAIM_RECOVERY_INVALID");
      }
      await this.assertPlayerSessionNotTombstoned(client, oldDigest, now);
      const secret = issuedSession.secret;
      const digest = issuedSession.digest;
      await client.query("DELETE FROM samurai_persistence.player_session_digests WHERE player_session_id = $1", [session.id]);
      await client.query(
        `INSERT INTO samurai_persistence.player_session_digests
          (player_session_id, slot, digest_key_version, digest_key_identity, digest, valid_until)
         VALUES ($1, 'current', $2, $3, $4, NULL)`,
        [session.id, digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest],
      );
      const rotateAfter = new Date(Math.min(
        session.expires_at.getTime() - 1,
        addMilliseconds(now, PLAYER_SESSION_ROTATE_MS).getTime(),
      ));
      await client.query(
        `UPDATE samurai_persistence.player_sessions
            SET delivery_generation = delivery_generation + 1, last_seen_at = $2,
                rotate_after = $3
          WHERE id = $1`,
        [session.id, now, rotateAfter],
      );
      await this.insertTombstone(
        client,
        "player-session",
        `player-session:v${oldDigest.digest_key_version}:${Buffer.from(oldDigest.digest).toString("base64url")}`,
        now,
        "player-session",
        oldDigest.digest_key_version,
        oldDigest.digest_key_identity,
      );
      await this.consumeChallenge(client, storedChallenge, intent.recoverClaimId, now);
      return {
        playerId: session.player_id,
        claimId: intent.recoverClaimId,
        sessionId: session.id,
        sessionSecret: secret,
        deliveryGeneration: Number(session.delivery_generation) + 1,
      };
    });
  }

  private async acknowledgeClaimDeliveryInternal(
    playerId: string,
    claimId: string,
    sessionSecret: string,
    expectedGeneration: number,
  ): Promise<void> {
    if (!UUID_V4_PATTERN.test(claimId)) invalid("CLAIM_RECOVERY_INVALID");
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1) invalid("CLAIM_RECOVERY_INVALID");
    await this.#runner.run(async (client) => {
      const player = await client.query<{ readonly id: string }>(
        "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
        [playerId],
      );
      if (!player.rows[0]) invalid("CLAIM_RECOVERY_INVALID");
      const sessionResult = await client.query<SessionRow>(
        `SELECT id::text, player_id, issuance_kind, issuance_id::text, state,
                delivery_generation::text, last_seen_at, expires_at
           FROM samurai_persistence.player_sessions
          WHERE player_id = $1 AND issuance_kind = 'claim' AND issuance_id = $2::uuid
          FOR UPDATE`,
        [playerId, claimId],
      );
      const session = sessionResult.rows[0];
      const digestResult = session ? await client.query<SessionDigestRow>(
        `SELECT digest_key_version, digest_key_identity, digest
           FROM samurai_persistence.player_session_digests
          WHERE player_session_id = $1 AND slot = 'current' FOR UPDATE`,
        [session.id],
      ) : { rows: [] as readonly SessionDigestRow[], rowCount: 0 };
      const now = await this.authority.assertTransactionReady(client, [], "retention");
      const stored = digestResult.rows[0];
      if (!session || !stored || session.state !== "pending-delivery"
        || Number(session.delivery_generation) !== expectedGeneration
        || session.expires_at.getTime() <= now.getTime()
        || addMilliseconds(session.last_seen_at, PLAYER_SESSION_IDLE_MS).getTime() <= now.getTime()) {
        invalid("CLAIM_RECOVERY_INVALID");
      }
      let candidate;
      try {
        candidate = this.authority.playerSessionKeys.digest(sessionSecret, now, stored.digest_key_version);
      } catch {
        invalid("CLAIM_RECOVERY_INVALID");
      }
      if (candidate.keyIdentity !== keyIdentityFromBytes(stored.digest_key_identity)
        || !constantTimeDigestEqual(candidate.digest, stored.digest)) invalid("CLAIM_RECOVERY_INVALID");
      await this.assertPlayerSessionNotTombstoned(client, stored, now);
      const result = await client.query(
        "UPDATE samurai_persistence.player_sessions SET state = 'active', last_seen_at = $2 WHERE id = $1 AND state = 'pending-delivery'",
        [session.id, now],
      );
      if (result.rowCount !== 1) invalid("CLAIM_RECOVERY_INVALID");
    });
  }

  async recoverClaimSession(input: RecoverClaimSessionInput): Promise<RecoverClaimSessionPublicResult> {
    try {
      return await this.recoverClaimSessionInternal(input);
    } catch {
      return ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE;
    }
  }

  async acknowledgeClaimDelivery(
    playerId: string,
    claimId: string,
    sessionSecret: string,
    expectedGeneration: number,
  ): Promise<void | typeof ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE> {
    try {
      await this.acknowledgeClaimDeliveryInternal(playerId, claimId, sessionSecret, expectedGeneration);
    } catch {
      return ACCOUNT_CLAIM_RECOVERY_PUBLIC_FAILURE;
    }
  }

  private async lockAuthenticatedPlayerSession(
    client: SqlClient,
    sessionSecret: string,
    allowedStates: readonly SessionRow["state"][] = ["active"],
  ): Promise<{ readonly session: SessionRow; readonly digest: ResolvedPlayerSessionRow; readonly now: Date }> {
    const initialNow = await this.authority.assertTransactionReady(client, [], "retention");
    let candidates;
    try {
      candidates = this.authority.playerSessionKeys.candidates(sessionSecret, initialNow);
    } catch {
      invalid("PLAYER_SESSION_INVALID");
    }
    let resolved: ResolvedPlayerSessionRow | null = null;
    for (const candidate of candidates) {
      const result = await client.query<ResolvedPlayerSessionRow>(
        `SELECT s.id::text, s.player_id, s.issuance_kind, s.issuance_id::text, s.state,
                s.delivery_generation::text, s.expires_at, d.slot, d.valid_until,
                d.digest_key_version, d.digest_key_identity, d.digest
           FROM samurai_persistence.player_session_digests d
           JOIN samurai_persistence.player_sessions s ON s.id = d.player_session_id
          WHERE d.digest_key_version = $1 AND d.digest_key_identity = $2 AND d.digest = $3
          LIMIT 1`,
        [candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest],
      );
      resolved = result.rows[0] ?? null;
      if (resolved) break;
    }
    if (!resolved) invalid("PLAYER_SESSION_INVALID");
    const player = await client.query<{ readonly id: string }>(
      "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
      [resolved.player_id],
    );
    if (!player.rows[0]) invalid("PLAYER_SESSION_INVALID");
    const sessionResult = await client.query<SessionRow>(
      `SELECT id::text, player_id, issuance_kind, issuance_id::text, state,
              delivery_generation::text, last_seen_at, expires_at
         FROM samurai_persistence.player_sessions WHERE id = $1::uuid FOR UPDATE`,
      [resolved.id],
    );
    const session = sessionResult.rows[0];
    const digests = await client.query<ResolvedPlayerSessionRow>(
      `SELECT s.id::text, s.player_id, s.issuance_kind, s.issuance_id::text, s.state,
              s.delivery_generation::text, s.expires_at, d.slot, d.valid_until,
              d.digest_key_version, d.digest_key_identity, d.digest
         FROM samurai_persistence.player_sessions s
         JOIN samurai_persistence.player_session_digests d ON d.player_session_id = s.id
        WHERE s.id = $1::uuid ORDER BY d.slot FOR UPDATE OF d`,
      [resolved.id],
    );
    const now = await this.authority.assertTransactionReady(client, [], "retention");
    if (!session || !allowedStates.includes(session.state) || session.expires_at.getTime() <= now.getTime()
      || addMilliseconds(session.last_seen_at, PLAYER_SESSION_IDLE_MS).getTime() <= now.getTime()) {
      invalid("PLAYER_SESSION_INVALID");
    }
    let matched: ResolvedPlayerSessionRow | null = null;
    for (const row of digests.rows) {
      if (row.slot === "predecessor" && (!row.valid_until || row.valid_until.getTime() <= now.getTime())) continue;
      try {
        const candidate = this.authority.playerSessionKeys.digest(sessionSecret, now, row.digest_key_version);
        if (candidate.keyIdentity === keyIdentityFromBytes(row.digest_key_identity)
          && constantTimeDigestEqual(candidate.digest, row.digest)) {
          matched = row;
          break;
        }
      } catch {
        // Missing, expired, or compromised selected key material fails this credential closed.
      }
    }
    if (!matched) invalid("PLAYER_SESSION_INVALID");
    await this.assertPlayerSessionNotTombstoned(client, matched, now);
    await client.query(
      "UPDATE samurai_persistence.player_sessions SET last_seen_at = $2 WHERE id = $1::uuid",
      [session.id, now],
    );
    return { session, digest: matched, now };
  }

  private async authenticatePlayerSessionInternal(sessionSecret: string): Promise<AuthenticatedPlayerSession> {
    return this.#runner.run(async (client) => {
      const { session, digest, now } = await this.lockAuthenticatedPlayerSession(client, sessionSecret);
      const timing = await client.query<{ readonly rotate_after: Date }>(
        "SELECT rotate_after FROM samurai_persistence.player_sessions WHERE id = $1::uuid",
        [session.id],
      );
      return {
        playerId: session.player_id,
        sessionId: session.id,
        claimId: session.issuance_id,
        deliveryGeneration: Number(session.delivery_generation),
        credentialKind: digest.slot,
        rotationRequired: digest.slot === "current" && (
          digest.digest_key_version !== this.authority.playerSessionKeys.active.version
          || (timing.rows[0]?.rotate_after.getTime() ?? 0) <= now.getTime()
        ),
      };
    });
  }

  async authenticatePlayerSession(
    sessionSecret: string,
  ): Promise<AuthenticatedPlayerSession | typeof ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE> {
    try {
      return await this.authenticatePlayerSessionInternal(sessionSecret);
    } catch {
      return ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE;
    }
  }

  private async rotatePlayerSessionInternal(sessionSecret: string): Promise<RotatedPlayerSession> {
    return this.#runner.run(async (client) => {
      const { session, digest: authenticated } = await this.lockAuthenticatedPlayerSession(client, sessionSecret);
      if (authenticated.slot !== "current") invalid("PLAYER_SESSION_INVALID");
      const existing = await client.query<ResolvedPlayerSessionRow>(
        `SELECT s.id::text, s.player_id, s.issuance_kind, s.issuance_id::text, s.state,
                s.delivery_generation::text, s.expires_at, d.slot, d.valid_until,
                d.digest_key_version, d.digest_key_identity, d.digest
           FROM samurai_persistence.player_sessions s
           JOIN samurai_persistence.player_session_digests d ON d.player_session_id = s.id
          WHERE s.id = $1::uuid ORDER BY d.slot FOR UPDATE OF d`,
        [session.id],
      );
      const predecessor = existing.rows.find((row) => row.slot === "predecessor");
      const lockedNow = await this.authority.assertTransactionReady(client, [], "retention");
      if (predecessor?.valid_until && predecessor.valid_until.getTime() > lockedNow.getTime()) {
        throw new PersistenceError(
          ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED.code,
          ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED.message,
        );
      }
      const issuedSession = await this.issueFreshPlayerSessionSecret(client, predecessor ? [predecessor] : []);
      const now = issuedSession.now;
      if (session.state !== "active" || session.expires_at.getTime() <= now.getTime()
        || addMilliseconds(session.last_seen_at, PLAYER_SESSION_IDLE_MS).getTime() <= now.getTime()) {
        invalid("PLAYER_SESSION_INVALID");
      }
      let current;
      try {
        current = this.authority.playerSessionKeys.digest(sessionSecret, now, authenticated.digest_key_version);
      } catch {
        invalid("PLAYER_SESSION_INVALID");
      }
      if (current.keyIdentity !== keyIdentityFromBytes(authenticated.digest_key_identity)
        || !constantTimeDigestEqual(current.digest, authenticated.digest)) invalid("PLAYER_SESSION_INVALID");
      await this.assertPlayerSessionNotTombstoned(client, authenticated, now);
      if (predecessor) {
        await this.insertTombstone(client, "player-session", this.playerSessionReplayKey(predecessor), now,
          "player-session", predecessor.digest_key_version, predecessor.digest_key_identity);
        await client.query(
          "DELETE FROM samurai_persistence.player_session_digests WHERE player_session_id = $1::uuid AND slot = 'predecessor'",
          [session.id],
        );
      }
      const replacementSecret = issuedSession.secret;
      const replacement = issuedSession.digest;
      const predecessorUntil = new Date(Math.min(
        session.expires_at.getTime(),
        addMilliseconds(now, ADR_0003_PERSISTENCE_LIFECYCLE.predecessorGraceMs).getTime(),
      ));
      await client.query(
        `UPDATE samurai_persistence.player_session_digests
            SET slot = 'predecessor', valid_until = $2
          WHERE player_session_id = $1::uuid AND slot = 'current'`,
        [session.id, predecessorUntil],
      );
      await client.query(
        `INSERT INTO samurai_persistence.player_session_digests
          (player_session_id, slot, digest_key_version, digest_key_identity, digest, valid_until)
         VALUES ($1::uuid, 'current', $2, $3, $4, NULL)`,
        [session.id, replacement.keyVersion, keyIdentityBytes(replacement.keyIdentity), replacement.digest],
      );
      const rotateAfter = new Date(Math.min(
        session.expires_at.getTime(),
        addMilliseconds(now, PLAYER_SESSION_ROTATE_MS).getTime(),
      ));
      await client.query(
        "UPDATE samurai_persistence.player_sessions SET last_seen_at = $2, rotate_after = $3 WHERE id = $1::uuid",
        [session.id, now, rotateAfter],
      );
      return {
        playerId: session.player_id,
        sessionId: session.id,
        claimId: session.issuance_id,
        deliveryGeneration: Number(session.delivery_generation),
        credentialKind: "current",
        rotationRequired: false,
        sessionSecret: replacementSecret,
      };
    });
  }

  async rotatePlayerSession(
    sessionSecret: string,
  ): Promise<RotatedPlayerSession | typeof ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE
    | typeof ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED> {
    try {
      return await this.rotatePlayerSessionInternal(sessionSecret);
    } catch (error) {
      if (error instanceof PersistenceError && error.code === ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED.code) {
        return ACCOUNT_PLAYER_SESSION_ROTATION_DEFERRED;
      }
      return ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE;
    }
  }

  private playerSessionReplayKey(row: SessionDigestRow): string {
    return `player-session:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`;
  }

  private async lockPlayerSessionReplayFences(client: SqlClient, rows: readonly SessionDigestRow[]): Promise<void> {
    await this.lockScopes(client, rows.map((row) => `player-session-replay:${this.playerSessionReplayKey(row)}`));
  }

  private async issueFreshPlayerSessionSecret(
    client: SqlClient,
    replayRows: readonly SessionDigestRow[] = [],
    baseMode: BaseAuthorityMode = "retention",
  ): Promise<{ readonly secret: string; readonly digest: ReturnType<PlayerSessionKeyring["digest"]>; readonly now: Date }> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const secret = this.#issuePlayerSecret();
      const initialNow = await this.authority.assertTransactionReady(client, ["player-session"], baseMode);
      let identities;
      try {
        identities = this.authority.playerSessionKeys.tombstoneCandidates(secret, initialNow);
      } catch {
        invalid("PLAYER_SESSION_ISSUANCE_INVALID");
      }
      await this.lockPlayerSessionReplayFences(client, [...replayRows, ...identities.map((digest) => ({
        digest_key_version: digest.keyVersion,
        digest_key_identity: keyIdentityBytes(digest.keyIdentity),
        digest: digest.digest,
      }))]);
      const now = await this.authority.assertTransactionReady(client, ["player-session"], baseMode);
      identities = this.authority.playerSessionKeys.tombstoneCandidates(secret, now);
      let collision = false;
      for (const identity of identities) {
        const row = {
          digest_key_version: identity.keyVersion,
          digest_key_identity: keyIdentityBytes(identity.keyIdentity),
          digest: identity.digest,
        };
        try {
          await this.assertPlayerSessionNotTombstoned(client, row, now);
        } catch (error) {
          if (error instanceof PersistenceError && error.code === "PLAYER_SESSION_REPLAY") {
            collision = true;
            break;
          }
          throw error;
        }
        const live = await client.query<{ readonly found: number }>(
          `SELECT 1 AS found FROM samurai_persistence.player_session_digests
            WHERE digest_key_version = $1 AND digest_key_identity = $2 AND digest = $3 LIMIT 1`,
          [identity.keyVersion, row.digest_key_identity, identity.digest],
        );
        if (live.rows[0]) {
          collision = true;
          break;
        }
      }
      if (collision) continue;
      return { secret, digest: this.authority.playerSessionKeys.digest(secret, now), now };
    }
    invalid("PLAYER_SESSION_COLLISION");
  }

  private async assertPlayerSessionNotTombstoned(
    client: SqlClient,
    row: SessionDigestRow,
    now: Date,
  ): Promise<void> {
    const replayKey = this.playerSessionReplayKey(row);
    for (const candidate of this.authority.persistence.tombstoneKeys.replayCandidates("player-session", replayKey, now)) {
      const result = await client.query<{ readonly found: number }>(
        `SELECT 1 AS found FROM samurai_persistence.deletion_tombstones
          WHERE kind = 'player-session' AND digest_key_version = $1
            AND digest_key_identity = $2 AND tombstone_digest = $3 AND expires_at > $4 LIMIT 1`,
        [candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest, now],
      );
      if (result.rows[0]) invalid("PLAYER_SESSION_REPLAY");
    }
  }

  private async deletePlayerWithWalletProofInternal(input: DeletePlayerWithWalletProofInput): Promise<void> {
    const intent = parsePlayerDeletionIntent(input.deletionIntent);
    if (!UUID_V4_PATTERN.test(input.challengeId)) invalid("PLAYER_DELETION_INVALID");
    const challenge = parseClaimChallenge(input.proof.challenge);
    const verified = verifyAccountProof(input.proof);
    const intentHash = await hashPlayerDeletionIntent(intent);
    const challengeHash = await hashClaimChallenge(challenge);
    if (challenge.claimIntentHash !== intentHash || challenge.account !== verified.account) {
      invalid("PLAYER_DELETION_INVALID");
    }
    await this.#runner.run(async (client) => {
      const resolved = await this.resolveWallet(client, challenge.chainId, verified.account);
      if (!resolved) invalid("PLAYER_DELETION_INVALID");
      const player = await client.query<{ readonly id: string }>(
        "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
        [resolved.player_id],
      );
      if (!player.rows[0]) invalid("PLAYER_DELETION_INVALID");
      await this.deleteLockedPlayerRows(client, resolved.player_id, {
        extraScopes: [
          `wallet:${challenge.chainId}:${verified.account}`,
          `delete:${intent.deleteClaimId}:${intent.idempotencyKey}`,
        ],
        extraChallengeIds: [input.challengeId],
        revalidate: async (now) => {
          const wallet = await this.lockWallet(client, challenge.chainId, verified.account);
          const storedChallenge = await this.lockChallenge(client, input.challengeId);
          if (!wallet || wallet.player_id !== resolved.player_id || wallet.public_key !== verified.publicKey
            || wallet.scheme !== verified.scheme || wallet.linked_claim_id !== intent.deleteClaimId) {
            invalid("PLAYER_DELETION_INVALID");
          }
          await this.assertChallengeNotTombstoned(client, storedChallenge.challenge_hash, now);
          await this.assertChallengeNonceNotTombstoned(client, storedChallenge.nonce_digest, now);
          this.assertChallenge(storedChallenge, "delete", null, intent.deleteClaimId,
            intentHash, challengeHash, challenge, now);
          await this.consumeChallenge(client, storedChallenge, intent.deleteClaimId, now);
        },
      });
    });
  }

  async deletePlayerWithWalletProof(input: DeletePlayerWithWalletProofInput): Promise<DeletePlayerPublicResult> {
    try {
      await this.deletePlayerWithWalletProofInternal(input);
    } catch {
      return ACCOUNT_PLAYER_DELETE_PUBLIC_FAILURE;
    }
  }

  private async deletePlayerInternal(sessionSecret: string): Promise<void> {
    await this.#runner.run(async (client) => {
      const initialNow = await this.authority.assertTransactionReady(client, [], "retention");
      let candidates;
      try {
        candidates = this.authority.playerSessionKeys.candidates(sessionSecret, initialNow);
      } catch {
        invalid("PLAYER_SESSION_INVALID");
      }
      let resolved: ResolvedPlayerSessionRow | null = null;
      for (const candidate of candidates) {
        const result = await client.query<ResolvedPlayerSessionRow>(
          `SELECT s.id::text, s.player_id, s.issuance_kind, s.issuance_id::text, s.state,
                  s.delivery_generation::text, s.expires_at, d.slot, d.valid_until,
                  d.digest_key_version, d.digest_key_identity, d.digest
             FROM samurai_persistence.player_session_digests d
             JOIN samurai_persistence.player_sessions s ON s.id = d.player_session_id
            WHERE d.digest_key_version = $1 AND d.digest_key_identity = $2 AND d.digest = $3
            LIMIT 1`,
          [candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest],
        );
        resolved = result.rows[0] ?? null;
        if (resolved) break;
      }
      if (!resolved) invalid("PLAYER_SESSION_INVALID");
      const player = await client.query<{ readonly id: string }>(
        "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
        [resolved.player_id],
      );
      if (!player.rows[0]) invalid("PLAYER_SESSION_INVALID");
      const resolvedSessionId = resolved.id;
      await this.deleteLockedPlayerRows(client, resolved.player_id, {
        revalidate: async (now) => {
          const sessionResult = await client.query<SessionRow>(
            `SELECT id::text, player_id, issuance_kind, issuance_id::text, state,
                    delivery_generation::text, last_seen_at, expires_at
               FROM samurai_persistence.player_sessions WHERE id = $1::uuid FOR UPDATE`,
            [resolvedSessionId],
          );
          const session = sessionResult.rows[0];
          const digests = await client.query<ResolvedPlayerSessionRow>(
            `SELECT s.id::text, s.player_id, s.issuance_kind, s.issuance_id::text, s.state,
                    s.delivery_generation::text, s.expires_at, d.slot, d.valid_until,
                    d.digest_key_version, d.digest_key_identity, d.digest
               FROM samurai_persistence.player_sessions s
               JOIN samurai_persistence.player_session_digests d ON d.player_session_id = s.id
              WHERE s.id = $1::uuid ORDER BY d.slot FOR UPDATE OF d`,
            [resolvedSessionId],
          );
          if (!session || session.player_id !== resolved.player_id
            || !["active", "pending-delivery"].includes(session.state)
            || session.expires_at.getTime() <= now.getTime()
            || addMilliseconds(session.last_seen_at, PLAYER_SESSION_IDLE_MS).getTime() <= now.getTime()) {
            invalid("PLAYER_SESSION_INVALID");
          }
          const current = digests.rows.find((row) => row.slot === "current");
          if (!current) invalid("PLAYER_SESSION_INVALID");
          let candidate;
          try {
            candidate = this.authority.playerSessionKeys.digest(sessionSecret, now, current.digest_key_version);
          } catch {
            invalid("PLAYER_SESSION_INVALID");
          }
          if (candidate.keyIdentity !== keyIdentityFromBytes(current.digest_key_identity)
            || !constantTimeDigestEqual(candidate.digest, current.digest)) invalid("PLAYER_SESSION_INVALID");
          await this.assertPlayerSessionNotTombstoned(client, current, now);
        },
      });
    });
  }

  private async deleteLockedPlayerRows(
    client: SqlClient,
    playerId: string,
    authority: {
      readonly extraScopes?: readonly string[];
      readonly extraChallengeIds?: readonly string[];
      readonly revalidate: (now: Date) => Promise<void>;
    },
  ): Promise<void> {
      const sessionCandidates = await client.query<{ readonly id: string; readonly issuance_id: string }>(
        "SELECT id::text, issuance_id::text FROM samurai_persistence.player_sessions WHERE player_id = $1 ORDER BY id",
        [playerId],
      );
      const digestCandidates = await client.query<SessionDigestRow>(
        `SELECT d.digest_key_version, d.digest_key_identity, d.digest
           FROM samurai_persistence.player_session_digests d
           JOIN samurai_persistence.player_sessions s ON s.id = d.player_session_id
          WHERE s.player_id = $1 ORDER BY d.player_session_id, d.slot`,
        [playerId],
      );
      const walletCandidates = await client.query<{
        readonly credential_id: string; readonly chain_id: string; readonly account: string; readonly linked_claim_id: string;
      }>(
        `SELECT credential_id::text, chain_id, account, linked_claim_id::text
           FROM samurai_persistence.wallet_credentials WHERE player_id = $1 ORDER BY credential_id`,
        [playerId],
      );
      const mergeCandidates = await client.query<{ readonly claim_id: string; readonly idempotency_key: string }>(
        "SELECT claim_id::text, idempotency_key FROM samurai_persistence.progress_merges WHERE player_id = $1 ORDER BY claim_id",
        [playerId],
      );
      const claimIds = [...new Set([
        ...sessionCandidates.rows.map((row) => row.issuance_id),
        ...mergeCandidates.rows.map((row) => row.claim_id),
        ...walletCandidates.rows.map((row) => row.linked_claim_id),
      ])];
      const extraChallengeIds = [...new Set(authority.extraChallengeIds ?? [])];
      await this.lockScopes(client, [
        ...(authority.extraScopes ?? []),
        ...digestCandidates.rows.map((row) => `player-session-replay:${this.playerSessionReplayKey(row)}`),
        ...walletCandidates.rows.map((row) => `wallet:${row.chain_id}:${row.account}`),
        ...walletCandidates.rows.map((row) => `claim-id:${row.linked_claim_id}`),
        ...claimIds.map((claimId) => `challenge-claim:${claimId}`),
        ...mergeCandidates.rows.flatMap((row) => [
          `claim-id:${row.claim_id}`,
          `claim-idempotency:${row.idempotency_key}`,
        ]),
      ]);
      const challengeCandidates = await client.query<ChallengeReplayRow>(
        `SELECT challenge_id::text, challenge_hash, nonce_digest, expires_at
           FROM samurai_persistence.claim_challenges
          WHERE claim_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
             OR challenge_id IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb))
          ORDER BY challenge_id`,
        [JSON.stringify(claimIds), JSON.stringify(extraChallengeIds)],
      );
      await this.lockScopes(client, [
        ...challengeCandidates.rows.map((row) => (
          `challenge-nonce:${Buffer.from(row.nonce_digest).toString("base64url")}`
        )),
      ]);
      await client.query<{ readonly id: string; readonly issuance_id: string }>(
        "SELECT id::text, issuance_id::text FROM samurai_persistence.player_sessions WHERE player_id = $1 ORDER BY id FOR UPDATE",
        [playerId],
      );
      const digests = await client.query<SessionDigestRow>(
        `SELECT d.digest_key_version, d.digest_key_identity, d.digest
           FROM samurai_persistence.player_session_digests d
           JOIN samurai_persistence.player_sessions s ON s.id = d.player_session_id
          WHERE s.player_id = $1 ORDER BY d.player_session_id, d.slot FOR UPDATE OF d`,
        [playerId],
      );
      const wallets = await client.query<{
        readonly credential_id: string; readonly chain_id: string; readonly account: string; readonly linked_claim_id: string;
      }>(
        `SELECT credential_id::text, chain_id, account, linked_claim_id::text
           FROM samurai_persistence.wallet_credentials WHERE player_id = $1 ORDER BY credential_id FOR UPDATE`,
        [playerId],
      );
      const merges = await client.query<{ readonly claim_id: string; readonly idempotency_key: string }>(
        "SELECT claim_id::text, idempotency_key FROM samurai_persistence.progress_merges WHERE player_id = $1 ORDER BY claim_id FOR UPDATE",
        [playerId],
      );
      const challenges = await client.query<ChallengeReplayRow>(
        `SELECT challenge_id::text, challenge_hash, nonce_digest, expires_at
           FROM samurai_persistence.claim_challenges
          WHERE claim_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))
             OR challenge_id IN (SELECT value::uuid FROM jsonb_array_elements_text($2::jsonb))
          ORDER BY challenge_id FOR UPDATE`,
        [JSON.stringify(claimIds), JSON.stringify(extraChallengeIds)],
      );
      await client.query(
        "SELECT 1 FROM samurai_persistence.player_progress WHERE player_id = $1 FOR UPDATE",
        [playerId],
      );
      const commands = await client.query<{ readonly idempotency_key: string }>(
        "SELECT idempotency_key FROM samurai_persistence.command_receipts WHERE player_id = $1 ORDER BY idempotency_key FOR UPDATE",
        [playerId],
      );
      await client.query(
        "SELECT 1 FROM samurai_persistence.domain_events WHERE player_id = $1 ORDER BY event_id FOR UPDATE",
        [playerId],
      );
      await client.query(
        `SELECT 1
           FROM samurai_persistence.outbox_deliveries o
           JOIN samurai_persistence.domain_events e ON e.event_id = o.event_id
          WHERE e.player_id = $1 ORDER BY o.event_id FOR UPDATE OF o`,
        [playerId],
      );
      const now = await this.authority.assertRetentionTransactionReady(client);
      await authority.revalidate(now);
      for (const row of digests.rows) {
        await this.insertTombstone(client, "player-session", this.playerSessionReplayKey(row), now,
          "player-session", row.digest_key_version, row.digest_key_identity);
      }
      for (const row of wallets.rows) {
        await this.insertTombstone(client, "wallet-credential",
          `wallet:${row.chain_id}:${row.account}`, now);
        await this.insertTombstone(client, "claim-id", `claim:${row.linked_claim_id}`, now);
      }
      for (const row of commands.rows) {
        await this.insertTombstone(client, "command",
          `player:${playerId}:command:${row.idempotency_key}`, now);
      }
      for (const row of merges.rows) {
        await this.insertTombstone(client, "claim-id", `claim:${row.claim_id}`, now);
        await this.insertTombstone(client, "claim-idempotency", `claim-idempotency:${row.idempotency_key}`, now);
      }
      for (const challenge of challenges.rows) {
        await this.insertTombstone(client, "claim-challenge",
          `challenge:${Buffer.from(challenge.challenge_hash).toString("base64url")}`, now);
        await this.insertTombstone(client, "claim-challenge", this.challengeNonceReplayKey(challenge.nonce_digest), now);
      }
      if (challenges.rows.length > 0) {
        await client.query(
          `DELETE FROM samurai_persistence.claim_challenges
            WHERE challenge_id IN (SELECT value::uuid FROM jsonb_array_elements_text($1::jsonb))`,
          [JSON.stringify(challenges.rows.map((row) => row.challenge_id))],
        );
      }
      await client.query("DELETE FROM samurai_persistence.players WHERE id = $1", [playerId]);
  }

  async deletePlayer(sessionSecret: string): Promise<void | typeof ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE> {
    try {
      await this.deletePlayerInternal(sessionSecret);
    } catch {
      return ACCOUNT_PLAYER_SESSION_PUBLIC_FAILURE;
    }
  }

  async deleteExpiredChallenges(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid("RETENTION_LIMIT_INVALID");
    return this.#runner.run(async (client) => {
      const initialNow = await this.authority.assertRetentionTransactionReady(client);
      const expired = await client.query<ChallengeReplayRow & { readonly claim_id: string }>(
        `SELECT challenge_id::text, claim_id::text, challenge_hash, nonce_digest, expires_at
          FROM samurai_persistence.claim_challenges
          WHERE expires_at <= $1
          ORDER BY expires_at, challenge_id
          LIMIT $2`,
        [initialNow, limit],
      );
      let cleaned = 0;
      for (const row of expired.rows) {
        await this.lockScopes(client, [
          `challenge-claim:${row.claim_id}`,
          `challenge-nonce:${Buffer.from(row.nonce_digest).toString("base64url")}`,
        ]);
        const locked = await client.query<ChallengeReplayRow & { readonly claim_id: string }>(
          `SELECT challenge_id::text, claim_id::text, challenge_hash, nonce_digest, expires_at
             FROM samurai_persistence.claim_challenges
            WHERE challenge_id = $1::uuid FOR UPDATE`,
          [row.challenge_id],
        );
        const current = locked.rows[0];
        const now = await this.authority.assertRetentionTransactionReady(client);
        if (!current || current.expires_at.getTime() > now.getTime()) continue;
        await this.insertTombstone(client, "claim-challenge",
          `challenge:${Buffer.from(current.challenge_hash).toString("base64url")}`, now);
        await this.insertTombstone(client, "claim-challenge", this.challengeNonceReplayKey(current.nonce_digest), now);
        const deleted = await client.query(
          "DELETE FROM samurai_persistence.claim_challenges WHERE challenge_id = $1::uuid",
          [row.challenge_id],
        );
        if (deleted.rowCount === 1) cleaned += 1;
      }
      return cleaned;
    });
  }

  async deleteExpiredPlayerSessions(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid("RETENTION_LIMIT_INVALID");
    return this.#runner.run(async (client) => {
      const initialNow = await this.authority.assertRetentionTransactionReady(client);
      const candidates = await client.query<{ readonly id: string; readonly player_id: string }>(
        `SELECT id::text, player_id FROM samurai_persistence.player_sessions
          WHERE (expires_at <= $1 OR last_seen_at <= $1 - interval '7 days')
            AND (state <> 'revoked' OR EXISTS (
              SELECT 1 FROM samurai_persistence.player_session_digests d WHERE d.player_session_id = player_sessions.id
            ))
          ORDER BY player_id, expires_at, id LIMIT $2`,
        [initialNow, limit],
      );
      let cleaned = 0;
      for (const candidate of candidates.rows) {
        const parent = await client.query<{ readonly id: string }>(
          "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
          [candidate.player_id],
        );
        if (!parent.rows[0]) continue;
        const session = await client.query<SessionRow>(
          `SELECT id::text, player_id, issuance_kind, issuance_id::text, state,
                  delivery_generation::text, last_seen_at, expires_at
             FROM samurai_persistence.player_sessions
            WHERE id = $1::uuid FOR UPDATE`,
          [candidate.id],
        );
        const digests = await client.query<SessionDigestRow>(
          `SELECT digest_key_version, digest_key_identity, digest
             FROM samurai_persistence.player_session_digests
            WHERE player_session_id = $1::uuid ORDER BY slot FOR UPDATE`,
          [candidate.id],
        );
        await this.lockPlayerSessionReplayFences(client, digests.rows);
        const now = await this.authority.assertRetentionTransactionReady(client);
        if (!session.rows[0] || (session.rows[0].expires_at.getTime() > now.getTime()
          && addMilliseconds(session.rows[0].last_seen_at, PLAYER_SESSION_IDLE_MS).getTime() > now.getTime())) continue;
        if (session.rows[0].state === "revoked" && digests.rows.length === 0) continue;
        for (const row of digests.rows) {
          await this.insertTombstone(client, "player-session", this.playerSessionReplayKey(row), now,
            "player-session", row.digest_key_version, row.digest_key_identity);
        }
        await client.query("DELETE FROM samurai_persistence.player_session_digests WHERE player_session_id = $1::uuid", [candidate.id]);
        await client.query(
          `UPDATE samurai_persistence.player_sessions
              SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2),
                  last_seen_at = LEAST(expires_at, GREATEST(last_seen_at, $2))
            WHERE id = $1::uuid`,
          [candidate.id, now],
        );
        await client.query(
          `DELETE FROM samurai_persistence.player_sessions s
            WHERE s.id = $1::uuid AND s.state = 'revoked'
              AND NOT EXISTS (SELECT 1 FROM samurai_persistence.player_session_digests d WHERE d.player_session_id = s.id)
              AND NOT EXISTS (SELECT 1 FROM samurai_persistence.progress_merges m WHERE m.session_id = s.id)`,
          [candidate.id],
        );
        cleaned += 1;
      }
      return cleaned;
    });
  }

  async deleteExpiredPlayerSessionPredecessors(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid("RETENTION_LIMIT_INVALID");
    return this.#runner.run(async (client) => {
      const initialNow = await this.authority.assertRetentionTransactionReady(client);
      const candidates = await client.query<{
        readonly player_session_id: string;
        readonly player_id: string;
      }>(
        `SELECT d.player_session_id::text, s.player_id
           FROM samurai_persistence.player_session_digests d
           JOIN samurai_persistence.player_sessions s ON s.id = d.player_session_id
          WHERE d.slot = 'predecessor' AND d.valid_until <= $1
          ORDER BY s.player_id, d.valid_until, d.player_session_id
          LIMIT $2`,
        [initialNow, limit],
      );
      let cleaned = 0;
      for (const candidate of candidates.rows) {
        const parent = await client.query<{ readonly id: string }>(
          "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
          [candidate.player_id],
        );
        if (!parent.rows[0]) continue;
        const session = await client.query<{ readonly id: string }>(
          "SELECT id::text FROM samurai_persistence.player_sessions WHERE id = $1::uuid FOR UPDATE",
          [candidate.player_session_id],
        );
        if (!session.rows[0]) continue;
        const predecessor = await client.query<SessionDigestRow & { readonly valid_until: Date | null }>(
          `SELECT digest_key_version, digest_key_identity, digest, valid_until
             FROM samurai_persistence.player_session_digests
            WHERE player_session_id = $1::uuid AND slot = 'predecessor' FOR UPDATE`,
          [candidate.player_session_id],
        );
        const row = predecessor.rows[0];
        if (!row) continue;
        await this.lockPlayerSessionReplayFences(client, [row]);
        const now = await this.authority.assertRetentionTransactionReady(client);
        if (!row.valid_until || row.valid_until.getTime() > now.getTime()) continue;
        await this.insertTombstone(client, "player-session", this.playerSessionReplayKey(row), now,
          "player-session", row.digest_key_version, row.digest_key_identity);
        const deleted = await client.query(
          `DELETE FROM samurai_persistence.player_session_digests
            WHERE player_session_id = $1::uuid AND slot = 'predecessor' AND valid_until <= $2`,
          [candidate.player_session_id, now],
        );
        if (deleted.rowCount === 1) {
          await client.query(
            `DELETE FROM samurai_persistence.player_sessions s
              WHERE s.id = $1::uuid AND s.state = 'revoked'
                AND NOT EXISTS (SELECT 1 FROM samurai_persistence.player_session_digests d WHERE d.player_session_id = s.id)
                AND NOT EXISTS (SELECT 1 FROM samurai_persistence.progress_merges m WHERE m.session_id = s.id)`,
            [candidate.player_session_id],
          );
          cleaned += 1;
        }
      }
      return cleaned;
    });
  }

  async deleteExpiredMergeReceipts(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid("RETENTION_LIMIT_INVALID");
    return this.#runner.run(async (client) => {
      const initialNow = await this.authority.assertRetentionTransactionReady(client);
      const candidates = await client.query<{ readonly claim_id: string; readonly player_id: string }>(
        `SELECT claim_id::text, player_id FROM samurai_persistence.progress_merges
          WHERE expires_at <= $1 ORDER BY player_id, expires_at, claim_id LIMIT $2`,
        [initialNow, limit],
      );
      let cleaned = 0;
      for (const candidate of candidates.rows) {
        const parent = await client.query<{ readonly id: string }>(
          "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
          [candidate.player_id],
        );
        if (!parent.rows[0]) continue;
        const resolved = await client.query<{
          readonly claim_id: string; readonly idempotency_key: string; readonly challenge_hash: Uint8Array;
          readonly session_id: string; readonly expires_at: Date;
        }>(
          `SELECT claim_id::text, idempotency_key, challenge_hash, session_id::text, expires_at
             FROM samurai_persistence.progress_merges
            WHERE claim_id = $1::uuid AND player_id = $2`,
          [candidate.claim_id, candidate.player_id],
        );
        const beforeLock = resolved.rows[0];
        if (!beforeLock) continue;
        await this.lockScopes(client, [
          `challenge-claim:${beforeLock.claim_id}`,
          `claim-id:${beforeLock.claim_id}`,
          `claim-idempotency:${beforeLock.idempotency_key}`,
        ]);
        const challenges = await this.lockChallengesForRemovalByClaimId(client, beforeLock.claim_id);
        const receipt = await client.query<{
          readonly claim_id: string; readonly idempotency_key: string; readonly challenge_hash: Uint8Array;
          readonly session_id: string; readonly expires_at: Date;
        }>(
          `SELECT claim_id::text, idempotency_key, challenge_hash, session_id::text, expires_at
             FROM samurai_persistence.progress_merges
            WHERE claim_id = $1::uuid AND player_id = $2 FOR UPDATE`,
          [candidate.claim_id, candidate.player_id],
        );
        const row = receipt.rows[0];
        const now = await this.authority.assertRetentionTransactionReady(client);
        if (!row || row.expires_at.getTime() > now.getTime()) continue;
        await this.insertTombstone(client, "claim-id", `claim:${row.claim_id}`, now);
        await this.insertTombstone(client, "claim-idempotency", `claim-idempotency:${row.idempotency_key}`, now);
        await this.insertTombstone(client, "claim-challenge",
          `challenge:${Buffer.from(row.challenge_hash).toString("base64url")}`, now);
        for (const challenge of challenges) {
          await this.insertTombstone(client, "claim-challenge",
            `challenge:${Buffer.from(challenge.challenge_hash).toString("base64url")}`, now);
          await this.insertTombstone(client, "claim-challenge", this.challengeNonceReplayKey(challenge.nonce_digest), now);
        }
        await client.query("DELETE FROM samurai_persistence.claim_challenges WHERE claim_id = $1::uuid", [row.claim_id]);
        await client.query("DELETE FROM samurai_persistence.progress_merges WHERE claim_id = $1::uuid", [row.claim_id]);
        await client.query(
          `DELETE FROM samurai_persistence.player_sessions s
            WHERE s.id = $1::uuid AND s.state = 'revoked'
              AND NOT EXISTS (SELECT 1 FROM samurai_persistence.player_session_digests d WHERE d.player_session_id = s.id)
              AND NOT EXISTS (SELECT 1 FROM samurai_persistence.progress_merges m WHERE m.session_id = s.id)`,
          [row.session_id],
        );
        cleaned += 1;
      }
      return cleaned;
    });
  }

  async purgeUnavailablePlayerSessionDigests(limit = 100): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) invalid("RETENTION_LIMIT_INVALID");
    return this.#runner.run(async (client) => {
      const initialNow = await this.authority.assertRetentionTransactionReady(client);
      type Candidate = {
        readonly player_session_id: string; readonly player_id: string; readonly slot: "current" | "predecessor";
        readonly digest_key_version: number; readonly digest_key_identity: Uint8Array; readonly digest: Uint8Array;
      };
      let purged = 0;
      let cursor: Pick<Candidate, "player_id" | "player_session_id" | "slot"> | undefined;
      while (purged < limit) {
        const candidates = await client.query<Candidate>(
          `SELECT d.player_session_id::text, s.player_id, d.slot, d.digest_key_version,
                  d.digest_key_identity, d.digest
             FROM samurai_persistence.player_session_digests d
             JOIN samurai_persistence.player_sessions s ON s.id = d.player_session_id
            WHERE ($1::text IS NULL OR
                   (s.player_id, d.player_session_id, d.slot::text) > ($1::text, $2::uuid, $3::text))
            ORDER BY s.player_id, d.player_session_id, d.slot
            LIMIT 256`,
          [cursor?.player_id ?? null, cursor?.player_session_id ?? null, cursor?.slot ?? null],
        );
        if (candidates.rows.length === 0) break;
        for (const candidate of candidates.rows) {
          cursor = candidate;
          if (!this.isPlayerSessionKeyUnavailable(candidate, initialNow)) continue;
          const parent = await client.query<{ readonly id: string }>(
            "SELECT id FROM samurai_persistence.players WHERE id = $1 FOR UPDATE",
            [candidate.player_id],
          );
          if (!parent.rows[0]) continue;
          const session = await client.query<SessionRow>(
            `SELECT id::text, player_id, issuance_kind, issuance_id::text, state,
                    delivery_generation::text, last_seen_at, expires_at
               FROM samurai_persistence.player_sessions WHERE id = $1::uuid FOR UPDATE`,
            [candidate.player_session_id],
          );
          const current = await client.query<SessionDigestRow & { readonly slot: "current" | "predecessor" }>(
            `SELECT slot, digest_key_version, digest_key_identity, digest
               FROM samurai_persistence.player_session_digests
              WHERE player_session_id = $1::uuid AND slot = $2 FOR UPDATE`,
            [candidate.player_session_id, candidate.slot],
          );
          const row = current.rows[0];
          if (!session.rows[0] || !row || row.digest_key_version !== candidate.digest_key_version
            || !constantTimeDigestEqual(row.digest_key_identity, candidate.digest_key_identity)
            || !constantTimeDigestEqual(row.digest, candidate.digest)) continue;
          await this.lockPlayerSessionReplayFences(client, [row]);
          const now = await this.authority.assertRetentionTransactionReady(client);
          if (!this.isPlayerSessionKeyUnavailable(row, now)) continue;
          await this.insertTombstone(client, "player-session", this.playerSessionReplayKey(row), now,
            "player-session", row.digest_key_version, row.digest_key_identity);
          await client.query(
            "DELETE FROM samurai_persistence.player_session_digests WHERE player_session_id = $1::uuid AND slot = $2",
            [candidate.player_session_id, candidate.slot],
          );
          if (candidate.slot === "current") {
            await client.query(
              `UPDATE samurai_persistence.player_sessions
                  SET state = 'revoked', revoked_at = COALESCE(revoked_at, $2),
                      last_seen_at = LEAST(expires_at, GREATEST(last_seen_at, $2))
                WHERE id = $1::uuid`,
              [candidate.player_session_id, now],
            );
          }
          await client.query(
            `DELETE FROM samurai_persistence.player_sessions s
              WHERE s.id = $1::uuid AND s.state = 'revoked'
                AND NOT EXISTS (SELECT 1 FROM samurai_persistence.player_session_digests d WHERE d.player_session_id = s.id)
                AND NOT EXISTS (SELECT 1 FROM samurai_persistence.progress_merges m WHERE m.session_id = s.id)`,
            [candidate.player_session_id],
          );
          purged += 1;
          if (purged === limit) break;
        }
      }
      return purged;
    });
  }

  private isPlayerSessionKeyUnavailable(
    row: Pick<SessionDigestRow, "digest_key_version" | "digest_key_identity">,
    now: Date,
  ): boolean {
    const metadata = this.authority.playerSessionKeys.metadata(row.digest_key_version);
    let storedIdentity: string | undefined;
    try {
      storedIdentity = keyIdentityFromBytes(row.digest_key_identity);
    } catch {
      return true;
    }
    return !metadata
      || metadata.keyIdentity !== storedIdentity
      || metadata.activatedAtMs > now.getTime()
      || (metadata.compromisedAtMs !== null && metadata.compromisedAtMs <= now.getTime())
      || (metadata.verifyUntilMs !== null && metadata.verifyUntilMs <= now.getTime());
  }

  private async authenticateGuest(
    client: SqlClient,
    secret: string,
    purposes: readonly CapabilityPurpose[],
  ): Promise<{ readonly id: string }> {
    const initialNow = await this.authority.assertTransactionReady(client, purposes, "serving");
    let candidates;
    try {
      candidates = this.authority.persistence.resumeKeys.candidates(secret, initialNow);
      await this.authority.persistence.lockGuestSecretReplayFence(client, secret, initialNow);
      await this.authority.persistence.assertGuestSecretNotTombstoned(client, secret, initialNow);
    } catch (error) {
      if (error instanceof GuestSecretFormatError) throw new GuestResumeError("GUEST_RESUME_INVALID");
      throw error;
    }
    const match = await this.#guestRepository.findResumeMatchForUpdate(client, candidates);
    const now = await this.authority.assertTransactionReady(client, purposes, "serving");
    try {
      await this.authority.persistence.assertGuestSecretNotTombstoned(client, secret, now);
    } catch {
      throw new GuestResumeError("GUEST_RESUME_INVALID");
    }
    if (!match || match.expiresAt.getTime() <= now.getTime()) throw new GuestResumeError("GUEST_RESUME_INVALID");
    const candidate = this.authority.persistence.resumeKeys.candidates(secret, now).find((item) => (
      item.keyVersion === match.digestKeyVersion && item.keyIdentity === match.digestKeyIdentity
    ));
    if (!candidate || !constantTimeDigestEqual(candidate.digest, match.digest)) throw new GuestResumeError("GUEST_RESUME_INVALID");
    return { id: match.id };
  }

  private async assertGuestClaimCapability(
    client: SqlClient,
    guestId: string,
    capability: string,
    suppliedNow?: Date,
    requiredUntil?: Date,
  ): Promise<void> {
    const result = await client.query<GuestCapabilityRow>(
      `SELECT digest_key_version, digest_key_identity, digest, expires_at
         FROM samurai_persistence.guest_claim_capabilities
        WHERE guest_session_id = $1 FOR UPDATE`,
      [guestId],
    );
    const row = result.rows[0];
    const now = suppliedNow ?? await this.authority.assertTransactionReady(client, ["guest-claim"], "serving");
    if (!row || row.expires_at.getTime() <= now.getTime()
      || (requiredUntil && row.expires_at.getTime() < requiredUntil.getTime())) {
      invalid("CLAIM_CAPABILITY_INVALID");
    }
    const replayKey = `guest-claim:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`;
    for (const candidate of this.authority.persistence.tombstoneKeys.replayCandidates("guest-claim", replayKey, now)) {
      const tombstone = await client.query<{ readonly found: number }>(
        `SELECT 1 AS found FROM samurai_persistence.deletion_tombstones
          WHERE kind = 'guest-claim' AND digest_key_version = $1
            AND digest_key_identity = $2 AND tombstone_digest = $3 AND expires_at > $4 LIMIT 1`,
        [candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest, now],
      );
      if (tombstone.rows[0]) invalid("CLAIM_CAPABILITY_INVALID");
    }
    try {
      const candidate = this.authority.guestClaimKeys.digest(capability, now, row.digest_key_version);
      if (candidate.keyIdentity !== keyIdentityFromBytes(row.digest_key_identity)
        || !constantTimeDigestEqual(candidate.digest, row.digest)) invalid("CLAIM_CAPABILITY_INVALID");
      const metadata = this.authority.guestClaimKeys.metadata(row.digest_key_version);
      if (!metadata || (metadata.verifyUntilMs !== null
        && metadata.verifyUntilMs < (requiredUntil?.getTime() ?? now.getTime()))) invalid("CLAIM_CAPABILITY_INVALID");
    } catch (error) {
      if (error instanceof CapabilitySecretFormatError) invalid("CLAIM_CAPABILITY_INVALID");
      throw error;
    }
  }

  private async insertChallenge(
    client: SqlClient,
    purpose: ChallengePurpose,
    guestId: string | null,
    claimId: string,
    intentHash: string,
    account: string,
    claimAuthority?: { readonly guestId: string; readonly capability: string },
  ): Promise<IssuedClaimChallenge> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const nonce = this.#issueNonce();
      base64url32(nonce);
      const nonceDigest = hashText(CHALLENGE_NONCE_DOMAIN, nonce);
      await this.lockScopes(client, [`challenge-nonce:${Buffer.from(nonceDigest).toString("base64url")}`]);
      const now = await this.authority.assertTransactionReady(
        client,
        purpose === "claim" ? ["guest-claim"] : [],
        purpose === "claim" ? "serving" : "retention",
      );
      if (claimAuthority) {
        await this.assertGuestClaimCapability(
          client,
          claimAuthority.guestId,
          claimAuthority.capability,
          now,
          addMilliseconds(now, CHALLENGE_LIFETIME_MS),
        );
      }
      const challenge = parseClaimChallenge({
        domain: "samurai-sushi:guest-claim:v1",
        schemaVersion: 1,
        origin: this.options.origin,
        chainId: this.options.chainId,
        account,
        claimIntentHash: intentHash,
        nonce,
        issuedAt: now.toISOString(),
        expiresAt: addMilliseconds(now, CHALLENGE_LIFETIME_MS).toISOString(),
      });
      const challengeHash = await hashClaimChallenge(challenge);
      const challengeId = this.#issueUuid();
      if (!UUID_V4_PATTERN.test(challengeId)) invalid("CLAIM_CHALLENGE_INVALID");
      await this.assertChallengeNotTombstoned(client, protocolHashBytes(challengeHash), now);
      await this.assertChallengeNonceNotTombstoned(client, nonceDigest, now);
      const inserted = await client.query<{ readonly challenge_id: string }>(
        `INSERT INTO samurai_persistence.claim_challenges
            (challenge_id, purpose, guest_session_id, claim_id, nonce_digest,
             challenge_hash, intent_hash, issued_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING
           RETURNING challenge_id::text`,
        [challengeId, purpose, guestId, claimId, nonceDigest,
          protocolHashBytes(challengeHash), protocolHashBytes(intentHash), now,
          addMilliseconds(now, CHALLENGE_LIFETIME_MS)],
      );
      if (inserted.rowCount === 1) {
        return { challengeId, challenge };
      }
    }
    invalid("CLAIM_CHALLENGE_COLLISION");
  }

  private async lockChallenge(client: SqlClient, challengeId: string): Promise<ChallengeRow> {
    const result = await client.query<ChallengeRow>(
      `SELECT challenge_id::text, purpose, guest_session_id, claim_id::text, nonce_digest,
              challenge_hash, intent_hash, issued_at, expires_at, consumed_at,
              consumed_claim_id::text
         FROM samurai_persistence.claim_challenges WHERE challenge_id = $1::uuid FOR UPDATE`,
      [challengeId],
    );
    return result.rows[0] ?? invalid("CLAIM_CHALLENGE_INVALID");
  }

  private assertChallenge(
    stored: ChallengeRow,
    purpose: ChallengePurpose,
    guestId: string | null,
    claimId: string,
    intentHash: string,
    challengeHash: string,
    challenge: ClaimChallengeV1,
    now: Date,
  ): void {
    if (stored.purpose !== purpose || stored.guest_session_id !== guestId || stored.claim_id !== claimId
      || stored.consumed_at !== null || stored.consumed_claim_id !== null
      || !constantTimeDigestEqual(stored.intent_hash, protocolHashBytes(intentHash))
      || !constantTimeDigestEqual(stored.challenge_hash, protocolHashBytes(challengeHash))
      || !constantTimeDigestEqual(stored.nonce_digest, hashText(CHALLENGE_NONCE_DOMAIN, challenge.nonce))
      || stored.issued_at.getTime() !== new Date(challenge.issuedAt).getTime()
      || stored.expires_at.getTime() !== new Date(challenge.expiresAt).getTime()
      || stored.issued_at.getTime() > now.getTime() || stored.expires_at.getTime() <= now.getTime()) {
      invalid(purpose === "claim" ? "CLAIM_CHALLENGE_INVALID" : "CLAIM_RECOVERY_INVALID");
    }
  }

  private async consumeChallenge(client: SqlClient, challenge: ChallengeRow, claimId: string, now: Date): Promise<void> {
    await this.insertTombstone(
      client,
      "claim-challenge",
      `challenge:${Buffer.from(challenge.challenge_hash).toString("base64url")}`,
      now,
    );
    await this.insertTombstone(
      client,
      "claim-challenge",
      this.challengeNonceReplayKey(challenge.nonce_digest),
      now,
    );
    const result = await client.query(
      `UPDATE samurai_persistence.claim_challenges
          SET consumed_at = $2, consumed_claim_id = $3::uuid, guest_session_id = NULL
        WHERE challenge_id = $1::uuid AND consumed_at IS NULL AND expires_at > $2`,
      [challenge.challenge_id, now, claimId],
    );
    if (result.rowCount !== 1) invalid("CLAIM_CHALLENGE_INVALID");
  }

  private async assertChallengeNotTombstoned(client: SqlClient, challengeHash: Uint8Array, now: Date): Promise<void> {
    const replayKey = `challenge:${Buffer.from(challengeHash).toString("base64url")}`;
    for (const candidate of this.authority.persistence.tombstoneKeys.replayCandidates("claim-challenge", replayKey, now)) {
      const result = await client.query<{ readonly found: number }>(
        `SELECT 1 AS found FROM samurai_persistence.deletion_tombstones
          WHERE kind = 'claim-challenge' AND digest_key_version = $1
            AND digest_key_identity = $2 AND tombstone_digest = $3 AND expires_at > $4 LIMIT 1`,
        [candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest, now],
      );
      if (result.rows[0]) invalid("CLAIM_CHALLENGE_REPLAY");
    }
  }

  private challengeNonceReplayKey(nonceDigest: Uint8Array): string {
    return `challenge-nonce:${Buffer.from(nonceDigest).toString("base64url")}`;
  }

  private async assertChallengeNonceNotTombstoned(
    client: SqlClient,
    nonceDigest: Uint8Array,
    now: Date,
  ): Promise<void> {
    const replayKey = this.challengeNonceReplayKey(nonceDigest);
    for (const candidate of this.authority.persistence.tombstoneKeys.replayCandidates("claim-challenge", replayKey, now)) {
      const result = await client.query<{ readonly found: number }>(
        `SELECT 1 AS found FROM samurai_persistence.deletion_tombstones
          WHERE kind = 'claim-challenge' AND digest_key_version = $1
            AND digest_key_identity = $2 AND tombstone_digest = $3 AND expires_at > $4 LIMIT 1`,
        [candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest, now],
      );
      if (result.rows[0]) invalid("CLAIM_CHALLENGE_REPLAY");
    }
  }

  private async assertClaimIdentifiersNotTombstoned(
    client: SqlClient,
    claimId: string,
    idempotencyKey: string,
    now: Date,
  ): Promise<void> {
    for (const [kind, replayKey] of [
      ["claim-id", `claim:${claimId}`],
      ["claim-idempotency", `claim-idempotency:${idempotencyKey}`],
    ] as const) {
      for (const candidate of this.authority.persistence.tombstoneKeys.replayCandidates(kind, replayKey, now)) {
        const result = await client.query<{ readonly found: number }>(
          `SELECT 1 AS found FROM samurai_persistence.deletion_tombstones
            WHERE kind = $1 AND digest_key_version = $2
              AND digest_key_identity = $3 AND tombstone_digest = $4 AND expires_at > $5 LIMIT 1`,
          [kind, candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest, now],
        );
        if (result.rows[0]) invalid("CLAIM_REPLAY");
      }
    }
  }

  private async lockWallet(client: SqlClient, chainId: string, account: string): Promise<WalletRow | null> {
    const result = await client.query<WalletRow>(
      `SELECT credential_id::text, player_id, chain_id, account, public_key, scheme, linked_claim_id::text
         FROM samurai_persistence.wallet_credentials
        WHERE chain_id = $1 AND account = $2 FOR UPDATE`,
      [chainId, account],
    );
    return result.rows[0] ?? null;
  }

  private async assertWalletNotTombstoned(
    client: SqlClient,
    chainId: string,
    account: string,
    now: Date,
  ): Promise<void> {
    const replayKey = `wallet:${chainId}:${account}`;
    for (const candidate of this.authority.persistence.tombstoneKeys.replayCandidates("wallet-credential", replayKey, now)) {
      const result = await client.query<{ readonly found: number }>(
        `SELECT 1 AS found FROM samurai_persistence.deletion_tombstones
          WHERE kind = 'wallet-credential' AND digest_key_version = $1
            AND digest_key_identity = $2 AND tombstone_digest = $3 AND expires_at > $4 LIMIT 1`,
        [candidate.keyVersion, keyIdentityBytes(candidate.keyIdentity), candidate.digest, now],
      );
      if (result.rows[0]) invalid("CLAIM_WALLET_CONFLICT");
    }
  }

  private async resolveWallet(client: SqlClient, chainId: string, account: string): Promise<WalletRow | null> {
    const result = await client.query<WalletRow>(
      `SELECT credential_id::text, player_id, chain_id, account, public_key, scheme, linked_claim_id::text
         FROM samurai_persistence.wallet_credentials WHERE chain_id = $1 AND account = $2`,
      [chainId, account],
    );
    return result.rows[0] ?? null;
  }

  private async lockPlayerProgress(client: SqlClient, playerId: string): Promise<PlayerProgressRow | null> {
    const result = await client.query<PlayerProgressRow>(
      `SELECT player_id, revision::text, content_version, checkpoint_schema_version,
              checkpoint, created_at, updated_at
         FROM samurai_persistence.player_progress WHERE player_id = $1 FOR UPDATE`,
      [playerId],
    );
    return result.rows[0] ?? null;
  }

  private async lockScopes(client: SqlClient, scopes: readonly string[]): Promise<void> {
    for (const scope of [...scopes].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [scope]);
    }
  }

  private async lockGuestOwnedRows(client: SqlClient, guestId: string): Promise<void> {
    for (const table of [
      "guest_claim_capabilities", "guest_progress", "command_receipts", "domain_events",
      "save_exports", "recovery_imports", "guest_resume_digests",
    ]) {
      await client.query(`SELECT 1 FROM samurai_persistence.${table} WHERE guest_session_id = $1 FOR UPDATE`, [guestId]);
    }
  }

  private async lockChallengesForRemovalByClaimId(
    client: SqlClient,
    claimId: string,
  ): Promise<readonly ChallengeReplayRow[]> {
    await this.lockScopes(client, [`challenge-claim:${claimId}`]);
    const candidates = await client.query<ChallengeReplayRow>(
      `SELECT challenge_id::text, challenge_hash, nonce_digest, expires_at
         FROM samurai_persistence.claim_challenges WHERE claim_id = $1::uuid ORDER BY challenge_id`,
      [claimId],
    );
    await this.lockScopes(client, candidates.rows.map((row) => (
      `challenge-nonce:${Buffer.from(row.nonce_digest).toString("base64url")}`
    )));
    const locked = await client.query<ChallengeReplayRow>(
      `SELECT challenge_id::text, challenge_hash, nonce_digest, expires_at
         FROM samurai_persistence.claim_challenges
        WHERE claim_id = $1::uuid ORDER BY challenge_id FOR UPDATE`,
      [claimId],
    );
    return locked.rows;
  }

  private async lockChallengesForRemovalByGuestId(
    client: SqlClient,
    guestId: string,
  ): Promise<readonly ChallengeReplayRow[]> {
    const candidates = await client.query<ChallengeReplayRow>(
      `SELECT challenge_id::text, challenge_hash, nonce_digest, expires_at
         FROM samurai_persistence.claim_challenges WHERE guest_session_id = $1 ORDER BY challenge_id`,
      [guestId],
    );
    await this.lockScopes(client, candidates.rows.map((row) => (
      `challenge-nonce:${Buffer.from(row.nonce_digest).toString("base64url")}`
    )));
    const locked = await client.query<ChallengeReplayRow>(
      `SELECT challenge_id::text, challenge_hash, nonce_digest, expires_at
         FROM samurai_persistence.claim_challenges
        WHERE guest_session_id = $1 ORDER BY challenge_id FOR UPDATE`,
      [guestId],
    );
    return locked.rows;
  }

  private async rewriteGuestRows(client: SqlClient, guestId: string, playerId: string, claimId: string): Promise<void> {
    await client.query(
      `UPDATE samurai_persistence.command_receipts
          SET player_id = $2, guest_session_id = NULL, origin_claim_id = $3::uuid
        WHERE guest_session_id = $1`,
      [guestId, playerId, claimId],
    );
    await client.query(
      `UPDATE samurai_persistence.domain_events
          SET player_id = $2, guest_session_id = NULL, origin_claim_id = $3::uuid
        WHERE guest_session_id = $1`,
      [guestId, playerId, claimId],
    );
  }

  private async revokeGuestPrivateRows(
    client: SqlClient,
    guestId: string,
    intent: ClaimIntentV1,
    now: Date,
    siblings: readonly ChallengeReplayRow[],
  ): Promise<void> {
    const resumes = await client.query<SessionDigestRow>(
      "SELECT digest_key_version, digest_key_identity, digest FROM samurai_persistence.guest_resume_digests WHERE guest_session_id = $1",
      [guestId],
    );
    const capability = await client.query<SessionDigestRow>(
      "SELECT digest_key_version, digest_key_identity, digest FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1",
      [guestId],
    );
    const exports = await client.query<{ readonly export_id: string }>(
      "SELECT export_id::text FROM samurai_persistence.save_exports WHERE guest_session_id = $1",
      [guestId],
    );
    const imports = await client.query<{ readonly import_id: string }>(
      "SELECT import_id::text FROM samurai_persistence.recovery_imports WHERE guest_session_id = $1",
      [guestId],
    );
    for (const row of resumes.rows) {
      await this.insertTombstone(client, "guest-session", `resume:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`, now,
        "resume", row.digest_key_version, row.digest_key_identity);
    }
    for (const row of capability.rows) {
      await this.insertTombstone(client, "guest-claim", `guest-claim:v${row.digest_key_version}:${Buffer.from(row.digest).toString("base64url")}`, now,
        "guest-claim", row.digest_key_version, row.digest_key_identity);
    }
    for (const row of exports.rows) await this.insertTombstone(client, "save-export", `export:${row.export_id}`, now);
    for (const row of imports.rows) await this.insertTombstone(client, "save-import", `import:${row.import_id}`, now);
    for (const row of siblings) {
      await this.insertTombstone(client, "claim-challenge", `challenge:${Buffer.from(row.challenge_hash).toString("base64url")}`, now);
      await this.insertTombstone(client, "claim-challenge", this.challengeNonceReplayKey(row.nonce_digest), now);
    }
    await this.insertTombstone(client, "claim-id", `claim:${intent.claimId}`, now);
    await this.insertTombstone(client, "claim-idempotency", `claim-idempotency:${intent.idempotencyKey}`, now);
    await client.query("DELETE FROM samurai_persistence.claim_challenges WHERE guest_session_id = $1", [guestId]);
    await client.query("DELETE FROM samurai_persistence.save_exports WHERE guest_session_id = $1", [guestId]);
    await client.query("DELETE FROM samurai_persistence.recovery_imports WHERE guest_session_id = $1", [guestId]);
    await client.query("DELETE FROM samurai_persistence.guest_claim_capabilities WHERE guest_session_id = $1", [guestId]);
  }

  private async insertTombstone(
    client: SqlClient,
    kind: TombstoneKind,
    replayKey: string,
    now: Date,
    capabilityPurpose?: "resume" | CapabilityPurpose,
    capabilityVersion?: number,
    capabilityIdentity?: Uint8Array,
  ): Promise<void> {
    const digest = this.authority.persistence.tombstoneKeys.digest(kind, replayKey, now);
    await client.query(
      `INSERT INTO samurai_persistence.deletion_tombstones
        (kind, digest_key_version, digest_key_identity, tombstone_digest,
         resume_digest_key_version, resume_digest_key_identity,
         capability_key_purpose, capability_key_version, capability_key_identity,
         created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (kind, digest_key_version, digest_key_identity, tombstone_digest)
       DO UPDATE SET expires_at = GREATEST(samurai_persistence.deletion_tombstones.expires_at, EXCLUDED.expires_at)`,
      [kind, digest.keyVersion, keyIdentityBytes(digest.keyIdentity), digest.digest,
        capabilityPurpose === "resume" ? (capabilityVersion ?? null) : null,
        capabilityPurpose === "resume" ? (capabilityIdentity ?? null) : null,
        capabilityPurpose === "guest-claim" || capabilityPurpose === "player-session" ? capabilityPurpose : null,
        capabilityPurpose === "guest-claim" || capabilityPurpose === "player-session" ? (capabilityVersion ?? null) : null,
        capabilityPurpose === "guest-claim" || capabilityPurpose === "player-session" ? (capabilityIdentity ?? null) : null,
        now, addMilliseconds(now, RECEIPT_LIFETIME_MS)],
    );
  }
}
