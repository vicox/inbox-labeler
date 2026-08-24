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
