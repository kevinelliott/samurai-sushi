import type { HmacKeyring, TombstoneKeyring } from "./crypto";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import { PersistenceError } from "./errors";

interface KeyVersionRow {
  readonly source: "resume" | "tombstone";
  readonly key_version: number;
}

export async function assertPersistenceKeyInventory(
  client: SqlClient,
  resumeKeys: HmacKeyring,
  tombstoneKeys: TombstoneKeyring,
): Promise<void> {
  const result = await client.query<KeyVersionRow>(`
    SELECT 'resume'::text AS source, digest_key_version AS key_version
      FROM samurai_persistence.guest_resume_digests
    UNION
    SELECT 'tombstone'::text AS source, digest_key_version AS key_version
      FROM samurai_persistence.deletion_tombstones
    ORDER BY source, key_version
  `);
  for (const row of result.rows) {
    const available = row.source === "resume"
      ? resumeKeys.hasVersion(row.key_version)
      : tombstoneKeys.hasVersion(row.key_version);
    if (!available) {
      throw new PersistenceError(
        "KEY_VERSION_UNAVAILABLE",
        `Required ${row.source} verification key version ${row.key_version} is unavailable.`,
      );
    }
  }
}

export class PersistenceKeyInventoryService {
  private readonly runner: TransactionRunner;

  constructor(
    pool: SqlPool,
    private readonly resumeKeys: HmacKeyring,
    private readonly tombstoneKeys: TombstoneKeyring,
  ) {
    this.runner = new TransactionRunner(pool);
  }

  async assertReady(): Promise<void> {
    await this.runner.run((client) => assertPersistenceKeyInventory(client, this.resumeKeys, this.tombstoneKeys));
  }
}
