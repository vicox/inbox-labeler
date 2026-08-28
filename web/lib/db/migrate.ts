import { ConfigurationError } from "../oauth/config.ts";
import { UNIQUE_VIOLATION, isSqlState, type SqlDriver } from "./driver.ts";

/**
 * One migration mechanism, for every schema in the database.
 *
 * There are two independent schemas — the OAuth flow state and InboxLabeler's
 * own labels and match history — and they have no business sharing a version
 * sequence: a change to one should not renumber the other, and either must be
 * able to move without the other being touched. So a migration is identified by
 * a module *and* a version, and each module counts from one.
 *
 * The guard against two instances migrating at once is the tracking table's own
 * primary key, not a lock. Each migration inserts its row and runs its DDL in
 * one transaction: two instances starting together both try the insert, one
 * blocks until the other commits and then fails on the primary key, and rolls
 * back — taking its DDL with it, because Postgres rolls back DDL like anything
 * else. Exactly one application of each version, with no advisory lock to
 * acquire, hold, or leak.
 */

/** One step, and the SQL that takes it. */
export type Migration = { version: number; sql: string };

/**
 * A named schema and its ordered steps.
 *
 * Append to `migrations`; never edit an entry that has shipped. A version
 * already recorded is never re-run, so changing one would leave two deployments
 * disagreeing about what the schema is.
 */
export type SchemaModule = { module: string; migrations: readonly Migration[] };

/**
 * Makes a module's schema ready to use, in the way this environment allows.
 *
 * The two environments do genuinely different things here, and that is the point
 * of the function existing:
 *
 *   development   migrate, so a checkout works after `npm install` and a schema
 *                 change is picked up by whichever process needs it.
 *
 *   production    check, and refuse. A request from the internet must never be
 *                 what causes DDL to run: the first request after a deploy would
 *                 be an arbitrary one, several instances would race to be it, and
 *                 a migration failing halfway would do so inside somebody's page
 *                 load with nobody watching. Schema changes are a step an operator
 *                 takes — `npm run db:migrate` — and this is where a deployment
 *                 that skipped it says so instead of guessing.
 *
 * The production path reads one row and writes nothing, not even the tracking
 * table: a missing tracking table is itself the answer, so creating it would be
 * the very DDL this exists to avoid.
 */
export async function prepareSchema(driver: SqlDriver, schema: SchemaModule): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    await migrate(driver, schema);
    return;
  }
  await requireSchema(driver, schema);
}

/**
 * Refuses unless every migration this code needs has already been applied.
 *
 * Named versions rather than a count, so a database migrated by a *newer* deploy
 * than this one still satisfies an older instance — which is what a rollback looks
 * like, and it should not be an outage.
 */
async function requireSchema(driver: SqlDriver, schema: SchemaModule): Promise<void> {
  const wanted = schema.migrations.map((migration) => migration.version);
  if (!wanted.length) return;

  // Asked as its own question first, because a statement naming a table that does
  // not exist fails when Postgres plans it — a WHERE clause guarding the reference
  // never gets the chance to be false.
  const [tracking] = await driver.query<{ present: boolean }>(
    "SELECT to_regclass('schema_migrations') IS NOT NULL AS present",
  );

  const applied = tracking?.present
    ? (
        await driver.query<{ version: number }>(
          "SELECT version FROM schema_migrations WHERE module = $1",
          [schema.module],
        )
      ).map((row) => row.version)
    : [];

  const missing = wanted.filter((version) => !applied.includes(version));
  if (missing.length) {
    throw new ConfigurationError(
      `The ${schema.module} schema is not up to date: migration(s) ` +
        `${missing.join(", ")} have not been applied. Run \`npm run db:migrate\` against ` +
        `this deployment's DATABASE_URL before the new code serves traffic. ` +
        `Production never migrates from a request.`,
    );
  }
}

/**
 * Brings one module's schema up to date, returning how many steps ran.
 *
 * Idempotent, so it is safe on every deploy and safe twice. Called by
 * `npm run db:migrate`, and by `prepareSchema` outside production.
 */
export async function migrate(driver: SqlDriver, schema: SchemaModule): Promise<number> {
  await ensureTrackingTable(driver);

  let applied = 0;
  for (const migration of schema.migrations) {
    try {
      await driver.transaction(async (tx) => {
        await tx.query("INSERT INTO schema_migrations (module, version) VALUES ($1, $2)", [
          schema.module,
          migration.version,
        ]);
        await tx.exec(migration.sql);
      });
      applied += 1;
    } catch (error) {
      // Another instance got there first. Any other failure is a real problem
      // and must not be mistaken for one.
      if (!isSqlState(error, UNIQUE_VIOLATION)) throw error;
    }
  }
  return applied;
}

/**
 * Creates the tracking table, and adopts what an earlier one recorded.
 *
 * The first version of this code tracked only OAuth migrations, in a table of
 * its own with no module column. A database written by it has the OAuth tables
 * already, so re-running that migration would fail on `relation already exists`
 * — not the unique violation the guard above forgives — and take the deployment
 * down on boot. Copying the old rows across first makes the new table agree that
 * the work is done. The old table is left alone rather than dropped: it is
 * harmless, and dropping it would make this step the one thing that cannot be
 * run twice.
 */
async function ensureTrackingTable(driver: SqlDriver): Promise<void> {
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      module     text NOT NULL,
      version    integer NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (module, version)
    );
  `);

  // Asked as its own question first, because a statement naming a table that
  // does not exist fails when Postgres plans it — a WHERE clause guarding the
  // reference never gets the chance to be false.
  const [legacy] = await driver.query<{ present: boolean }>(
    "SELECT to_regclass('oauth_schema_migrations') IS NOT NULL AS present",
  );
  if (!legacy?.present) return;

  await driver.exec(`
    INSERT INTO schema_migrations (module, version)
    SELECT 'oauth', version FROM oauth_schema_migrations
    ON CONFLICT DO NOTHING;
  `);
}
