import { createHash } from "node:crypto";

import { clearCookie, cookieOf, newCookieValue, setCookie } from "../cookies.ts";
import type { Deployment } from "./config.ts";

/**
 * Binding each pause in the OAuth flow to the browser that is walking through it.
 *
 * The flow pauses twice, and both pauses hand a reference to the browser and take
 * it back later. A reference alone is not evidence of anything here, because the
 * attacker in question is not guessing it: they made the authorization request
 * themselves, for a client they registered, so they hold every reference the flow
 * produces. What they lack is a *user*. Each pause therefore also hands the browser
 * a value it never sees the inside of, and the pause only resumes when that value
 * comes back with it:
 *
 *     GET  /oauth/authorize   park, bound to a consent binding   ─► the page
 *     POST /oauth/authorize   the consent binding must return    ─► Google
 *                             park again, bound to a fresh provider binding
 *     GET  /oauth/callback    the provider binding must return   ─► the code
 *
 * ## Why the second pause needs its own binding
 *
 * Without one, the Google authorization URL that an approval produces is a bearer
 * credential for the approval: the `state` in it names a parked, *already
 * approved* login, and anything that completes the Google leg with it receives an
 * InboxLabeler authorization code for the account that signs in. So browser A
 * approves, and the URL is opened in browser B — by an attacker who obtained it,
 * or by a person pasting it — and browser B walks away with a code bound to
 * whoever B was signed in to Google as. The approval and the identity come from
 * two different people, which is precisely what an authorization flow exists to
 * prevent.
 *
 * A fresh binding at the moment of approval closes it. B does not have A's cookie,
 * so B resumes nothing; and because the binding is matched by the same statement
 * that spends the reference, B's attempt consumes nothing either — A's approval is
 * still there to be completed by A.
 *
 * It is a *fresh* value rather than the consent binding carried forward. The two
 * pauses are two steps and each is spent on first use, so reusing one value would
 * mean a value that survives its own consumption; and a fresh one keeps the
 * consent cookie's `SameSite=Strict` where it belongs while the provider leg gets
 * the `Lax` it needs.
 *
 * ## Strict for consent, Lax for the provider leg
 *
 * The consent binding is presented by a form posting to the origin that served it,
 * so `Strict` applies and is what actually stops a cross-site submission of an
 * approval. The provider binding is presented on a top-level navigation arriving
 * *from Google*, which is a cross-site context: with `Strict` the browser would not
 * send it, and no sign-in could ever complete. `Lax` sends a cookie on exactly
 * that navigation and withholds it from cross-site form posts and subresource
 * requests. Nothing is lost by the difference, because what the provider binding
 * defends against is a different browser, not a different site.
 *
 * ## One cookie per flow, not per browser
 *
 * Both names carry the flow they belong to. A single name would make these
 * bindings mutually exclusive: two MCP clients being connected at once, or one
 * client retried in another tab, would overwrite each other's cookie and leave a
 * request that can no longer be approved. Naming each cookie after the reference
 * it belongs to makes concurrent flows independent, and each is cleared on its own
 * when it is answered.
 *
 * The name is derived from the reference the request already carries — in the form,
 * or as the provider's `state` — so nothing new has to travel. It is not a secret:
 * knowing which cookie belongs to a flow is no help without the value inside it.
 */

/** The prefixes the two families of binding cookie are named with. */
export const CONSENT_COOKIE = "il_consent";
export const PROVIDER_COOKIE = "il_provider";

/**
 * The cookie name for one pause of one flow.
 *
 * A short digest of the reference rather than the reference itself: it keeps the
 * name to a sensible length, and a cookie name is a place values get logged by
 * things that would not think to redact one.
 */
function flowCookie(family: string, reference: string): string {
  return `${family}_${createHash("sha256").update(reference, "utf8").digest("hex").slice(0, 16)}`;
}

/** A fresh binding value. Shared with the website's cookies: one construction. */
export const newBinding = newCookieValue;

// --- the consent pause ------------------------------------------------------

export function consentBindingOf(
  request: Request,
  reference: string,
  deployment: Deployment,
): string | null {
  return cookieOf(request, flowCookie(CONSENT_COOKIE, reference), deployment);
}

export function setConsentBinding(
  reference: string,
  value: string,
  deployment: Deployment,
  maxAgeSeconds: number,
): string {
  return setCookie(flowCookie(CONSENT_COOKIE, reference), value, deployment, {
    sameSite: "Strict",
    maxAgeSeconds,
  });
}

/**
 * Sent on every answer to an approval, whether or not it was honoured: a binding
 * is for one decision, so leaving it in the browser would let a later request
 * inherit it. Only this flow's cookie is cleared — another flow in the same
 * browser is still waiting for its own answer.
 */
export function clearConsentBinding(reference: string, deployment: Deployment): string {
  return clearCookie(flowCookie(CONSENT_COOKIE, reference), deployment, "Strict");
}

// --- the provider pause -----------------------------------------------------

export function providerBindingOf(
  request: Request,
  state: string,
  deployment: Deployment,
): string | null {
  return cookieOf(request, flowCookie(PROVIDER_COOKIE, state), deployment);
}

export function setProviderBinding(
  state: string,
  value: string,
  deployment: Deployment,
  maxAgeSeconds: number,
): string {
  return setCookie(flowCookie(PROVIDER_COOKIE, state), value, deployment, {
    sameSite: "Lax",
    maxAgeSeconds,
  });
}

/**
 * Cleared on every answer from the callback, honoured or not, and only ever this
 * flow's: a second authorization waiting in the same browser keeps its own.
 */
export function clearProviderBinding(state: string, deployment: Deployment): string {
  return clearCookie(flowCookie(PROVIDER_COOKIE, state), deployment, "Lax");
}
