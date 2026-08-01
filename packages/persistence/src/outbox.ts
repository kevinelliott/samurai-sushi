import { randomUUID } from "node:crypto";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import { OutboxClaimLostError } from "./errors";
import type { PersistenceAuthority } from "./key-inventory";

export interface OutboxClaim {
  readonly eventId: string;
  readonly attemptCount: number;
  readonly claimToken: string;
  readonly claimGeneration: number;
  readonly claimExpiresAt: string;
}

export interface OutboxDeliveryPolicy {
  readonly maxAttempts: number;
}

export const DEFAULT_OUTBOX_DELIVERY_POLICY: OutboxDeliveryPolicy = Object.freeze({ maxAttempts: 5 });

interface OutboxClaimRow {
  readonly event_id: string;
  readonly attempt_count: number;
  readonly claim_token: string;
  readonly claim_generation: string;
  readonly claim_expires_at: Date;
}

interface StateRow {
  readonly state: "pending" | "delivered" | "dead-letter";
}

interface ClaimFenceRow {
  readonly attempt_count: number;
  readonly claim_expires_at: Date;
}

interface DatabaseClockRow {
  readonly now: Date;
}

function positiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
}

export class OutboxDeliveryService {
  private readonly runner: TransactionRunner;
  private readonly maxAttempts: number;

  constructor(
    pool: SqlPool,
    private readonly authority: PersistenceAuthority,
    policy: OutboxDeliveryPolicy = DEFAULT_OUTBOX_DELIVERY_POLICY,
  ) {
    this.runner = new TransactionRunner(pool);
    positiveInteger(policy.maxAttempts, "Outbox maximum attempts", 100);
    this.maxAttempts = policy.maxAttempts;
  }

  async claim(limit = 25, leaseMs = 30_000): Promise<readonly OutboxClaim[]> {
    positiveInteger(limit, "Outbox claim limit", 1_000);
    positiveInteger(leaseMs, "Outbox lease milliseconds", 15 * 60 * 1_000);
    const claimToken = randomUUID();
    return this.runner.run(async (client) => {
      await this.authority.assertTransactionReady(client);
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
         SELECT claimed.event_id, claimed.attempt_count, claimed.claim_token,
                claimed.claim_generation, claimed.claim_expires_at
           FROM claimed
          ORDER BY claimed.available_at, claimed.event_id`,
        [limit, claimToken, leaseMs, this.maxAttempts],
      );
      return Object.freeze(result.rows.map((row) => Object.freeze({
        eventId: row.event_id,
        attemptCount: row.attempt_count,
        claimToken: row.claim_token,
        claimGeneration: Number(row.claim_generation),
        claimExpiresAt: row.claim_expires_at.toISOString(),
      })));
    });
  }

  async markDelivered(eventId: string, claimToken: string, claimGeneration: number): Promise<void> {
    positiveInteger(claimGeneration, "Outbox claim generation", Number.MAX_SAFE_INTEGER);
    await this.runner.run(async (client) => {
      await this.authority.assertTransactionReady(client);
      const { now } = await this.lockLiveClaim(client, eventId, claimToken, claimGeneration);
      const result = await client.query(
        `UPDATE samurai_persistence.outbox_deliveries
            SET state = 'delivered', delivered_at = $4, claim_token = NULL,
                claim_expires_at = NULL, last_error_code = NULL
          WHERE event_id = $1 AND state = 'processing' AND claim_token = $2 AND claim_generation = $3`,
        [eventId, claimToken, claimGeneration, now],
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
      await this.authority.assertTransactionReady(client);
      const { now, attemptCount } = await this.lockLiveClaim(client, eventId, claimToken, claimGeneration);
      const terminal = (options.permanent ?? false) || attemptCount >= this.maxAttempts;
      const result = await client.query<StateRow>(
        `UPDATE samurai_persistence.outbox_deliveries
            SET state = CASE WHEN $4 THEN 'dead-letter' ELSE 'pending' END,
                available_at = CASE WHEN $4 THEN available_at ELSE $5::timestamptz + ($6::text || ' milliseconds')::interval END,
                claim_token = NULL,
                claim_expires_at = NULL,
                dead_lettered_at = CASE WHEN $4 THEN $5 ELSE NULL END,
                last_error_code = $7
          WHERE event_id = $1 AND state = 'processing' AND claim_token = $2 AND claim_generation = $3
        RETURNING state`,
        [eventId, claimToken, claimGeneration, terminal, now, backoffMs, errorCode],
      );
      const state = result.rows[0]?.state;
      if (!state) throw new OutboxClaimLostError();
      return state === "dead-letter" ? state : "pending";
    });
  }

  private async lockLiveClaim(
    client: SqlClient,
    eventId: string,
    claimToken: string,
    claimGeneration: number,
  ): Promise<{ readonly now: Date; readonly attemptCount: number }> {
    const fence = await client.query<ClaimFenceRow>(
      `SELECT attempt_count, claim_expires_at
         FROM samurai_persistence.outbox_deliveries
        WHERE event_id = $1 AND state = 'processing' AND claim_token = $2 AND claim_generation = $3
        FOR UPDATE`,
      [eventId, claimToken, claimGeneration],
    );
    const row = fence.rows[0];
    if (!row) throw new OutboxClaimLostError();
    const clock = await client.query<DatabaseClockRow>("SELECT clock_timestamp() AS now");
    const now = clock.rows[0]?.now;
    if (!now || row.claim_expires_at.getTime() <= now.getTime()) throw new OutboxClaimLostError();
    return { now, attemptCount: row.attempt_count };
  }
}
