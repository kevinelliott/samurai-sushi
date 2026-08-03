import { Pool, type PoolClient, type QueryResult as PgQueryResult } from "pg";
import {
  AccountClaimAuthority,
  AccountClaimService,
  EveningServiceAuthority,
  GuestClaimKeyring,
  GuestSessionService,
  HmacKeyring,
  mergeFirstEveningCheckpointForClaim,
  PersistenceAuthority,
  PlayerSessionKeyring,
  ReceiptLifecycleAuthority,
  ReceiptReviewWalletAuthority,
  TombstoneKeyring,
  type ConnectedSqlClient,
  type QueryResult,
  type SqlPool,
  type SqlValue,
} from "@samurai-sushi/persistence";
import type { AccountRuntimeConfig } from "./config";

class PgClientAdapter implements ConnectedSqlClient {
  constructor(private readonly client: PoolClient) {}
  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result: PgQueryResult<Row> = await this.client.query(text, values ? [...values] : undefined);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  release(): void { this.client.release(); }
}

class PgPoolAdapter implements SqlPool {
  constructor(private readonly pool: Pool) {}
  async query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    const result: PgQueryResult<Row> = await this.pool.query(text, values ? [...values] : undefined);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  async connect(): Promise<ConnectedSqlClient> { return new PgClientAdapter(await this.pool.connect()); }
}

export interface AccountRuntimeServices {
  readonly guests: GuestSessionService;
  readonly accounts: AccountClaimService;
  readonly evening: EveningServiceAuthority;
  readonly receiptReview: ReceiptReviewWalletAuthority | null;
  close(): Promise<void>;
}

export async function composeAccountRuntime(config: AccountRuntimeConfig): Promise<AccountRuntimeServices> {
  const rawPool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  const pool = new PgPoolAdapter(rawPool);
  try {
    const resumeKeys = new HmacKeyring(config.keys.resume, config.resumeVerificationKeys);
    const tombstoneKeys = new TombstoneKeyring(config.keys.tombstone);
    const guestClaimKeys = new GuestClaimKeyring(config.keys.guestClaim);
    const playerSessionKeys = new PlayerSessionKeyring(config.keys.playerSession);
    const persistence = new PersistenceAuthority(pool, resumeKeys, tombstoneKeys);
    const authority = new AccountClaimAuthority(pool, persistence, guestClaimKeys, playerSessionKeys);
    await authority.bootstrap();
    const accounts = new AccountClaimService(pool, authority, {
      origin: config.canonicalOrigin,
      chainId: config.chainId,
      mergeCheckpoint: mergeFirstEveningCheckpointForClaim,
    });
    const evening = new EveningServiceAuthority(pool, persistence, accounts);
    const receiptReview = config.receiptPolicy
      ? new ReceiptReviewWalletAuthority(pool, evening, new ReceiptLifecycleAuthority(pool, evening), config.receiptPolicy)
      : null;
    return Object.freeze({
      guests: new GuestSessionService(pool, persistence, { claimKeys: guestClaimKeys }),
      accounts,
      evening,
      receiptReview,
      close: async () => rawPool.end(),
    });
  } catch (error) {
    await rawPool.end().catch(() => undefined);
    throw error;
  }
}
