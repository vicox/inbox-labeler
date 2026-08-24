import { createRemoteJWKSet, jwtVerify } from "jose";

import type { AuthenticatedUser } from "../identity.ts";
import { ConfigurationError } from "./config.ts";
import type { IdentityProvider } from "./provider.ts";

/**
 * Google as the identity provider: the only file that knows Google exists.
 *
 * Everything Google-shaped is behind this module's two functions — its
 * endpoints, the OpenID Connect identity token, the keys that sign one, the
 * claim the subject lives in. What leaves is an `AuthenticatedUser`, so the rest
 * of the OAuth layer stays provider-agnostic and a second provider is a sibling
 * file rather than a change here.
 *
 * Note what is *not* asked for. The scope is `openid` alone: enough to learn
 * that a real Google account authenticated and which one it was, and nothing
 * more. Email and profile are one word away and deliberately not requested —
 * InboxLabeler does not need them to decide whose labels these are, and data
 * that is never collected cannot leak.
 */

/**
 * Google's OpenID Connect endpoints, as published in its discovery document at
 * https://accounts.google.com/.well-known/openid-configuration.
 *
 * Written out rather than discovered at runtime. They have been stable for
 * years and are documented as such, and fetching the document on the
 * authorization path would add a network round trip — and a way for a login to
 * fail — in exchange for a change that has not happened.
 */
const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";

/**
 * The issuer values Google signs identity tokens with.
 *
 * Two spellings, both current: Google has issued tokens under the bare host as
 * well as the https form, and its own documentation tells verifiers to accept
 * either. Accepting exactly these two and nothing else is the point of writing
 * them down.
 */
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

/**
 * The key set, fetched once and refreshed as Google rotates.
 *
 * Module scope so the fetch is shared and cached across logins rather than
 * repeated per request. `jose` handles the rotation and the caching; the
 * alternative is pinning keys by hand and being broken the day they change.
 */
const keys = createRemoteJWKSet(new URL(JWKS_URI));

export function google(): IdentityProvider {
  return {
    name: "google",

    authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: credentials().clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      }).toString();
      return url.toString();
    },

    async identify({ code, redirectUri, codeVerifier, nonce }) {
      const { clientId, clientSecret } = credentials();

      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: codeVerifier,
        }),
      });

      if (!response.ok) {
        // The body may name the account or echo the code, so it is not repeated
        // here: this message ends up in a browser and in whatever logs the
        // deployment keeps.
        throw new IdentityError(`Google rejected the authorization code (HTTP ${response.status}).`);
      }

      const body: unknown = await response.json();
      const idToken = (body as { id_token?: unknown }).id_token;
      if (typeof idToken !== "string") {
        throw new IdentityError("Google's token response carried no identity token.");
      }

      return identityFrom(idToken, clientId, nonce);
    },
  };
}

/**
 * Verifies the identity token and reads the one claim we keep.
 *
 * Signature, issuer, audience and expiry are checked by `jose` against Google's
 * published keys — an identity token is only evidence once all four hold, and
 * reading claims out of an unverified one is how a login gets forged.
 *
 * The nonce is checked here rather than by the library. It is what ties this
 * token to the login we started: without it a token Google legitimately issued
 * for some other session could be replayed into this one, and it would verify
 * perfectly.
 */
async function identityFrom(idToken: string, audience: string, nonce: string): Promise<AuthenticatedUser> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, { issuer: ISSUERS, audience }));
  } catch {
    throw new IdentityError("Google's identity token did not verify.");
  }

  if (payload.nonce !== nonce) {
    throw new IdentityError("Google's identity token belongs to a different login.");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new IdentityError("Google's identity token carried no subject.");
  }

  // `sub` is Google's stable, opaque identifier for the account: it survives a
  // change of email address, which is exactly the property a storage key needs
  // and exactly the one an address lacks. Qualified with the provider name so
  // it can never collide with a subject minted elsewhere.
  return { id: `google:${payload.sub}` };
}

/**
 * The deployment's registered Google application.
 *
 * Read per call, so a build — which runs with none of this set — never trips
 * over it. A missing value is a `ConfigurationError`, which the routes answer
 * as a server fault rather than blaming the client for it.
 */
function credentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new ConfigurationError(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set to authenticate users. See web/.env.example.",
    );
  }
  return { clientId, clientSecret };
}

/** A login that could not be completed. Never carries a token or a claim. */
export class IdentityError extends Error {
  override readonly name = "IdentityError";
}
