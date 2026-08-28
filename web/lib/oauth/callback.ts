import { codeRedirect, errorRedirect, type Redirectable } from "./authorization-request.ts";
import { ConfigurationError, deployment } from "./config.ts";
import { AccessDeniedError } from "./access.ts";
import { clearProviderBinding, providerBindingOf } from "./flow-binding.ts";
import { IdentityError } from "./google.ts";
import { wrongOrigin } from "./origin.ts";
import { identifyUser, identityProvider, type IdentityProvider } from "./provider.ts";
import { configurationFault, errorPage } from "./responses.ts";
import { oauthStore } from "./store.ts";

/**
 * Where the identity provider returns the user, and where the flow rejoins the
 * client's own.
 *
 *     provider ─► /oauth/callback ─► authorization code ─► client's redirect_uri
 *
 * The parked request is what makes that join safe. Everything used to build the
 * response — which client, which redirect URI, which code challenge, which
 * `state` to echo — is read from the record parked before the user left, never
 * from this request's own query string. The provider returns two things and two
 * only: an authorization code of its own, and the reference that finds the
 * record.
 *
 * And the record is not found by that reference alone. It was parked bound to a
 * value this browser holds as a cookie, and the binding is matched by the same
 * statement that spends the reference — so a `state` that reaches a *different*
 * browser finds nothing and consumes nothing. Without that, the Google URL an
 * approval produces would be enough on its own to collect a code for whichever
 * account the browser opening it happens to be signed in to, which would join one
 * person's approval to another person's identity. See flow-binding.ts.
 */
export async function handleProviderCallback(
  request: Request,
  // The identity provider, as a seam. Only a test passes one: the round trip to
  // Google is the single step of this flow that cannot be exercised without a real
  // Google account, and everything it guards — which browser may complete an
  // approved authorization, and what the code that comes out is bound to — is
  // exactly what has to be proved. The same seam `admittedIdentity` has.
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
  const reference = params.get("state");
  if (!reference) {
    return errorPage("invalid_request", "The sign-in response carried no state.", 400);
  }

  // Cleared on every answer below, honoured or not, and only ever this flow's.
  const forget = clearProviderBinding(reference, config);

  // Refused before the store is touched, so a browser that was never given the
  // binding cannot consume the approval it is trying to use. There is nothing to
  // report to a client here: without the parked record we do not know which
  // client this was, so the person in front of the browser is told instead.
  const presented = providerBindingOf(request, reference, config);
  if (!presented) {
    return errorPage(
      "invalid_request",
      "This sign-in did not come back to the browser that started it. Start again from your MCP client.",
      400,
      forget,
    );
  }

  const login = await (await oauthStore()).takeLogin(reference, presented);
  if (!login) {
    return errorPage(
      "invalid_request",
      "This sign-in has expired, was already completed, or was approved in a different browser. Start again from your MCP client.",
      400,
      forget,
    );
  }

  /** Hands a failure back to the client that asked, now that there is one to name. */
  const toClient = (error: string, description: string) =>
    redirect(
      errorRedirect(
        {
          kind: "redirectable",
          redirectUri: login.redirectUri,
          error,
          description,
          clientState: login.clientState,
        } satisfies Redirectable,
        config.issuer,
      ),
      forget,
    );

  const failed = params.get("error");
  if (failed) {
    return toClient(
      failed === "access_denied" ? "access_denied" : "server_error",
      "Signing in with Google did not complete.",
    );
  }

  const providerCode = params.get("code");
  if (!providerCode) {
    return toClient("server_error", "Google returned no authorization code.");
  }

  let user;
  try {
    user = await identifyUser(
      {
        code: providerCode,
        redirectUri: config.callbackEndpoint,
        codeVerifier: login.providerCodeVerifier,
        nonce: login.nonce,
      },
      provider,
    );
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationFault(error, "text");
    // Authenticated, and still not permitted. Said plainly, because the person
    // reading it can act on it and it gives nothing away — they know their own
    // address, and whether it is on somebody's list is not a secret from them.
    if (error instanceof AccessDeniedError) {
      return toClient("access_denied", "This Google account is not permitted to use this InboxLabeler deployment.");
    }
    if (error instanceof IdentityError) {
      // The reason stays here. It describes how an identity token failed to
      // verify, which is useful to whoever runs this and is not the client's
      // business — and an `error_description` travels in a URL.
      return toClient("access_denied", "Could not verify who signed in.");
    }
    throw error;
  }

  // The authorization code binds the user to the request that was approved. The
  // code challenge travels with it so the token endpoint can require the client
  // that began the flow to finish it, and the resource travels with it so the
  // token minted at the end is bound to the audience that was asked for.
  const code = await (await oauthStore()).issueCode({
    clientId: login.clientId,
    redirectUri: login.redirectUri,
    codeChallenge: login.codeChallenge,
    scope: login.scope,
    resource: login.resource,
    userId: user.id,
  });

  return redirect(codeRedirect(login.redirectUri, code, config.issuer, login.clientState), forget);
}

function redirect(location: string, setCookie: string): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  headers.append("set-cookie", setCookie);
  return new Response(null, { status: 302, headers });
}
