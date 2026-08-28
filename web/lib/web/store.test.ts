import assert from "node:assert/strict";
import test, { after, describe } from "node:test";

import type { SqlDriver } from "../db/driver.ts";
import { migrate } from "../db/migrate.ts";
import { embeddedDriver } from "../db/pglite.ts";
import { WEB_LOGIN_TTL_MS, WEB_SESSION_TTL_MS, type WebStore } from "./store.ts";
import { WEB_SCHEMA, sqlWebStore } from "./store/sql.ts";

/**
 * The browser-session store, driven the way the sign-in flow drives it.
 *
 * The suite runs against the embedded Postgres always, and a real Postgres too
 * when `TEST_DATABASE_URL` is set — the same reason as the other two stores: one
 * run proves the statements are right, the other proves they are right on a
 * server with real connections.
 *
 * Two themes run through it. One is that a parked sign-in is spent exactly once
 * and only by the browser that started it, because that is what makes the `state`
 * Google echoes back evidence of anything. The other is that a session is a
 * lookup key and nothing more: it names its owner, it stops working when it is
 * ended or expires, and one session can never answer as another.
 */

const ALICE = { id: "google:alice" };
const BOB = { id: "google:bob" };

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
    const opened: SqlDriver[] = [];

    async function fresh(): Promise<WebStore> {
      const sql = await driver.open();
      opened.push(sql);
      await migrate(sql, WEB_SCHEMA);
      await sql.exec("DELETE FROM web_logins; DELETE FROM web_sessions;");
      return sqlWebStore(sql);
    }

    after(async () => {
      for (const sql of opened) await sql.close();
    });

    // --- a sign-in in progress ---------------------------------------------

    test("a parked sign-in comes back to the browser that started it", async () => {
      const store = await fresh();
      const state = await store.parkLogin({
        nonce: "nonce-1",
        providerCodeVerifier: "verifier-1",
        browserBinding: "binding-1",
      });

      const login = await store.takeLogin(state, "binding-1");

      assert.equal(login?.nonce, "nonce-1");
      assert.equal(login?.providerCodeVerifier, "verifier-1");
    });

    test("a state presented without the browser's binding resumes nothing", async () => {
      // The attack this exists for: somebody starts their own sign-in, holds the
      // `state`, and gets a victim's browser to complete it. The victim's browser
      // does not have the cookie, so there is nothing to resume.
      const store = await fresh();
      const state = await store.parkLogin({
        nonce: "n",
        providerCodeVerifier: "v",
        browserBinding: "the-starter's-cookie",
      });

      assert.equal(await store.takeLogin(state, "someone-else's-cookie"), undefined);
      // And it is still there for the browser that does hold it, so a failed
      // attempt does not cost the legitimate signer their sign-in.
      assert.notEqual(await store.takeLogin(state, "the-starter's-cookie"), undefined);
    });

    test("a state is spent by the first presentation and refused after", async () => {
      const store = await fresh();
      const state = await store.parkLogin({
        nonce: "n",
        providerCodeVerifier: "v",
        browserBinding: "b",
      });

      assert.notEqual(await store.takeLogin(state, "b"), undefined);
      assert.equal(await store.takeLogin(state, "b"), undefined, "replay finds nothing");
    });

    test("a sign-in that has expired resumes nothing", async () => {
      const store = await fresh();
      const state = await store.parkLogin({
        nonce: "n",
        providerCodeVerifier: "v",
        browserBinding: "b",
      });

      const past = Date.now() + WEB_LOGIN_TTL_MS + 1;
      assert.equal(await store.takeLogin(state, "b", past), undefined);
    });

    test("a state nobody parked resumes nothing", async () => {
      const store = await fresh();
      assert.equal(await store.takeLogin("invented", "b"), undefined);
    });

    // --- a session -----------------------------------------------------------

    test("a session names its owner and the address it was admitted on", async () => {
      const store = await fresh();
      const value = await store.createSession({ user: ALICE, email: "alice@example.com" });

      const session = await store.session(value);

      assert.deepEqual(session?.user, ALICE);
      assert.equal(session?.email, "alice@example.com");
    });

    test("two users' sessions never answer as each other", async () => {
      const store = await fresh();
      const alice = await store.createSession({ user: ALICE, email: "alice@example.com" });
      const bob = await store.createSession({ user: BOB, email: "bob@example.com" });

      assert.deepEqual((await store.session(alice))?.user, ALICE);
      assert.deepEqual((await store.session(bob))?.user, BOB);
      assert.notEqual(alice, bob);
    });

    test("ending a session makes the cookie a dead value", async () => {
      const store = await fresh();
      const value = await store.createSession({ user: ALICE, email: "alice@example.com" });

      await store.endSession(value);

      // The point of the row existing at all: signing out revokes rather than
      // merely asking the browser to forget. A copy of the cookie is now useless.
      assert.equal(await store.session(value), undefined);
    });

    test("ending one session leaves the same user's other browsers alone", async () => {
      const store = await fresh();
      const laptop = await store.createSession({ user: ALICE, email: "alice@example.com" });
      const phone = await store.createSession({ user: ALICE, email: "alice@example.com" });

      await store.endSession(laptop);

      assert.equal(await store.session(laptop), undefined);
      assert.notEqual(await store.session(phone), undefined);
    });

    test("ending a session that never existed is not an error", async () => {
      const store = await fresh();
      await store.endSession("never-issued");
    });

    test("an expired session is indistinguishable from an absent one", async () => {
      const store = await fresh();
      const value = await store.createSession({ user: ALICE, email: "alice@example.com" });

      assert.equal(await store.session(value, Date.now() + WEB_SESSION_TTL_MS + 1), undefined);
    });

    test("a cookie value that was never issued resolves to nobody", async () => {
      const store = await fresh();
      await store.createSession({ user: ALICE, email: "alice@example.com" });

      for (const invented of ["", "guess", "google:alice", "a".repeat(43)]) {
        assert.equal(await store.session(invented), undefined, invented);
      }
    });

    // --- what a copy of the database is worth --------------------------------

    test("neither table holds a value a browser presents", async () => {
      const store = await fresh();
      const state = await store.parkLogin({
        nonce: "n",
        providerCodeVerifier: "v",
        browserBinding: "the-binding",
      });
      const session = await store.createSession({ user: ALICE, email: "alice@example.com" });

      // Read through the driver rather than the store, because the question is
      // what is on disk: whoever holds a copy of this database must learn that
      // somebody is signed in without being able to become them.
      const sql = opened[opened.length - 1]!;
      const [logins] = await sql.query<{ dump: string }>(
        "SELECT web_logins::text AS dump FROM web_logins",
      );
      const [sessions] = await sql.query<{ dump: string }>(
        "SELECT web_sessions::text AS dump FROM web_sessions",
      );

      for (const secret of [state, "the-binding", session]) {
        assert.equal(logins?.dump.includes(secret), false, `web_logins holds ${secret}`);
        assert.equal(sessions?.dump.includes(secret), false, `web_sessions holds ${secret}`);
      }
    });

    // --- housekeeping --------------------------------------------------------

    test("cleanup removes what has expired and nothing else", async () => {
      const store = await fresh();
      await store.parkLogin({ nonce: "n", providerCodeVerifier: "v", browserBinding: "b" });
      const live = await store.createSession({ user: ALICE, email: "alice@example.com" });

      assert.equal(await store.cleanup(), 0, "nothing has expired yet");
      assert.notEqual(await store.session(live), undefined);

      assert.equal(await store.cleanup(Date.now() + WEB_SESSION_TTL_MS + 1), 2);
    });
  });
}
