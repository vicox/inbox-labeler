import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * PKCE (RFC 7636), in both directions.
 *
 * This server needs both halves. It *checks* a challenge, as the authorization
 * server an MCP client talks to, and it *creates* one, as the client talking to
 * the upstream identity provider. The two are the same construction seen from
 * opposite ends, so they belong together.
 *
 * Only S256 exists here. OAuth 2.1 removes the `plain` method, and it was never
 * worth having: a challenge equal to its own verifier proves nothing to anyone
 * who saw the authorization request go past.
 */

/** A verifier and the challenge derived from it, for our leg to the provider. */
export type Pkce = { verifier: string; challenge: string };

/**
 * The alphabet RFC 7636 allows in a verifier: unreserved URI characters.
 *
 * Written out because the point of checking is to reject what is outside it. A
 * value carrying anything else is not a verifier a conforming client produced, so
 * there is nothing to be gained by trying to make sense of it.
 */
const VERIFIER_CHARACTERS = /^[A-Za-z0-9\-._~]+$/u;

/** And the alphabet a base64url challenge is written in — no padding. */
const CHALLENGE_CHARACTERS = /^[A-Za-z0-9\-_]+$/u;

/** RFC 7636 section 4.1: a verifier is between 43 and 128 characters. */
const VERIFIER_MIN = 43;
const VERIFIER_MAX = 128;

/**
 * An S256 challenge is the base64url of a SHA-256 digest, so its length is not a
 * range: 32 bytes is always 43 unpadded base64url characters.
 */
const S256_CHALLENGE_LENGTH = 43;

/**
 * A fresh verifier, and its challenge.
 *
 * 32 random bytes, base64url — 43 characters, the shortest RFC 7636 allows,
 * and already the full width of the hash it feeds. Length beyond this adds no
 * unpredictability, and the value has to survive a URL.
 */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

/** S256: the base64url SHA-256 of the verifier's ASCII bytes. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * Checks a code challenge, returning it, or explains what is wrong with it.
 *
 * Only S256 exists here, and an S256 challenge has exactly one shape: 43
 * characters of base64url. Anything else was not produced by hashing a verifier,
 * so accepting it would mean storing a challenge no verifier can ever satisfy —
 * a flow that fails at the token endpoint instead of at the request that was
 * actually malformed.
 */
export function checkCodeChallenge(value: unknown): { challenge: string } | { error: string } {
  const challenge = typeof value === "string" ? value : "";

  if (challenge.length !== S256_CHALLENGE_LENGTH) {
    return {
      error:
        `code_challenge must be ${S256_CHALLENGE_LENGTH} characters: the base64url of a SHA-256 digest.`,
    };
  }
  if (!CHALLENGE_CHARACTERS.test(challenge)) {
    return { error: "code_challenge must be base64url, without padding." };
  }
  return { challenge };
}

/**
 * Checks a code verifier against RFC 7636's own limits.
 *
 * Length and alphabet, before the value is hashed. A verifier outside them cannot
 * be the one a conforming client generated, and checking here means a malformed
 * request is refused as malformed rather than as a mismatched proof — which is
 * the difference between a client that can fix itself and one that cannot see
 * why it is failing.
 */
export function checkCodeVerifier(value: unknown): { verifier: string } | { error: string } {
  const verifier = typeof value === "string" ? value : "";

  if (verifier.length < VERIFIER_MIN || verifier.length > VERIFIER_MAX) {
    return {
      error: `code_verifier must be between ${VERIFIER_MIN} and ${VERIFIER_MAX} characters.`,
    };
  }
  if (!VERIFIER_CHARACTERS.test(verifier)) {
    return { error: "code_verifier may only contain A-Z a-z 0-9 and the characters - . _ ~" };
  }
  return { verifier };
}

/**
 * Whether this verifier is the one the stored challenge was made from.
 *
 * Compared in constant time. The challenge is not secret — it travelled in a
 * query string — but the comparison still runs against a value an attacker
 * chooses and can repeat, and a length-or-content-dependent answer is exactly
 * what makes that repetition useful. Constant time costs nothing here.
 */
export function verifyCodeChallenge(challenge: string, verifier: string | undefined): boolean {
  if (!verifier) return false;
  const expected = Buffer.from(challenge, "utf8");
  const actual = Buffer.from(challengeFor(verifier), "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
