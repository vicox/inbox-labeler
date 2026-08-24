import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";
import { SignJWT, jwtVerify } from "jose";

import type { AuthenticatedUser } from "../identity.ts";
import { MCP_SCOPE, type Deployment } from "./config.ts";

/**
 * Access tokens: how one is minted, and how the MCP endpoint checks one.
 *
 * A signed JWT rather than a reference into a store, for one reason that
 * outweighs the others: the MCP endpoint is the only part of this system that
 * runs on every request, and a self-contained token lets it decide yes or no
 * from the token and the signing key alone. No lookup, no shared store, the
 * same answer on every instance. The flow state that genuinely cannot be
 * stateless is in `store.ts`, and it is deliberately not on this path.
 *
 * The cost of that choice is that a minted token cannot be withdrawn before it
 * expires, which is why the lifetime below is an hour rather than a day.
 *
 * HS256 with the deployment secret. Symmetric is right while the same
 * deployment both issues and accepts these: nobody else needs to verify one,
 * so a public key would buy nothing and add a key pair to look after.
 */

/**
 * How long an access token lives.
 *
 * An hour. Long enough that a client is not exchanging refresh tokens
 * mid-conversation, short enough to bound the one thing a stateless token gives
 * up: the window in which a leaked token still works. A refresh token covers
 * the gap for anything longer.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** What we put in a token, beyond the registered claims. */
type AccessTokenClaims = {
  /** The client the token was issued to, kept for attribution in errors. */
  client_id: string;
  scope: string;
};

/**
 * Mints an access token for a user.
 *
 * Note what identifies the user: `sub`, set from the authenticated identity and
 * nothing else. No client-supplied value reaches it, which is the invariant the
 * whole layer rests on — a token for user A can only ever come back as user A.
 *
 * `aud` is the resource identifier the grant was authorized for (RFC 8707), and
 * it is a parameter rather than read from `deployment` on purpose. Taking it from
 * the deployment would mean that changing the configured origin silently
 * retargets every grant made under the old one: a code the user approved for one
 * resource would mint a token valid at another. The grant carries the resource it
 * was approved for, and that is the only thing allowed to decide the audience.
 *
 * It is what stops a token minted for some other resource server from being
 * replayed at ours, and what stops ours from being replayed elsewhere.
 */
export async function mintAccessToken(
  deployment: Deployment,
  key: Uint8Array,
  user: AuthenticatedUser,
  clientId: string,
  scope: string,
  resource: string,
): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({ client_id: clientId, scope } satisfies AccessTokenClaims)
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(deployment.issuer)
    .setAudience(resource)
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .setJti(crypto.randomUUID())
    .sign(key);

  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * The verifier the MCP endpoint's bearer gate runs every request through.
 *
 * Every failure — a bad signature, the wrong issuer, the wrong audience, an
 * expired token, a missing scope — comes back as the same `invalid_token`. The
 * SDK turns that into a 401 carrying the `WWW-Authenticate` challenge that
 * points a client at our Protected Resource Metadata, which is how an
 * unauthenticated client discovers where to go and get a token. Telling it
 * *which* check failed would tell an attacker probing with forged tokens the
 * same thing.
 *
 * `expiresAt` is populated deliberately: the SDK rejects a token that has no
 * expiry rather than treating it as eternal, and this is where that value comes
 * from.
 */
export function accessTokenVerifier(deployment: Deployment, key: Uint8Array): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload;
      try {
        ({ payload } = await jwtVerify(token, key, {
          issuer: deployment.issuer,
          audience: deployment.resource,
          algorithms: ["HS256"],
        }));
      } catch {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid or has expired.");
      }

      const scopes = typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
      if (!payload.sub || !scopes.includes(MCP_SCOPE)) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, "The access token is invalid or has expired.");
      }

      return {
        token,
        clientId: typeof payload.client_id === "string" ? payload.client_id : "",
        scopes,
        expiresAt: payload.exp,
        resource: new URL(deployment.resource),
        // The authenticated user, carried to the MCP boundary. `extra` is the
        // SDK's channel for exactly this, and `lib/mcp/endpoint.ts` is the only
        // reader — see `authenticatedUser` there for why it is read once, at
        // the boundary, rather than by each tool.
        extra: { userId: payload.sub },
      };
    },
  };
}
