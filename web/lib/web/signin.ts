import { randomBytes } from "node:crypto";

import { AccessDeniedError } from "../oauth/access.ts";
import { ConfigurationError, deployment, signingKey, type Deployment } from "../oauth/config.ts";
import { IdentityError } from "../oauth/google.ts";
import { wrongOrigin } from "../oauth/origin.ts";
import { challengeFor, createPkce } from "../oauth/pkce.ts";
import { admittedIdentity, identityProvider, type IdentityProvider } from "../oauth/provider.ts";
import {
  SIGN_INS_PER_WINDOW,
  SIGN_IN_WINDOW_MS,
  callerBucket,
  tooManyRequestsPage,
} from "../oauth/rate-limit.ts";
import { configurationFault, errorPage } from "../oauth/responses.ts";
import { oauthStore } from "../oauth/store.ts";
import {
  clearLoginCookie,
  clearSessionCookie,
  loginBindingOf,
  newBinding,
  sessionOf,
  setLoginCookie,
  setSessionCookie,
} from "./cookies.ts";
import { WEB_LOGIN_TTL_MS, WEB_SESSION_TTL_MS, webStore, type WebStore } from "./store.ts";

/**
 * Signing a person in to inboxlabeler.com, and out again.
 *
 *     POST /auth/signin    park a sign-in, bind it to this browser  ─►  Google
 *     GET  /auth/callback  Google returns  ─►  session cookie       ─►  /dashboard
 *     POST /auth/signout   delete the session, forget the cookie    ─►  /
 *
 * This is authentication of a human in a browser, and it is deliberately a
 * separate thing from the OAuth flow under `/oauth`, which is an MCP client
 * asking a user to authorize it. The two share what they should — one identity
 * provider, one access list, one canonical user identity, one deployment
 * configuration, one PKCE implementation, one database — and share nothing else.
 * Neither can produce the other's credential: this flow cannot mint an
 * authorization code, and the OAuth flow cannot mint a session cookie, because
 * they read and write different tables and there is no branch between them.
 *
 * ## Why both endpoints that a page reaches are POST
 *
 * Starting a sign-in and signing out are both `POST`, and both refuse a request
 * whose `Origin` is not this deployment's. `SameSite=Lax` already means a
 * cross-site form post carries no cookie, so a forged sign-out could not end
 * anybody's session; the `Origin` check is the belt to that braces, and it is what
 * makes "another site cannot start or end a session here" true without depending
 * on a browser having honoured a cookie attribute. Starting a sign-in through a
 * GET would additionally mean a link, a prefetch or an image tag could set a
 * cookie and consume a rate-limit budget on a visitor's behalf.
 */

/**
 * Starts a sign-in.
 *
 * Never short-circuits when a session already exists, on purpose: pressing sign
 * in while signed in is how somebody switches Google account, and answering it
 * with "you are already signed in" would make the account they are trying to
 * leave the one they are stuck with.
 */
export async function handleSignIn(request: Request): Promise<Response> {
  let config;
  // Read here rather than where it is used, so a deployment missing it is
  // answered as the configuration fault it is. Needed on this path because the
  // rate-limit bucket is derived from it: see `callerBucket`.
  let key;
  try {
    config = deployment();
    key = signingKey();
  } catch (error) {
    return configurationFault(error, "text");
  }

  const misdirected = wrongOrigin(request, config, "text");
  if (misdirected) return misdirected;

  const forged = crossSite(request, config);
  if (forged) return forged;

  // Counted before anything is written on this caller's behalf. Every press that
  // gets past here parks a record, so the ceiling is what keeps a stranger from
  // filling the table with them.
  const allowed = await (await oauthStore()).consumeRateLimit(
    callerBucket("signin", request, key),
    SIGN_INS_PER_WINDOW,
    SIGN_IN_WINDOW_MS,
  );
  if (!allowed) return tooManyRequestsPage("sign-in attempts", "press sign in again");

  // Everything checked on the way back is fixed now, before the browser leaves:
  // our own PKCE verifier for the exchange with Google, the nonce the identity
  // token has to carry, and the value that ties the returning `state` to this
  // browser.
  const { verifier } = createPkce();
  const binding = newBinding();
  const nonce = randomBytes(16).toString("base64url");

  const state = await (await webStore()).parkLogin({
    nonce,
    providerCodeVerifier: verifier,
    browserBinding: binding,
  });

  try {
    return redirect(
      identityProvider().authorizationUrl({
        redirectUri: config.webCallbackEndpoint,
        state,
        nonce,
        codeChallenge: challengeFor(verifier),
        // No account-selection argument: the provider makes the user choose on
        // every authorization it starts, this one and an MCP client's alike. See
        // `authorizationUrl` in lib/oauth/google.ts.
      }),
      // Named after this sign-in's own state, so a second tab's sign-in neither
      // overwrites this one's cookie nor has its callback clear it.
      [setLoginCookie(state, binding, config, WEB_LOGIN_TTL_MS / 1000)],
    );
  } catch (error) {
    return configurationFault(error, "text");
  }
}

/**
 * Where Google returns a browser, and where a session begins.
 *
 * Nothing about who signs in comes from this request's query string except the
 * two values Google is supposed to return: the `state` that finds the parked
 * sign-in, and the code that is exchanged for an identity token. The subject that
 * becomes the owner is read from that token after its signature, issuer, audience,
 * expiry and nonce have been checked — so there is no field here, and no cookie,
 * that could name a different account.
 *
 * `provider` is a seam for tests, the same one `admittedIdentity` has: the round
 * trip to Google is the only step in this flow that cannot be exercised without a
 * real Google account, and everything after it is exactly what has to be proved.
 */
export async function handleWebCallback(
  request: Request,
  provider: IdentityProvider = identityProvider(),
): Promise<Response> {
  let config;
  try {
    config = deployment();
  } catch (error) {
    return configurationFault(error, "text");
  }

  const misdirected = wrongOrigin(request, config, "text");
  if (misdirected) return misdirected;

  const params = new URL(request.url).searchParams;
  const state = params.get("state");

  // Without a state there is no sign-in this callback could be about, and — this
  // is the part that matters — no cookie it is entitled to clear. Answering here
  // means a stray or forged callback cannot reach past its own flow and destroy a
  // pending sign-in waiting in another tab.
  if (!state) {
    return signInFailed(
      "This sign-in response carried no state. Start again from the home page.",
      400,
      [],
    );
  }

  // Cleared on every answer from here down, honoured or not, and only ever this
  // sign-in's: a binding is for one sign-in, so leaving it in the browser would
  // let a later one inherit it.
  const forget = clearLoginCookie(state, config);

  const binding = loginBindingOf(request, state, config);
  if (!binding) {
    return signInFailed(
      "This sign-in could not be matched to the browser that started it. Start again from the home page.",
      400,
      [forget],
    );
  }

  const login = await (await webStore()).takeLogin(state, binding);
  if (!login) {
    return signInFailed(
      "This sign-in has expired, was already completed, or was started in a different browser. Start again from the home page.",
      400,
      [forget],
    );
  }

  // Google's own refusal — most often the person closing the chooser. Reported as
  // theirs to answer rather than as a fault, and without repeating anything Google
  // put in the URL.
  if (params.get("error")) {
    return signInFailed("Signing in with Google did not complete.", 400, [forget]);
  }

  const code = params.get("code");
  if (!code) {
    return signInFailed("Google returned no authorization code.", 400, [forget]);
  }

  let identity;
  try {
    identity = await admittedIdentity(
      {
        code,
        redirectUri: config.webCallbackEndpoint,
        codeVerifier: login.providerCodeVerifier,
        nonce: login.nonce,
      },
      provider,
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationFault(error, "text");
    // Authenticated with Google, and still not admitted. Said plainly, because
    // the person reading it can act on it and it gives nothing away: they know
    // their own address, and whether it is on somebody's list is not a secret
    // from them. 403 rather than 401 — the credential was accepted, the account
    // was not.
    if (error instanceof AccessDeniedError) {
      return signInFailed(
        "This Google account is not on the Inbox Labeler closed beta's access list. " +
          "If you have more than one Google account, check that you signed in with the invited one.",
        403,
        [forget],
        "access_denied",
      );
    }
    // The reason stays in the log. It describes how an identity token failed to
    // verify, which is useful to whoever runs this and is nobody else's business.
    if (error instanceof IdentityError) {
      return signInFailed("Could not verify who signed in.", 403, [forget], "access_denied");
    }
    throw error;
  }

  const store = await webStore();

  // A sign-in in a browser that already holds a session replaces it rather than
  // adding to it — which is what switching account has to mean. The old row goes,
  // so the session that was showing the other account's labels stops working
  // rather than lingering until it expires.
  const previous = sessionOf(request, config);
  if (previous) await store.endSession(previous);

  const session = await store.createSession({ user: identity.user, email: identity.email });

  return redirect("/dashboard", [
    forget,
    setSessionCookie(session, config, WEB_SESSION_TTL_MS / 1000),
  ]);
}

/**
 * Signs out.
 *
 * The row is deleted and the cookie is cleared, in that order and both always. A
 * cookie the browser has been asked to forget is still a working credential for
 * anyone who kept a copy, so the deletion is the part that makes this mean
 * something; clearing the cookie is only tidiness on top of it.
 *
 * A cookie that matches no session is answered the same way as one that did.
 * There is nothing else to say: the browser ends up signed out either way, and
 * distinguishing them would only report whether somebody else's guess had hit a
 * live session.
 *
 * A database that cannot be reached makes this fail rather than succeed quietly,
 * which is the right way round: clearing the cookie and answering 302 would tell
 * somebody they had signed out while the session that matters — the row — was still
 * live. A failed sign-out they can see is better than one they cannot.
 */
export async function handleSignOut(
  request: Request,
  // The store, as a seam. Only a test passes one: it is the single way to drive
  // the case where the database cannot be reached, which is a case with a
  // security property in it — see the note above about failing visibly.
  sessions: Promise<WebStore> = webStore(),
): Promise<Response> {
  let config;
  try {
    config = deployment();
  } catch (error) {
    return configurationFault(error, "text");
  }

  const misdirected = wrongOrigin(request, config, "text");
  if (misdirected) return misdirected;

  const forged = crossSite(request, config);
  if (forged) return forged;

  const presented = sessionOf(request, config);
  if (presented) await (await sessions).endSession(presented);

  return redirect("/", [clearSessionCookie(config)]);
}

/**
 * Refuses a state-changing request that did not come from a page of ours.
 *
 * `Origin` is what a browser sends on every form post, same-origin ones included,
 * and it is one of the few request headers a page cannot forge. A missing header
 * is refused rather than waved through: the two callers are both forms on this
 * site, so an absent `Origin` is not something a legitimate press produces.
 *
 * This is the CSRF defence for both endpoints, and it stands alone. The session
 * cookie's `SameSite=Lax` means a cross-site post carries no session anyway, but
 * that is a property of the browser honouring an attribute, and this is a property
 * of the server.
 */
function crossSite(request: Request, config: Deployment): Response | undefined {
  if (request.headers.get("origin") === config.issuer) return undefined;

  // The configured origin, so the message is true in a local checkout as well as
  // on the hosted deployment. It is configuration, never anything the request
  // carried, so echoing it tells a caller nothing it did not already know.
  return errorPage(
    "invalid_request",
    `This request did not come from ${config.issuer}. Use the buttons on the site.`,
    403,
  );
}

/**
 * A sign-in that will not be completed, in plain text.
 *
 * Text rather than a rendered page, like every other dead end in this flow: there
 * is nothing here worth styling, and a text body cannot become a scripting bug if
 * a value from the request is ever repeated in it. None is, today.
 */
function signInFailed(
  description: string,
  status: number,
  setCookies: string[],
  error = "invalid_request",
): Response {
  const response = errorPage(error, description, status);
  for (const cookie of setCookies) response.headers.append("set-cookie", cookie);
  return response;
}

/**
 * A 302 built by hand rather than with `Response.redirect`, which refuses a
 * relative location and gives no chance to set headers. A redirect mid-flow must
 * not be cached, and both of these carry cookies.
 */
function redirect(location: string, setCookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(null, { status: 302, headers });
}
