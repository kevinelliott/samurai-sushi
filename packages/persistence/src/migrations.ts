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
  readonly catalogChecksum: Uint8Array;
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

const MIGRATION_MANIFEST = [
  {
    name: "0001_persistence_spine.sql",
    checksumHex: "4d7fd2b2103a1cf7bf332db8e7f14b034e66e72de64efc398a7d4e42b2571533",
    catalogChecksumHex: "434770ddcac493dfdcbe90e8747bdc0319065b81000cd8f1613a22cefb386c4c",
  },
  {
    name: "0002_portable_recovery.sql",
    checksumHex: "19228c2338e44feffab73d71c8641bc98b5bcb806be19300501f072a9a49dc48",
    catalogChecksumHex: "9353296a3bc15b064810e3a3ab1cd28ed17d02d70daf35cec4903a868a4e6692",
  },
] as const;

type MigrationTextReader = (name: string) => Promise<string>;

const readBundledMigration: MigrationTextReader = async (name) => {
  const path = fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
  return readFile(path, "utf8");
};

async function loadBundledMigrations(readMigration: MigrationTextReader): Promise<readonly Migration[]> {
  return Promise.all(
    MIGRATION_MANIFEST.map(async (manifest) => {
      const sql = await readMigration(manifest.name);
      const checksum = createHash("sha256").update(sql).digest();
      if (checksum.toString("hex") !== manifest.checksumHex) throw new MigrationChangedError(manifest.name);
      return {
        name: manifest.name,
        sql,
        checksum,
        catalogChecksum: Buffer.from(manifest.catalogChecksumHex, "hex"),
      };
    }),
  );
}

export async function bundledMigrations(): Promise<readonly Migration[]> {
  return loadBundledMigrations(readBundledMigration);
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
             (n.nspowner = current_user::regrole)::text || '|' || COALESCE(n.nspacl::text, '') AS definition
        FROM pg_namespace n
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'relation'::text AS kind,
             c.relname::text AS identity,
             c.relkind::text || '|' || c.relpersistence::text || '|' || c.relrowsecurity::text || '|' ||
             c.relforcerowsecurity::text || '|' || c.relreplident::text || '|' ||
             (c.relowner = current_user::regrole)::text || '|' ||
             COALESCE(c.relam::regclass::text, '') || '|' || COALESCE(c.reloptions::text, '') || '|' ||
             COALESCE(c.relacl::text, '') AS definition
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'samurai_persistence' AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      UNION ALL
      SELECT 'column', c.relname || '.' || a.attnum::text || '.' || a.attname,
             a.atttypid::regtype::text || '|' || a.atttypmod::text || '|' ||
             format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|' || a.attidentity::text || '|' ||
             a.attgenerated::text || '|' || a.attcollation::regcollation::text || '|' || a.attstorage::text || '|' ||
             a.attcompression::text || '|' ||
             COALESCE(pg_get_expr(d.adbin, d.adrelid), '') || '|' || COALESCE(a.attacl::text, '') || '|' ||
             COALESCE(a.attoptions::text, '') || '|' || COALESCE(a.attfdwoptions::text, '')
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
             || '|' || i.indisunique::text || '|' || i.indnullsnotdistinct::text
             || '|' || i.indisprimary::text || '|' || i.indisexclusion::text
             || '|' || i.indimmediate::text || '|' || i.indisclustered::text
             || '|' || i.indisvalid::text || '|' || i.indcheckxmin::text
             || '|' || i.indisready::text || '|' || i.indislive::text
             || '|' || i.indisreplident::text || '|' || i.indnatts::text
             || '|' || i.indnkeyatts::text || '|' || i.indkey::text
             || '|' || i.indoption::text
             || '|' || index_class.relpersistence::text
             || '|' || (index_class.relowner = current_user::regrole)::text
             || '|' || index_class.relam::regclass::text
             || '|' || COALESCE(index_class.reloptions::text, '')
             || '|' || COALESCE(index_class.relacl::text, '')
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
             || '|' || (procedure.proowner = current_user::regrole)::text
             || '|' || COALESCE(procedure.proacl::text, '')
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
      UNION ALL
      SELECT 'type', t.typname,
             t.typtype::text || '|' || t.typcategory::text || '|' || t.typispreferred::text || '|' ||
             t.typisdefined::text || '|' || t.typdelim::text || '|' || t.typlen::text || '|' ||
             t.typbyval::text || '|' || t.typalign::text || '|' || t.typstorage::text || '|' ||
             t.typnotnull::text || '|' || t.typtypmod::text || '|' || t.typndims::text || '|' ||
             COALESCE(NULLIF(t.typelem, 0)::regtype::text, '') || '|' ||
             COALESCE(NULLIF(t.typarray, 0)::regtype::text, '') || '|' ||
             COALESCE(NULLIF(t.typbasetype, 0)::regtype::text, '') || '|' ||
             t.typcollation::regcollation::text || '|' ||
             (t.typowner = current_user::regrole)::text || '|' || COALESCE(t.typacl::text, '') || '|' ||
             COALESCE(t.typdefault, '')
        FROM pg_type t
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'samurai_persistence' AND t.typrelid = 0
      UNION ALL
      SELECT 'enum', t.typname || '.' || e.enumsortorder::text, e.enumlabel
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'type_constraint', t.typname || '.' || con.conname, pg_get_constraintdef(con.oid, true)
        FROM pg_constraint con
        JOIN pg_type t ON t.oid = con.contypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'range', range_type.typname,
             r.rngsubtype::regtype::text || '|' || r.rngcollation::regcollation::text || '|' ||
             operator_namespace.nspname || '.' || operator_class.opcname || '|' ||
             COALESCE(NULLIF(r.rngcanonical, 0)::regprocedure::text, '') || '|' ||
             COALESCE(NULLIF(r.rngsubdiff, 0)::regprocedure::text, '') || '|' ||
             r.rngmultitypid::regtype::text
        FROM pg_range r
        JOIN pg_type range_type ON range_type.oid = r.rngtypid
        JOIN pg_namespace n ON n.oid = range_type.typnamespace
        JOIN pg_opclass operator_class ON operator_class.oid = r.rngsubopc
        JOIN pg_namespace operator_namespace ON operator_namespace.oid = operator_class.opcnamespace
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'collation', coll.collname || '.' || coll.collencoding::text,
             (coll.collowner = current_user::regrole)::text || '|' ||
             coll.collprovider::text || '|' || coll.collisdeterministic::text || '|' ||
             coll.collencoding::text || '|' || COALESCE(coll.collcollate, '') || '|' ||
             COALESCE(coll.collctype, '') || '|' || COALESCE(coll.colllocale, '') || '|' ||
             COALESCE(coll.collicurules, '') || '|' || COALESCE(coll.collversion, '')
        FROM pg_collation coll
        JOIN pg_namespace n ON n.oid = coll.collnamespace
       WHERE n.nspname = 'samurai_persistence'
      UNION ALL
      SELECT 'schema_object_inventory',
             identified.type || '|' || COALESCE(identified.schema, '') || '|' || COALESCE(identified.name, ''),
             identified.identity || '|' || dependency.classid::regclass::text || '|' || dependency.deptype::text
        FROM pg_depend dependency
        JOIN pg_namespace n
          ON dependency.refclassid = 'pg_namespace'::regclass
         AND dependency.refobjid = n.oid
       CROSS JOIN LATERAL pg_identify_object(
         dependency.classid,
         dependency.objid,
         dependency.objsubid
       ) identified
       WHERE n.nspname = 'samurai_persistence'
    )
    SELECT kind, identity, definition FROM catalog_rows ORDER BY kind, identity, definition
  `);
  return createHash("sha256").update(JSON.stringify(result.rows)).digest();
}

async function applyMigrationsWithReader(pool: SqlPool, readMigration: MigrationTextReader): Promise<void> {
  const selected = await loadBundledMigrations(readMigration);
  const runner = new TransactionRunner(pool);
  await runner.run(async (client) => {
    await client.query("SET LOCAL search_path = pg_catalog");
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
    if (ledger.rows.length > 0) {
      const prefix = selected[ledger.rows.length - 1];
      if (!prefix) throw new MigrationSchemaDriftError("The migration ledger prefix is not code-known.");
      const livePrefixChecksum = await catalogChecksum(client);
      if (!Buffer.from(livePrefixChecksum).equals(Buffer.from(prefix.catalogChecksum))) {
        throw new MigrationSchemaDriftError("The live persistence catalog does not match its applied migration prefix.");
      }
    }
    let expectedCatalogChecksum: Uint8Array | undefined;
    for (const migration of selected) {
      const recorded = ledger.rows.find((row) => row.name === migration.name);
      if (recorded) {
        if (!Buffer.from(recorded.checksum).equals(Buffer.from(migration.checksum))) throw new MigrationChangedError(migration.name);
        if (!Buffer.from(recorded.catalog_checksum).equals(Buffer.from(migration.catalogChecksum))) {
          throw new MigrationSchemaDriftError("The migration ledger catalog checksum is not the code-known schema attestation.");
        }
        expectedCatalogChecksum = migration.catalogChecksum;
        continue;
      }
      await client.query(migration.sql);
      const installedCatalogChecksum = await catalogChecksum(client);
      if (!Buffer.from(installedCatalogChecksum).equals(Buffer.from(migration.catalogChecksum))) {
        throw new MigrationSchemaDriftError(
          `The installed persistence catalog ${Buffer.from(installedCatalogChecksum).toString("hex")} does not match the code-known schema attestation.`,
        );
      }
      expectedCatalogChecksum = migration.catalogChecksum;
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

export async function applyMigrations(pool: SqlPool): Promise<void> {
  return applyMigrationsWithReader(pool, readBundledMigration);
}

/** @internal Test seam proving bundled-byte rejection occurs before database access. */
export const migrationTestOnly = {
  applyMigrationsWithReader,
} as const;
