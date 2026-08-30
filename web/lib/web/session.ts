import type { AuthenticatedUser } from "../identity.ts";
import { allows } from "../oauth/access.ts";
import { webStore } from "./store.ts";

/**
 * Who is signed in to this browser — the one way anything on the website asks.
 *
 * Every authenticated page resolves the visitor through this function and through
 * nothing else, and it takes exactly one argument: the value of a cookie. There
 * is no parameter for a user, an owner, an account or an address, so a page cannot
 * be written that reads whose data to show from a URL, a query string, a form
 * field or a request body. That is the tenant-isolation mechanism on the web side,
 * and it is a shape rather than a rule to remember — the same argument as
 * `inboxStore(user)`, which is the only thing this result is then handed to.
 */

/**
 * A signed-in visitor: the owner, and the address to show them.
 *
 * `user` is the canonical InboxLabeler identity, byte for byte the same value an
 * MCP access token's subject carries for the same Google account — both are
 * `identityFromClaims`' provider-qualified subject, minted from the same identity
 * token by the same code. So a browser and an MCP client authenticated with one
 * Google account are one owner, and the site shows the labels `get_labels`
 * returns because it reads them through the same store.
 *
 * `email` is for the person looking at the page, so they can see which of their
 * Google accounts this is. It is never an input to anything: nothing keys, scopes
 * or authorises on it.
 */
export type SignedInVisitor = {
  user: AuthenticatedUser;
  email: string;
};

/**
 * Resolves a session cookie, or returns null.
 *
 * Null means "not signed in", and it deliberately covers every way of not being:
 * no cookie, a value that matches no row, an expired session, and an account the
 * access list no longer admits. Callers have one thing to do about all four —
 * offer a sign-in — and collapsing them here is what stops a caller from
 * accidentally treating one of them as authenticated.
 *
 * An account that has left the access list has its session **deleted** on the way
 * to that answer, rather than merely refused. A closed beta's operator removing
 * an address should end that browser's access, not leave a row that would work
 * again if the address were re-added; and the row is the only thing keeping the
 * address, so removing it is also the tidier answer for the person removed.
 *
 * A database failure is not caught here. It is not an authentication answer and
 * must not be turned into one: "signed out" would send someone round a sign-in
 * loop that cannot succeed, and "signed in" would be a great deal worse. The
 * caller decides what a page does when the database is unreachable.
 */
export async function signedInVisitor(cookieValue: string | null): Promise<SignedInVisitor | null> {
  if (!cookieValue) return null;

  const store = await webStore();
  const session = await store.session(cookieValue);
  if (!session) return null;

  // Re-asked on every request rather than only at sign-in. The list is the whole
  // of this deployment's access control and an operator changes it while people
  // are signed in, so a session that was admitted a week ago is not evidence that
  // it still is. The address compared is the one on the row, which the browser
  // has no way to influence.
  if (!allows(session.email)) {
    await store.endSession(cookieValue);
    return null;
  }

  return { user: session.user, email: session.email };
}
