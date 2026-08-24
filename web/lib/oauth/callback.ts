import { codeRedirect, errorRedirect, type Redirectable } from "./authorization-request.ts";
import { ConfigurationError, deployment } from "./config.ts";
import { IdentityError } from "./google.ts";
import { wrongOrigin } from "./origin.ts";
import { identityProvider } from "./provider.ts";
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
 */
export async function handleProviderCallback(request: Request): Promise<Response> {
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

  const login = await (await oauthStore()).takeLogin(reference, null);
  if (!login) {
    return errorPage(
      "invalid_request",
      "This sign-in has expired or was already completed. Start again from your MCP client.",
      400,
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
    user = await identityProvider().identify({
      code: providerCode,
      redirectUri: config.callbackEndpoint,
      codeVerifier: login.providerCodeVerifier,
      nonce: login.nonce,
    });
  } catch (error) {
    if (error instanceof ConfigurationError) return configurationFault(error, "text");
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

  return redirect(codeRedirect(login.redirectUri, code, config.issuer, login.clientState));
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "no-store" },
  });
}
