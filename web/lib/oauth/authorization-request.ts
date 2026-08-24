import { isRegisteredRedirectUri } from "./clients.ts";
import { MCP_SCOPE, type Deployment } from "./config.ts";
import { checkCodeChallenge } from "./pkce.ts";
import { sameResource } from "./resource.ts";
import type { RegisteredClient } from "./store.ts";

/**
 * Checking an authorization request, and the two ways of refusing one.
 *
 * The split matters more than it looks. RFC 6749 §4.1.2.1 divides failures by
 * whether the redirect URI can be trusted yet:
 *
 * - **Before** the client and its redirect URI are known good, an error must be
 *   shown to the user and **must not** be redirected anywhere. Redirecting on a
 *   bad redirect URI is the open-redirect the check exists to stop, and it would
 *   turn this endpoint into a way to bounce people to a phishing page under our
 *   own domain's good name.
 * - **After** both check out, an error goes back to the client as a redirect, so
 *   it can report the problem instead of leaving the user on a dead page.
 *
 * Everything here is a pure decision over parameters, a client record and the
 * deployment. No store, no request, no network — which is what makes the rules
 * testable one at a time.
 */

/** A request that passed every check, ready to be parked. */
export type AuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  resource: string;
  clientState?: string;
};

/** Refused before the redirect URI was trusted: show it, never redirect it. */
export type Unredirectable = {
  kind: "unredirectable";
  status: 400;
  error: string;
  description: string;
};

/** Refused after the redirect URI was trusted: hand it back to the client. */
export type Redirectable = {
  kind: "redirectable";
  redirectUri: string;
  error: string;
  description: string;
  clientState?: string;
};

export type AuthorizationRejection = Unredirectable | Redirectable;

/**
 * Validates an authorization request in the order the rules allow.
 *
 * The sequence is the security property: nothing may be redirected until the
 * client and its redirect URI have both been established, so those two checks
 * come first and every later failure is allowed to redirect.
 */
export function validateAuthorization(
  params: URLSearchParams,
  client: RegisteredClient | undefined,
  deployment: Deployment,
): AuthorizationRequest | AuthorizationRejection {
  const clientId = params.get("client_id");
  if (!clientId) {
    return unredirectable("invalid_request", "client_id is required.");
  }
  if (!client) {
    return unredirectable(
      "invalid_client",
      "Unknown client_id. Register at the registration endpoint first, or re-register: this server's client registrations do not survive a restart.",
    );
  }

  // A single registered redirect URI is not a default. Requiring the parameter
  // even then keeps one client's request from ever being completed against
  // another's registration, and matches what OAuth 2.1 asks of a public client.
  const redirectUri = params.get("redirect_uri");
  if (!redirectUri) {
    return unredirectable("invalid_request", "redirect_uri is required.");
  }
  if (!isRegisteredRedirectUri(client.redirectUris, redirectUri)) {
    return unredirectable(
      "invalid_request",
      "redirect_uri does not exactly match a URI registered by this client.",
    );
  }

  // Past this line the redirect URI is trusted, so failures go back to the
  // client rather than stopping in front of the user.
  const clientState = params.get("state") ?? undefined;
  const reject = (error: string, description: string): Redirectable => ({
    kind: "redirectable",
    redirectUri,
    error,
    description,
    clientState,
  });

  if (params.get("response_type") !== "code") {
    return reject(
      "unsupported_response_type",
      "response_type must be \"code\": this server supports the authorization code flow only.",
    );
  }

  const presented = params.get("code_challenge");
  if (!presented) {
    return reject("invalid_request", "code_challenge is required: this server requires PKCE.");
  }
  if (params.get("code_challenge_method") !== "S256") {
    // No default, and no `plain`. OAuth 2.1 removes `plain`, and treating a
    // missing method as `plain` — which RFC 7636 once did — would silently
    // accept a challenge that proves nothing.
    return reject(
      "invalid_request",
      "code_challenge_method must be \"S256\".",
    );
  }
  // Checked here rather than at the token endpoint, because a challenge that no
  // verifier can satisfy should fail the request that was malformed and not the
  // exchange that comes minutes later.
  const checked = checkCodeChallenge(presented);
  if ("error" in checked) return reject("invalid_request", checked.error);
  const codeChallenge = checked.challenge;

  const scope = params.get("scope");
  if (scope !== null) {
    const requested = scope.split(" ").filter(Boolean);
    const unknown = requested.filter((one) => one !== MCP_SCOPE);
    if (unknown.length) {
      return reject("invalid_scope", `Unknown scope: ${unknown.join(", ")}.`);
    }
  }

  // RFC 8707. A client is required by the MCP specification to name the
  // resource it wants a token for, and this server has exactly one — so a
  // mismatch is refused rather than quietly retargeted, and an absent value
  // falls back to the only answer it could have had. That fallback is what
  // keeps a client that predates the requirement working.
  const resource = params.get("resource");
  if (resource !== null && !sameResource(resource, deployment.resource)) {
    return reject(
      "invalid_target",
      `This server issues tokens for ${deployment.resource} only.`,
    );
  }

  return {
    clientId: client.clientId,
    redirectUri,
    codeChallenge,
    scope: MCP_SCOPE,
    resource: deployment.resource,
    clientState,
  };
}

function unredirectable(error: string, description: string): Unredirectable {
  return { kind: "unredirectable", status: 400, error, description };
}

/**
 * Builds the redirect that carries an error back to the client.
 *
 * `iss` is included, on success and failure alike. RFC 9207 requires it in both
 * — an error response is just as forgeable as a successful one — and this
 * server advertises `authorization_response_iss_parameter_supported`, which
 * means a conforming client rejects any response that arrives without it.
 */
export function errorRedirect(rejection: Redirectable, issuer: string): string {
  const url = new URL(rejection.redirectUri);
  url.searchParams.set("error", rejection.error);
  url.searchParams.set("error_description", rejection.description);
  if (rejection.clientState !== undefined) url.searchParams.set("state", rejection.clientState);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

/** Builds the redirect that delivers an authorization code to the client. */
export function codeRedirect(
  redirectUri: string,
  code: string,
  issuer: string,
  clientState: string | undefined,
): string {
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (clientState !== undefined) url.searchParams.set("state", clientState);
  url.searchParams.set("iss", issuer);
  return url.toString();
}
