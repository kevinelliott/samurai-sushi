export type SqlValue = string | number | boolean | Date | Uint8Array | null;

export interface QueryResult<Row extends object> {
  readonly rows: readonly Row[];
  readonly rowCount: number | null;
}

export interface SqlClient {
  query<Row extends object>(text: string, values?: readonly SqlValue[]): Promise<QueryResult<Row>>;
}

export interface ConnectedSqlClient extends SqlClient {
  release(): void;
}

export interface SqlPool extends SqlClient {
  connect(): Promise<ConnectedSqlClient>;
}

export class TransactionRunner {
  constructor(private readonly pool: SqlPool) {}

  async run<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
