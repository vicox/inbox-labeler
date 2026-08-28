import type { SqlDriver } from "../../db/driver.ts";
import type { SchemaModule } from "../../db/migrate.ts";
import {
  AUTHORIZATION_CODE_TTL_MS,
  CLIENT_RETENTION_MS,
  PENDING_LOGIN_TTL_MS,
  RATE_LIMIT_RETENTION_MS,
  REFRESH_TOKEN_TTL_MS,
  reference,
  referenceHash,
  type AuthorizationCode,
  type CodeRedemption,
  type OAuthStore,
  type RefreshGrant,
  type RefreshRotation,
  type RegisteredClient,
} from "../store.ts";

/**
 * The OAuth store in SQL, written once for anything that speaks Postgres.
 *
 * Everything here is single-use, and the whole durability argument is about how
 * a thing gets spent exactly once. There are two shapes, and which one applies
 * depends on whether spending it involves a decision.
 *
 * **Nothing to decide: one statement.** A parked login is resumed with
 *
 *     DELETE FROM … WHERE hash = $1 AND expires_at > $2 AND binding … RETURNING …
 *
 * The row is located, checked for expiry, matched against its browser binding,
 * removed and returned indivisibly. Two requests presenting the same reference —
 * on two instances, in the same millisecond — cannot both come away with it: the
 * database serialises them on the row, the first gets the returned row, the
 * second matches nothing. A read followed by a delete would look equivalent and
 * would not be; the window between the two is exactly the replay this removes.
 *
 * **Something to decide: lock, decide, then spend.** An authorization code and a
 * refresh token both carry constraints that the request has to satisfy — which
 * client, which redirect URI, which verifier, which resource, which scope — and
 * those cannot be expressed as a WHERE clause without teaching this file the
 * protocol. Deciding them *after* a `DELETE … RETURNING` would mean a request
 * that was never going to succeed had already consumed somebody's credential on
 * its way to being refused. So instead:
 *
 *     SELECT … WHERE hash = $1 FOR UPDATE     -- located and locked, nothing spent
 *     …expiry, replay, and the caller's own check…
 *     DELETE / UPDATE … INSERT successor      -- only now, in the same transaction
 *
 * `FOR UPDATE` is what makes the gap safe. A concurrent spend of the same row
 * blocks at the SELECT until this transaction ends, and then sees what happened
 * rather than racing past it — a deleted code as absent, a spent refresh token as
 * spent. Exactly one caller gets through, and a refusal costs the holder nothing.
 *
 * The two consume differently, on purpose. A code is deleted, so a second
 * presentation simply finds nothing. A refresh token is *marked* spent and its
 * successor inserted in the same transaction, because a deleted row cannot tell
 * the difference between a token that never existed and one that was already
 * used — and that difference is what makes replay detectable, and the family
 * revocable when it is detected.
 *
 * There is no application-level lock anywhere in this file, and no advisory lock:
 * the row is the only thing anything waits on.
 *
 * Expiry is checked on every read, which is why cleanup can never be
 * load-bearing: a row past `expires_at` is refused whether or not anything has
 * got round to deleting it.
 */

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
export const OAUTH_SCHEMA: SchemaModule = {
  module: "oauth",
  migrations: [
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
    {
      // Refresh tokens become chains rather than isolated values, so that reusing
      // one that has already been rotated is something the store can *notice*
      // rather than merely refuse. A grant's details move to the family, because
      // they never differ between the tokens in one chain — which client, which
      // user, which scope, which resource are properties of the authorization,
      // not of the credential that happens to represent it right now.
      version: 2,
      sql: `
        CREATE TABLE oauth_refresh_families (
          family_id  text PRIMARY KEY,
          client_id  text NOT NULL,
          user_id    text NOT NULL,
          scope      text NOT NULL,
          resource   text NOT NULL,
          -- Set when a replay is detected. The row outlives its tokens so that a
          -- second replay is still recognised as one rather than as a stranger.
          revoked_at timestamptz,
          expires_at timestamptz NOT NULL
        );
        CREATE INDEX oauth_refresh_families_expires_at ON oauth_refresh_families (expires_at);

        ALTER TABLE oauth_refresh_tokens
          ADD COLUMN family_id text,
          -- Spending is now a mark rather than a deletion: a deleted row cannot
          -- tell the difference between a token that never existed and one that
          -- was already used, and that difference is the whole point.
          ADD COLUMN spent_at timestamptz;

        -- Every token that already exists becomes a family of one, so nobody
        -- holding a refresh token is logged out by this migration.
        INSERT INTO oauth_refresh_families (family_id, client_id, user_id, scope, resource, expires_at)
          SELECT encode(token_hash, 'hex'), client_id, user_id, scope, resource, expires_at
            FROM oauth_refresh_tokens;
        UPDATE oauth_refresh_tokens SET family_id = encode(token_hash, 'hex');

        ALTER TABLE oauth_refresh_tokens
          ALTER COLUMN family_id SET NOT NULL,
          ADD CONSTRAINT oauth_refresh_tokens_family
            FOREIGN KEY (family_id) REFERENCES oauth_refresh_families (family_id)
            ON DELETE CASCADE,
          DROP COLUMN client_id,
          DROP COLUMN user_id,
          DROP COLUMN scope,
          DROP COLUMN resource;

        CREATE INDEX oauth_refresh_tokens_family ON oauth_refresh_tokens (family_id);
      `,
    },
    {
      // Each pause in the flow is bound to the browser walking through it. Without
      // this the reference is enough on its own, and an attacker who made the
      // request holds it — so they can have someone else's browser use it.
      //
      // The column is named for the pause it was introduced for and now carries
      // the binding of whichever pause parked the row: the consent binding on the
      // first park, a fresh provider-leg binding on the second. It is left
      // nullable as it shipped — the application requires a binding on every park
      // and presents one on every take, so no row written by current code can have
      // a null here, and a rename would break an in-flight approval during the
      // window between migrating and deploying. See lib/oauth/flow-binding.ts.
      version: 3,
      sql: `
        ALTER TABLE oauth_pending_logins ADD COLUMN consent_session_hash bytea;
      `,
    },
    {
      // Somewhere to count requests against, so that open registration has a
      // ceiling. One row per bucket, replaced as each window rolls over.
      version: 4,
      sql: `
        CREATE TABLE oauth_rate_limits (
          bucket       text PRIMARY KEY,
          window_start timestamptz NOT NULL,
          count        integer NOT NULL
        );
        CREATE INDEX oauth_rate_limits_window_start ON oauth_rate_limits (window_start);
      `,
    },
    {
      // When each client was last put to use, so that a registration nobody ever
      // came back for can age out. Everything else here expires; this table was
      // the one that only grew, and open registration means whoever wants to can
      // make it grow.
      //
      // Existing rows are seeded with `now()` rather than with `registered_at`,
      // which is the difference between a safe migration and one that deletes
      // working clients. Nothing recorded use before this column existed, so a
      // client registered longer ago than the retention window would otherwise be
      // swept on the first registration after the migration — while still in
      // active use, because using it is exactly what was never recorded. Seeding
      // from the migration gives every existing client a full window in which to
      // prove itself, and costs one row per abandoned registration for one window.
      version: 5,
      sql: `
        ALTER TABLE oauth_clients ADD COLUMN last_used_at timestamptz;
        UPDATE oauth_clients SET last_used_at = now() WHERE last_used_at IS NULL;
        ALTER TABLE oauth_clients
          ALTER COLUMN last_used_at SET NOT NULL,
          ALTER COLUMN last_used_at SET DEFAULT now();
        CREATE INDEX oauth_clients_last_used_at ON oauth_clients (last_used_at);
      `,
    },
  ],
};

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
  /**
   * Drops rate-limit buckets nobody has touched for a day.
   *
   * Separate from `sweep` because this table ages out by `window_start` rather
   * than expiring by `expires_at`. Failures are swallowed for the same reason:
   * housekeeping must never be why a request is refused, and the next call will
   * try again.
   */
  const sweepBuckets = async (now: number): Promise<void> => {
    try {
      await driver.query(`DELETE FROM oauth_rate_limits WHERE window_start <= $1`, [
        new Date(now - RATE_LIMIT_RETENTION_MS),
      ]);
    } catch {
      // Left to the next call.
    }
  };

  /**
   * Drops client registrations nobody has used for the retention window.
   *
   * Separate from `sweep` because this table ages out by `last_used_at` rather
   * than expiring by `expires_at`, and because a client is not a credential — it
   * is a registration that a lapsed client re-creates on its own. Failures are
   * swallowed for the same reason as every other sweep here.
   */
  const sweepClients = async (now: number): Promise<void> => {
    try {
      await driver.query(`DELETE FROM oauth_clients WHERE last_used_at <= $1`, [
        new Date(now - CLIENT_RETENTION_MS),
      ]);
    } catch {
      // Left to the next registration.
    }
  };

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
        `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, registered_at, last_used_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [
          registered.clientId,
          registered.redirectUris,
          registered.clientName ?? null,
          new Date(registered.registeredAt),
        ],
      );
      // On the way past, and only here: this is the write that makes the table
      // grow, so it is the write that pays for keeping it bounded. Indexed on
      // last_used_at, so it is a range delete rather than a scan.
      await sweepClients(Date.now());
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

    async parkLogin(login, browserBinding) {
      const value = reference();
      const expiresAt = Date.now() + PENDING_LOGIN_TTL_MS;

      await driver.query(
        `INSERT INTO oauth_pending_logins
           (reference_hash, client_id, redirect_uri, code_challenge, scope, resource,
            client_state, nonce, provider_code_verifier, expires_at, consent_session_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
          // Only the hash, like every other reference here: a copy of the
          // database must not be a set of usable browser bindings.
          referenceHash(browserBinding),
        ],
      );
      await sweep("oauth_pending_logins", Date.now());

      // An authorization was started for this client, which is what "used" means.
      // Deliberately not on `client()`: a token request quotes an id it was given,
      // and a stranger guessing at ids must not be able to keep a registration
      // alive. Failures are swallowed — housekeeping must never fail a login.
      try {
        await driver.query(`UPDATE oauth_clients SET last_used_at = $2 WHERE client_id = $1`, [
          login.clientId,
          new Date(),
        ]);
      } catch {
        // Left to the next authorization.
      }
      return value;
    },

    async takeLogin(value, browserBinding, now = Date.now()) {
      const rows = await driver.query<PendingLoginRow>(
        // The binding is matched inside the statement that spends the reference,
        // so it is not a check a caller could skip — and a mismatch matches no
        // row, which means it deletes nothing: the browser that legitimately
        // parked this record can still resume it after somebody else has tried.
        // `IS NOT DISTINCT FROM` keeps the comparison symmetric about null, so a
        // row written before bindings were required cannot be taken with one.
        `DELETE FROM oauth_pending_logins
         WHERE reference_hash = $1 AND expires_at > $2
           AND consent_session_hash IS NOT DISTINCT FROM $3
         RETURNING client_id, redirect_uri, code_challenge, scope, resource,
                   client_state, nonce, provider_code_verifier, expires_at`,
        [referenceHash(value), new Date(now), referenceHash(browserBinding)],
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

    async redeemCode(value, acceptable, now = Date.now()) {
      const at = new Date(now);
      const presented = referenceHash(value);

      return driver.transaction<CodeRedemption>(async (tx) => {
        // Locked, not merely read. `FOR UPDATE` is what lets the check below run
        // before the code is consumed without opening a gap: a concurrent
        // redemption of the same code blocks here until this transaction ends,
        // and then finds the row gone rather than racing past it.
        const found = await tx.query<AuthorizationCodeRow>(
          `SELECT client_id, redirect_uri, code_challenge, scope, resource, user_id, expires_at
             FROM oauth_authorization_codes
            WHERE code_hash = $1
            FOR UPDATE`,
          [presented],
        );
        const row = found[0];
        if (!row || row.expires_at <= at) return { outcome: "unknown" };

        const grant = codeOf(row);

        // The caller's own rules, while the row is still untouched. A refusal
        // here returns without consuming anything, so the client that actually
        // holds the code can still redeem it.
        const refusal = acceptable(grant);
        if (refusal) return { outcome: "refused", grant, refusal };

        // Consumed by deletion, which is what keeps a code single-use: a second
        // presentation finds nothing, and there is no spent row to reason about.
        await tx.query(`DELETE FROM oauth_authorization_codes WHERE code_hash = $1`, [presented]);

        return { outcome: "redeemed", grant };
      });
    },

    async issueRefreshToken(grant) {
      const value = reference();
      const family = reference();
      const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS);

      // The family and its first token in one transaction: a family with no
      // token would be a grant nothing can exercise, and a token with no family
      // cannot exist at all — the foreign key says so.
      await driver.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO oauth_refresh_families
             (family_id, client_id, user_id, scope, resource, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [family, grant.clientId, grant.userId, grant.scope, grant.resource, expiresAt],
        );
        await tx.query(
          `INSERT INTO oauth_refresh_tokens (token_hash, family_id, expires_at)
           VALUES ($1, $2, $3)`,
          [referenceHash(value), family, expiresAt],
        );
      });

      await sweep("oauth_refresh_families", Date.now());
      return value;
    },

    async rotateRefreshToken(value, acceptable, now = Date.now()) {
      const at = new Date(now);
      const presented = referenceHash(value);

      return driver.transaction<RefreshRotation>(async (tx) => {
        // Locked, not merely read. `FOR UPDATE` is what lets the check below run
        // before the spend without opening a gap: a concurrent rotation of the
        // same token blocks here until this transaction ends, and then sees the
        // row as spent rather than racing past it.
        const found = await tx.query<TokenRow>(
          `SELECT t.spent_at, t.expires_at,
                  f.family_id, f.client_id, f.user_id, f.scope, f.resource,
                  f.revoked_at, f.expires_at AS family_expires_at
             FROM oauth_refresh_tokens t
             JOIN oauth_refresh_families f ON f.family_id = t.family_id
            WHERE t.token_hash = $1
            FOR UPDATE OF t`,
          [presented],
        );
        const row = found[0];
        if (!row) return { outcome: "unknown" };

        // A token that was already rotated has been presented again. Checked
        // before anything else about the request, because a replay is a replay
        // whoever sends it and whatever else they got wrong.
        if (row.spent_at) {
          await tx.query(
            `UPDATE oauth_refresh_families SET revoked_at = COALESCE(revoked_at, $2)
              WHERE family_id = $1`,
            [row.family_id, at],
          );
          await tx.query(`DELETE FROM oauth_refresh_tokens WHERE family_id = $1`, [row.family_id]);
          return { outcome: "replayed", grant: grantOf(row) };
        }

        if (row.revoked_at || row.expires_at <= at || row.family_expires_at <= at) {
          return { outcome: "unknown" };
        }

        // The caller's own rules, while the row is still untouched. A refusal
        // here returns without spending anything.
        const refusal = acceptable(grantOf(row));
        if (refusal) return { outcome: "refused", grant: grantOf(row), refusal };

        await tx.query(`UPDATE oauth_refresh_tokens SET spent_at = $2 WHERE token_hash = $1`, [
          presented,
          at,
        ]);

        // The successor, in the same transaction as the spend. There is no
        // instant in which the grant has no usable token, and no way for a
        // failure after this point to leave one spent with nothing to replace it.
        const successor = reference();
        await tx.query(
          `INSERT INTO oauth_refresh_tokens (token_hash, family_id, expires_at)
           VALUES ($1, $2, $3)`,
          [referenceHash(successor), row.family_id, row.family_expires_at],
        );

        return { outcome: "rotated", grant: grantOf(row), refreshToken: successor };
      });
    },

    async consumeRateLimit(bucket, limit, windowMs, now = Date.now()) {
      const at = new Date(now);
      const windowStart = new Date(now - windowMs);

      // One statement, so two simultaneous requests cannot both read the same
      // count. The window rolls over inside the upsert: a row whose window has
      // aged out is reset to this request rather than deleted and re-inserted.
      const rows = await driver.query<{ count: number }>(
        `INSERT INTO oauth_rate_limits (bucket, window_start, count)
         VALUES ($1, $2, 1)
         ON CONFLICT (bucket) DO UPDATE SET
           window_start = CASE
             WHEN oauth_rate_limits.window_start <= $3 THEN $2
             ELSE oauth_rate_limits.window_start END,
           count = CASE
             WHEN oauth_rate_limits.window_start <= $3 THEN 1
             ELSE oauth_rate_limits.count + 1 END
         RETURNING count`,
        [bucket, at, windowStart],
      );

      // Aged-out buckets go on the way past, which is the only sweep this table
      // gets: it is written on every call to an open endpoint, so the work is
      // proportional to use and there is no background job whose failure could
      // leave it growing unnoticed. Indexed on `window_start`, so it is a range
      // delete rather than a scan, and it can never touch a live bucket — a
      // bucket in use has a window_start far newer than the retention horizon.
      await sweepBuckets(now);

      return (rows[0]?.count ?? Number.MAX_SAFE_INTEGER) <= limit;
    },

    async cleanup(now = Date.now()) {
      const at = new Date(now);
      let removed = 0;
      for (const table of [
        "oauth_pending_logins",
        "oauth_authorization_codes",
        "oauth_refresh_tokens",
        // Families last, so their tokens have already gone by their own expiry
        // rather than by cascade — the count then reflects what actually expired.
        "oauth_refresh_families",
      ]) {
        const rows = await driver.query<{ id: unknown }>(
          `DELETE FROM ${table} WHERE expires_at <= $1 RETURNING 1 AS id`,
          [at],
        );
        removed += rows.length;
      }

      // Rate-limit buckets have a window rather than an expiry, so they are aged
      // out rather than expired. A bucket nobody has touched for a day cannot be
      // inside any window this server uses, and keeping it would let the table
      // grow with every address that ever called.
      const buckets = await driver.query<{ id: unknown }>(
        `DELETE FROM oauth_rate_limits WHERE window_start <= $1 RETURNING 1 AS id`,
        [new Date(now - RATE_LIMIT_RETENTION_MS)],
      );
      removed += buckets.length;

      // Client registrations age out the same way, by last use rather than by an
      // expiry of their own.
      const clients = await driver.query<{ id: unknown }>(
        `DELETE FROM oauth_clients WHERE last_used_at <= $1 RETURNING 1 AS id`,
        [new Date(now - CLIENT_RETENTION_MS)],
      );
      removed += clients.length;

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

function codeOf(row: AuthorizationCodeRow): AuthorizationCode {
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    scope: row.scope,
    resource: row.resource,
    userId: row.user_id,
    expiresAt: row.expires_at.getTime(),
  };
}

/** A refresh token joined to the family that gives it meaning. */
type TokenRow = {
  spent_at: Date | null;
  expires_at: Date;
  family_id: string;
  client_id: string;
  user_id: string;
  scope: string;
  resource: string;
  revoked_at: Date | null;
  family_expires_at: Date;
};

function grantOf(row: Pick<TokenRow, "client_id" | "user_id" | "scope" | "resource">): RefreshGrant {
  return {
    clientId: row.client_id,
    userId: row.user_id,
    scope: row.scope,
    resource: row.resource,
  };
}
