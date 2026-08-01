import { timingSafeEqual } from "node:crypto";
import { canonicalJson, subjectIdentity, validateCommandEnvelope } from "@samurai-sushi/domain";
import type { JsonObject, JsonValue } from "@samurai-sushi/domain";
import { canonicalizeDecision, hashPersistenceResponse } from "./canonical-decision";
import { constantTimeDigestEqual, GuestSecretFormatError } from "./crypto";
import type { SqlPool } from "./database";
import { TransactionRunner } from "./database";
import type {
  PersistenceCommandEnvelope,
  PersistenceCommandHandler,
} from "./domain-adapter";
import {
  CommandAuthenticationError,
  IdempotencyPayloadMismatchError,
  IdempotencyReceiptExpiredError,
  GuestRotationRequiredError,
  PersistenceError,
  RevisionConflictError,
} from "./errors";
import { addMilliseconds, ADR_0003_PERSISTENCE_LIFECYCLE } from "./lifecycle";
import type { PersistenceAuthority } from "./key-inventory";
import { GuestProgressRepository, GuestSessionRepository } from "./repositories";

interface ReceiptRow {
  readonly command_name: string;
  readonly expected_revision: string;
  readonly content_version: string;
  readonly payload_hash: Uint8Array;
  readonly response_schema_version: number;
  readonly response_payload: unknown;
  readonly result_hash: Uint8Array;
  readonly committed_revision: string;
  readonly expires_at: Date;
}

interface RevisionRow {
  readonly revision: string;
}

export interface CommandExecutionResult<ResponsePayload> {
  readonly disposition: "committed" | "replayed";
  readonly responseSchemaVersion: number;
  readonly response: ResponsePayload;
  readonly resultHash: `sha256:${string}`;
  readonly committedRevision: number;
}

function digestFromDomainHash(value: string, field: string): Uint8Array {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new PersistenceError("INVALID_DIGEST", `${field} must use lowercase sha256:<hex> form.`);
  }
  return Buffer.from(value.slice("sha256:".length), "hex");
}

function sameDigest(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === 32 && right.byteLength === 32 && timingSafeEqual(left, right);
}

export class GuestCommandExecutor {
  private readonly runner: TransactionRunner;
  private readonly progress = new GuestProgressRepository();
  private readonly sessions = new GuestSessionRepository();

  constructor(
    pool: SqlPool,
    private readonly authority: PersistenceAuthority,
  ) {
    this.runner = new TransactionRunner(pool);
  }

  async execute<
    Payload extends JsonValue,
    Checkpoint extends JsonObject,
    ResponsePayload extends JsonValue,
  >(
    resumeSecret: string,
    commandInput: unknown,
    handler: PersistenceCommandHandler<Payload, Checkpoint, ResponsePayload>,
  ): Promise<CommandExecutionResult<ResponsePayload>> {
    let command: PersistenceCommandEnvelope<Payload>;
    try {
      assertBoundedUnauthenticatedCommand(commandInput);
      const serialized = canonicalJson(commandInput);
      if (Buffer.byteLength(serialized, "utf8") > MAX_COMMAND_BYTES) throw new CommandBoundsError();
      const detached = JSON.parse(serialized) as unknown;
      command = deepFreeze(validateCommandEnvelope(detached)) as PersistenceCommandEnvelope<Payload>;
    } catch (error) {
      if (error instanceof GuestSecretFormatError) throw new CommandAuthenticationError();
      throw error;
    }
    if (command.subject.kind !== "guest") throw new PersistenceError("UNSUPPORTED_SUBJECT", "Stage 1 accepts guest subjects only.");
    const subject = subjectIdentity(command.subject);
    const guestSessionId = subject.subjectId;
    const payloadHash = digestFromDomainHash(command.payloadHash, "payloadHash");
    return this.runner.run(async (client) => {
      const now = await this.authority.assertTransactionReady(client);
      let candidates;
      try {
        candidates = this.authority.resumeKeys.candidates(resumeSecret, now);
      } catch (error) {
        if (error instanceof GuestSecretFormatError) throw new CommandAuthenticationError();
        throw error;
      }
      try {
        await this.authority.assertGuestSecretNotTombstoned(client, resumeSecret, now);
      } catch (error) {
        if (error instanceof PersistenceError && error.code === "GUEST_SECRET_TOMBSTONED") {
          throw new CommandAuthenticationError();
        }
        throw error;
      }
      const session = await this.sessions.findResumeMatchForUpdate(client, candidates);
      const authenticatedCandidate = session
        ? candidates.find((candidate) => candidate.keyVersion === session.digestKeyVersion)
        : undefined;
      const authenticated = Boolean(
        session
        && session.id === guestSessionId
        && authenticatedCandidate
        && constantTimeDigestEqual(authenticatedCandidate.digest, session.digest),
      );
      if (
        !authenticated
        || !session
        || session.expiresAt.getTime() <= now.getTime()
        || (session.slot === "predecessor"
          && (!session.digestValidUntil || session.digestValidUntil.getTime() <= now.getTime()))
      ) {
        throw new CommandAuthenticationError();
      }
      if (
        session.rotateAfter.getTime() <= now.getTime()
        || (session.slot === "current" && session.digestKeyVersion !== this.authority.resumeKeys.active.version)
      ) throw new GuestRotationRequiredError();
      await this.sessions.touch(client, guestSessionId, now);

      const lockScope = `guest:${guestSessionId}:${command.idempotencyKey}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockScope]);

      const receipt = await client.query<ReceiptRow>(
        `SELECT command_name, expected_revision, content_version, payload_hash,
                response_schema_version, response_payload, result_hash, committed_revision, expires_at
           FROM samurai_persistence.command_receipts
          WHERE guest_session_id = $1 AND idempotency_key = $2`,
        [guestSessionId, command.idempotencyKey],
      );
      const stored = receipt.rows[0];
      if (stored) {
        if (
          stored.command_name !== command.commandName
          || Number(stored.expected_revision) !== command.expectedRevision
          || stored.content_version !== command.contentVersion
          || !sameDigest(stored.payload_hash, payloadHash)
        ) {
          throw new IdempotencyPayloadMismatchError();
        }
        if (stored.expires_at.getTime() <= now.getTime()) throw new IdempotencyReceiptExpiredError();
        const replayResponse = deepFreeze(JSON.parse(canonicalJson(stored.response_payload)) as ResponsePayload);
        const replayResultHash = hashPersistenceResponse(stored.response_schema_version, replayResponse);
        if (!sameDigest(digestFromDomainHash(replayResultHash, "replayResultHash"), stored.result_hash)) {
          throw new PersistenceError("RECEIPT_INTEGRITY_FAILURE", "The stored response no longer matches its canonical result hash.");
        }
        return {
          disposition: "replayed",
          responseSchemaVersion: stored.response_schema_version,
          response: replayResponse,
          resultHash: replayResultHash,
          committedRevision: Number(stored.committed_revision),
        };
      }

      const progress = await this.progress.lock<Checkpoint>(client, guestSessionId);
      if (!progress) throw new PersistenceError("GUEST_PROGRESS_NOT_FOUND", "The guest progress record does not exist.");
      if (progress.revision !== command.expectedRevision) {
        throw new RevisionConflictError(command.expectedRevision, progress.revision);
      }

      const canonicalCheckpoint = deepFreeze(JSON.parse(canonicalJson(progress.checkpoint)) as Checkpoint);
      const rawDecision = await handler(canonicalCheckpoint, command);
      const canonical = canonicalizeDecision<Checkpoint, ResponsePayload>(rawDecision);
      const decision = canonical.decision;
      const committedRevision = command.expectedRevision + 1;
      const updated = await client.query<RevisionRow>(
        `UPDATE samurai_persistence.guest_progress
            SET revision = revision + 1,
                content_version = $3,
                checkpoint_schema_version = $4,
                checkpoint = $5::jsonb,
                updated_at = $6
          WHERE guest_session_id = $1 AND revision = $2
          RETURNING revision`,
        [
          guestSessionId,
          command.expectedRevision,
          command.contentVersion,
          decision.checkpointSchemaVersion,
          JSON.stringify(decision.checkpoint),
          now,
        ],
      );
      if (updated.rowCount !== 1) {
        const latest = await this.progress.lock<Checkpoint>(client, guestSessionId);
        throw new RevisionConflictError(command.expectedRevision, latest?.revision ?? -1);
      }

      await client.query(
        `INSERT INTO samurai_persistence.domain_events
          (event_id, guest_session_id, event_type, schema_version, payload, committed_revision, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          decision.event.eventId,
          guestSessionId,
          decision.event.eventType,
          decision.event.schemaVersion,
          JSON.stringify(decision.event.payload),
          committedRevision,
          now,
        ],
      );
      await client.query(
        `INSERT INTO samurai_persistence.outbox_deliveries
          (event_id, state, attempt_count, available_at)
         VALUES ($1, 'pending', 0, $2)`,
        [decision.event.eventId, now],
      );
      const resultHash = digestFromDomainHash(canonical.resultHash, "resultHash");
      await client.query(
        `INSERT INTO samurai_persistence.command_receipts
          (guest_session_id, idempotency_key, command_name, expected_revision, content_version, payload_hash,
           response_schema_version, response_payload, result_hash, committed_revision, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
        [
          guestSessionId,
          command.idempotencyKey,
          command.commandName,
          command.expectedRevision,
          command.contentVersion,
          payloadHash,
          decision.response.schemaVersion,
          JSON.stringify(decision.response.payload),
          resultHash,
          committedRevision,
          now,
          addMilliseconds(now, ADR_0003_PERSISTENCE_LIFECYCLE.receiptLifetimeMs),
        ],
      );
      return {
        disposition: "committed",
        responseSchemaVersion: decision.response.schemaVersion,
        response: deepFreeze(decision.response.payload),
        resultHash: canonical.resultHash,
        committedRevision,
      };
    });
  }
}

const MAX_COMMAND_DEPTH = 32;
const MAX_COMMAND_NODES = 2_048;
const MAX_COMMAND_STRING_BYTES = 16 * 1_024;
const MAX_COMMAND_BYTES = 256 * 1_024;

export class CommandBoundsError extends PersistenceError {
  constructor() {
    super("COMMAND_BOUNDS_EXCEEDED", "The unauthenticated command exceeds structural resource limits.");
    this.name = "CommandBoundsError";
  }
}

function assertBoundedUnauthenticatedCommand(root: unknown): void {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  let stringBytes = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_COMMAND_NODES || item.depth > MAX_COMMAND_DEPTH) throw new CommandBoundsError();
    if (typeof item.value === "string") {
      const bytes = Buffer.byteLength(item.value, "utf8");
      if (bytes > MAX_COMMAND_STRING_BYTES) throw new CommandBoundsError();
      stringBytes += bytes;
      if (stringBytes > MAX_COMMAND_BYTES) throw new CommandBoundsError();
      continue;
    }
    if (item.value === null || typeof item.value !== "object") continue;
    const descriptors = Object.getOwnPropertyDescriptors(item.value);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") throw new CommandBoundsError();
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) throw new CommandBoundsError();
      const keyBytes = Buffer.byteLength(key, "utf8");
      if (keyBytes > MAX_COMMAND_STRING_BYTES) throw new CommandBoundsError();
      stringBytes += keyBytes;
      if (stringBytes > MAX_COMMAND_BYTES) throw new CommandBoundsError();
      stack.push({ value: descriptor.value, depth: item.depth + 1 });
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
