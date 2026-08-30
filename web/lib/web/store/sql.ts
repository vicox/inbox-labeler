import type { SqlDriver } from "../../db/driver.ts";
import type { SchemaModule } from "../../db/migrate.ts";
// The deployment's reference primitives: 32 bytes of CSPRNG output, and the
// SHA-256 that is all a table ever keeps of one. They live in the OAuth store
// because that is where they were first needed, and using the same construction
// here is deliberate — a session cookie is a bearer credential exactly like an
// authorization code, so it should be as unguessable and as unusable-from-a-
// database-copy as one. See `lib/oauth/store.ts` for the full argument.
import { reference, referenceHash } from "../../oauth/store.ts";
import { WEB_LOGIN_TTL_MS, WEB_SESSION_TTL_MS, type WebStore } from "../store.ts";

/**
 * The browser-session store in SQL.
 *
 * Two tables, and only one of them holds anything spent exactly once. A parked
 * sign-in is resumed with
 *
 *     DELETE FROM web_logins WHERE hash = $1 AND expires_at > $2 AND binding = $3 RETURNING …
 *
 * so the row is located, checked for expiry, matched against the browser that
 * started the sign-in, removed and returned indivisibly. Two requests presenting
 * the same `state` cannot both come away with it: the database serialises them on
 * the row, the first gets the returned row, the second matches nothing. A read
 * followed by a delete would look equivalent and would not be.
 *
 * A session needs none of that. It is presented many times rather than once, so
 * reading it is a plain indexed probe with the expiry in the WHERE clause, and
 * ending it is a plain delete. There is nothing to decide and therefore nothing
 * to lock.
 *
 * Both tables are keyed by the SHA-256 of the value the browser holds, never the
 * value: a copy of this database is not a set of working sessions. Whoever reads
 * it learns that somebody is signed in and cannot become them.
 */

export const WEB_SCHEMA: SchemaModule = {
  module: "web",
  migrations: [
    {
      version: 1,
      sql: `
        -- A sign-in in progress. No client, no redirect URI, no code challenge
        -- and no resource, because a browser sign-in has none of those — which is
        -- also why this is not a row in oauth_pending_logins.
        CREATE TABLE web_logins (
          reference_hash         bytea PRIMARY KEY,
          -- The hash of the cookie the browser was given. NOT NULL, so a sign-in
          -- that is not bound to a browser cannot be written at all.
          browser_hash           bytea NOT NULL,
          nonce                  text NOT NULL,
          provider_code_verifier text NOT NULL,
          expires_at             timestamptz NOT NULL
        );
        CREATE INDEX web_logins_expires_at ON web_logins (expires_at);

        -- A signed-in browser. The columns are the whole of what a session is
        -- allowed to know: whose it is, which address Google verified for them,
        -- and when it began and ends. There is nowhere to put a profile, a Google
        -- token, an address the browser visited or a record of what it read.
        CREATE TABLE web_sessions (
          session_hash bytea PRIMARY KEY,
          -- The same provider-qualified subject that keys inbox_labels, so a
          -- browser and an MCP client on one Google account are one owner.
          user_id      text NOT NULL,
          email        text NOT NULL,
          created_at   timestamptz NOT NULL,
          expires_at   timestamptz NOT NULL
        );
        CREATE INDEX web_sessions_expires_at ON web_sessions (expires_at);
      `,
    },
  ],
};

export function sqlWebStore(driver: SqlDriver): WebStore {
  /**
   * Deletes what has expired from one table.
   *
   * Opportunistic: it runs after a write, on the table just written to, so the
   * work is proportional to use and there is no background job whose failure
   * could go unnoticed. Failures are swallowed on purpose — housekeeping must
   * never be the reason a sign-in fails, and the next write will try again.
   */
  const sweep = async (table: string, now: number): Promise<void> => {
    try {
      await driver.query(`DELETE FROM ${table} WHERE expires_at <= $1`, [new Date(now)]);
    } catch {
      // Left to the next write.
    }
  };

  return {
    async parkLogin(login) {
      const value = reference();

      await driver.query(
        `INSERT INTO web_logins
           (reference_hash, browser_hash, nonce, provider_code_verifier, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          referenceHash(value),
          referenceHash(login.browserBinding),
          login.nonce,
          login.providerCodeVerifier,
          new Date(Date.now() + WEB_LOGIN_TTL_MS),
        ],
      );
      await sweep("web_logins", Date.now());
      return value;
    },

    async takeLogin(value, browserBinding, now = Date.now()) {
      const rows = await driver.query<PendingWebLoginRow>(
        // The binding is matched inside the statement that spends the reference,
        // so it is not a check a caller could skip.
        `DELETE FROM web_logins
          WHERE reference_hash = $1 AND expires_at > $2 AND browser_hash = $3
         RETURNING nonce, provider_code_verifier, expires_at`,
        [referenceHash(value), new Date(now), referenceHash(browserBinding)],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        nonce: row.nonce,
        providerCodeVerifier: row.provider_code_verifier,
        expiresAt: row.expires_at.getTime(),
      };
    },

    async createSession(session) {
      const value = reference();
      const now = Date.now();

      await driver.query(
        `INSERT INTO web_sessions (session_hash, user_id, email, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          referenceHash(value),
          session.user.id,
          session.email,
          new Date(now),
          new Date(now + WEB_SESSION_TTL_MS),
        ],
      );
      await sweep("web_sessions", now);
      return value;
    },

    async session(value, now = Date.now()) {
      // Expiry is in the WHERE clause rather than checked afterwards, so an
      // expired session is indistinguishable from an absent one at every call
      // site — there is no branch in which a caller could read a stale row and
      // decide for itself what to do about it.
      const rows = await driver.query<WebSessionRow>(
        `SELECT user_id, email, expires_at FROM web_sessions
          WHERE session_hash = $1 AND expires_at > $2`,
        [referenceHash(value), new Date(now)],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        user: { id: row.user_id },
        email: row.email,
        expiresAt: row.expires_at.getTime(),
      };
    },

    async endSession(value) {
      await driver.query(`DELETE FROM web_sessions WHERE session_hash = $1`, [
        referenceHash(value),
      ]);
    },

    async cleanup(now = Date.now()) {
      const at = new Date(now);
      let removed = 0;
      for (const table of ["web_logins", "web_sessions"]) {
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

type PendingWebLoginRow = {
  nonce: string;
  provider_code_verifier: string;
  expires_at: Date;
};

type WebSessionRow = {
  user_id: string;
  email: string;
  expires_at: Date;
};
