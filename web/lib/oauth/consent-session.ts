import { createHash, randomBytes } from "node:crypto";

import type { Deployment } from "./config.ts";

/**
 * Binding a consent decision to the browser that was shown the page.
 *
 * The reference in the consent form is unguessable, and that is not enough. The
 * attacker in question is not guessing it — they made the authorization request
 * themselves, for a client they registered, so they hold the reference already.
 * What they lack is a user. If approving takes nothing but the reference, they can
 * put it in a form on their own site, have a signed-in victim's browser submit it,
 * and collect a code for the victim's account at their own redirect URI.
 *
 * So the page hands the browser a second value it does not get to see, and the
 * approval is only honoured when it comes back:
 *
 *     GET  /oauth/authorize   parks the request, bound to a fresh session value
 *                             Set-Cookie: the value, HttpOnly + SameSite=Strict
 *     POST /oauth/authorize   the cookie must come back, or nothing is resumed
 *                             and the cookie is cleared either way
 *
 * `SameSite=Strict` is the part that actually stops the attack — a cross-site
 * form submission does not carry the cookie, so the approval arrives unbound and
 * finds no record. What makes that true rather than merely likely is that the
 * binding is checked by the same statement that spends the reference: it does not
 * depend on the browser having honoured the attribute, and there is no route that
 * could forget to look.
 *
 * `HttpOnly` because no script has any reason to read it. `Path=/oauth` because
 * nothing outside the flow sends it. `Secure` whenever the deployment is not
 * loopback, which is derived from the configured origin rather than from a switch
 * that could be left in the wrong position.
 *
 * ## One binding per flow, not per browser
 *
 * The cookie's *name* carries the flow it belongs to. A single name would make
 * these bindings mutually exclusive: opening a second authorization request in the
 * same browser — two MCP clients being connected, or one client retried in another
 * tab — would overwrite the first's cookie and leave a request that can no longer
 * be approved. Naming the cookie after the request makes concurrent flows
 * independent, and each one is cleared on its own when it is answered.
 *
 * The name is derived from the reference the form already carries, so nothing new
 * has to travel between the page and the approval. It is not a secret: the
 * reference is in the form, and knowing which cookie belongs to a flow is no help
 * without the value inside it.
 */

/** The prefix every consent cookie's name starts with. */
export const CONSENT_COOKIE_PREFIX = "il_consent_";

/**
 * The cookie name for one authorization request.
 *
 * A short digest of the reference rather than the reference itself: it keeps the
 * name to a sensible length, and a cookie name is a place values get logged by
 * things that would not think to redact one.
 */
export function consentCookieName(reference: string): string {
  return CONSENT_COOKIE_PREFIX + createHash("sha256").update(reference, "utf8").digest("hex").slice(0, 16);
}

/** A fresh binding value: 32 bytes from the system CSPRNG, like every reference. */
export function newConsentSession(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Reads the binding a request is carrying, if any.
 *
 * Parsed from the header rather than through a framework helper so that this
 * works identically in a route handler and in a test that builds a `Request` by
 * hand — the whole point is to be able to prove the two-browser case.
 */
export function consentSessionOf(request: Request, reference: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  const wanted = consentCookieName(reference);
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== wanted) continue;

    const value = pair.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

/** The `Set-Cookie` that gives a browser its binding. */
export function setConsentSession(
  reference: string,
  value: string,
  deployment: Deployment,
  maxAgeSeconds: number,
): string {
  return attributes([
    `${consentCookieName(reference)}=${value}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/oauth",
    `Max-Age=${maxAgeSeconds}`,
  ], deployment);
}

/**
 * The `Set-Cookie` that takes it away again.
 *
 * Sent on every answer to an approval, whether or not it was honoured: a binding
 * is for one decision, so leaving it in the browser would let a later request
 * inherit it. Only this flow's cookie is cleared — another flow in the same
 * browser is still waiting for its own answer.
 */
export function clearConsentSession(reference: string, deployment: Deployment): string {
  return attributes(
    [`${consentCookieName(reference)}=`, "HttpOnly", "SameSite=Strict", "Path=/oauth", "Max-Age=0"],
    deployment,
  );
}

function attributes(parts: string[], deployment: Deployment): string {
  // `Secure` on anything but loopback. A browser rejects a Secure cookie over
  // plain http, which would silently break local development — and there is no
  // transit to protect there.
  return (deployment.insecure ? parts : [...parts, "Secure"]).join("; ");
}
