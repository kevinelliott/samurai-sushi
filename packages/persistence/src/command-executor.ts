import { timingSafeEqual } from "node:crypto";
import { subjectIdentity } from "@samurai-sushi/domain";
import type { JsonObject, JsonValue } from "@samurai-sushi/domain";
import type { SqlPool } from "./database";
import { TransactionRunner } from "./database";
import type {
  PersistenceCommandEnvelope,
  PersistenceCommandHandler,
} from "./domain-adapter";
import { IdempotencyPayloadMismatchError, PersistenceError, RevisionConflictError } from "./errors";
import { GuestProgressRepository } from "./repositories";

const RECEIPT_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;

interface ReceiptRow {
  readonly command_name: string;
  readonly expected_revision: string;
  readonly content_version: string;
  readonly payload_hash: Uint8Array;
  readonly response_schema_version: number;
  readonly response_payload: unknown;
  readonly result_hash: Uint8Array;
  readonly committed_revision: string;
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

  constructor(
    pool: SqlPool,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.runner = new TransactionRunner(pool);
  }

  async execute<
    Payload extends JsonValue,
    Checkpoint extends JsonObject,
    ResponsePayload extends JsonValue,
  >(
    command: PersistenceCommandEnvelope<Payload>,
    handler: PersistenceCommandHandler<Payload, Checkpoint, ResponsePayload>,
  ): Promise<CommandExecutionResult<ResponsePayload>> {
    if (command.subject.kind !== "guest") throw new PersistenceError("UNSUPPORTED_SUBJECT", "Stage 1 accepts guest subjects only.");
    const subject = subjectIdentity(command.subject);
    const guestSessionId = subject.subjectId;
    const payloadHash = digestFromDomainHash(command.payloadHash, "payloadHash");
    return this.runner.run(async (client) => {
      const lockScope = `guest:${guestSessionId}:${command.idempotencyKey}`;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockScope]);

      const receipt = await client.query<ReceiptRow>(
        `SELECT command_name, expected_revision, content_version, payload_hash,
                response_schema_version, response_payload, result_hash, committed_revision
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
        return {
          disposition: "replayed",
          responseSchemaVersion: stored.response_schema_version,
          response: stored.response_payload as ResponsePayload,
          resultHash: `sha256:${Buffer.from(stored.result_hash).toString("hex")}`,
          committedRevision: Number(stored.committed_revision),
        };
      }

      const progress = await this.progress.lock<Checkpoint>(client, guestSessionId);
      if (!progress) throw new PersistenceError("GUEST_PROGRESS_NOT_FOUND", "The guest progress record does not exist.");
      if (progress.revision !== command.expectedRevision) {
        throw new RevisionConflictError(command.expectedRevision, progress.revision);
      }

      const decision = await handler(progress.checkpoint, command);
      const committedRevision = command.expectedRevision + 1;
      const now = this.now();
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
      const resultHash = digestFromDomainHash(decision.response.resultHash, "resultHash");
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
          new Date(now.getTime() + RECEIPT_LIFETIME_MS),
        ],
      );
      return {
        disposition: "committed",
        responseSchemaVersion: decision.response.schemaVersion,
        response: decision.response.payload,
        resultHash: decision.response.resultHash,
        committedRevision,
      };
    });
  }
}
