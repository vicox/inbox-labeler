import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import {
  AUTHORIZATION_CODE_TTL_MS,
  PENDING_LOGIN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  referenceHash,
  type OAuthStore,
} from "./store.ts";
import { embeddedDriver } from "../db/pglite.ts";
import type { SqlDriver } from "../db/driver.ts";
import { migrate } from "../db/migrate.ts";
import { OAUTH_SCHEMA, sqlOAuthStore } from "./store/sql.ts";

/**
 * The durable store, driven the way the OAuth endpoints drive it.
 *
 * The suite runs against the embedded Postgres always, and against a real
 * Postgres as well when `TEST_DATABASE_URL` is set. Both are the same SQL, so
 * one run proves the statements are right and the other proves they are right on
 * a server with real connections and real row locks.
 *
 * The two concurrency tests are the reason this file exists. What they establish
 * is that a spend is one statement rather than a read followed by a write — the
 * property that does not survive being refactored carelessly, and the one that a
 * single-instance test would never notice was gone.
 */

const GRANT = {
  clientId: "client-1",
  redirectUri: "https://client.example/cb",
  codeChallenge: "challenge",
  scope: "mcp",
  resource: "https://inboxlabeler.example/mcp",
  userId: "google:alice",
};

const LOGIN = {
  clientId: "client-1",
  redirectUri: "https://client.example/cb",
  codeChallenge: "challenge",
  scope: "mcp",
  resource: "https://inboxlabeler.example/mcp",
  clientState: "client-state",
  nonce: "nonce",
  providerCodeVerifier: "verifier",
};

/** The drivers this run can reach: always embedded, plus Postgres when given one. */
const drivers: { name: string; open: () => Promise<SqlDriver> }[] = [
  { name: "embedded postgres", open: () => embeddedDriver() },
];

if (process.env.TEST_DATABASE_URL) {
  drivers.push({
    name: "postgres",
    open: async () => {
      const { postgresDriver } = await import("../db/postgres.ts");
      return postgresDriver(process.env.TEST_DATABASE_URL!);
    },
  });
}

for (const driver of drivers) {
  describe(driver.name, () => {
    /** Opened per assertion group so no test inherits another's rows. */
    const opened: SqlDriver[] = [];

    /**
     * A store with nothing in it.
     *
     * The emptying is not ceremony. The embedded driver hands out a brand new
     * in-memory database per call, so tests are isolated whether or not anyone
     * asks; a real Postgres is one shared server, where they are not. Truncating
     * makes both behave the same way, which is what lets an assertion count rows
     * — and it was a shared server that caught the assertions which had quietly
     * been relying on being alone.
     */
    async function fresh(): Promise<{ store: OAuthStore; driver: SqlDriver }> {
      const sql = await driver.open();
      opened.push(sql);
      await migrate(sql, OAUTH_SCHEMA);
      await sql.exec(`
        TRUNCATE oauth_clients, oauth_pending_logins,
                 oauth_authorization_codes, oauth_refresh_tokens;
      `);
      return { store: sqlOAuthStore(sql), driver: sql };
    }

    after(async () => {
      for (const sql of opened) await sql.close().catch(() => {});
    });

    // --- durability -------------------------------------------------------
    //
    // A second store built on the same connection is what a second application
    // instance looks like from the data's point of view: separate object,
    // separate caches, nothing shared but the database.

    test("a registered client is visible to another store instance", async () => {
      const { store, driver: sql } = await fresh();
      const registered = await store.registerClient({
        redirectUris: ["https://client.example/cb"],
        clientName: "Claude",
      });

      const elsewhere = sqlOAuthStore(sql);
      const seen = await elsewhere.client(registered.clientId);

      assert.equal(seen?.clientId, registered.clientId);
      assert.deepEqual(seen?.redirectUris, ["https://client.example/cb"]);
      assert.equal(seen?.clientName, "Claude");
    });

    test("a parked login is visible to another store instance", async () => {
      const { store, driver: sql } = await fresh();
      const reference = await store.parkLogin(LOGIN);

      const resumed = await sqlOAuthStore(sql).takeLogin(reference);

      assert.equal(resumed?.nonce, "nonce");
      assert.equal(resumed?.providerCodeVerifier, "verifier");
      assert.equal(resumed?.clientState, "client-state");
      assert.equal(resumed?.redirectUri, LOGIN.redirectUri);
    });

    test("an authorization code is visible to another store instance", async () => {
      const { store, driver: sql } = await fresh();
      const code = await store.issueCode(GRANT);

      const granted = await sqlOAuthStore(sql).redeemCode(code);

      assert.equal(granted?.userId, "google:alice");
      assert.equal(granted?.codeChallenge, "challenge");
      assert.equal(granted?.resource, GRANT.resource);
    });

    test("a refresh token is visible to another store instance", async () => {
      const { store, driver: sql } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      const granted = await sqlOAuthStore(sql).redeemRefreshToken(token);

      assert.equal(granted?.userId, "google:alice");
      assert.equal(granted?.scope, "mcp");
    });

    test("a client registered before a restart is still there after one", async () => {
      // A restart, for a store, is losing everything held in the process and
      // reading the database again — which is what re-running the migration and
      // rebuilding the store on a reopened connection reproduces.
      const directory = mkdtempSync(join(tmpdir(), "oauth-store-"));
      try {
        if (driver.name !== "embedded postgres") return;

        const first = await embeddedDriver(directory);
        await migrate(first, OAUTH_SCHEMA);
        const registered = await sqlOAuthStore(first).registerClient({
          redirectUris: ["https://client.example/cb"],
        });
        const code = await sqlOAuthStore(first).issueCode({
          ...GRANT,
          clientId: registered.clientId,
        });
        await first.close();

        const second = await embeddedDriver(directory);
        await migrate(second, OAUTH_SCHEMA);
        try {
          const seen = await sqlOAuthStore(second).client(registered.clientId);
          assert.equal(seen?.clientId, registered.clientId, "the client survived");

          const granted = await sqlOAuthStore(second).redeemCode(code);
          assert.equal(granted?.userId, "google:alice", "and so did the code");
        } finally {
          await second.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });

    // --- single use -------------------------------------------------------

    test("an authorization code is redeemable exactly once", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);

      assert.equal((await store.redeemCode(code))?.userId, "google:alice");
      assert.equal(await store.redeemCode(code), undefined);
    });

    test("a refresh token is spent by being used", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      assert.equal((await store.redeemRefreshToken(token))?.userId, "google:alice");
      assert.equal(await store.redeemRefreshToken(token), undefined);
    });

    test("a parked login resumes once, which is what makes the consent form single-use", async () => {
      const { store } = await fresh();
      const reference = await store.parkLogin(LOGIN);

      assert.equal((await store.takeLogin(reference))?.nonce, "nonce");
      assert.equal(await store.takeLogin(reference), undefined);
    });

    // --- the two races ----------------------------------------------------
    //
    // Requesting the same spend many times at once. Exactly one caller may come
    // away with the record; every other must get nothing. A store that read the
    // row and then deleted it would let several through here.

    test("simultaneous exchanges of one authorization code: exactly one succeeds", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);

      const attempts = await Promise.all(
        Array.from({ length: 12 }, () => store.redeemCode(code)),
      );
      const winners = attempts.filter((attempt) => attempt !== undefined);

      assert.equal(winners.length, 1, `expected one winner, got ${winners.length}`);
      assert.equal(winners[0]?.userId, "google:alice");
    });

    test("simultaneous rotations of one refresh token: exactly one succeeds", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      const attempts = await Promise.all(
        Array.from({ length: 12 }, () => store.redeemRefreshToken(token)),
      );
      const winners = attempts.filter((attempt) => attempt !== undefined);

      assert.equal(winners.length, 1, `expected one winner, got ${winners.length}`);
      assert.equal(winners[0]?.userId, "google:alice");
    });

    test("simultaneous resumptions of one parked login: exactly one succeeds", async () => {
      const { store } = await fresh();
      const reference = await store.parkLogin(LOGIN);

      const attempts = await Promise.all(
        Array.from({ length: 12 }, () => store.takeLogin(reference)),
      );

      assert.equal(attempts.filter((attempt) => attempt !== undefined).length, 1);
    });

    test("a race across two store instances still has one winner", async () => {
      const { store, driver: sql } = await fresh();
      const other = sqlOAuthStore(sql);
      const code = await store.issueCode(GRANT);

      const attempts = await Promise.all([
        store.redeemCode(code),
        other.redeemCode(code),
        store.redeemCode(code),
        other.redeemCode(code),
      ]);

      assert.equal(attempts.filter((attempt) => attempt !== undefined).length, 1);
    });

    // --- expiry -----------------------------------------------------------

    test("an expired authorization code is rejected", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);

      assert.equal(await store.redeemCode(code, Date.now() + AUTHORIZATION_CODE_TTL_MS + 1), undefined);
    });

    test("an expired refresh token is rejected", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      assert.equal(
        await store.redeemRefreshToken(token, Date.now() + REFRESH_TOKEN_TTL_MS + 1),
        undefined,
      );
    });

    test("an expired parked login is rejected", async () => {
      const { store } = await fresh();
      const reference = await store.parkLogin(LOGIN);

      assert.equal(await store.takeLogin(reference, Date.now() + PENDING_LOGIN_TTL_MS + 1), undefined);
    });

    test("expiry is rejected on read, whether or not cleanup has run", async () => {
      const { store, driver: sql } = await fresh();
      const code = await store.issueCode(GRANT);
      const after = Date.now() + AUTHORIZATION_CODE_TTL_MS + 1;

      // The row is still there — nothing has swept it — and it is still refused.
      const rows = await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM oauth_authorization_codes",
      );
      assert.equal(rows[0].n, 1, "the expired row has not been cleaned up");
      assert.equal(await store.redeemCode(code, after), undefined);
    });

    // --- cleanup ----------------------------------------------------------

    test("cleanup removes expired records and leaves live ones", async () => {
      const { store, driver: sql } = await fresh();
      await store.issueCode(GRANT);
      await store.parkLogin(LOGIN);
      await store.issueRefreshToken(GRANT);

      const live = await store.cleanup();
      assert.equal(live, 0, "nothing has expired yet");

      const removed = await store.cleanup(Date.now() + REFRESH_TOKEN_TTL_MS + 1);
      assert.equal(removed, 3, "one of each kind went");

      for (const table of [
        "oauth_authorization_codes",
        "oauth_pending_logins",
        "oauth_refresh_tokens",
      ]) {
        const rows = await sql.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(rows[0].n, 0, table);
      }
    });

    test("cleanup leaves registered clients alone: a registration does not expire", async () => {
      const { store } = await fresh();
      const registered = await store.registerClient({ redirectUris: ["https://client.example/cb"] });

      await store.cleanup(Date.now() + REFRESH_TOKEN_TTL_MS + 1);

      assert.ok(await store.client(registered.clientId));
    });

    test("issuing sweeps what has already expired", async () => {
      const { store, driver: sql } = await fresh();
      // A code that is already past its life by the time the next one is issued.
      await sql.query(
        `INSERT INTO oauth_authorization_codes
           (code_hash, client_id, redirect_uri, code_challenge, scope, resource, user_id, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          referenceHash("stale"),
          GRANT.clientId,
          GRANT.redirectUri,
          GRANT.codeChallenge,
          GRANT.scope,
          GRANT.resource,
          GRANT.userId,
          new Date(Date.now() - 1000),
        ],
      );

      await store.issueCode(GRANT);

      const rows = await sql.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM oauth_authorization_codes",
      );
      assert.equal(rows[0].n, 1, "the stale row went, the new one stayed");
    });

    // --- what is stored ---------------------------------------------------

    test("the reference a client holds is never stored, only its hash", async () => {
      const { store, driver: sql } = await fresh();
      const code = await store.issueCode(GRANT);
      const token = await store.issueRefreshToken(GRANT);
      const login = await store.parkLogin(LOGIN);

      for (const [table, column, value] of [
        ["oauth_authorization_codes", "code_hash", code],
        ["oauth_refresh_tokens", "token_hash", token],
        ["oauth_pending_logins", "reference_hash", login],
      ] as const) {
        const rows = await sql.query<Record<string, Uint8Array>>(`SELECT ${column} FROM ${table}`);
        const stored = Buffer.from(rows[0][column]);

        assert.equal(stored.length, 32, `${table}: a SHA-256 digest`);
        assert.equal(stored.toString("utf8").includes(value), false, `${table}: not the raw value`);
        assert.ok(stored.equals(referenceHash(value)), `${table}: the hash of what was handed out`);
      }
    });

    test("a hash cannot be presented in place of the reference it came from", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);

      assert.equal(
        await store.redeemCode(referenceHash(code).toString("base64url")),
        undefined,
        "whoever reads the database still cannot redeem",
      );
      assert.ok(await store.redeemCode(code), "only the reference works");
    });

    test("no store keeps a Google secret or any signing material", async () => {
      const { store, driver: sql } = await fresh();
      await store.parkLogin(LOGIN);

      // Every column of the parked row, as text. The provider code verifier is
      // ours and belongs here; a client secret or a signing key never would.
      const rows = await sql.query<Record<string, unknown>>("SELECT * FROM oauth_pending_logins");
      const columns = Object.keys(rows[0]).sort();

      assert.deepEqual(columns, [
        "client_id",
        "client_state",
        "code_challenge",
        "expires_at",
        "nonce",
        "provider_code_verifier",
        "redirect_uri",
        "reference_hash",
        "resource",
        "scope",
      ]);
    });

    test("a login stores one user-free record: identity arrives later", async () => {
      const { store, driver: sql } = await fresh();
      await store.parkLogin(LOGIN);

      const rows = await sql.query<Record<string, unknown>>("SELECT * FROM oauth_pending_logins");
      assert.equal("user_id" in rows[0], false, "nobody is identified until the callback");
    });

    // --- misses -----------------------------------------------------------

    test("a reference that was never issued finds nothing", async () => {
      const { store } = await fresh();

      assert.equal(await store.redeemCode("made-up"), undefined);
      assert.equal(await store.redeemRefreshToken("made-up"), undefined);
      assert.equal(await store.takeLogin("made-up"), undefined);
      assert.equal(await store.client("made-up"), undefined);
    });

    test("two clients registering identical metadata are still two clients", async () => {
      const { store } = await fresh();
      const metadata = { redirectUris: ["https://client.example/cb"], clientName: "Claude" };

      const first = await store.registerClient(metadata);
      const second = await store.registerClient(metadata);

      assert.notEqual(first.clientId, second.clientId);
      assert.match(first.clientId, /^[A-Za-z0-9_-]{43}$/);
    });

    test("a client with no name round-trips as having none", async () => {
      const { store } = await fresh();
      const registered = await store.registerClient({ redirectUris: ["https://client.example/cb"] });

      assert.equal((await store.client(registered.clientId))?.clientName, undefined);
    });

    test("a login with no client state round-trips as having none", async () => {
      const { store } = await fresh();
      // The store writes `clientState ?? null`, so an absent one and an
      // undefined one are the same row — which is the case a client that sent
      // no `state` produces.
      const reference = await store.parkLogin({ ...LOGIN, clientState: undefined });

      assert.equal((await store.takeLogin(reference))?.clientState, undefined);
    });

    // --- migrations -------------------------------------------------------

    test("migrating twice is not an error and applies nothing the second time", async () => {
      const { driver: sql } = await fresh();

      assert.equal(await migrate(sql, OAUTH_SCHEMA), 0, "everything was applied when the store opened");
    });

    test("concurrent migrations settle on one application of each version", async () => {
      const { driver: sql } = await fresh();

      const results = await Promise.all(Array.from({ length: 5 }, () => migrate(sql, OAUTH_SCHEMA)));

      assert.deepEqual(results, [0, 0, 0, 0, 0], "all no-ops once the schema is current");
      const rows = await sql.query<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE module = $1 ORDER BY version",
        ["oauth"],
      );
      assert.deepEqual(
        rows.map((row: { version: number }) => row.version),
        [1],
      );
    });
  });
}
