import { Pool } from "pg";

import type { SqlDriver, Transaction } from "./driver.ts";

/**
 * Postgres, for anything hosted.
 *
 * A pool rather than a connection, because a serverless or multi-instance
 * deployment opens and drops handlers constantly and a pool is what keeps that
 * from becoming a connection per request. It is created once per process — the
 * store above caches it — and never closed on a request path.
 *
 * `pg` is on Next.js' list of packages excluded from server bundling, so it is
 * loaded by Node directly and needs no configuration here.
 *
 * Connecting only: bringing the schema up to date is `migrate`, called by
 * whoever opens the store, so that connecting to a database and changing its
 * shape stay two decisions.
 */
export async function postgresDriver(connectionString: string): Promise<SqlDriver> {
  const pool = new Pool({
    connectionString,
    // A small ceiling on purpose. Several instances share one database, and a
    // pool per instance sized for a single-server world is how a deployment
    // exhausts a managed Postgres' connection limit. Nothing here holds a
    // connection for longer than one short statement.
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  const driver: SqlDriver = {
    async query<Row>(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
      const result = await pool.query(sql, params as unknown[]);
      return result.rows as Row[];
    },

    async exec(sql: string): Promise<void> {
      // No parameters, so this goes as a simple query, which is the only form
      // Postgres lets carry several statements at once.
      await pool.query(sql);
    },

    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      // A transaction has to run on one connection, so it is checked out of the
      // pool rather than going through it — `pool.query` would be free to spread
      // the statements over several connections, and BEGIN on one of them
      // governs nothing on the others.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work({
          async query<Row>(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
            return (await client.query(sql, params as unknown[])).rows as Row[];
          },
          async exec(script: string): Promise<void> {
            await client.query(script);
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {
          // The connection is already unusable; releasing it below is what
          // matters, and the original error is the one worth reporting.
        });
        throw error;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };

  return driver;
}
