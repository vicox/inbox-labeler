import { createRemoteJWKSet, jwtVerify } from "jose";

import { ConfigurationError } from "./config.ts";
import type { IdentityProvider, VerifiedIdentity } from "./provider.ts";

/**
 * Google as the identity provider: the only file that knows Google exists.
 *
 * Everything Google-shaped is behind this module's two functions — its
 * endpoints, the OpenID Connect identity token, the keys that sign one, the
 * claim the subject lives in. What leaves is an `AuthenticatedUser`, so the rest
 * of the OAuth layer stays provider-agnostic and a second provider is a sibling
 * file rather than a change here.
 *
 * Note what is *not* asked for. The scope is `openid email`: enough to learn that
 * a real Google account authenticated, which one it was, and the address needed
 * to answer whether it is on this deployment's access list. `profile` is one word
 * away and deliberately not requested — a name and a picture would tell
 * InboxLabeler nothing it needs, and data that is never collected cannot leak.
 *
 * The address leaves this module only as far as the seam in `provider.ts`, which
 * asks the access list about it. For an MCP client's authorization it is dropped
 * there and goes no further. For a website sign-in it travels one step more, into
 * the browser-session row that the site reads to say which Google account it
 * is showing — and out again when that session ends. No token and no MCP result
 * ever carries it.
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

    // Derived from the endpoint above rather than written again: two strings that
    // have to agree are two strings that can stop agreeing, and this one governs
    // what the consent page's policy admits.
    authorizationOrigin: new URL(AUTHORIZATION_ENDPOINT).origin,

    authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
      const url = new URL(AUTHORIZATION_ENDPOINT);
      url.search = new URLSearchParams({
        client_id: credentials().clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "openid email",
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        // `prompt=select_account` is Google's name for "show the chooser", and it
        // is sent on every authorization this server starts — the website's own
        // sign-in and an MCP client's alike.
        //
        // Without it, a browser holding several Google sessions has one of them
        // chosen for it, and the person at the keyboard is never told which. The
        // symptom is not an error: they arrive signed in, or connect a
        // client, as an identity they did not pick, and the only sign is that
        // their labels appear to be missing. This deployment has already seen that
        // confusion.
        //
        // Unconditional rather than a per-flow option, because there is no flow
        // here that wants the other behaviour. An identity provider whose answer
        // depended on which of our flows asked would be a provider with two
        // meanings, and the extra click it costs someone with one account is the
        // whole of the price.
        //
        // It is not a substitute for the browser bindings in `flow-binding.ts`.
        // This makes the *chosen* account visible to the person choosing; the
        // bindings are what keep the browser that approved and the browser that
        // signs in the same browser. Neither does the other's job.
        prompt: "select_account",
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
async function identityFrom(
  idToken: string,
  audience: string,
  nonce: string,
): Promise<VerifiedIdentity> {
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, keys, { issuer: ISSUERS, audience }));
  } catch {
    throw new IdentityError("Google's identity token did not verify.");
  }

  return identityFromClaims(payload, nonce);
}

/**
 * The claims a verified identity token has to carry, and what they mean.
 *
 * Separate from the verification above so that what is required of the *claims*
 * can be stated — and tested — without forging a signature Google alone can make.
 * Reaching this function means the token's signature, issuer, audience and expiry
 * have already been checked; what is left is whether it says enough to act on.
 */
export function identityFromClaims(
  payload: Record<string, unknown>,
  nonce: string,
): VerifiedIdentity {
  if (payload.nonce !== nonce) {
    throw new IdentityError("Google's identity token belongs to a different login.");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new IdentityError("Google's identity token carried no subject.");
  }

  // An address is only evidence of anything if Google says it verified it.
  // `email_verified` false means the account holder typed an address and never
  // proved it, so an allowlist checked against it would be an allowlist anyone
  // could put themselves on.
  if (typeof payload.email !== "string" || !payload.email.trim()) {
    throw new IdentityError("Google's identity token carried no email address.");
  }
  if (payload.email_verified !== true) {
    throw new IdentityError("Google has not verified this account's email address.");
  }

  // `sub` is Google's stable, opaque identifier for the account: it survives a
  // change of email address, which is exactly the property a storage key needs
  // and exactly the one an address lacks. Qualified with the provider name so
  // it can never collide with a subject minted elsewhere.
  return {
    user: { id: `google:${payload.sub}` },
    email: payload.email.trim().toLowerCase(),
  };
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
