import { randomBytes } from "node:crypto";

import { errorRedirect, validateAuthorization } from "./authorization-request.ts";
import { deployment } from "./config.ts";
import { consentPage } from "./consent.ts";
import { challengeFor, createPkce } from "./pkce.ts";
import { identityProvider } from "./provider.ts";
import { configurationFault, errorPage } from "./responses.ts";
import { oauthStore } from "./store.ts";

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

  const store = await oauthStore();
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
  const reference = await store.parkLogin({
    clientId: validated.clientId,
    redirectUri: validated.redirectUri,
    codeChallenge: validated.codeChallenge,
    scope: validated.scope,
    resource: validated.resource,
    clientState: validated.clientState,
    nonce: randomBytes(16).toString("base64url"),
    providerCodeVerifier: verifier,
  });

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

  const store = await oauthStore();
  const login = await store.takeLogin(reference);
  if (!login) {
    return errorPage(
      "invalid_request",
      "This authorization request has expired or was already used. Start again from your MCP client.",
      400,
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
    );
  }

  // Approved. Park it again; the new reference is what travels as the
  // provider's `state`, so a value the provider echoes back can only have come
  // from an approval that happened.
  const state = await store.parkLogin(login);

  try {
    return redirect(
      identityProvider().authorizationUrl({
        redirectUri: config.callbackEndpoint,
        state,
        nonce: login.nonce,
        codeChallenge: challengeFor(login.providerCodeVerifier),
      }),
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
function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}


