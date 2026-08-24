/**
 * `npm run db:migrate` — brings the OAuth schema up to date.
 *
 * A deployment should run this before the new code starts serving, so that the
 * schema change is a step someone ordered rather than a side effect of whichever
 * instance happened to boot first. Opening the store migrates too, so a missed
 * run is not an outage — but only the command can be placed in a deploy.
 *
 * Idempotent and safe to run concurrently — see `migrate` for how the
 * migrations table's own primary key does that without a lock.
 */
import { migrate } from "./sql.ts";

const url = process.env.DATABASE_URL?.trim();

async function main(): Promise<void> {
  const driver = url
    ? await (await import("./postgres.ts")).postgresDriver(url)
    : await (await import("./pglite.ts")).embeddedDriver(process.env.OAUTH_STORE_DIR);

  try {
    const applied = await migrate(driver);
    const target = url ? "DATABASE_URL" : (process.env.OAUTH_STORE_DIR ?? "an in-memory database");
    console.log(
      applied === 0
        ? `OAuth schema is up to date (${target}).`
        : `Applied ${applied} OAuth migration(s) (${target}).`,
    );
  } finally {
    await driver.close();
  }
}

await main();
