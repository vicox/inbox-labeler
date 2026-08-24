import { ConfigurationError, deployment, signingKey, type Deployment } from "./config.ts";
import { verifyCodeChallenge } from "./pkce.ts";
import { json, oauthError } from "./responses.ts";
import { store } from "./store.ts";
import { ACCESS_TOKEN_TTL_SECONDS, mintAccessToken } from "./tokens.ts";

/**
 * The token endpoint: an authorization code or a refresh token in, an access
 * token out.
 *
 * Two grants, and one rule they share — the credential presented is spent by
 * being presented. `redeemCode` and `redeemRefreshToken` both read and delete in
 * one step, so an authorization code works once and a refresh token is replaced
 * by the one issued alongside its access token. OAuth 2.1 requires that rotation
 * for public clients, and it is what turns a stolen refresh token into a
 * detectable failure rather than indefinite access.
 *
 * No client authentication, because there is none to have: MCP clients are
 * public clients that cannot keep a secret. PKCE does the work a secret would —
 * the code challenge fixed at the start of the flow can only be satisfied by
 * whoever chose the verifier.
 */
export async function handleToken(request: Request): Promise<Response> {
  let config: Deployment;
  let key: Uint8Array;
  try {
    config = deployment();
    key = signingKey();
  } catch (error) {
    if (error instanceof ConfigurationError) return oauthError("server_error", error.message, 500);
    throw error;
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "The request body must be form-encoded.", 400);
  }

  const field = (name: string): string | undefined => {
    const value = form.get(name);
    return typeof value === "string" && value ? value : undefined;
  };

  const clientId = field("client_id");
  if (!clientId) return oauthError("invalid_client", "client_id is required.", 401);

  switch (field("grant_type")) {
    case "authorization_code":
      return authorizationCodeGrant(config, key, clientId, field);
    case "refresh_token":
      return refreshTokenGrant(config, key, clientId, field);
    case undefined:
      return oauthError("invalid_request", "grant_type is required.", 400);
    default:
      return oauthError(
        "unsupported_grant_type",
        "This server supports the authorization_code and refresh_token grants.",
        400,
      );
  }
}

type Field = (name: string) => string | undefined;

async function authorizationCodeGrant(
  config: Deployment,
  key: Uint8Array,
  clientId: string,
  field: Field,
): Promise<Response> {
  const code = field("code");
  if (!code) return oauthError("invalid_request", "code is required.", 400);

  const granted = store.redeemCode(code);
  if (!granted) {
    // One answer for never-existed, expired and already-redeemed. To a
    // legitimate client they mean the same thing — start again — and telling
    // them apart would tell whoever holds a stolen code which of the three it is.
    return oauthError(
      "invalid_grant",
      "The authorization code is invalid, expired, or already used.",
      400,
    );
  }

  // The code was issued to one client. Presenting it as another is either a
  // mix-up or an intercepted code being redeemed by its interceptor.
  if (granted.clientId !== clientId) {
    return oauthError("invalid_grant", "The authorization code was not issued to this client.", 400);
  }

  // RFC 6749 §4.1.3: the redirect URI must be repeated and must match, so a code
  // obtained through one registered URI cannot be redeemed as though it had come
  // back through another.
  if (field("redirect_uri") !== granted.redirectUri) {
    return oauthError("invalid_grant", "redirect_uri does not match the authorization request.", 400);
  }

  if (!verifyCodeChallenge(granted.codeChallenge, field("code_verifier"))) {
    return oauthError("invalid_grant", "code_verifier does not match the code_challenge.", 400);
  }

  // RFC 8707: anything other than the resource the code was issued for is
  // refused rather than quietly retargeted. The whole value of an audience is
  // that it cannot be changed after the user approved it.
  const resource = field("resource");
  if (resource !== undefined && resource !== granted.resource) {
    return oauthError("invalid_target", `This code is bound to ${granted.resource}.`, 400);
  }

  return issue(config, key, {
    clientId,
    userId: granted.userId,
    scope: granted.scope,
    resource: granted.resource,
  });
}

async function refreshTokenGrant(
  config: Deployment,
  key: Uint8Array,
  clientId: string,
  field: Field,
): Promise<Response> {
  const presented = field("refresh_token");
  if (!presented) return oauthError("invalid_request", "refresh_token is required.", 400);

  const granted = store.redeemRefreshToken(presented);
  if (!granted) {
    return oauthError("invalid_grant", "The refresh token is invalid, expired, or already used.", 400);
  }
  if (granted.clientId !== clientId) {
    return oauthError("invalid_grant", "The refresh token was not issued to this client.", 400);
  }

  // A refresh request may ask for less than it holds, never more.
  const requested = field("scope");
  if (requested !== undefined) {
    const held = granted.scope.split(" ");
    if (requested.split(" ").some((one) => !held.includes(one))) {
      return oauthError("invalid_scope", "A refresh token cannot be exchanged for a wider scope.", 400);
    }
  }

  const resource = field("resource");
  if (resource !== undefined && resource !== granted.resource) {
    return oauthError("invalid_target", `This refresh token is bound to ${granted.resource}.`, 400);
  }

  return issue(config, key, {
    clientId,
    userId: granted.userId,
    scope: granted.scope,
    resource: granted.resource,
  });
}

/**
 * Mints the pair a successful grant returns.
 *
 * The user id comes from the redeemed grant and from nowhere else. No field of
 * the request reaches it, which is the invariant the MCP endpoint's guarantee
 * rests on: a token says who it is for because the authorization flow decided,
 * not because a client asked.
 */
async function issue(
  config: Deployment,
  key: Uint8Array,
  grant: { clientId: string; userId: string; scope: string; resource: string },
): Promise<Response> {
  const { token } = await mintAccessToken(config, key, { id: grant.userId }, grant.clientId, grant.scope);

  const refreshToken = store.issueRefreshToken({
    clientId: grant.clientId,
    userId: grant.userId,
    scope: grant.scope,
    resource: grant.resource,
  });

  return json(
    {
      access_token: token,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: grant.scope,
    },
    200,
  );
}
