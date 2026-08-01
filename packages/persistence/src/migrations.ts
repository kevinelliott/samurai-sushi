import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { SqlClient, SqlPool } from "./database";
import { TransactionRunner } from "./database";
import { MigrationChangedError, MigrationSchemaDriftError } from "./errors";

export interface Migration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: Uint8Array;
}

interface AppliedMigrationRow {
  readonly name: string;
  readonly checksum: Uint8Array;
  readonly catalog_checksum: Uint8Array;
}

interface NamespaceStateRow {
  readonly namespace_exists: boolean;
  readonly ledger_exists: boolean;
}

interface CatalogRow {
  readonly kind: string;
  readonly identity: string;
  readonly definition: string;
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
  await client.query("CREATE SCHEMA samurai_persistence");
  await client.query(`
    CREATE TABLE samurai_persistence.schema_migrations (
      name text PRIMARY KEY,
      checksum bytea NOT NULL CHECK (octet_length(checksum) = 32),
      catalog_checksum bytea NOT NULL CHECK (octet_length(catalog_checksum) = 32),
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `);
}

async function namespaceState(client: SqlClient): Promise<NamespaceStateRow> {
  const result = await client.query<NamespaceStateRow>(`
    SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'samurai_persistence') AS namespace_exists,
           to_regclass('samurai_persistence.schema_migrations') IS NOT NULL AS ledger_exists
  `);
  const state = result.rows[0];
  if (!state) throw new MigrationSchemaDriftError("PostgreSQL did not return persistence namespace state.");
  return state;
}

async function catalogChecksum(client: SqlClient): Promise<Uint8Array> {
  const result = await client.query<CatalogRow>(`
    WITH catalog_rows AS (
      SELECT 'schema'::text AS kind,
             n.nspname::text AS identity,
             n.nspowner::regrole::text || '|' || COALESCE(n.nspacl::text, '') AS definition
        FROM pg_namespace n
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'relation'::text AS kind,
             c.relname::text AS identity,
             c.relkind::text || '|' || c.relpersistence::text || '|' || c.relrowsecurity::text || '|' ||
             c.relforcerowsecurity::text || '|' || c.relreplident::text || '|' || c.relowner::regrole::text || '|' ||
             COALESCE(c.relam::regclass::text, '') || '|' || COALESCE(c.reloptions::text, '') || '|' ||
             COALESCE(c.relacl::text, '') AS definition
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'samurai_persistence' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      UNION ALL
      SELECT 'column', c.relname || '.' || a.attnum::text || '.' || a.attname,
             format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || a.attidentity::text || '|' ||
             a.attgenerated::text || '|' || a.attcollation::regcollation::text || '|' || a.attstorage::text || '|' ||
             a.attcompression::text || '|' ||
             COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE n.nspname = 'samurai_persistence' AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint', c.relname || '.' || con.conname, pg_get_constraintdef(con.oid, true)
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'index', table_class.relname || '.' || index_class.relname, pg_get_indexdef(index_class.oid)
        FROM pg_index i
        JOIN pg_class table_class ON table_class.oid = i.indrelid
        JOIN pg_class index_class ON index_class.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = table_class.relnamespace
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'trigger', table_class.relname || '.' || trigger.tgname,
             pg_get_triggerdef(trigger.oid, true) || '|' || trigger.tgfoid::regprocedure::text
        FROM pg_trigger trigger
        JOIN pg_class table_class ON table_class.oid = trigger.tgrelid
        JOIN pg_namespace n ON n.oid = table_class.relnamespace
       WHERE n.nspname = 'samurai_persistence' AND NOT trigger.tgisinternal
      UNION ALL
      SELECT 'function', procedure.oid::regprocedure::text, pg_get_functiondef(procedure.oid)
        FROM pg_proc procedure
       JOIN pg_namespace n ON n.oid = procedure.pronamespace
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'policy', table_class.relname || '.' || policy.polname,
             policy.polcmd::text || '|' || policy.polpermissive::text || '|' ||
             COALESCE(policy.polroles::text, '') || '|' ||
             COALESCE(pg_get_expr(policy.polqual, policy.polrelid), '') || '|' ||
             COALESCE(pg_get_expr(policy.polwithcheck, policy.polrelid), '')
        FROM pg_policy policy
        JOIN pg_class table_class ON table_class.oid = policy.polrelid
        JOIN pg_namespace n ON n.oid = table_class.relnamespace
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'view', c.relname, pg_get_viewdef(c.oid, true)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'samurai_persistence' AND c.relkind IN ('v', 'm')
    )
    SELECT kind, identity, definition FROM catalog_rows ORDER BY kind, identity, definition
  `);
  return createHash("sha256").update(JSON.stringify(result.rows)).digest();
}

export async function applyMigrations(pool: SqlPool): Promise<void> {
  const selected = await bundledMigrations();
  for (const migration of selected) {
    const computed = createHash("sha256").update(migration.sql).digest();
    if (!Buffer.from(computed).equals(Buffer.from(migration.checksum))) throw new MigrationChangedError(migration.name);
  }
  const runner = new TransactionRunner(pool);
  await runner.run(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", ["samurai-sushi:persistence:migrations:v1"]);
    const state = await namespaceState(client);
    const freshBootstrap = !state.namespace_exists;
    if (freshBootstrap) {
      await prepareMigrationLedger(client);
    } else if (!state.ledger_exists) {
      throw new MigrationSchemaDriftError("The persistence namespace already exists without the exact migration ledger.");
    }
    const ledger = await client.query<AppliedMigrationRow>(
      "SELECT name, checksum, catalog_checksum FROM samurai_persistence.schema_migrations ORDER BY applied_at, name",
    );
    if (!freshBootstrap && ledger.rows.length === 0) {
      throw new MigrationSchemaDriftError("A pre-existing persistence namespace cannot have an empty migration ledger.");
    }
    const selectedNames = selected.map((migration) => migration.name);
    if (
      ledger.rows.length > selectedNames.length
      || ledger.rows.some((row, index) => row.name !== selectedNames[index])
    ) {
      throw new MigrationSchemaDriftError("The migration ledger contains unknown or out-of-order entries.");
    }
    let expectedCatalogChecksum: Uint8Array | undefined;
    for (const migration of selected) {
      const recorded = ledger.rows.find((row) => row.name === migration.name);
      if (recorded) {
        if (!Buffer.from(recorded.checksum).equals(Buffer.from(migration.checksum))) throw new MigrationChangedError(migration.name);
        expectedCatalogChecksum = recorded.catalog_checksum;
        continue;
      }
      await client.query(migration.sql);
      expectedCatalogChecksum = await catalogChecksum(client);
      await client.query(
        "INSERT INTO samurai_persistence.schema_migrations (name, checksum, catalog_checksum) VALUES ($1, $2, $3)",
        [migration.name, migration.checksum, expectedCatalogChecksum],
      );
    }
    if (expectedCatalogChecksum) {
      const liveCatalogChecksum = await catalogChecksum(client);
      if (!Buffer.from(liveCatalogChecksum).equals(Buffer.from(expectedCatalogChecksum))) {
        throw new MigrationSchemaDriftError();
      }
    }
  });
}
