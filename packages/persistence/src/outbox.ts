import { randomUUID } from "node:crypto";
import type { JsonObject } from "@samurai-sushi/domain";
import type { SqlPool } from "./database";
import { TransactionRunner } from "./database";
import { OutboxClaimLostError } from "./errors";

export interface OutboxClaim {
  readonly eventId: string;
  readonly eventType: string;
  readonly schemaVersion: number;
  readonly payload: JsonObject;
  readonly committedRevision: number;
  readonly createdAt: Date;
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly claimGeneration: number;
  readonly claimExpiresAt: Date;
}

export interface OutboxDeliveryPolicy {
  readonly maxAttempts: number;
}

export const DEFAULT_OUTBOX_DELIVERY_POLICY: OutboxDeliveryPolicy = Object.freeze({ maxAttempts: 5 });

interface OutboxClaimRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly payload: JsonObject;
  readonly committed_revision: string;
  readonly created_at: Date;
  readonly attempt_count: number;
  readonly claim_token: string;
  readonly claim_generation: string;
  readonly claim_expires_at: Date;
}

interface StateRow {
  readonly state: "pending" | "delivered" | "dead-letter";
}

function positiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
}

export class OutboxDeliveryService {
  private readonly runner: TransactionRunner;
  private readonly maxAttempts: number;

  constructor(pool: SqlPool, policy: OutboxDeliveryPolicy = DEFAULT_OUTBOX_DELIVERY_POLICY) {
    this.runner = new TransactionRunner(pool);
    positiveInteger(policy.maxAttempts, "Outbox maximum attempts", 100);
    this.maxAttempts = policy.maxAttempts;
  }

  async claim(limit = 25, leaseMs = 30_000): Promise<readonly OutboxClaim[]> {
    positiveInteger(limit, "Outbox claim limit", 1_000);
    positiveInteger(leaseMs, "Outbox lease milliseconds", 15 * 60 * 1_000);
    const claimToken = randomUUID();
    return this.runner.run(async (client) => {
      const result = await client.query<OutboxClaimRow>(
        `WITH clock AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         ), exhausted AS (
           UPDATE samurai_persistence.outbox_deliveries delivery
              SET state = 'dead-letter', dead_lettered_at = clock.now,
                  claim_token = NULL, claim_expires_at = NULL, last_error_code = 'LEASE_EXHAUSTED'
             FROM clock
            WHERE delivery.state = 'processing' AND delivery.claim_expires_at <= clock.now
              AND delivery.attempt_count >= $4
         RETURNING delivery.event_id
         ), candidates AS (
           SELECT event_id
             FROM samurai_persistence.outbox_deliveries, clock
            WHERE ((state = 'pending' AND available_at <= clock.now)
               OR (state = 'processing' AND claim_expires_at <= clock.now AND attempt_count < $4))
              AND event_id NOT IN (SELECT event_id FROM exhausted)
            ORDER BY available_at, event_id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         ), claimed AS (
           UPDATE samurai_persistence.outbox_deliveries delivery
              SET state = 'processing',
                  attempt_count = attempt_count + 1,
                  last_attempt_at = clock.now,
                  claim_token = $2,
                  claim_generation = claim_generation + 1,
                  claim_expires_at = clock.now + ($3::text || ' milliseconds')::interval,
                  delivered_at = NULL,
                  dead_lettered_at = NULL
             FROM candidates, clock
            WHERE delivery.event_id = candidates.event_id
           RETURNING delivery.*
         )
         SELECT event.event_id, event.event_type, event.schema_version, event.payload,
                event.committed_revision, event.created_at, claimed.attempt_count,
                claimed.claim_token, claimed.claim_generation, claimed.claim_expires_at
           FROM claimed
           JOIN samurai_persistence.domain_events event ON event.event_id = claimed.event_id
          ORDER BY event.created_at, event.event_id`,
        [limit, claimToken, leaseMs, this.maxAttempts],
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        payload: row.payload,
        committedRevision: Number(row.committed_revision),
        createdAt: row.created_at,
        attemptCount: row.attempt_count,
        claimToken: row.claim_token,
        claimGeneration: Number(row.claim_generation),
        claimExpiresAt: row.claim_expires_at,
      }));
    });
  }

  async markDelivered(eventId: string, claimToken: string, claimGeneration: number): Promise<void> {
    positiveInteger(claimGeneration, "Outbox claim generation", Number.MAX_SAFE_INTEGER);
    await this.runner.run(async (client) => {
      const result = await client.query(
        `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE samurai_persistence.outbox_deliveries delivery
            SET state = 'delivered', delivered_at = clock.now, claim_token = NULL,
                claim_expires_at = NULL, last_error_code = NULL
           FROM clock
          WHERE event_id = $1 AND state = 'processing' AND claim_token = $2 AND claim_generation = $3
            AND claim_expires_at > clock.now`,
        [eventId, claimToken, claimGeneration],
      );
      if (result.rowCount !== 1) throw new OutboxClaimLostError();
    });
  }

  async recordFailure(
    eventId: string,
    claimToken: string,
    claimGeneration: number,
    errorCode: string,
    options: { readonly permanent?: boolean; readonly backoffMs?: number } = {},
  ): Promise<"pending" | "dead-letter"> {
    positiveInteger(claimGeneration, "Outbox claim generation", Number.MAX_SAFE_INTEGER);
    const backoffMs = options.backoffMs ?? 1_000;
    positiveInteger(backoffMs, "Outbox retry backoff milliseconds", 24 * 60 * 60 * 1_000);
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(errorCode)) throw new Error("Outbox error codes must be stable uppercase identifiers.");
    return this.runner.run(async (client) => {
      const result = await client.query<StateRow>(
        `WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
         UPDATE samurai_persistence.outbox_deliveries delivery
            SET state = CASE WHEN $4 OR attempt_count >= $5 THEN 'dead-letter' ELSE 'pending' END,
                available_at = CASE
                  WHEN $4 OR attempt_count >= $5 THEN available_at
                  ELSE clock.now + ($6::text || ' milliseconds')::interval
                END,
                claim_token = NULL,
                claim_expires_at = NULL,
                dead_lettered_at = CASE WHEN $4 OR attempt_count >= $5 THEN clock.now ELSE NULL END,
                last_error_code = $7
           FROM clock
          WHERE event_id = $1 AND state = 'processing' AND claim_token = $2 AND claim_generation = $3
            AND claim_expires_at > clock.now
        RETURNING state`,
        [eventId, claimToken, claimGeneration, options.permanent ?? false, this.maxAttempts, backoffMs, errorCode],
      );
      const state = result.rows[0]?.state;
      if (!state) throw new OutboxClaimLostError();
      return state === "dead-letter" ? state : "pending";
    });
  }
}
