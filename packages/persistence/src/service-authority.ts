import { createHash, timingSafeEqual } from "node:crypto";
import {
  FIRST_EVENING_CONTENT_VERSION,
  createInitialEveningServiceCheckpoint,
  decodeEveningServiceCheckpoint,
  rebaseEveningServiceCheckpointForClaim,
  reduceEveningService,
  type EveningServiceCheckpoint,
  type EveningServiceResponse,
} from "@samurai-sushi/domain/evening-service";
import {
  canonicalJson,
  createCommandEnvelope,
  type CommandEnvelope,
  type IdempotencyKey,
  type JsonObject,
  type SubjectRef,
} from "@samurai-sushi/domain";
import type { AccountClaimService, AccountClaimServiceOptions } from "./account-claim";
import { hashPersistenceResponse } from "./canonical-decision";
import { constantTimeDigestEqual, GuestSecretFormatError } from "./crypto";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import {
  CommandAuthenticationError,
  GuestRotationRequiredError,
  IdempotencyPayloadMismatchError,
  IdempotencyReceiptExpiredError,
  PersistenceError,
  RevisionConflictError,
} from "./errors";
import type { PersistenceAuthority } from "./key-inventory";
import { addMilliseconds, ADR_0003_PERSISTENCE_LIFECYCLE } from "./lifecycle";
import { GuestSessionRepository } from "./repositories";

const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;
const EVENT_ID_DOMAIN = "samurai-sushi:evening-service-event:v1\n";

export type ServiceSubjectCredential =
  | { readonly kind: "guest"; readonly resumeSecret: string }
  | { readonly kind: "player"; readonly sessionSecret: string };

export interface EveningServiceCommandInput {
  readonly idempotencyKey: string;
  readonly expectedRevision: number;
  readonly commandName: string;
  readonly payload: JsonObject;
}

export interface EveningServiceQueryResult {
  readonly checkpoint: EveningServiceCheckpoint;
  readonly revision: number;
  readonly contentVersion: typeof FIRST_EVENING_CONTENT_VERSION;
}

export interface EveningServiceExecutionResult {
  readonly disposition: "committed" | "replayed";
  readonly checkpointAdvanced: boolean;
  readonly responseSchemaVersion: 1;
  readonly response: EveningServiceResponse;
  readonly resultHash: `sha256:${string}`;
  readonly committedRevision: number;
}

export type EveningServiceWriteBoundary = "checkpoint" | "settlement-unlock" | "event" | "outbox" | "receipt";

export interface EveningServiceAuthorityOptions {
  readonly afterWriteBoundary?: (boundary: EveningServiceWriteBoundary) => void | Promise<void>;
}

export const mergeFirstEveningCheckpointForClaim: NonNullable<AccountClaimServiceOptions["mergeCheckpoint"]> = (guest, player, intent) => {
  if (guest.contentVersion !== FIRST_EVENING_CONTENT_VERSION) return guest.checkpoint;
  const committedRevision = intent.createPlayer ? guest.revision : intent.playerRevision + 1;
  let playerCheckpoint: EveningServiceCheckpoint | null = null;
  if (player?.content_version === FIRST_EVENING_CONTENT_VERSION) {
    const playerRevision = Number(player.revision);
    const decodedPlayerCheckpoint = decodeEveningServiceCheckpoint(player.checkpoint);
    if (!Number.isSafeInteger(playerRevision) || playerRevision < 0 || decodedPlayerCheckpoint.revision !== playerRevision) {
      throw new PersistenceError("SERVICE_REVISION_INVALID", "The target player checkpoint revision does not match canonical progress.");
    }
    playerCheckpoint = decodedPlayerCheckpoint;
  }
  return rebaseEveningServiceCheckpointForClaim(guest.checkpoint, playerCheckpoint, committedRevision) as Readonly<Record<string, unknown>>;
};

interface ProgressRow {
  readonly revision: string;
  readonly content_version: string;
  readonly checkpoint_schema_version: number;
  readonly checkpoint: unknown;
}

interface ReceiptRow {
  readonly command_name: string;
  readonly expected_revision: string;
  readonly content_version: string;
  readonly payload_hash: Uint8Array;
  readonly response_schema_version: number;
  readonly response_payload: unknown;
  readonly result_hash: Uint8Array;
  readonly committed_revision: string;
  readonly checkpoint_advanced: boolean;
  readonly expires_at: Date;
}

interface AuthenticatedSubject {
  readonly subject: SubjectRef;
  readonly subjectKind: "guest" | "player";
  readonly subjectId: string;
  readonly playerSessionId: string | null;
  readonly playerSessionDeliveryGeneration: number | null;
  revalidate(client: SqlClient): Promise<Date>;
}

export interface SettledServiceTransactionContext {
  readonly client: SqlClient;
  readonly subjectKind: "guest" | "player";
  readonly subjectId: string;
  readonly playerSessionId: string | null;
  readonly playerSessionDeliveryGeneration: number | null;
  readonly checkpoint: EveningServiceCheckpoint;
  readonly now: Date;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function exactObject(value: unknown, expected: readonly string[], path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new PersistenceError("SERVICE_REQUEST_INVALID", `${path} must be a plain object.`);
  }
  const row = value as Record<string, unknown>;
  const actual = Object.keys(row).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new PersistenceError("SERVICE_REQUEST_INVALID", `${path} has an unexpected shape.`);
  }
  return row;
}

function assertBoundedCommandInput(input: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: input, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (++nodes > 2_048 || depth > 32) throw new PersistenceError("SERVICE_REQUEST_INVALID", "The service command exceeds structural bounds.");
    if (typeof value === "string" && value.length > 4_096) throw new PersistenceError("SERVICE_REQUEST_INVALID", "The service command contains an oversized string.");
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) throw new PersistenceError("SERVICE_REQUEST_INVALID", "The service command contains an object alias or cycle.");
    seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 256) throw new PersistenceError("SERVICE_REQUEST_INVALID", "The service command contains an oversized array.");
      for (const child of value) stack.push({ value: child, depth: depth + 1 });
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new PersistenceError("SERVICE_REQUEST_INVALID", "The service command must contain only plain objects.");
      }
      const entries = Object.entries(value);
      if (entries.length > 64) throw new PersistenceError("SERVICE_REQUEST_INVALID", "The service command contains an oversized object.");
      for (const [, child] of entries) stack.push({ value: child, depth: depth + 1 });
    }
  }
}

function parseCommandInput(input: unknown): EveningServiceCommandInput {
  assertBoundedCommandInput(input);
  const canonical = canonicalJson(input);
  if (Buffer.byteLength(canonical, "utf8") > 64 * 1024) throw new PersistenceError("SERVICE_REQUEST_INVALID", "The service command is too large.");
  const row = exactObject(JSON.parse(canonical), ["commandName", "expectedRevision", "idempotencyKey", "payload"], "$command");
  if (typeof row.commandName !== "string" || typeof row.idempotencyKey !== "string"
    || !Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 0
    || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) {
    throw new PersistenceError("SERVICE_REQUEST_INVALID", "The service command is invalid.");
  }
  return deepFreeze({
    commandName: row.commandName,
    idempotencyKey: row.idempotencyKey,
    expectedRevision: row.expectedRevision as number,
    payload: row.payload as JsonObject,
  });
}

function digestBytes(hash: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) throw new PersistenceError("INVALID_DIGEST", "The canonical digest is invalid.");
  return Buffer.from(hash.slice(7), "hex");
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === 32 && right.byteLength === 32 && timingSafeEqual(left, right);
}

function serviceEventId(subjectKind: "guest" | "player", subjectId: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(EVENT_ID_DOMAIN).update(subjectKind).update("\0").update(subjectId).update("\0").update(idempotencyKey).digest("hex");
  return `service:${digest}`;
}

export class EveningServiceAuthority {
  readonly #runner: TransactionRunner;
  readonly #guests = new GuestSessionRepository();

  constructor(
    pool: SqlPool,
    readonly persistence: PersistenceAuthority,
    readonly accounts: AccountClaimService,
    readonly options: EveningServiceAuthorityOptions = {},
  ) {
    this.#runner = new TransactionRunner(pool);
  }

  async #authenticateGuest(client: SqlClient, resumeSecret: string): Promise<AuthenticatedSubject> {
    const initialNow = await this.persistence.assertTransactionReady(client);
    let candidates;
    try {
      candidates = this.persistence.resumeKeys.candidates(resumeSecret, initialNow);
      await this.persistence.assertGuestSecretNotTombstoned(client, resumeSecret, initialNow);
    } catch (error) {
      if (error instanceof GuestSecretFormatError || (error instanceof PersistenceError && error.code === "GUEST_SECRET_TOMBSTONED")) throw new CommandAuthenticationError();
      throw error;
    }
    const preliminary = await this.#guests.findResumeMatchUnlocked(client, candidates);
    if (!preliminary) throw new CommandAuthenticationError();
    const parent = await this.#guests.lockById(client, preliminary.id);
    const digests = await this.#guests.resumeDigests(client, preliminary.id, true);
    if (!parent) throw new CommandAuthenticationError();

    const revalidate = async (revalidationClient: SqlClient): Promise<Date> => {
      const now = await this.persistence.assertTransactionReady(revalidationClient);
      let fresh;
      try {
        fresh = this.persistence.resumeKeys.candidates(resumeSecret, now);
        await this.persistence.assertGuestSecretNotTombstoned(revalidationClient, resumeSecret, now);
      } catch (error) {
        if (error instanceof GuestSecretFormatError || (error instanceof PersistenceError && error.code === "GUEST_SECRET_TOMBSTONED")) throw new CommandAuthenticationError();
        throw error;
      }
      const stored = digests.find((row) => row.slot === preliminary.slot
        && row.digest_key_version === preliminary.digestKeyVersion
        && `sha256:${Buffer.from(row.digest_key_identity).toString("hex")}` === preliminary.digestKeyIdentity
        && constantTimeDigestEqual(row.digest, preliminary.digest));
      const candidate = fresh.find((row) => row.keyVersion === preliminary.digestKeyVersion && row.keyIdentity === preliminary.digestKeyIdentity);
      if (!stored || !candidate || !constantTimeDigestEqual(candidate.digest, preliminary.digest)
        || parent.expiresAt.getTime() <= now.getTime()
        || (preliminary.slot === "predecessor" && (!preliminary.digestValidUntil || preliminary.digestValidUntil.getTime() <= now.getTime()))) {
        throw new CommandAuthenticationError();
      }
      if (parent.rotateAfter.getTime() <= now.getTime()
        || (preliminary.slot === "current" && preliminary.digestKeyVersion !== this.persistence.resumeKeys.active.version)) {
        throw new GuestRotationRequiredError();
      }
      return now;
    };
    await revalidate(client);
    return {
      subject: { kind: "guest", guestSessionId: preliminary.id },
      subjectKind: "guest",
      subjectId: preliminary.id,
      playerSessionId: null,
      playerSessionDeliveryGeneration: null,
      revalidate,
    };
  }

  async #authenticatePlayer(client: SqlClient, sessionSecret: string): Promise<AuthenticatedSubject> {
    const isPlayerAuthenticationFailure = (error: unknown): boolean => Boolean(error && typeof error === "object"
      && ["PLAYER_SESSION_INVALID", "PLAYER_SESSION_REPLAY"].includes(String((error as { readonly code?: unknown }).code)));
    let initial;
    try {
      initial = await this.accounts.lockActivePlayerSessionForService(client, sessionSecret);
    } catch (error) {
      if (isPlayerAuthenticationFailure(error)) throw new CommandAuthenticationError();
      throw error;
    }
    return {
      subject: { kind: "player", playerId: initial.playerId },
      subjectKind: "player",
      subjectId: initial.playerId,
      playerSessionId: initial.sessionId,
      playerSessionDeliveryGeneration: initial.deliveryGeneration,
      revalidate: async (revalidationClient) => {
        let fresh;
        try {
          fresh = await this.accounts.lockActivePlayerSessionForService(revalidationClient, sessionSecret);
        } catch (error) {
          if (isPlayerAuthenticationFailure(error)) throw new CommandAuthenticationError();
          throw error;
        }
        if (fresh.playerId !== initial.playerId || fresh.sessionId !== initial.sessionId
          || fresh.deliveryGeneration !== initial.deliveryGeneration) throw new CommandAuthenticationError();
        return fresh.now;
      },
    };
  }

  async #authenticate(client: SqlClient, credential: ServiceSubjectCredential): Promise<AuthenticatedSubject> {
    if (credential.kind === "guest") return this.#authenticateGuest(client, credential.resumeSecret);
    if (credential.kind === "player") return this.#authenticatePlayer(client, credential.sessionSecret);
    throw new CommandAuthenticationError();
  }

  async query(credential: ServiceSubjectCredential): Promise<EveningServiceQueryResult> {
    return this.#runner.run(async (client) => {
      const authenticated = await this.#authenticate(client, credential);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`service-subject:${authenticated.subjectKind}:${authenticated.subjectId}`]);
      const progress = await this.#lockProgress(client, authenticated);
      const now = await authenticated.revalidate(client);
      if (authenticated.subjectKind === "guest") await this.#guests.touch(client, authenticated.subjectId, now);
      const checkpoint = this.#checkpointFromProgress(progress);
      return { checkpoint, revision: checkpoint.revision, contentVersion: FIRST_EVENING_CONTENT_VERSION };
    });
  }

  /** Server-only composition seam for post-SETTLED authorities that must share the subject/progress lock. */
  async runSettledTransaction<T>(
    credential: ServiceSubjectCredential,
    idempotencyScope: string,
    operation: (context: SettledServiceTransactionContext) => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyScope)) {
      throw new PersistenceError("SERVICE_REQUEST_INVALID", "The settled transaction idempotency scope is invalid.");
    }
    return this.#runner.run(async (client) => {
      const authenticated = await this.#authenticate(client, credential);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `settled-authority:${authenticated.subjectKind}:${authenticated.subjectId}:${idempotencyScope}`,
      ]);
      const progress = await this.#lockProgress(client, authenticated);
      const checkpoint = this.#checkpointFromProgress(progress);
      if (checkpoint.phase !== "SETTLED") {
        throw new PersistenceError("SERVICE_NOT_SETTLED", "Receipt intent preparation requires the exact settled checkpoint.");
      }
      const now = await authenticated.revalidate(client);
      if (authenticated.subjectKind === "guest") await this.#guests.touch(client, authenticated.subjectId, now);
      return operation({
        client,
        subjectKind: authenticated.subjectKind,
        subjectId: authenticated.subjectId,
        playerSessionId: authenticated.playerSessionId,
        playerSessionDeliveryGeneration: authenticated.playerSessionDeliveryGeneration,
        checkpoint,
        now,
      });
    });
  }

  async execute(credential: ServiceSubjectCredential, input: unknown): Promise<EveningServiceExecutionResult> {
    const request = parseCommandInput(input);
    if (request.expectedRevision === MAX_SAFE_REVISION) throw new RevisionConflictError(request.expectedRevision, request.expectedRevision);
    return this.#runner.run(async (client) => {
      const authenticated = await this.#authenticate(client, credential);
      const command = createCommandEnvelope({
        schemaVersion: 1,
        subject: authenticated.subject,
        idempotencyKey: request.idempotencyKey as IdempotencyKey,
        expectedRevision: request.expectedRevision,
        contentVersion: FIRST_EVENING_CONTENT_VERSION,
        commandName: request.commandName,
        payload: request.payload,
      }) as CommandEnvelope<JsonObject>;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `service-command:${authenticated.subjectKind}:${authenticated.subjectId}:${command.idempotencyKey}`,
      ]);
      const receipt = await this.#receipt(client, authenticated, command.idempotencyKey);
      const replayNow = await authenticated.revalidate(client);
      if (receipt) return this.#replay(receipt, command, replayNow);

      const progress = await this.#lockProgress(client, authenticated);
      if (Number(progress.revision) !== command.expectedRevision) throw new RevisionConflictError(command.expectedRevision, Number(progress.revision));
      const checkpoint = this.#checkpointFromProgress(progress);
      const decision = reduceEveningService(checkpoint, command);
      const checkpointAdvanced = decision.response.payload.accepted;
      const committedRevision = checkpointAdvanced ? command.expectedRevision + 1 : command.expectedRevision;
      if (decision.checkpoint.revision !== committedRevision) throw new PersistenceError("SERVICE_DECISION_REVISION_INVALID", "The reducer produced an invalid revision transition.");
      const writeNow = await authenticated.revalidate(client);
      if (authenticated.subjectKind === "guest") await this.#guests.touch(client, authenticated.subjectId, writeNow);

      if (checkpointAdvanced) {
        await this.#updateProgress(client, authenticated, command.expectedRevision, decision.checkpoint, writeNow);
        await this.options.afterWriteBoundary?.("checkpoint");
        if (decision.response.payload.settledNow) await this.options.afterWriteBoundary?.("settlement-unlock");
        const eventId = serviceEventId(authenticated.subjectKind, authenticated.subjectId, command.idempotencyKey);
        await client.query(
          `INSERT INTO samurai_persistence.domain_events
            (event_id, guest_session_id, player_id, event_type, schema_version, payload, committed_revision, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
          [eventId, authenticated.subjectKind === "guest" ? authenticated.subjectId : null,
            authenticated.subjectKind === "player" ? authenticated.subjectId : null,
            decision.event.eventType, decision.event.schemaVersion, JSON.stringify(decision.event.payload), committedRevision, writeNow],
        );
        await this.options.afterWriteBoundary?.("event");
        await client.query(
          `INSERT INTO samurai_persistence.outbox_deliveries (event_id, state, attempt_count, available_at)
           VALUES ($1, 'pending', 0, $2)`,
          [eventId, writeNow],
        );
        await this.options.afterWriteBoundary?.("outbox");
      }

      const resultHash = hashPersistenceResponse(1, decision.response.payload);
      await client.query(
        `INSERT INTO samurai_persistence.command_receipts
          (guest_session_id, player_id, idempotency_key, command_name, expected_revision, content_version, payload_hash,
           response_schema_version, response_payload, result_hash, committed_revision, checkpoint_advanced, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8::jsonb, $9, $10, $11, $12, $13)`,
        [authenticated.subjectKind === "guest" ? authenticated.subjectId : null,
          authenticated.subjectKind === "player" ? authenticated.subjectId : null,
          command.idempotencyKey, command.commandName, command.expectedRevision, command.contentVersion,
          digestBytes(command.payloadHash), JSON.stringify(decision.response.payload), digestBytes(resultHash), committedRevision,
          checkpointAdvanced, writeNow, addMilliseconds(writeNow, ADR_0003_PERSISTENCE_LIFECYCLE.receiptLifetimeMs)],
      );
      await this.options.afterWriteBoundary?.("receipt");
      return deepFreeze({
        disposition: "committed",
        checkpointAdvanced,
        responseSchemaVersion: 1,
        response: decision.response.payload,
        resultHash,
        committedRevision,
      });
    });
  }

  async #receipt(client: SqlClient, authenticated: AuthenticatedSubject, idempotencyKey: string): Promise<ReceiptRow | undefined> {
    const result = await client.query<ReceiptRow>(
      `SELECT command_name, expected_revision, content_version, payload_hash, response_schema_version,
              response_payload, result_hash, committed_revision, checkpoint_advanced, expires_at
         FROM samurai_persistence.command_receipts
        WHERE subject_kind = $1 AND subject_id = $2 AND idempotency_key = $3`,
      [authenticated.subjectKind, authenticated.subjectId, idempotencyKey],
    );
    return result.rows[0];
  }

  #replay(receipt: ReceiptRow, command: CommandEnvelope<JsonObject>, now: Date): EveningServiceExecutionResult {
    if (receipt.command_name !== command.commandName || Number(receipt.expected_revision) !== command.expectedRevision
      || receipt.content_version !== command.contentVersion || !sameDigest(receipt.payload_hash, digestBytes(command.payloadHash))) {
      throw new IdempotencyPayloadMismatchError();
    }
    if (receipt.expires_at.getTime() <= now.getTime()) throw new IdempotencyReceiptExpiredError();
    const response = deepFreeze(JSON.parse(canonicalJson(receipt.response_payload)) as EveningServiceResponse);
    const resultHash = hashPersistenceResponse(receipt.response_schema_version, response);
    if (receipt.response_schema_version !== 1 || !sameDigest(receipt.result_hash, digestBytes(resultHash))) {
      throw new PersistenceError("RECEIPT_INTEGRITY_FAILURE", "The stored service response failed its canonical result hash.");
    }
    return deepFreeze({
      disposition: "replayed",
      checkpointAdvanced: receipt.checkpoint_advanced,
      responseSchemaVersion: 1,
      response,
      resultHash,
      committedRevision: Number(receipt.committed_revision),
    });
  }

  async #lockProgress(client: SqlClient, authenticated: AuthenticatedSubject): Promise<ProgressRow> {
    const idColumn = authenticated.subjectKind === "guest" ? "guest_session_id" : "player_id";
    const table = authenticated.subjectKind === "guest" ? "guest_progress" : "player_progress";
    const result = await client.query<ProgressRow>(
      `SELECT revision, content_version, checkpoint_schema_version, checkpoint
         FROM samurai_persistence.${table} WHERE ${idColumn} = $1 FOR UPDATE`,
      [authenticated.subjectId],
    );
    const progress = result.rows[0];
    if (!progress) throw new PersistenceError("SERVICE_PROGRESS_NOT_FOUND", "The canonical subject progress does not exist.");
    return progress;
  }

  #checkpointFromProgress(progress: ProgressRow): EveningServiceCheckpoint {
    const revision = Number(progress.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) throw new PersistenceError("SERVICE_REVISION_INVALID", "The canonical revision is not a safe integer.");
    if (progress.content_version === FIRST_EVENING_CONTENT_VERSION) {
      const checkpoint = decodeEveningServiceCheckpoint(progress.checkpoint);
      if (checkpoint.revision !== revision) throw new PersistenceError("SERVICE_REVISION_INVALID", "The checkpoint revision does not match canonical progress.");
      return checkpoint;
    }
    if (revision === 0) return createInitialEveningServiceCheckpoint();
    throw new PersistenceError("SERVICE_CONTENT_CONFLICT", "Existing canonical progress belongs to another content authority.");
  }

  async #updateProgress(
    client: SqlClient,
    authenticated: AuthenticatedSubject,
    expectedRevision: number,
    checkpoint: EveningServiceCheckpoint,
    now: Date,
  ): Promise<void> {
    const idColumn = authenticated.subjectKind === "guest" ? "guest_session_id" : "player_id";
    const table = authenticated.subjectKind === "guest" ? "guest_progress" : "player_progress";
    const result = await client.query<{ readonly revision: string }>(
      `UPDATE samurai_persistence.${table}
          SET revision = $3, content_version = $4, checkpoint_schema_version = $5,
              checkpoint = $6::jsonb, updated_at = $7
        WHERE ${idColumn} = $1 AND revision = $2
        RETURNING revision`,
      [authenticated.subjectId, expectedRevision, checkpoint.revision, FIRST_EVENING_CONTENT_VERSION, checkpoint.schemaVersion, JSON.stringify(checkpoint), now],
    );
    if (result.rowCount !== 1) {
      const latest = await this.#lockProgress(client, authenticated);
      throw new RevisionConflictError(expectedRevision, Number(latest.revision));
    }
  }
}

export const eveningServiceEventIdDomain = EVENT_ID_DOMAIN;
