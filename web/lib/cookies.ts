import { randomBytes } from "node:crypto";

import type { Deployment } from "./oauth/config.ts";

/**
 * How this deployment writes and reads a cookie — one set of rules, for every
 * cookie it sets.
 *
 * There are four of them, in two families, and they are all the same kind of
 * thing: an unguessable value that binds one step of a flow, or one session, to
 * the browser holding it. None carries information. The value is a lookup key
 * whose row holds the meaning, so there is nothing in a cookie to read, tamper
 * with or decode — which is why none of them is signed. A signature protects a
 * value a client is trusted to carry back with meaning intact, and these carry
 * none.
 *
 *     il_consent_<flow>   an MCP client's approval, bound to the browser shown it
 *     il_provider_<flow>  the Google leg after that approval, same browser
 *     il_login_<flow>     a website sign-in in progress
 *     il_session          a signed-in browser
 *
 * Centralised here rather than written out per cookie because the attributes are
 * the security properties. A cookie that got one of them wrong would look
 * identical to one that did not, and there would be no single place to check.
 *
 * ## `__Host-` in production
 *
 * Every cookie name is prefixed with `__Host-` unless the deployment is loopback.
 * A browser refuses to store a cookie so named unless it is `Secure`, has
 * `Path=/` and carries no `Domain` — and, crucially, refuses to store one *set by
 * a different host*, which is what makes the prefix worth having. Without it a
 * compromised sibling subdomain can set `Domain=inboxlabeler.com; <our name>=…`
 * and the browser will present it alongside ours on every request; with it, that
 * cookie cannot be created at all. The prefix is a property the browser enforces,
 * where "we never set `Domain`" is only a property of our own code.
 *
 * It is dropped on loopback because the prefix requires `Secure` and a browser
 * rejects a `Secure` cookie over plain http, which would leave local development
 * unable to sign in at all. Both the writing and the reading of a name go through
 * `cookieName`, so the two can never disagree about which form is in use.
 *
 * `Path=/` on all four follows from the prefix. It is wider than the `/oauth` and
 * `/auth` paths two of them strictly need, and that is the trade: a cookie sent on
 * requests that ignore it costs nothing, while a cookie a subdomain can forge
 * costs a flow.
 *
 * ## Duplicates are refused rather than resolved
 *
 * A `Cookie` header carrying the same name twice is ambiguous, and the ambiguity
 * is exactly what cookie tossing produces. Picking the first, or the last, would
 * be choosing which of two credentials to honour on a rule the attacker also
 * knows. So two cookies of one name read as none, the flow fails closed, and the
 * remedy — clear the cookies and start again — is one the person can perform.
 */

/** How a cookie behaves across sites. See each caller for why it wants which. */
export type SameSite = "Strict" | "Lax";

/**
 * The name this deployment stores a cookie under.
 *
 * Called by every writer and every reader, so the `__Host-` decision is made once
 * per request from the deployment rather than remembered in four places.
 */
export function cookieName(base: string, deployment: Deployment): string {
  return deployment.insecure ? base : `__Host-${base}`;
}

/** A fresh cookie value: 32 bytes from the system CSPRNG, like every reference. */
export function newCookieValue(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Reads one cookie from a request, or null when it is absent, empty or ambiguous.
 *
 * Parsed from the header rather than through a framework helper so that this
 * behaves identically in a route handler and in a test that builds a `Request` by
 * hand — which is what lets the two-browser cases be proved rather than assumed.
 *
 * `base` is the unprefixed name; the deployment decides the rest.
 */
export function cookieOf(request: Request, base: string, deployment: Deployment): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  const wanted = cookieName(base, deployment);
  const found: string[] = [];

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== wanted) continue;
    found.push(pair.slice(separator + 1).trim());
  }

  // Exactly one, or nothing. See the note on duplicates above.
  return found.length === 1 ? found[0] || null : null;
}

/** The `Set-Cookie` that gives a browser a value. */
export function setCookie(
  base: string,
  value: string,
  deployment: Deployment,
  options: { sameSite: SameSite; maxAgeSeconds: number },
): string {
  return attributes(base, value, deployment, options.sameSite, Math.floor(options.maxAgeSeconds));
}

/**
 * The `Set-Cookie` that takes it away again.
 *
 * Only ever sent together with whatever makes the value useless on the server —
 * spending a parked record, or deleting a session row. A cookie the browser has
 * been asked to forget is still a working credential for anyone who kept a copy.
 */
export function clearCookie(base: string, deployment: Deployment, sameSite: SameSite): string {
  return attributes(base, "", deployment, sameSite, 0);
}

function attributes(
  base: string,
  value: string,
  deployment: Deployment,
  sameSite: SameSite,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${cookieName(base, deployment)}=${value}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
    // Required by the `__Host-` prefix, and set even without it so that the two
    // environments differ in the name alone.
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
  ];

  // `Secure` on anything but loopback — and it is what the prefix requires, so
  // the two decisions are the same decision, taken from the configured origin
  // rather than from a switch that could be left in the wrong position.
  return (deployment.insecure ? parts : [...parts, "Secure"]).join("; ");
}
