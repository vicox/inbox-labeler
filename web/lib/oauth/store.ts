import { createHash, randomBytes } from "node:crypto";

import { database } from "../db.ts";
import { prepareSchema } from "../db/migrate.ts";

/**
 * The OAuth flow state that has to outlive a request, and the contract every
 * adapter implements.
 *
 * Access tokens are deliberately absent, and that is the line this module draws.
 * They are signed documents carrying everything needed to check them, so the MCP
 * endpoint — the hot path, and the one that has to give the same answer on every
 * instance — validates a request from the token and the key alone, reading
 * nothing from here. What is left is the state whose correctness *is* the record
 * of what has already happened: an authorization code must be refusable the
 * second time it is presented, and a rotated refresh token must stop working. No
 * signed value can express "already used", so those four things are stored.
 *
 * Everything below is an interface rather than an implementation because the
 * protocol code must not know which database it is talking to — `authorization`,
 * `callback`, `exchange` and `registration` depend only on this file, so a
 * self-hosted deployment can add an adapter without any of them changing.
 */

/** A client that registered itself, per RFC 7591. */
export type RegisteredClient = {
  clientId: string;
  /** Exactly the URIs this client may be redirected back to. Matched literally. */
  redirectUris: string[];
  clientName?: string;
  registeredAt: number;
};

/**
 * An authorization request parked mid-flow.
 *
 * It holds the client's request rather than passing it through the browser and
 * back, because a value that travels through the browser is a value the browser
 * can change: keeping the code challenge and the redirect URI here means the
 * ones checked at the end of the flow are provably the ones checked at the
 * start.
 *
 * One record is parked twice, under a fresh reference each time, because the
 * flow pauses twice — once for the user to approve the client, once for the
 * identity provider to authenticate them:
 *
 *     GET  /oauth/authorize   park       ─►  reference travels in the consent form
 *     POST /oauth/authorize   take, park ─►  reference travels as the provider's `state`
 *     GET  /oauth/callback    take
 *
 * Each reference is unguessable and spent on first use, which is what makes the
 * first one a CSRF token for the consent form as well as a lookup key: a page
 * that was never served the form cannot forge a submission of it.
 *
 * Both parks are bound to the browser walking the flow, and the binding is
 * required rather than optional — there is no way to write an unbound record or to
 * take one without presenting a binding. The reference on its own is not evidence
 * of a browser: the attacker who matters here registered the client and made the
 * request, so they hold every reference the flow mints. See `lib/oauth/flow-binding.ts`.
 */
export type PendingLogin = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  /** The client's own `state`, returned to it untouched. */
  clientState?: string;
  /** The nonce we required in the provider's identity token. */
  nonce: string;
  /** The verifier for our own PKCE exchange with the provider. */
  providerCodeVerifier: string;
  expiresAt: number;
};

/** An issued authorization code, redeemable exactly once. */
export type AuthorizationCode = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  userId: string;
  expiresAt: number;
};

/**
 * What a refresh token stands for: the authorization, not the credential.
 *
 * These are the properties of the grant, so they live on the family rather than
 * on whichever token currently represents it. Rotating produces a new credential
 * for the same grant, and nothing here changes.
 */
export type RefreshGrant = {
  clientId: string;
  scope: string;
  resource: string;
  userId: string;
};

/**
 * The outcome of presenting a refresh token.
 *
 * Three outcomes and not two, because "this token has already been rotated" is
 * different from "there is no such token" in what it means, even though a client
 * is told the same thing either way. A spent token in a live family is evidence
 * that either the client or somebody holding a stolen copy is replaying it, and
 * the only safe response is to end the family — the legitimate holder can start
 * again, and the thief has nothing.
 */
export type RefreshRotation =
  | { outcome: "rotated"; grant: RefreshGrant; refreshToken: string }
  | { outcome: "unknown" }
  | { outcome: "replayed"; grant: RefreshGrant }
  | { outcome: "refused"; grant: RefreshGrant; refusal: GrantRefusal };

/**
 * Why a grant was not acceptable for this request.
 *
 * The store does not decide this — it is handed a check and reports what the
 * check said. What the store guarantees is *when* the check runs: before the
 * credential is spent, inside the transaction that would spend it. A request
 * naming the wrong client, redirect URI, verifier, resource or scope therefore
 * leaves the credential exactly as it was, which is the difference between
 * refusing a request and consuming somebody's credential on the way to refusing
 * it.
 *
 * Shared by both grants, because it is the same idea in both: an authorization
 * code and a refresh token are single-use credentials, and neither should be
 * spendable by a request that was never going to succeed.
 */
export type GrantRefusal = { error: string; description: string };

/**
 * The outcome of presenting an authorization code.
 *
 * `unknown` covers never-existed, expired and already-redeemed together, which is
 * deliberate: to a legitimate client they mean the same thing — start again — and
 * telling them apart would tell whoever holds a stolen code which of the three it
 * is. A code is consumed by deletion, so replay finds nothing.
 */
export type CodeRedemption =
  | { outcome: "redeemed"; grant: AuthorizationCode }
  | { outcome: "unknown" }
  | { outcome: "refused"; grant: AuthorizationCode; refusal: GrantRefusal };

/**
 * How long each kind of record lives.
 *
 * An authorization code gets one minute: it is handed straight from the redirect
 * to the token request, so the only thing a longer window buys is a wider replay
 * opportunity. OAuth 2.1 recommends a maximum of ten minutes and short-lived
 * beyond that; a minute is comfortably inside it. A login in progress gets ten,
 * because a real person is signing in during it. A refresh token gets thirty
 * days, long enough that a client which checks in occasionally is not thrown
 * back to a browser, and short enough that an abandoned one lapses on its own.
 */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * How long a client registration survives without being used.
 *
 * Registration is open by necessity — dynamic registration is how a client that
 * has never met this server gets an id — so without this the table is the one
 * thing here that grows and never shrinks, and a rate limit only bounds how fast.
 * Ninety days is comfortably longer than the thirty a refresh token lives, so no
 * client that is still in use can reach it, and a client that has lapsed will
 * simply register again, which is the mechanism it already implements.
 *
 * "Used" means an authorization was started for it. Looking a client up is not
 * use: a token request quotes an id it was given, and counting that would keep a
 * registration alive on the strength of a stranger guessing at it.
 */
export const CLIENT_RETENTION_MS = 90 * 24 * 60 * 60_000;

/**
 * How long a rate-limit bucket is kept after anyone last touched it.
 *
 * A bucket has a window rather than a lifetime, so it is aged out instead of
 * expiring: a day is comfortably longer than any window this server uses, and
 * keeping them for ever would let the table grow with every address that has
 * ever called an open endpoint.
 */
export const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60_000;

/**
 * The store, as the protocol code sees it.
 *
 * Two shapes of operation, and the difference between them is the whole point of
 * this task. `issue*` and `park*` mint a reference and return it. `take*` and
 * `redeem*` **spend** one: they return the record and make it unusable in the
 * same indivisible step, so a second presentation of the same value finds
 * nothing. An adapter that implements those as a read followed by a write is
 * wrong, however carefully it is written — between the two, a concurrent request
 * on another instance can read the same row and both callers succeed.
 *
 * `now` is an explicit parameter throughout rather than read from the clock
 * inside. It keeps expiry testable without waiting, and every TTL here is
 * minutes or days, so an application clock is precise enough for the comparison.
 */
export type OAuthStore = {
  registerClient(client: Omit<RegisteredClient, "clientId" | "registeredAt">): Promise<RegisteredClient>;
  client(clientId: string): Promise<RegisteredClient | undefined>;

  /**
   * Parks a request and returns the single-use reference that resumes it.
   *
   * `browserBinding` ties the record to one browser: the value is given to that
   * browser as a cookie, and only a request carrying it back can resume this
   * record. Required, so that a record which anything could resume is not
   * expressible.
   */
  parkLogin(login: Omit<PendingLogin, "expiresAt">, browserBinding: string): Promise<string>;
  /**
   * Resumes a parked request, spending its reference.
   *
   * `browserBinding` is what the caller's browser presented. It is matched as part
   * of the same statement that spends the reference, so a mismatch finds nothing
   * *and consumes nothing* — the legitimate browser's parked request survives
   * somebody else's attempt on it, and the check cannot be forgotten at a call
   * site because there is no call without it.
   */
  takeLogin(
    reference: string,
    browserBinding: string,
    now?: number,
  ): Promise<PendingLogin | undefined>;

  issueCode(code: Omit<AuthorizationCode, "expiresAt">): Promise<string>;
  /**
   * Redeems a code, atomically and exactly once.
   *
   * One transaction, in one order: the code is found and locked, its expiry
   * checked, `acceptable` consulted, and only then is it consumed. Nothing before
   * the last step mutates anything, so a request that fails `acceptable` — the
   * wrong client, redirect URI, verifier or resource — leaves the code redeemable
   * by the client that actually holds it.
   *
   * `acceptable` returns nothing to proceed, or a refusal to stop. It runs while
   * the row is locked, so no concurrent redemption can slip between the check and
   * the consume.
   */
  redeemCode(
    code: string,
    acceptable: (grant: AuthorizationCode) => GrantRefusal | undefined,
    now?: number,
  ): Promise<CodeRedemption>;

  /** Starts a new refresh-token family for a freshly authorized grant. */
  issueRefreshToken(grant: RefreshGrant): Promise<string>;
  /**
   * Spends a refresh token and issues its successor, atomically and exactly once.
   *
   * One transaction, in one order: the token and its family are found and locked,
   * a replay is detected, `acceptable` is consulted, and only then is the token
   * marked spent and its successor created. Nothing before the last step mutates
   * anything, so a request that fails `acceptable` — the wrong client, the wrong
   * resource, too wide a scope — leaves the credential usable.
   *
   * `acceptable` returns nothing to proceed, or a refusal to stop. It runs while
   * the row is locked, so no concurrent rotation can slip between the check and
   * the spend.
   */
  rotateRefreshToken(
    token: string,
    acceptable: (grant: RefreshGrant) => GrantRefusal | undefined,
    now?: number,
  ): Promise<RefreshRotation>;

  /**
   * Counts one request against a bucket, and says whether it may proceed.
   *
   * A fixed window, incremented inside the statement so that concurrent requests
   * cannot both see the same count. `false` means the caller is over the limit.
   *
   * Rate limiting is not a correctness mechanism here and must not become one:
   * it exists so that an open endpoint has a ceiling, and every caller treats a
   * refusal as "later", never as "invalid".
   */
  consumeRateLimit(bucket: string, limit: number, windowMs: number, now?: number): Promise<boolean>;

  /**
   * Deletes expired records, returning how many went.
   *
   * Never load-bearing: every read above filters on expiry itself, so a store
   * that is never cleaned is still correct, only larger. See the adapter for
   * when this runs on its own.
   */
  cleanup(now?: number): Promise<number>;
};

/**
 * A reference to something in the store: unguessable, and meaningless on its
 * own.
 *
 * 32 bytes from the system CSPRNG. Authorization codes, refresh tokens and the
 * flow references are all bearer credentials, so the only thing between an
 * attacker and someone else's grant is that the value cannot be guessed or
 * derived — which is also why they carry no structure. Base64url, because every
 * one of them travels in a URL or a form body.
 */
export function reference(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * What a store actually keeps: the SHA-256 of a reference, never the reference.
 *
 * A row is found by hashing what the client presented and looking that up, so a
 * copy of the database is not a set of working credentials. Whoever reads it
 * learns that a grant exists and cannot redeem it.
 *
 * A plain hash rather than a password KDF, deliberately. Slow hashing exists to
 * make guessing a *low-entropy* secret expensive; these references are 32 bytes
 * of CSPRNG output, so there is nothing to guess and a KDF would only add
 * latency to every token request. What matters here is that the function is
 * one-way and that lookup stays a single indexed probe.
 */
export function referenceHash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * The store this deployment uses, opened once.
 *
 * Cached as a promise rather than a value so that concurrent first requests share
 * one connection and one migration run instead of racing to build their own —
 * and forgotten if it fails, so a transient failure does not leave the instance
 * permanently unable to open a store.
 */
let opening: Promise<OAuthStore> | undefined;

export function oauthStore(): Promise<OAuthStore> {
  opening ??= open().catch((error: unknown) => {
    opening = undefined;
    throw error;
  });
  return opening;
}

/**
 * Opens the store on the shared connection.
 *
 * Choosing the driver and refusing to run without durable storage in production
 * both moved to `lib/db.ts`, because they are the database's business rather than
 * OAuth's and the product store needs the same answer. What is left here is this
 * schema and this adapter.
 */
async function open(): Promise<OAuthStore> {
  const driver = await database();
  const { OAUTH_SCHEMA, sqlOAuthStore } = await import("./store/sql.ts");

  // Outside production this migrates; in production it checks and refuses. A
  // deploy runs `npm run db:migrate` in its own step, and DDL never runs because
  // a request arrived. See lib/db/migrate.ts.
  await prepareSchema(driver, OAUTH_SCHEMA);
  return sqlOAuthStore(driver);
}
