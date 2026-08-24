import { randomBytes } from "node:crypto";

import { errorRedirect, validateAuthorization } from "./authorization-request.ts";
import { deployment } from "./config.ts";
import { consentPage } from "./consent.ts";
import {
  clearConsentSession,
  consentSessionOf,
  newConsentSession,
  setConsentSession,
} from "./consent-session.ts";
import { challengeFor, createPkce } from "./pkce.ts";
import { wrongOrigin } from "./origin.ts";
import {
  AUTHORIZATIONS_PER_WINDOW,
  AUTHORIZATION_WINDOW_MS,
  callerAddress,
  tooManyRequestsPage,
} from "./rate-limit.ts";
import { identityProvider } from "./provider.ts";
import { configurationFault, errorPage } from "./responses.ts";
import { PENDING_LOGIN_TTL_MS, oauthStore } from "./store.ts";

/**
 * The authorization endpoint: two steps at one URL.
 *
 *     GET   validate the request, then ask the user           ─►  consent page
 *     POST  the user answered                                 ─►  the provider
 *
 * Two methods rather than two paths, so `authorization_endpoint` in the
 * discovery document names one place, and so the approval and the request it
 * approves stay together — the only reason the POST exists is the GET.
 *
 * Nothing here decides who the user is. That is the identity provider's job and
 * happens after approval; this endpoint's own work is deciding whether the
 * client may ask at all.
 */

export async function handleAuthorize(request: Request): Promise<Response> {
  let config;
  try {
    config = deployment();
  } catch (error) {
    return configurationFault(error, "text");
  }

  // First, before the database is even opened: a request at a hostname this
  // deployment does not serve is not a request for this server.
  const misdirected = wrongOrigin(request, config, "text");
  if (misdirected) return misdirected;

  const store = await oauthStore();

  // Counted before anything is read or written on this caller's behalf. Every
  // visit that gets past here parks a request, so the ceiling is what keeps a
  // stranger from filling the table with them.
  const allowed = await store.consumeRateLimit(
    `authorize:${callerAddress(request)}`,
    AUTHORIZATIONS_PER_WINDOW,
    AUTHORIZATION_WINDOW_MS,
  );
  if (!allowed) return tooManyRequestsPage("authorization requests");

  const params = new URL(request.url).searchParams;
  const clientId = params.get("client_id");
  const client = clientId ? await store.client(clientId) : undefined;

  const validated = validateAuthorization(params, client, config);

  if ("kind" in validated) {
    if (validated.kind === "unredirectable") {
      return errorPage(validated.error, validated.description, validated.status);
    }
    return redirect(errorRedirect(validated, config.issuer));
  }

  // Everything the flow will need is decided now and parked, the nonce and our
  // own PKCE pair included. Generating them here rather than after approval
  // means the values checked on the way back were fixed before the user was
  // sent anywhere.
  const { verifier } = createPkce();
  // The value the browser will hold, and the record it unlocks. Only its hash is
  // stored, so the cookie is the only copy that can be presented.
  const consentSession = newConsentSession();
  const reference = await store.parkLogin({
    clientId: validated.clientId,
    redirectUri: validated.redirectUri,
    codeChallenge: validated.codeChallenge,
    scope: validated.scope,
    resource: validated.resource,
    clientState: validated.clientState,
    nonce: randomBytes(16).toString("base64url"),
    providerCodeVerifier: verifier,
  }, consentSession);

  return new Response(
    consentPage({
      clientName: client?.clientName,
      redirectUri: validated.redirectUri,
      reference,
      action: config.authorizationEndpoint,
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "set-cookie": setConsentSession(reference, consentSession, config, PENDING_LOGIN_TTL_MS / 1000),
        // A consent decision has to be made on this page, not inside someone
        // else's. Framing it is how a clickjacking attack collects an approval
        // the user believed was something else.
        "x-frame-options": "DENY",
        "content-security-policy":
          "frame-ancestors 'none'; default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

/**
 * The user answered the consent page.
 *
 * The parked request is taken, not read: the reference is spent here, so a
 * submission cannot be replayed, and a page that was never served the reference
 * cannot forge one. That is what stands in for a separate CSRF token.
 */
export async function handleConsent(request: Request): Promise<Response> {
  let config;
  try {
    config = deployment();
  } catch (error) {
    return configurationFault(error, "text");
  }

  const misdirected = wrongOrigin(request, config, "text");
  if (misdirected) return misdirected;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage("invalid_request", "The approval could not be read.", 400);
  }

  const reference = form.get("request");
  if (typeof reference !== "string") {
    return errorPage("invalid_request", "The approval form was incomplete.", 400);
  }

  // The binding the browser is carrying. A cross-site submission has none,
  // because the cookie is SameSite=Strict — and an approval without one resumes
  // nothing, because the record was parked with a binding to match.
  const presented = consentSessionOf(request, reference);
  const forget = clearConsentSession(reference, config);

  if (presented === null) {
    return errorPage(
      "invalid_request",
      "This approval did not come from the browser that was shown the page. Start again from your MCP client.",
      400,
      forget,
    );
  }

  const store = await oauthStore();
  const login = await store.takeLogin(reference, presented);
  if (!login) {
    return errorPage(
      "invalid_request",
      "This authorization request has expired, was already used, or was approved from a different browser. Start again from your MCP client.",
      400,
      forget,
    );
  }

  if (form.get("approve") !== "yes") {
    // A refusal is the client's answer to receive, not an error page for the
    // user to be stuck on. `access_denied` is what OAuth defines for exactly
    // this, and the client can then say so in its own words.
    return redirect(
      errorRedirect(
        {
          kind: "redirectable",
          redirectUri: login.redirectUri,
          error: "access_denied",
          description: "The user declined to connect this application.",
          clientState: login.clientState,
        },
        config.issuer,
      ),
      forget,
    );
  }

  // Approved. Park it again; the new reference is what travels as the
  // provider's `state`, so a value the provider echoes back can only have come
  // from an approval that happened.
  // Parked again without a binding: from here the reference travels as the
  // provider's `state` and comes back on a top-level redirect, where a cookie
  // would prove nothing the reference does not already prove.
  const state = await store.parkLogin(login);

  try {
    return redirect(
      identityProvider().authorizationUrl({
        redirectUri: config.callbackEndpoint,
        state,
        nonce: login.nonce,
        codeChallenge: challengeFor(login.providerCodeVerifier),
      }),
      forget,
    );
  } catch (error) {
    return configurationFault(error, "text");
  }
}

/**
 * A 302 built by hand rather than with `Response.redirect`.
 *
 * `Response.redirect` refuses a URL it considers non-absolute and gives no
 * chance to set headers; a redirect mid-flow must not be cached, so the header
 * matters.
 */
function redirect(location: string, setCookie?: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(null, { status: 302, headers });
}


