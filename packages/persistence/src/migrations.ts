import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import { MigrationChangedError } from "./errors";

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: Uint8Array;
}

interface AppliedMigrationRow {
  readonly checksum: Uint8Array;
}

const MIGRATION_NAMES = ["0001_persistence_spine.sql"] as const;

export async function bundledMigrations(): Promise<readonly Migration[]> {
  return Promise.all(
    MIGRATION_NAMES.map(async (name) => {
      const path = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
      const sql = await readFile(path, "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest() };
    }),
  );
}

async function prepareMigrationLedger(client: SqlClient): Promise<void> {
  await client.query("CREATE SCHEMA IF NOT EXISTS samurai_persistence");
  await client.query(`
    CREATE TABLE IF NOT EXISTS samurai_persistence.schema_migrations (
      name text PRIMARY KEY,
      checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

export async function applyMigrations(pool: SqlPool, migrations?: readonly Migration[]): Promise<void> {
  const selected = migrations ?? (await bundledMigrations());
  const runner = new TransactionRunner(pool);
  await runner.run(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["samurai-sushi:persistence:migrations:v1"]);
    await prepareMigrationLedger(client);
    for (const migration of selected) {
      const existing = await client.query<AppliedMigrationRow>(
        "SELECT checksum FROM samurai_persistence.schema_migrations WHERE name = $1",
        [migration.name],
      );
      const recorded = existing.rows[0]?.checksum;
      if (recorded) {
        if (!Buffer.from(recorded).equals(Buffer.from(migration.checksum))) throw new MigrationChangedError(migration.name);
        continue;
      }
      await client.query(migration.sql);
      await client.query(
        "INSERT INTO samurai_persistence.schema_migrations (name, checksum) VALUES ($1, $2)",
        [migration.name, migration.checksum],
      );
    }
  });
}
