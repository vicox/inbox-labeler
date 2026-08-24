import { ConfigurationError } from "./oauth/config.ts";
import type { SqlDriver } from "./db/driver.ts";

/**
 * The database this deployment uses, opened once.
 *
 * One connection for everything stored here. There are two independent schemas
 * — the OAuth flow state and InboxLabeler's labels and match history — and they
 * are kept apart by their tables and their migrations, not by each opening its
 * own pool. A pool per schema would double the connections every instance holds
 * against a managed Postgres for no benefit, which is the sort of thing that
 * only shows up once several instances are running.
 *
 * Cached as a promise rather than a value so that concurrent first requests
 * share one pool instead of racing to build their own — but only once it has
 * resolved. A rejected promise is forgotten, because caching one would turn a
 * single transient failure into a permanently broken instance: a database that
 * was briefly waking up, or a pool that timed out on the very first request,
 * would poison every request afterwards until the instance happened to be
 * recycled.
 *
 * `ConfigurationError` comes from the OAuth configuration module because that is
 * where this deployment's configuration lives; the error means the same thing
 * here — something the operator has to fix, answered as a server fault rather
 * than blamed on the client.
 */
let opening: Promise<SqlDriver> | undefined;

export function database(): Promise<SqlDriver> {
  opening ??= open().catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

/**
 * Chooses the driver, and refuses to guess in production.
 *
 * `DATABASE_URL` is the switch. With it, Postgres; without it, the embedded
 * Postgres that makes `npm run dev` work with nothing installed. In production
 * its absence is a configuration error rather than a fallback — quietly running
 * a hosted deployment on a store that a restart or a second instance would
 * invalidate is exactly the failure durable storage exists to remove, and it is
 * worse for being silent.
 *
 * Both drivers are loaded on demand, so a deployment pays for neither the one it
 * does not use nor a connection it has not needed yet.
 */
async function open(): Promise<SqlDriver> {
  const url = process.env.DATABASE_URL?.trim();

  if (url) {
    const { postgresDriver } = await import("./db/postgres.ts");
    return postgresDriver(url);
  }

  if (process.env.NODE_ENV === "production") {
    throw new ConfigurationError(
      "DATABASE_URL is not set. InboxLabeler needs durable storage in production: a restart or a second instance would otherwise invalidate every login in progress and lose every label. See web/.env.example.",
    );
  }

  const { embeddedDriver } = await import("./db/pglite.ts");
  return embeddedDriver(process.env.DEV_DATABASE_DIR);
}
