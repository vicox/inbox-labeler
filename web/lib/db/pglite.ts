import { PGlite } from "@electric-sql/pglite";

import type { SqlDriver, Transaction } from "./driver.ts";

/**
 * Postgres embedded in the process, for development and tests.
 *
 * The point is that it is not a different database. PGlite is Postgres compiled
 * to WebAssembly, so the schema, the `DELETE … RETURNING` that makes a spend
 * atomic and the transactional DDL the migrations rely on are the same code
 * running here as in production — which is what lets the store's tests, the
 * concurrency ones included, prove something about the deployed system while
 * needing no database to be installed or running.
 *
 * What it is not is a production store. One process owns the data directory, so
 * a second instance cannot open it — which is the reason `DATABASE_URL` is
 * required when hosting rather than merely recommended, and why `oauthStore`
 * treats its absence in production as a configuration error instead of falling
 * back here.
 *
 * It is nonetheless a runtime dependency rather than a development one, and that
 * is a packaging fact rather than a change of purpose: the bundler has to
 * resolve every import it can see, so a build run without development
 * dependencies would fail on this one. `serverExternalPackages` in
 * next.config.ts keeps the thirty megabytes of WebAssembly out of the server
 * bundle, so production installs it and never loads it.
 */
export async function embeddedDriver(dataDir?: string): Promise<SqlDriver> {
  // A directory when one is given, so a developer's registered clients and
  // logins survive a restart the way they will in production. Memory otherwise,
  // which is what tests want: each one opens a database nothing else has
  // touched.
  const db = await PGlite.create(dataDir ? { dataDir } : undefined);

  const driver: SqlDriver = {
    async query<Row>(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
      const result = await db.query(sql, params as unknown[]);
      return result.rows as Row[];
    },

    async exec(sql: string): Promise<void> {
      await db.exec(sql);
    },

    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        return work({
          async query<Row>(sql: string, params: readonly unknown[] = []): Promise<Row[]> {
            return (await tx.query(sql, params as unknown[])).rows as Row[];
          },
          async exec(script: string): Promise<void> {
            await tx.exec(script);
          },
        });
      }) as Promise<T>;
    },

    async close() {
      await db.close();
    },
  };

  return driver;
}
