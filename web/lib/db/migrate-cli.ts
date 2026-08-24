/**
 * `npm run db:migrate` — brings every schema in the database up to date.
 *
 * A deployment should run this before the new code starts serving, so that a
 * schema change is a step someone ordered rather than a side effect of whichever
 * instance booted first. Opening a store migrates its own schema too, so a
 * missed run is not an outage — but only the command can be placed in a deploy.
 *
 * Idempotent and safe to run concurrently: see `migrate` for how the tracking
 * table's own primary key does that without a lock.
 */
import { migrate, type SchemaModule } from "./migrate.ts";
import { INBOX_SCHEMA } from "../inbox/store/sql.ts";
import { OAUTH_SCHEMA } from "../oauth/store/sql.ts";
import type { SqlDriver } from "./driver.ts";

/** Every schema, in no particular order: they share no version sequence. */
const SCHEMAS: readonly SchemaModule[] = [OAUTH_SCHEMA, INBOX_SCHEMA];

const url = process.env.DATABASE_URL?.trim();

/**
 * The embedded database is opt-in, and only ever by saying so.
 *
 * Falling back to it when `DATABASE_URL` is absent is the wrong default for a
 * command that exists to change a schema: a deploy step whose variable failed to
 * reach it would report success having migrated a database that lives for the
 * length of the process, and the real one would stay untouched with nothing to
 * say so. So the absence of a connection string is an error, and reaching the
 * development database takes an explicit flag.
 */
const EMBEDDED_FLAG = "--embedded";
const embedded = process.argv.includes(EMBEDDED_FLAG);

async function main(): Promise<void> {
  if (!url && !embedded) {
    console.error(
      "DATABASE_URL is not set.\n\n" +
        "Migrations must name the database they change. Set DATABASE_URL to the\n" +
        `database to migrate, or pass ${EMBEDDED_FLAG} to migrate the local development\n` +
        "database instead.",
    );
    process.exitCode = 1;
    return;
  }
  if (url && embedded) {
    console.error(
      `Both DATABASE_URL and ${EMBEDDED_FLAG} were given, and they name different\n` +
        "databases. Pass one.",
    );
    process.exitCode = 1;
    return;
  }

  const driver: SqlDriver = url
    ? await (await import("./postgres.ts")).postgresDriver(url)
    : await (await import("./pglite.ts")).embeddedDriver(process.env.DEV_DATABASE_DIR);

  const target = url
    ? "DATABASE_URL"
    : (process.env.DEV_DATABASE_DIR ?? "an in-memory development database");
  try {
    let total = 0;
    for (const schema of SCHEMAS) {
      const applied = await migrate(driver, schema);
      total += applied;
      if (applied > 0) console.log(`  ${schema.module}: applied ${applied} migration(s)`);
    }
    console.log(
      total === 0 ? `Schema is up to date (${target}).` : `Applied ${total} migration(s) (${target}).`,
    );
  } finally {
    await driver.close();
  }
}

await main();
