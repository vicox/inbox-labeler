import { deployment, signingKey, type Deployment } from "./config.ts";
import { checkCodeVerifier, verifyCodeChallenge } from "./pkce.ts";
import { wrongOrigin } from "./origin.ts";
import { sameResource } from "./resource.ts";
import { configurationFault, json, oauthError } from "./responses.ts";
import {
  oauthStore,
  type AuthorizationCode,
  type GrantRefusal,
  type RefreshGrant,
} from "./store.ts";
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
    return configurationFault(error);
  }

  const misdirected = wrongOrigin(request, config);
  if (misdirected) return misdirected;

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

  // The verifier's shape is decidable from the request alone, so it is settled
  // before the database is touched: a malformed one is the caller's mistake and
  // has nothing to do with any stored code.
  const verifier = checkCodeVerifier(field("code_verifier"));
  if ("error" in verifier) return oauthError("invalid_request", verifier.error, 400);

  const redirectUri = field("redirect_uri");
  const requestedResource = field("resource");

  /**
   * Everything this request has to be right about, checked against the code.
   *
   * Handed to the store rather than applied to its answer, because the order
   * matters: a request naming the wrong client, redirect URI or verifier must not
   * have consumed the code by the time it is refused. Anyone who learns a code —
   * from a log, a referrer, a shared screen — could otherwise burn it with a
   * single malformed exchange and strand the client that legitimately holds it.
   * The store runs this while the row is locked and before it is deleted, so a
   * refusal costs that client nothing.
   */
  const acceptable = (granted: AuthorizationCode): GrantRefusal | undefined => {
    // The code was issued to one client. Presenting it as another is either a
    // mix-up or an intercepted code being redeemed by its interceptor.
    if (granted.clientId !== clientId) {
      return {
        error: "invalid_grant",
        description: "The authorization code was not issued to this client.",
      };
    }

    // RFC 6749 §4.1.3: the redirect URI must be repeated and must match, so a
    // code obtained through one registered URI cannot be redeemed as though it
    // had come back through another.
    if (redirectUri !== granted.redirectUri) {
      return {
        error: "invalid_grant",
        description: "redirect_uri does not match the authorization request.",
      };
    }

    if (!verifyCodeChallenge(granted.codeChallenge, verifier.verifier)) {
      return {
        error: "invalid_grant",
        description: "code_verifier does not match the code_challenge.",
      };
    }

    // RFC 8707: anything other than the resource the code was issued for is
    // refused rather than quietly retargeted. The whole value of an audience is
    // that it cannot be changed after the user approved it.
    if (requestedResource !== undefined && !sameResource(requestedResource, granted.resource)) {
      return {
        error: "invalid_target",
        description: `This code is bound to ${granted.resource}.`,
      };
    }

    // And if this deployment no longer serves the resource the code was approved
    // for, the code stops being redeemable rather than being pointed at whatever
    // the origin is now.
    if (!sameResource(granted.resource, config.resource)) {
      return {
        error: "invalid_grant",
        description: "This grant was issued for a resource this server no longer serves. Start again.",
      };
    }

    return undefined;
  };

  const redemption = await (await oauthStore()).redeemCode(code, acceptable);

  if (redemption.outcome === "refused") {
    return oauthError(redemption.refusal.error, redemption.refusal.description, 400);
  }

  // One answer for never-existed, expired and already-redeemed. To a legitimate
  // client they mean the same thing — start again — and telling them apart would
  // tell whoever holds a stolen code which of the three it is.
  if (redemption.outcome !== "redeemed") {
    return oauthError(
      "invalid_grant",
      "The authorization code is invalid, expired, or already used.",
      400,
    );
  }

  const { grant } = redemption;
  return issue(config, key, {
    clientId,
    userId: grant.userId,
    scope: grant.scope,
    resource: grant.resource,
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

  const requestedScope = field("scope");
  const requestedResource = field("resource");

  /**
   * Everything this request has to be right about, checked against the grant.
   *
   * Handed to the store rather than applied to its answer, because the order
   * matters: a request naming the wrong client must not have consumed a working
   * refresh token by the time it is refused. The store runs this while the row is
   * locked and before it is spent, so a refusal costs the holder nothing.
   */
  const acceptable = (grant: RefreshGrant): GrantRefusal | undefined => {
    if (grant.clientId !== clientId) {
      return {
        error: "invalid_grant",
        description: "The refresh token was not issued to this client.",
      };
    }

    // A refresh request may ask for less than it holds, never more.
    if (requestedScope !== undefined) {
      const held = grant.scope.split(" ");
      if (requestedScope.split(" ").some((one) => !held.includes(one))) {
        return {
          error: "invalid_scope",
          description: "A refresh token cannot be exchanged for a wider scope.",
        };
      }
    }

    if (requestedResource !== undefined && !sameResource(requestedResource, grant.resource)) {
      return {
        error: "invalid_target",
        description: `This refresh token is bound to ${grant.resource}.`,
      };
    }

    // The grant names the resource the user approved. If this deployment no
    // longer serves it — the configured origin moved — the grant stops being
    // redeemable rather than being retargeted onto the new one. Checked here, not
    // in `issue`, so that it too costs the holder nothing.
    if (!sameResource(grant.resource, config.resource)) {
      return {
        error: "invalid_grant",
        description: "This grant was issued for a resource this server no longer serves. Start again.",
      };
    }

    return undefined;
  };

  const rotation = await (await oauthStore()).rotateRefreshToken(presented, acceptable);

  if (rotation.outcome === "refused") {
    return oauthError(rotation.refusal.error, rotation.refusal.description, 400);
  }

  // One answer for a token that is gone, whichever way it went. A client that has
  // lost its place is told to start again, and whoever is replaying a stolen
  // token learns nothing about whether it was recognised — which is the only
  // reason the outcomes are distinguished inside the store rather than out here.
  if (rotation.outcome !== "rotated") {
    return oauthError("invalid_grant", "The refresh token is invalid, expired, or already used.", 400);
  }

  return issue(config, key, rotation.grant, rotation.refreshToken);
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
  rotated?: string,
): Promise<Response> {
  // The grant names the resource the user approved. If this deployment no longer
  // serves it — the configured origin moved — the grant is not retargeted onto
  // the new one, it stops being redeemable. Minting for the new resource would
  // hand out a token for something nobody authorized, and minting for the old one
  // would hand out a token this server would then refuse.
  //
  // Both grants now check this before they consume anything, so reaching it means
  // something changed between that check and this one. It stays as the last line
  // rather than being removed: this is the only place the audience is decided, and
  // a token minted for a resource this server would refuse is worse than an error.
  if (!sameResource(grant.resource, config.resource)) {
    return oauthError(
      "invalid_grant",
      "This grant was issued for a resource this server no longer serves. Start again.",
      400,
    );
  }

  const { token } = await mintAccessToken(
    config,
    key,
    { id: grant.userId },
    grant.clientId,
    grant.scope,
    grant.resource,
  );

  // A rotation already minted its successor, inside the same transaction that
  // spent the token it replaces. Only a fresh authorization starts a family.
  const refreshToken =
    rotated ??
    (await (await oauthStore()).issueRefreshToken({
      clientId: grant.clientId,
      userId: grant.userId,
      scope: grant.scope,
      resource: grant.resource,
    }));

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
