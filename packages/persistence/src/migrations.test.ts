import { describe, expect, it } from "vitest";
import type { ConnectedSqlClient, QueryResult, SqlPool, SqlValue } from "./database";
import { MigrationChangedError } from "./errors";
import { migrationTestOnly } from "./migrations";

class DatabaseAccessProbe implements SqlPool {
  connectCalls = 0;
  queryCalls = 0;

  async query<Row extends object>(_text: string, _values?: readonly SqlValue[]): Promise<QueryResult<Row>> {
    this.queryCalls += 1;
    throw new Error("A rejected migration asset must not query PostgreSQL.");
  }

  async connect(): Promise<ConnectedSqlClient> {
    this.connectCalls += 1;
    throw new Error("A rejected migration asset must not connect to PostgreSQL.");
  }
}

describe("migration asset binding", () => {
  it("rejects altered bundled bytes before connecting to or querying PostgreSQL", async () => {
    const pool = new DatabaseAccessProbe();

    await expect(
      migrationTestOnly.applyMigrationsWithReader(pool, async () => "-- attacker-replaced migration bytes\n"),
    ).rejects.toBeInstanceOf(MigrationChangedError);

    expect(pool.connectCalls).toBe(0);
    expect(pool.queryCalls).toBe(0);
  });
});
