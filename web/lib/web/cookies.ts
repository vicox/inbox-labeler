import { createHash } from "node:crypto";

import { clearCookie, cookieOf, newCookieValue, setCookie } from "../cookies.ts";
import type { Deployment } from "../oauth/config.ts";

/**
 * The website's two cookies: a sign-in in progress, and a signed-in browser.
 *
 * How they are written — `HttpOnly`, `__Host-` in production, `Secure` off
 * loopback only, `Path=/`, and a duplicate name read as no cookie at all — is
 * `lib/cookies.ts`, which is the same set of rules the OAuth flow's bindings use.
 * What is here is which cookies exist, what each one is for, and the two choices
 * that differ between them.
 *
 * ## SameSite=Lax on both, and Strict would break both
 *
 * Both are presented on a **top-level navigation arriving from Google**, which is
 * a cross-site context: with `Strict` the browser sends neither, so a sign-in
 * could never complete and a completed one would look signed-out on arrival at
 * the home page. `Lax` sends a cookie on exactly that navigation and withholds it
 * from cross-site form posts and subresource requests — which is the half that
 * matters, because the one state-changing request here is signing out.
 *
 * (The consent binding under `/oauth` keeps `Strict`, because it is presented by a
 * form posting to the origin that served it. The difference is the flow, not a
 * difference of opinion about safety.)
 *
 * ## One login cookie per sign-in, one session cookie per browser
 *
 * The login cookie's name carries the sign-in it belongs to, the way the OAuth
 * flow's bindings do. A single name would make two sign-ins in one browser
 * mutually exclusive — a second tab would overwrite the first tab's cookie, and a
 * callback answering either would clear the other's — so opening the sign-in twice
 * would leave a flow that can no longer complete, and, worse, a mismatched or
 * stale callback would destroy a *valid* pending sign-in it has nothing to do
 * with. Naming each cookie after its own `state` makes concurrent sign-ins
 * independent: each is cleared on its own, and a callback can only ever affect the
 * flow whose `state` it carries.
 *
 * The session cookie has one name, because a browser has one session. Signing in
 * again replaces it, which is what switching Google account has to mean.
 */

/** The prefix a sign-in's own cookie is named with. */
export const LOGIN_COOKIE = "il_login";

/** The cookie a signed-in browser holds. */
export const SESSION_COOKIE = "il_session";

/**
 * The login cookie's name for one sign-in.
 *
 * A short digest of the `state` rather than the `state` itself: it keeps the name
 * to a sensible length, and a cookie name is a place values get logged by things
 * that would not think to redact one. Derived from a value the callback already
 * carries, so nothing extra has to travel between the two requests.
 */
function loginCookie(state: string): string {
  return `${LOGIN_COOKIE}_${createHash("sha256").update(state, "utf8").digest("hex").slice(0, 16)}`;
}

/** A fresh binding value. One construction for every cookie this deployment sets. */
export const newBinding = newCookieValue;

export function loginBindingOf(
  request: Request,
  state: string,
  deployment: Deployment,
): string | null {
  return cookieOf(request, loginCookie(state), deployment);
}

export function setLoginCookie(
  state: string,
  value: string,
  deployment: Deployment,
  maxAgeSeconds: number,
): string {
  return setCookie(loginCookie(state), value, deployment, { sameSite: "Lax", maxAgeSeconds });
}

/**
 * Sent on every answer to a callback, whether or not the sign-in completed: a
 * binding is for one sign-in, so leaving it in the browser would let a later one
 * inherit it. Only this sign-in's cookie is cleared — another waiting in the same
 * browser keeps its own.
 */
export function clearLoginCookie(state: string, deployment: Deployment): string {
  return clearCookie(loginCookie(state), deployment, "Lax");
}

export function sessionOf(request: Request, deployment: Deployment): string | null {
  return cookieOf(request, SESSION_COOKIE, deployment);
}

export function setSessionCookie(
  value: string,
  deployment: Deployment,
  maxAgeSeconds: number,
): string {
  return setCookie(SESSION_COOKIE, value, deployment, { sameSite: "Lax", maxAgeSeconds });
}

/**
 * Ends a session in the browser.
 *
 * Only ever sent together with deleting the row, never instead of it. A cookie the
 * browser has been asked to forget is still a working credential for anyone who
 * kept a copy; the row going is what makes signing out mean something.
 */
export function clearSessionCookie(deployment: Deployment): string {
  return clearCookie(SESSION_COOKIE, deployment, "Lax");
}
