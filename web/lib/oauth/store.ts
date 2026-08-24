import { createHash, randomBytes } from "node:crypto";

import { database } from "../db.ts";
import { migrate } from "../db/migrate.ts";

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

/** An issued refresh token, replaced by a new one each time it is used. */
export type RefreshToken = {
  clientId: string;
  scope: string;
  resource: string;
  userId: string;
  expiresAt: number;
};

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

  /** Parks a request and returns the single-use reference that resumes it. */
  parkLogin(login: Omit<PendingLogin, "expiresAt">): Promise<string>;
  /** Resumes a parked request, spending its reference. */
  takeLogin(reference: string, now?: number): Promise<PendingLogin | undefined>;

  issueCode(code: Omit<AuthorizationCode, "expiresAt">): Promise<string>;
  /** Redeems a code, atomically and exactly once. */
  redeemCode(code: string, now?: number): Promise<AuthorizationCode | undefined>;

  issueRefreshToken(token: Omit<RefreshToken, "expiresAt">): Promise<string>;
  /** Rotates a refresh token, atomically and exactly once. */
  redeemRefreshToken(token: string, now?: number): Promise<RefreshToken | undefined>;

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
 * Cached as a promise rather than a value so that concurrent first requests
 * share one connection pool and one migration run instead of racing to build
 * their own.
 */
let opening: Promise<OAuthStore> | undefined;

export function oauthStore(): Promise<OAuthStore> {
  opening ??= open();
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

  // Migrating here as well as from `npm run db:migrate` is belt and braces: a
  // deploy should run the command in its own step, and an instance that comes up
  // against an un-migrated database should still work rather than serve errors
  // until someone notices.
  await migrate(driver, OAUTH_SCHEMA);
  return sqlOAuthStore(driver);
}
