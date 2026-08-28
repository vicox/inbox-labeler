import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";

/**
 * Where this deployment lives, and the secret it signs with.
 *
 * Every public URL in the OAuth and MCP surface is derived from one configured
 * origin, never from the request's Host header. That is a security decision
 * rather than a stylistic one: the issuer identifier and a token's audience are
 * strings a client compares byte for byte, and Host is attacker-controlled, so
 * deriving them from Host would let a request carrying a forged Host mint a
 * token that an honest client then accepts as belonging to a different server.
 * One explicit value, read from the environment, removes that whole class of
 * problem — and is also what lets the same code serve localhost and the
 * production origin without either of them being written down here.
 */

/**
 * The single scope this resource server understands.
 *
 * One scope, because there is currently one thing to authorize: talking to
 * InboxLabeler's MCP endpoint at all. Finer grants — reading labels versus
 * changing them — are a real distinction, but inventing the vocabulary for it
 * before the tools that would need it exist would mean guessing, and a scope
 * name is hard to take back once clients have asked for it.
 */
export const MCP_SCOPE = "mcp";

/**
 * The development origin, used only when no origin is configured and we are
 * not in production.
 *
 * This is the one place a hostname is written down. It exists so that cloning
 * the repository and running `npm run dev` produces a working discovery
 * document instead of a configuration error, which is worth one line. In
 * production a missing value is an error, never this.
 */
const DEVELOPMENT_ORIGIN = "http://localhost:3000";

/** The shortest secret we accept, in bytes: HMAC-SHA256's full key width. */
const MINIMUM_SECRET_BYTES = 32;

export type Deployment = {
  /**
   * The OAuth issuer identifier (RFC 8414) and the origin every endpoint below
   * hangs off. No trailing slash, because clients compare it literally.
   */
  issuer: string;
  /**
   * The RFC 8707 resource identifier of the MCP endpoint: the canonical URI a
   * client names when asking for a token, and the value an access token's
   * audience has to equal for us to accept it.
   */
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  /** Where the identity provider sends the user back to. */
  callbackEndpoint: string;
  /**
   * Where the identity provider sends a *browser* back to, which is a different
   * place on purpose.
   *
   * The two flows come back from Google to two endpoints because they resume two
   * different things: `callbackEndpoint` finds an MCP client's parked
   * authorization request and answers it with a code, this one finds a browser's
   * parked sign-in and answers it with a session cookie. Sharing one endpoint
   * would mean a single handler holding both kinds of state and deciding between
   * them per request — and the failure mode of getting that wrong is a browser
   * sign-in redeemable as an MCP authorization. Two URLs, two tables, no
   * decision to get wrong.
   *
   * Both have to be registered with the Google client: see web/.env.example.
   */
  webCallbackEndpoint: string;
  /** The RFC 9728 document a 401 points an unauthenticated client at. */
  resourceMetadataUrl: string;
  /** The issuer's hostname, for the transport's Origin check. */
  hostname: string;
  /** True while the origin is a loopback address, which relaxes the HTTPS rule. */
  insecure: boolean;
};

/**
 * Reads the configured origin and derives every public URL from it.
 *
 * Called per request rather than once at module load. Route handlers must not
 * read configuration while a production build renders them, and a build runs
 * with none of these variables set — so resolving lazily is what keeps a
 * missing secret from turning into a failed build instead of the runtime error
 * it actually is.
 */
export function deployment(): Deployment {
  const origin = checkedOrigin(configuredOrigin());
  const resource = `${origin}/mcp`;

  return {
    issuer: origin,
    resource,
    authorizationEndpoint: `${origin}/oauth/authorize`,
    tokenEndpoint: `${origin}/oauth/token`,
    registrationEndpoint: `${origin}/oauth/register`,
    callbackEndpoint: `${origin}/oauth/callback`,
    webCallbackEndpoint: `${origin}/auth/callback`,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(resource)),
    hostname: new URL(origin).hostname,
    insecure: isLoopback(new URL(origin)),
  };
}

/**
 * The configured value, reduced to an origin — or refused if it was not one.
 *
 * A trailing slash is tolerated, because `https://host/` and `https://host` are
 * the same origin and a client comparing the issuer byte for byte must not get a
 * different answer depending on how somebody happened to type it.
 *
 * A *path* is refused rather than dropped, which is the part worth being strict
 * about. Every endpoint here is derived by appending to this value, so a
 * configured `https://host/app` would silently produce `https://host/oauth/token`
 * — a deployment that looks configured and serves its OAuth surface from
 * somewhere nobody asked for. Nothing about that would show up until a client
 * failed, so it fails here instead, while there is still somebody reading the
 * message. Mounting the application under a path is a different feature and would
 * need Next.js' own `basePath`; this refuses it rather than pretending.
 */
function checkedOrigin(configured: string): string {
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new ConfigurationError(
      `PUBLIC_ORIGIN is not a URL: ${JSON.stringify(configured)}. It must be an origin such as https://inboxlabeler.com.`,
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError(
      `PUBLIC_ORIGIN must be an http or https URL, not ${url.protocol}`,
    );
  }

  const path = url.pathname === "/" ? "" : url.pathname;
  if (path || url.search || url.hash) {
    throw new ConfigurationError(
      `PUBLIC_ORIGIN must be an origin with no path, query or fragment. ` +
        `Got ${JSON.stringify(configured)}; every OAuth and MCP URL is derived by appending to it, ` +
        `so use ${JSON.stringify(url.origin)} instead.`,
    );
  }

  return url.origin;
}

function configuredOrigin(): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) return configured;

  if (process.env.NODE_ENV === "production") {
    throw new ConfigurationError(
      "PUBLIC_ORIGIN is not set. It must be the public origin this deployment is reached at, e.g. https://inboxlabeler.com.",
    );
  }
  return DEVELOPMENT_ORIGIN;
}

/**
 * The key every token and grant reference is signed with.
 *
 * A short secret is rejected rather than stretched. Padding a weak value into
 * a key-shaped one would leave the deployment looking configured while its
 * tokens stayed forgeable, and a forgeable access token is the one failure
 * this whole layer exists to prevent — so it is better to refuse to start.
 */
export function signingKey(): Uint8Array {
  const secret = process.env.OAUTH_SIGNING_SECRET ?? "";
  const key = new TextEncoder().encode(secret);
  if (key.byteLength < MINIMUM_SECRET_BYTES) {
    throw new ConfigurationError(
      `OAUTH_SIGNING_SECRET must be at least ${MINIMUM_SECRET_BYTES} bytes. Generate one with: openssl rand -base64 48`,
    );
  }
  return key;
}

/**
 * A deployment that is missing something it needs.
 *
 * Its own type so a route can answer 500 for it and keep 400 for a client that
 * sent a bad request — the two look alike at the point they are caught and mean
 * opposite things to whoever has to fix them.
 *
 * It writes itself to stderr on construction, which is unusual and deliberate.
 * The message never reaches a client — a public endpoint naming its own
 * environment variables tells whoever is probing how the deployment is put
 * together — so the log is the only place an operator can learn what is wrong.
 * Logging where the error is *made* rather than where it is caught is what makes
 * that true on every path, including the ones that surface as a framework or SDK
 * error nobody here shapes. Nothing sensitive can be in it: this is raised before
 * any credential is read, and it names variables rather than values.
 */
export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";

  constructor(message: string) {
    super(message);
    console.error(`[inboxlabeler] configuration error: ${message}`);
  }
}

/**
 * Loopback is the one place a non-HTTPS origin is legitimate, and only there:
 * a hostname that merely resolves to a loopback address does not count, since
 * we can only see the name.
 */
function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}
