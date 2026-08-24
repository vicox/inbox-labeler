import {
  AUTHORIZATION_CODE_TTL_MS,
  PENDING_LOGIN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  reference,
  referenceHash,
  type OAuthStore,
  type RegisteredClient,
} from "../store.ts";

/**
 * The OAuth store in SQL, written once for anything that speaks Postgres.
 *
 * Every spend is a single statement:
 *
 *     DELETE FROM … WHERE hash = $1 AND expires_at > $2 RETURNING …
 *
 * That one line is the whole durability argument. The row is located, checked
 * for expiry, removed and returned indivisibly, so two requests presenting the
 * same authorization code — on two instances, in the same millisecond — cannot
 * both come away with it: the database serialises them on the row, the first
 * gets the returned row, the second matches nothing. A read followed by a delete
 * would look equivalent and would not be; the window between the two is exactly
 * the replay this shape removes. There is no application-level lock anywhere in
 * this file, and there does not need to be one.
 *
 * The same statement carries expiry, which is why cleanup can never be
 * load-bearing: a row past `expires_at` is not returned whether or not anything
 * has got round to deleting it.
 */

/**
 * The little a store needs from a database driver.
 *
 * Deliberately smaller than any real client's API, so that adding an adapter is
 * a day's work rather than a port and nothing in this file can reach for a
 * driver-specific feature.
 *
 * `query` and `exec` are separate because the wire protocol separates them.
 * `query` carries bound parameters, which makes it a prepared statement and
 * therefore exactly one command — every value the store handles goes through it,
 * always bound and never interpolated. `exec` runs a multi-statement script with
 * no parameters, which is what a migration is; putting DDL through `query`
 * fails, and putting a parameter through `exec` is impossible, so the split
 * keeps both honest.
 */
export type SqlDriver = {
  query<Row>(sql: string, params?: readonly unknown[]): Promise<Row[]>;
  /** Runs a parameterless script, which may contain several statements. */
  exec(sql: string): Promise<void>;
  /** Runs `work` in a transaction, rolling back if it throws. */
  transaction<T>(work: (tx: Pick<SqlDriver, "query" | "exec">) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** Postgres' unique-violation SQLSTATE, which the migration guard relies on. */
const UNIQUE_VIOLATION = "23505";

/**
 * The schema, as ordered migrations.
 *
 * SQL lives in this file rather than in `.sql` files on disk on purpose: a
 * route handler may be bundled or run somewhere with no filesystem to read,
 * and a migration that cannot be found at runtime is a migration that silently
 * does not run. Inline strings are always where the code is.
 *
 * Append to this list; never edit an entry that has shipped. A version already
 * recorded is never re-run, so changing one would leave two deployments
 * disagreeing about what the schema is.
 *
 * There are no foreign keys from a grant to its client, and that is a choice
 * rather than an omission. The tables have opposite lifetimes — a registration
 * is permanent, a grant lives for a minute — and nothing deletes a client, so a
 * key would only add a cascade nobody triggers. Which client a grant belongs to
 * is validated by the protocol layer before the row is written, and checked
 * again when it is spent.
 */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE oauth_clients (
        client_id     text PRIMARY KEY,
        redirect_uris text[] NOT NULL,
        client_name   text,
        registered_at timestamptz NOT NULL
      );

      -- Every grant table is keyed by the SHA-256 of the reference the client
      -- holds, never the reference itself: a copy of this database is not a set
      -- of usable credentials. The primary key is also what makes a spend
      -- atomic, since it is the index the DELETE locates its single row by.
      CREATE TABLE oauth_pending_logins (
        reference_hash         bytea PRIMARY KEY,
        client_id              text NOT NULL,
        redirect_uri           text NOT NULL,
        code_challenge         text NOT NULL,
        scope                  text NOT NULL,
        resource               text NOT NULL,
        client_state           text,
        nonce                  text NOT NULL,
        provider_code_verifier text NOT NULL,
        expires_at             timestamptz NOT NULL
      );
      CREATE INDEX oauth_pending_logins_expires_at ON oauth_pending_logins (expires_at);

      CREATE TABLE oauth_authorization_codes (
        code_hash      bytea PRIMARY KEY,
        client_id      text NOT NULL,
        redirect_uri   text NOT NULL,
        code_challenge text NOT NULL,
        scope          text NOT NULL,
        resource       text NOT NULL,
        user_id        text NOT NULL,
        expires_at     timestamptz NOT NULL
      );
      CREATE INDEX oauth_authorization_codes_expires_at ON oauth_authorization_codes (expires_at);

      CREATE TABLE oauth_refresh_tokens (
        token_hash bytea PRIMARY KEY,
        client_id  text NOT NULL,
        scope      text NOT NULL,
        resource   text NOT NULL,
        user_id    text NOT NULL,
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX oauth_refresh_tokens_expires_at ON oauth_refresh_tokens (expires_at);
    `,
  },
];

/**
 * Brings the schema up to date, safely from several instances at once.
 *
 * The guard is the migrations table's own primary key, not a lock. Each
 * migration inserts its version and runs its DDL in one transaction: two
 * instances starting together both try the insert, one blocks until the other
 * commits and then fails on the unique index, and rolls back — taking its DDL
 * with it, because Postgres rolls back DDL like anything else. What is left is
 * exactly one application of each version, with no advisory lock to acquire, to
 * hold, or to leak.
 *
 * Idempotent, so it is safe to run on every deploy and safe to run twice.
 */
export async function migrate(driver: SqlDriver): Promise<number> {
  await driver.exec(`
    CREATE TABLE IF NOT EXISTS oauth_schema_migrations (
      version    integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  let applied = 0;
  for (const migration of MIGRATIONS) {
    try {
      await driver.transaction(async (tx) => {
        await tx.query("INSERT INTO oauth_schema_migrations (version) VALUES ($1)", [migration.version]);
        await tx.exec(migration.sql);
      });
      applied += 1;
    } catch (error) {
      // Another instance got there first. Any other failure is a real problem
      // and must not be mistaken for one.
      if ((error as { code?: string }).code !== UNIQUE_VIOLATION) throw error;
    }
  }
  return applied;
}

export function sqlOAuthStore(driver: SqlDriver): OAuthStore {
  /**
   * Deletes what has expired from one table.
   *
   * Opportunistic: it runs after a write, on the table just written to, so the
   * work is proportional to use and there is no background job whose failure
   * could go unnoticed. Indexed on `expires_at`, so it is a range delete rather
   * than a scan. Failures are swallowed on purpose — housekeeping must never be
   * the reason a login fails, and the next write will try again.
   */
  const sweep = async (table: string, now: number): Promise<void> => {
    try {
      await driver.query(`DELETE FROM ${table} WHERE expires_at <= $1`, [new Date(now)]);
    } catch {
      // Left to the next write.
    }
  };

  return {
    async registerClient(client) {
      const registered: RegisteredClient = {
        ...client,
        // A fresh random id rather than anything derived from the metadata: two
        // clients that register identically are still two clients, and an id
        // predictable from a name would let one impersonate another.
        clientId: reference(),
        registeredAt: Date.now(),
      };

      await driver.query(
        `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, registered_at)
         VALUES ($1, $2, $3, $4)`,
        [
          registered.clientId,
          registered.redirectUris,
          registered.clientName ?? null,
          new Date(registered.registeredAt),
        ],
      );
      return registered;
    },

    async client(clientId) {
      const rows = await driver.query<ClientRow>(
        `SELECT client_id, redirect_uris, client_name, registered_at
         FROM oauth_clients WHERE client_id = $1`,
        [clientId],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        clientId: row.client_id,
        redirectUris: row.redirect_uris,
        clientName: row.client_name ?? undefined,
        registeredAt: row.registered_at.getTime(),
      };
    },

    async parkLogin(login) {
      const value = reference();
      const expiresAt = Date.now() + PENDING_LOGIN_TTL_MS;

      await driver.query(
        `INSERT INTO oauth_pending_logins
           (reference_hash, client_id, redirect_uri, code_challenge, scope, resource,
            client_state, nonce, provider_code_verifier, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          referenceHash(value),
          login.clientId,
          login.redirectUri,
          login.codeChallenge,
          login.scope,
          login.resource,
          login.clientState ?? null,
          login.nonce,
          login.providerCodeVerifier,
          new Date(expiresAt),
        ],
      );
      await sweep("oauth_pending_logins", Date.now());
      return value;
    },

    async takeLogin(value, now = Date.now()) {
      const rows = await driver.query<PendingLoginRow>(
        `DELETE FROM oauth_pending_logins
         WHERE reference_hash = $1 AND expires_at > $2
         RETURNING client_id, redirect_uri, code_challenge, scope, resource,
                   client_state, nonce, provider_code_verifier, expires_at`,
        [referenceHash(value), new Date(now)],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
        clientState: row.client_state ?? undefined,
        nonce: row.nonce,
        providerCodeVerifier: row.provider_code_verifier,
        expiresAt: row.expires_at.getTime(),
      };
    },

    async issueCode(code) {
      const value = reference();
      const expiresAt = Date.now() + AUTHORIZATION_CODE_TTL_MS;

      await driver.query(
        `INSERT INTO oauth_authorization_codes
           (code_hash, client_id, redirect_uri, code_challenge, scope, resource, user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          referenceHash(value),
          code.clientId,
          code.redirectUri,
          code.codeChallenge,
          code.scope,
          code.resource,
          code.userId,
          new Date(expiresAt),
        ],
      );
      await sweep("oauth_authorization_codes", Date.now());
      return value;
    },

    async redeemCode(value, now = Date.now()) {
      const rows = await driver.query<AuthorizationCodeRow>(
        `DELETE FROM oauth_authorization_codes
         WHERE code_hash = $1 AND expires_at > $2
         RETURNING client_id, redirect_uri, code_challenge, scope, resource, user_id, expires_at`,
        [referenceHash(value), new Date(now)],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        codeChallenge: row.code_challenge,
        scope: row.scope,
        resource: row.resource,
        userId: row.user_id,
        expiresAt: row.expires_at.getTime(),
      };
    },

    async issueRefreshToken(token) {
      const value = reference();
      const expiresAt = Date.now() + REFRESH_TOKEN_TTL_MS;

      await driver.query(
        `INSERT INTO oauth_refresh_tokens
           (token_hash, client_id, scope, resource, user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          referenceHash(value),
          token.clientId,
          token.scope,
          token.resource,
          token.userId,
          new Date(expiresAt),
        ],
      );
      await sweep("oauth_refresh_tokens", Date.now());
      return value;
    },

    async redeemRefreshToken(value, now = Date.now()) {
      const rows = await driver.query<RefreshTokenRow>(
        `DELETE FROM oauth_refresh_tokens
         WHERE token_hash = $1 AND expires_at > $2
         RETURNING client_id, scope, resource, user_id, expires_at`,
        [referenceHash(value), new Date(now)],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        clientId: row.client_id,
        scope: row.scope,
        resource: row.resource,
        userId: row.user_id,
        expiresAt: row.expires_at.getTime(),
      };
    },

    async cleanup(now = Date.now()) {
      const at = new Date(now);
      let removed = 0;
      for (const table of [
        "oauth_pending_logins",
        "oauth_authorization_codes",
        "oauth_refresh_tokens",
      ]) {
        const rows = await driver.query<{ id: unknown }>(
          `DELETE FROM ${table} WHERE expires_at <= $1 RETURNING 1 AS id`,
          [at],
        );
        removed += rows.length;
      }
      return removed;
    },
  };
}

type ClientRow = {
  client_id: string;
  redirect_uris: string[];
  client_name: string | null;
  registered_at: Date;
};

type PendingLoginRow = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  client_state: string | null;
  nonce: string;
  provider_code_verifier: string;
  expires_at: Date;
};

type AuthorizationCodeRow = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  user_id: string;
  expires_at: Date;
};

type RefreshTokenRow = {
  client_id: string;
  scope: string;
  resource: string;
  user_id: string;
  expires_at: Date;
};
