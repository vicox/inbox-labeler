import { randomBytes } from "node:crypto";

/**
 * The short-lived state an OAuth flow needs between requests: registered
 * clients, logins in progress, authorization codes and refresh tokens.
 *
 * Access tokens are deliberately absent. They are signed documents that carry
 * everything needed to check them, so the MCP endpoint — the hot path, and the
 * one that has to work on every instance — validates a request without reading
 * anything from here. What is left is the flow state that genuinely cannot be
 * stateless, because its correctness *is* the record of what has already
 * happened: an authorization code has to be refusable the second time it is
 * presented, and a rotated refresh token has to stop working. A signed value
 * cannot express "already used".
 *
 * ## This store is memory, and that is a real limitation
 *
 * It lives in one process. Restart it and pending logins, unredeemed codes,
 * refresh tokens and client registrations are gone; run two instances and each
 * has its own. Neither breaks an access token already in a client's hands —
 * those keep working until they expire, because nothing here is consulted to
 * validate one — but a client mid-flow gets an error and has to start again,
 * and a client that registered against one instance is unknown to the others.
 *
 * So this is enough to develop and test the flow against, and not enough to
 * host it. Making it durable is a storage decision that belongs with the one
 * InboxLabeler's own per-user state will need, which is why it is not being
 * guessed at here. Everything below goes through this one interface so that
 * choice lands in one file.
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
 *     GET  /oauth/authorize   park   ─►  reference travels in the consent form
 *     POST /oauth/authorize   take, park ─►  reference travels as the provider's `state`
 *     GET  /oauth/callback    take
 *
 * Each reference is unguessable and spent on first use, which is what makes the
 * first one a CSRF token for the consent form as well as a lookup key: a page
 * that has not been served the form cannot forge a submission of it.
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
 * An authorization code gets one minute: it is handed straight from the
 * redirect to the token request, so the only thing a longer window buys is a
 * wider replay opportunity. OAuth 2.1 recommends a maximum of ten minutes and
 * short-lived beyond that; a minute is comfortably inside it. A login in
 * progress gets ten, because a real person is typing a password in the middle
 * of it. A refresh token gets thirty days, long enough that a client which
 * checks in occasionally is not thrown back to a browser, and short enough that
 * an abandoned one lapses on its own.
 */
export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const PENDING_LOGIN_TTL_MS = 10 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * A reference to something in the store: unguessable, and meaningless on its
 * own.
 *
 * 32 bytes from the system CSPRNG. Authorization codes and refresh tokens are
 * bearer credentials, so the only thing standing between an attacker and
 * someone else's grant is that the value cannot be guessed or derived — which
 * is also why they carry no structure. Base64url, because every one of them
 * travels in a URL or a form body.
 */
function reference(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * A record kept until it expires.
 *
 * Expiry is checked on read rather than swept on a timer. A record past its
 * expiry is indistinguishable from one that was never there, which is the
 * behaviour every caller wants, and it means there is no background job whose
 * failure could quietly leave stale grants redeemable.
 */
class Expiring<T extends { expiresAt: number }> {
  private readonly records = new Map<string, T>();

  put(record: T): string {
    const key = reference();
    this.records.set(key, record);
    this.sweep();
    return key;
  }

  get(key: string, now: number): T | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    if (record.expiresAt <= now) {
      this.records.delete(key);
      return undefined;
    }
    return record;
  }

  /**
   * Reads a record and removes it in the same step.
   *
   * The two halves are inseparable on purpose. This is what makes an
   * authorization code single-use and a refresh token rotate: a second
   * presentation of the same value finds nothing, because taking it *is*
   * spending it. Splitting them into a get and a later delete would leave a
   * window where two concurrent redemptions both succeed.
   */
  take(key: string, now: number): T | undefined {
    const record = this.get(key, now);
    if (record) this.records.delete(key);
    return record;
  }

  /** Drops whatever has already expired, so an idle process stops growing. */
  private sweep(): void {
    const now = Date.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(key);
    }
  }

  /** Test seam: how many records are held, expired ones included. */
  get size(): number {
    return this.records.size;
  }
}

/**
 * One store, holding the four kinds of flow state.
 *
 * Exposed as a class so a test can work against its own instance instead of
 * whatever earlier tests left in a shared one; the module-level `store` below
 * is the single instance the routes use.
 */
export class OAuthStore {
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly logins = new Expiring<PendingLogin>();
  private readonly codes = new Expiring<AuthorizationCode>();
  private readonly refreshTokens = new Expiring<RefreshToken>();

  /**
   * Registers a client and returns its id.
   *
   * The id is a fresh random reference rather than anything derived from the
   * client's metadata: two clients that register identical metadata are still
   * two clients, and a client id that could be predicted from a name would let
   * one impersonate another at the token endpoint.
   */
  registerClient(client: Omit<RegisteredClient, "clientId" | "registeredAt">): RegisteredClient {
    const registered: RegisteredClient = {
      ...client,
      clientId: reference(),
      registeredAt: Date.now(),
    };
    this.clients.set(registered.clientId, registered);
    return registered;
  }

  client(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  /** Parks a request and returns the single-use reference that resumes it. */
  parkLogin(login: Omit<PendingLogin, "expiresAt">): string {
    return this.logins.put({ ...login, expiresAt: Date.now() + PENDING_LOGIN_TTL_MS });
  }

  /** Resumes a parked request, spending its reference. */
  takeLogin(reference: string, now = Date.now()): PendingLogin | undefined {
    return this.logins.take(reference, now);
  }

  issueCode(code: Omit<AuthorizationCode, "expiresAt">): string {
    return this.codes.put({ ...code, expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_MS });
  }

  redeemCode(code: string, now = Date.now()): AuthorizationCode | undefined {
    return this.codes.take(code, now);
  }

  issueRefreshToken(token: Omit<RefreshToken, "expiresAt">): string {
    return this.refreshTokens.put({ ...token, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS });
  }

  redeemRefreshToken(token: string, now = Date.now()): RefreshToken | undefined {
    return this.refreshTokens.take(token, now);
  }
}

/**
 * The instance the route handlers share.
 *
 * Module state, which in development means Next.js can discard it on a reload —
 * one more reason the store above says what it says about being memory.
 */
export const store = new OAuthStore();
