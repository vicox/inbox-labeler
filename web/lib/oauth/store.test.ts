import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, describe } from "node:test";

import {
  AUTHORIZATION_CODE_TTL_MS,
  CLIENT_RETENTION_MS,
  PENDING_LOGIN_TTL_MS,
  RATE_LIMIT_RETENTION_MS,
  REFRESH_TOKEN_TTL_MS,
  referenceHash,
  type AuthorizationCode,
  type OAuthStore,
  type RefreshGrant,
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

/** A check that accepts every grant, for the tests that are not about checking. */
const allow = () => undefined;

/**
 * Redeems a code with a check that accepts anything, reading the grant back.
 *
 * The tests that are about single use, isolation and expiry care about the grant
 * rather than the outcome, so this keeps them saying what they mean. The tests
 * that are about the check itself use `redeemCode` directly.
 */
async function redeem(store: OAuthStore, code: string, now?: number) {
  const redemption = await store.redeemCode(code, allow, now);
  return redemption.outcome === "redeemed" ? redemption.grant : undefined;
}

/**
 * The browser binding every park below uses.
 *
 * One value shared across these tests on purpose: what they are about is how a
 * reference is spent, and the binding is required for a record to exist at all.
 * That the binding must *match* is `flow.test.ts`' subject, where there are two
 * browsers to tell apart.
 */
const BINDING = "a-browser-binding";

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
        TRUNCATE oauth_clients, oauth_pending_logins, oauth_authorization_codes,
                 oauth_refresh_tokens, oauth_refresh_families, oauth_rate_limits;
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
      const reference = await store.parkLogin(LOGIN, BINDING);

      const resumed = await sqlOAuthStore(sql).takeLogin(reference, BINDING);

      assert.equal(resumed?.nonce, "nonce");
      assert.equal(resumed?.providerCodeVerifier, "verifier");
      assert.equal(resumed?.clientState, "client-state");
      assert.equal(resumed?.redirectUri, LOGIN.redirectUri);
    });

    test("an authorization code is visible to another store instance", async () => {
      const { store, driver: sql } = await fresh();
      const code = await store.issueCode(GRANT);

      const granted = await redeem(sqlOAuthStore(sql), code);

      assert.equal(granted?.userId, "google:alice");
      assert.equal(granted?.codeChallenge, "challenge");
      assert.equal(granted?.resource, GRANT.resource);
    });

    test("a refresh token is visible to another store instance", async () => {
      const { store, driver: sql } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      const rotation = await sqlOAuthStore(sql).rotateRefreshToken(token, allow);

      assert.equal(rotation.outcome, "rotated");
      assert.equal(rotation.outcome === "rotated" ? rotation.grant.userId : null, "google:alice");
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

          const granted = await redeem(sqlOAuthStore(second), code);
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

      assert.equal((await redeem(store, code))?.userId, "google:alice");
      assert.equal(await redeem(store, code), undefined);
    });

    test("a refresh token is spent by being used, and its reuse is noticed", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      const first = await store.rotateRefreshToken(token, allow);
      assert.equal(first.outcome, "rotated");

      // Not merely refused: recognised as a replay, which is what lets the family
      // be ended rather than the one token.
      assert.equal((await store.rotateRefreshToken(token, allow)).outcome, "replayed");
    });

    test("a parked login resumes once, which is what makes the consent form single-use", async () => {
      const { store } = await fresh();
      const reference = await store.parkLogin(LOGIN, BINDING);

      assert.equal((await store.takeLogin(reference, BINDING))?.nonce, "nonce");
      assert.equal(await store.takeLogin(reference, BINDING), undefined);
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
        Array.from({ length: 12 }, () => redeem(store, code)),
      );
      const winners = attempts.filter((attempt) => attempt !== undefined);

      assert.equal(winners.length, 1, `expected one winner, got ${winners.length}`);
      assert.equal(winners[0]?.userId, "google:alice");
    });

    test("simultaneous rotations of one refresh token: exactly one succeeds", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      const attempts = await Promise.all(
        Array.from({ length: 12 }, () => store.rotateRefreshToken(token, allow)),
      );
      const rotated = attempts.filter((attempt) => attempt.outcome === "rotated");

      assert.equal(rotated.length, 1, `expected one winner, got ${rotated.length}`);

      // The first loser finds the token spent and treats it as a replay, which is
      // the intended posture: a token presented twice ends the chain, whether the
      // second presentation was a thief or a client racing itself. That revocation
      // deletes the family's tokens, so the losers behind it find nothing at all.
      // Every one of them is refused; which flavour of refusal they get depends
      // only on where they were in the queue, and the client is told the same
      // thing either way.
      assert.ok(attempts.some((attempt) => attempt.outcome === "replayed"));
      assert.ok(
        attempts.every((attempt) => attempt.outcome !== "refused"),
        "no loser was refused for a reason the check invented",
      );
    });

    test("simultaneous resumptions of one parked login: exactly one succeeds", async () => {
      const { store } = await fresh();
      const reference = await store.parkLogin(LOGIN, BINDING);

      const attempts = await Promise.all(
        Array.from({ length: 12 }, () => store.takeLogin(reference, BINDING)),
      );

      assert.equal(attempts.filter((attempt) => attempt !== undefined).length, 1);
    });

    test("a race across two store instances still has one winner", async () => {
      const { store, driver: sql } = await fresh();
      const other = sqlOAuthStore(sql);
      const code = await store.issueCode(GRANT);

      const attempts = await Promise.all([
        redeem(store, code),
        redeem(other, code),
        redeem(store, code),
        redeem(other, code),
      ]);

      assert.equal(attempts.filter((attempt) => attempt !== undefined).length, 1);
    });

    // --- expiry -----------------------------------------------------------

    test("an expired authorization code is rejected", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);

      assert.equal(await redeem(store, code, Date.now() + AUTHORIZATION_CODE_TTL_MS + 1), undefined);
    });

    test("an expired refresh token is rejected", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      const rotation = await store.rotateRefreshToken(token, allow, Date.now() + REFRESH_TOKEN_TTL_MS + 1);
      assert.equal(rotation.outcome, "unknown");
    });

    test("an expired parked login is rejected", async () => {
      const { store } = await fresh();
      const reference = await store.parkLogin(LOGIN, BINDING);

      assert.equal(
        await store.takeLogin(reference, BINDING, Date.now() + PENDING_LOGIN_TTL_MS + 1),
        undefined,
      );
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
      assert.equal(await redeem(store, code, after), undefined);
    });

    // --- cleanup ----------------------------------------------------------

    test("cleanup removes expired records and leaves live ones", async () => {
      const { store, driver: sql } = await fresh();
      await store.issueCode(GRANT);
      await store.parkLogin(LOGIN, BINDING);
      await store.issueRefreshToken(GRANT);

      const live = await store.cleanup();
      assert.equal(live, 0, "nothing has expired yet");

      const removed = await store.cleanup(Date.now() + REFRESH_TOKEN_TTL_MS + 1);
      // Four rows: the code, the parked login, the refresh token, and the family
      // the token belonged to.
      assert.equal(removed, 4, "one of each kind went, the family included");

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
      const login = await store.parkLogin(LOGIN, BINDING);

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
        await redeem(store, referenceHash(code).toString("base64url")),
        undefined,
        "whoever reads the database still cannot redeem",
      );
      assert.ok(await redeem(store, code), "only the reference works");
    });

    test("no store keeps a Google secret or any signing material", async () => {
      const { store, driver: sql } = await fresh();
      await store.parkLogin(LOGIN, BINDING);

      // Every column of the parked row, as text. The provider code verifier is
      // ours and belongs here; a client secret or a signing key never would.
      const rows = await sql.query<Record<string, unknown>>("SELECT * FROM oauth_pending_logins");
      const columns = Object.keys(rows[0]).sort();

      assert.deepEqual(columns, [
        "client_id",
        "client_state",
        "code_challenge",
        // The browser binding, and like every other reference here it is stored
        // as a hash rather than as the value the cookie carries.
        "consent_session_hash",
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
      await store.parkLogin(LOGIN, BINDING);

      const rows = await sql.query<Record<string, unknown>>("SELECT * FROM oauth_pending_logins");
      assert.equal("user_id" in rows[0], false, "nobody is identified until the callback");
    });

    // --- misses -----------------------------------------------------------

    test("a reference that was never issued finds nothing", async () => {
      const { store } = await fresh();

      assert.equal(await redeem(store, "made-up"), undefined);
      assert.equal((await store.rotateRefreshToken("made-up", allow)).outcome, "unknown");
      assert.equal(await store.takeLogin("made-up", BINDING), undefined);
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
      const reference = await store.parkLogin({ ...LOGIN, clientState: undefined }, BINDING);

      assert.equal((await store.takeLogin(reference, BINDING))?.clientState, undefined);
    });

    // --- migrations -------------------------------------------------------

    test("migrating twice is not an error and applies nothing the second time", async () => {
      const { driver: sql } = await fresh();

      assert.equal(await migrate(sql, OAUTH_SCHEMA), 0, "everything was applied when the store opened");
    });

    test("a refused check leaves the authorization code unconsumed", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);

      const refused = await store.redeemCode(code, () => ({
        error: "invalid_grant",
        description: "no",
      }));
      assert.equal(refused.outcome, "refused");

      // Still redeemable, so nothing was consumed on the way to the refusal.
      assert.equal((await store.redeemCode(code, allow)).outcome, "redeemed");
    });

    test("the code check sees the grant it is deciding about", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);

      let seen: AuthorizationCode | undefined;
      await store.redeemCode(code, (grant) => {
        seen = grant;
        return undefined;
      });

      assert.equal(seen?.clientId, GRANT.clientId);
      assert.equal(seen?.redirectUri, GRANT.redirectUri);
      assert.equal(seen?.codeChallenge, GRANT.codeChallenge);
      assert.equal(seen?.resource, GRANT.resource);
      assert.equal(seen?.userId, GRANT.userId);
    });

    test("the code check does not run for a code that is unknown or expired", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);

      let ran = 0;
      const counting = () => {
        ran += 1;
        return undefined;
      };

      assert.equal((await store.redeemCode("made-up", counting)).outcome, "unknown");
      assert.equal(
        (await store.redeemCode(code, counting, Date.now() + AUTHORIZATION_CODE_TTL_MS + 1)).outcome,
        "unknown",
      );
      assert.equal(ran, 0, "there was nothing to decide about");
    });

    test("repeated refusals never consume the code", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);
      const no = () => ({ error: "invalid_grant", description: "no" });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await store.redeemCode(code, no)).outcome, "refused");
      }

      assert.equal((await store.redeemCode(code, allow)).outcome, "redeemed");
    });

    test("simultaneous redemptions with a refusing check consume nothing", async () => {
      const { store } = await fresh();
      const code = await store.issueCode(GRANT);
      const no = () => ({ error: "invalid_grant", description: "no" });

      const attempts = await Promise.all(
        Array.from({ length: 8 }, () => store.redeemCode(code, no)),
      );
      assert.ok(attempts.every((attempt) => attempt.outcome === "refused"));

      assert.equal((await store.redeemCode(code, allow)).outcome, "redeemed");
    });

    test("a refused check leaves the token unspent and the family intact", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      const refused = await store.rotateRefreshToken(token, () => ({
        error: "invalid_grant",
        description: "no",
      }));
      assert.equal(refused.outcome, "refused");

      // Still rotatable, so nothing was consumed on the way to the refusal.
      assert.equal((await store.rotateRefreshToken(token, allow)).outcome, "rotated");
    });

    test("the check sees the grant it is deciding about", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);

      let seen: RefreshGrant | undefined;
      await store.rotateRefreshToken(token, (grant) => {
        seen = grant;
        return undefined;
      });

      assert.deepEqual(seen, {
        clientId: GRANT.clientId,
        userId: GRANT.userId,
        scope: GRANT.scope,
        resource: GRANT.resource,
      });
    });

    test("the check does not run for a token that is unknown or already spent", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);
      await store.rotateRefreshToken(token, allow);

      let ran = 0;
      const counting = () => {
        ran += 1;
        return undefined;
      };

      assert.equal((await store.rotateRefreshToken(token, counting)).outcome, "replayed");
      assert.equal((await store.rotateRefreshToken("made-up", counting)).outcome, "unknown");
      assert.equal(ran, 0, "there was nothing to decide about");
    });

    test("a refusal is not a replay: repeated refusals do not revoke the family", async () => {
      const { store } = await fresh();
      const token = await store.issueRefreshToken(GRANT);
      const no = () => ({ error: "invalid_grant", description: "no" });

      for (let attempt = 0; attempt < 5; attempt += 1) {
        assert.equal((await store.rotateRefreshToken(token, no)).outcome, "refused");
      }

      assert.equal((await store.rotateRefreshToken(token, allow)).outcome, "rotated");
    });

    // --- rate limiting ----------------------------------------------------

    test("a bucket allows requests up to its limit and then refuses", async () => {
      const { store } = await fresh();

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        assert.equal(await store.consumeRateLimit("b", 3, 60_000), true, `attempt ${attempt}`);
      }
      assert.equal(await store.consumeRateLimit("b", 3, 60_000), false, "over the limit");
    });

    test("buckets are independent", async () => {
      const { store } = await fresh();

      assert.equal(await store.consumeRateLimit("one", 1, 60_000), true);
      assert.equal(await store.consumeRateLimit("one", 1, 60_000), false);
      assert.equal(await store.consumeRateLimit("two", 1, 60_000), true, "a different caller");
    });

    test("a window rolls over rather than accumulating for ever", async () => {
      const { store } = await fresh();
      const start = Date.now();

      assert.equal(await store.consumeRateLimit("c", 1, 60_000, start), true);
      assert.equal(await store.consumeRateLimit("c", 1, 60_000, start), false);

      // Past the window, the bucket is this request rather than the last one's.
      assert.equal(await store.consumeRateLimit("c", 1, 60_000, start + 60_001), true);
    });

    test("simultaneous requests against one bucket cannot both slip through", async () => {
      const { store } = await fresh();

      const attempts = await Promise.all(
        Array.from({ length: 10 }, () => store.consumeRateLimit("d", 4, 60_000)),
      );

      assert.equal(attempts.filter(Boolean).length, 4, "the limit held under concurrency");
    });

    test("cleanup ages out buckets nobody has touched", async () => {
      const { store, driver: sql } = await fresh();
      await store.consumeRateLimit("stale", 5, 60_000, Date.now() - RATE_LIMIT_RETENTION_MS - 1000);
      await store.consumeRateLimit("fresh", 5, 60_000);

      await store.cleanup();

      const rows = await sql.query<{ bucket: string }>("SELECT bucket FROM oauth_rate_limits");
      assert.deepEqual(
        rows.map((row: { bucket: string }) => row.bucket),
        ["fresh"],
      );
    });

    // --- client registrations age out by use ------------------------------
    //
    // The one table here that used to only grow. Registration is open by
    // necessity, so a ceiling on rate decides how fast it grows and this decides
    // how large it gets.

    test("registering marks the client used, and starting an authorization marks it again", async () => {
      const { store, driver: sql } = await fresh();
      const registered = await store.registerClient({ redirectUris: ["https://client.example/cb"] });

      const used = async () => {
        const [row] = await sql.query<{ last_used_at: Date }>(
          "SELECT last_used_at FROM oauth_clients WHERE client_id = $1",
          [registered.clientId],
        );
        return row!.last_used_at.getTime();
      };

      const atRegistration = await used();
      assert.equal(atRegistration, registered.registeredAt, "seeded from the registration");

      await store.parkLogin({ ...LOGIN, clientId: registered.clientId }, BINDING);
      assert.ok(await used() >= atRegistration, "starting an authorization is use");
    });

    test("a client nobody has used for the retention window is swept, and a live one is not", async () => {
      const { store, driver: sql } = await fresh();

      const abandoned = await store.registerClient({ redirectUris: ["https://one.example/cb"] });
      const live = await store.registerClient({ redirectUris: ["https://two.example/cb"] });

      // Only the first is aged; the second keeps the timestamp it was given.
      await sql.query("UPDATE oauth_clients SET last_used_at = $2 WHERE client_id = $1", [
        abandoned.clientId,
        new Date(Date.now() - CLIENT_RETENTION_MS - 1),
      ]);

      // The sweep runs on the write that makes the table grow, which is the only
      // place it needs to: registration.
      await store.registerClient({ redirectUris: ["https://three.example/cb"] });

      assert.equal(await store.client(abandoned.clientId), undefined, "the abandoned one is gone");
      assert.ok(await store.client(live.clientId), "the live one is untouched");
    });

    test("a client that keeps authorizing is never swept, however old its registration", async () => {
      const { store, driver: sql } = await fresh();
      const client = await store.registerClient({ redirectUris: ["https://client.example/cb"] });

      // Registered long ago...
      await sql.query("UPDATE oauth_clients SET registered_at = $2 WHERE client_id = $1", [
        client.clientId,
        new Date(Date.now() - CLIENT_RETENTION_MS * 4),
      ]);
      // ...and used just now, which is what the sweep measures.
      await store.parkLogin({ ...LOGIN, clientId: client.clientId }, BINDING);

      await store.registerClient({ redirectUris: ["https://other.example/cb"] });

      assert.ok(await store.client(client.clientId), "age of registration is not disuse");
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
        [1, 2, 3, 4, 5],
      );
    });
  });
}
