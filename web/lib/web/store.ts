import { database } from "../db.ts";
import { prepareSchema } from "../db/migrate.ts";
import type { AuthenticatedUser } from "../identity.ts";

/**
 * The two records a browser session needs to outlive a request, and the contract
 * an adapter implements.
 *
 * ## Why this is a table, when an access token is not
 *
 * The MCP endpoint's access tokens are deliberately signed and stateless: it is
 * the hot path, it must give the same answer on every instance, and it therefore
 * accepts the one cost of that choice — a minted token cannot be withdrawn before
 * it expires. A browser session cannot accept that cost, for three reasons, and
 * each one on its own would be enough:
 *
 *   - **Signing out has to mean something.** A signed cookie can only be
 *     forgotten, never revoked, so a copy taken before signing out would keep
 *     working. Here the row is deleted and the credential is dead.
 *   - **The access list has to keep applying.** A closed beta whose operator
 *     removes an address should not leave that browser reading a dashboard for
 *     days. The address is on the row, so every request can re-ask.
 *   - **Nothing about a page render needs statelessness.** It already runs
 *     several queries against this database; one more indexed probe is free,
 *     where on the MCP path it would be the only query there is.
 *
 * ## What a session is allowed to hold
 *
 * The user key, the verified address, and two timestamps. Not a profile, not a
 * Google token — Google's token response is verified and dropped inside
 * `lib/oauth/google.ts` and never reaches this module — and no history of what
 * was looked at. The address is here because the dashboard names it and because
 * the access list is re-checked against it; it goes when the session goes.
 *
 * ## Two tables, because there are two lifetimes
 *
 * A sign-in in progress lives for minutes and is spent once; a session lives for
 * days and is presented on every request. They also fail differently: an
 * unresumable login is a person who has to press the button again, an unusable
 * session is a person who has to sign in again.
 *
 * Neither table is `oauth_pending_logins`. That record carries a client, a
 * redirect URI, a code challenge and a resource, none of which a browser sign-in
 * has, and mixing them would mean one handler holding both kinds of state — where
 * the failure mode is a browser sign-in redeemed as an MCP authorization code.
 */

/**
 * A browser sign-in parked while the user is at Google.
 *
 * `browserBinding` is what makes the `state` Google echoes back evidence of
 * anything. Without it, a `state` that an attacker started their own sign-in to
 * obtain could be handed to a victim's browser, which would complete it and end up
 * holding a session for the attacker's account — or the attacker could complete a
 * `state` they obtained from somebody else's browser. The cookie is the thing
 * neither of them can supply.
 *
 * The MCP flow binds both of its pauses the same way and for the same reason; see
 * `lib/oauth/flow-binding.ts`, which argues it at length.
 */
export type PendingWebLogin = {
  /** The nonce required in the provider's identity token. */
  nonce: string;
  /** The verifier for our own PKCE exchange with the provider. */
  providerCodeVerifier: string;
  expiresAt: number;
};

/** Who a presented session cookie belongs to. */
export type WebSessionRecord = {
  user: AuthenticatedUser;
  /** The address Google verified at sign-in, normalised. */
  email: string;
  expiresAt: number;
};

/**
 * How long each record lives.
 *
 * Ten minutes for a sign-in in progress, the same as an authorization in
 * progress: a real person is signing in during it, and nothing about a browser
 * sign-in takes longer than one at an MCP client.
 *
 * Seven days for a session, as an absolute expiry rather than an idle timeout
 * that slides. A week is short enough that an abandoned laptop stops being a way
 * in fairly soon and long enough that a beta tester is not signing in daily; and
 * absolute means the privacy page can state one number that is true, rather than
 * "seven days from whenever you last looked", which is not a period anyone can
 * check. Signing in again is one button and mints a fresh week.
 */
export const WEB_LOGIN_TTL_MS = 10 * 60_000;
export const WEB_SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * The store, as the sign-in flow and the dashboard see it.
 *
 * `takeLogin` **spends** its reference: it returns the record and makes it
 * unusable in the same indivisible step, so a `state` cannot be replayed. An
 * adapter that implements it as a read followed by a delete is wrong however
 * carefully it is written — see `lib/oauth/store/sql.ts`, which argues this at
 * length for the same reason.
 *
 * `now` is an explicit parameter so expiry is testable without waiting.
 */
export type WebStore = {
  /** Parks a sign-in and returns the single-use reference that resumes it. */
  parkLogin(login: {
    nonce: string;
    providerCodeVerifier: string;
    /** The value the browser is given as a cookie; only its hash is stored. */
    browserBinding: string;
  }): Promise<string>;
  /**
   * Resumes a parked sign-in, spending its reference.
   *
   * The binding is matched by the same statement that spends the reference, so a
   * mismatch finds nothing and there is no call site that could forget to check.
   */
  takeLogin(
    reference: string,
    browserBinding: string,
    now?: number,
  ): Promise<PendingWebLogin | undefined>;

  /** Creates a session and returns the value the browser will hold. */
  createSession(session: { user: AuthenticatedUser; email: string }): Promise<string>;
  /** Who this cookie belongs to, or nothing if it is unknown or expired. */
  session(value: string, now?: number): Promise<WebSessionRecord | undefined>;
  /**
   * Ends a session, whether or not it existed.
   *
   * Idempotent and silent about what it found: signing out twice, or presenting a
   * cookie for a session that has already gone, is not a condition worth
   * reporting to anyone.
   */
  endSession(value: string): Promise<void>;

  /**
   * Deletes expired records, returning how many went.
   *
   * Never load-bearing: both reads above filter on expiry themselves, so a store
   * that is never cleaned is still correct, only larger.
   */
  cleanup(now?: number): Promise<number>;
};

/**
 * The store this deployment uses, opened once.
 *
 * Cached as a promise so concurrent first requests share one migration run, and
 * forgotten if it fails, so a transient database failure does not leave the
 * instance permanently unable to open a store. The same shape, and the same
 * reasoning, as `oauthStore` and `inboxStore`.
 */
let opening: Promise<WebStore> | undefined;

export function webStore(): Promise<WebStore> {
  opening ??= open().catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

async function open(): Promise<WebStore> {
  const driver = await database();
  const { WEB_SCHEMA, sqlWebStore } = await import("./store/sql.ts");

  // Outside production this migrates; in production it checks and refuses. See
  // lib/db/migrate.ts for why a request must never be what runs DDL.
  await prepareSchema(driver, WEB_SCHEMA);
  return sqlWebStore(driver);
}
