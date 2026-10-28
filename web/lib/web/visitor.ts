import { headers } from "next/headers";

import { deployment } from "../oauth/config.ts";
import { sessionOf } from "./cookies.ts";
import { signedInVisitor, type SignedInVisitor } from "./session.ts";

/**
 * Who is signed in, for a page that is being rendered.
 *
 * The whole of this module is the step that gets the cookie out of the framework's
 * request context. It is separate from `session.ts` so that the resolution itself
 * — the part with the isolation and the access-list argument in it — depends on
 * nothing but a string and can be driven directly by a test, while the
 * framework-shaped half stays too small to hold a mistake.
 *
 * The `Cookie` header rather than `cookies()`, because the cookie's *name* depends
 * on the deployment (`__Host-` in production) and its value must be read by
 * exactly the code that writes it. `sessionOf` is that code, and it takes a
 * `Request`; handing it the real header keeps one parser and one naming rule for
 * every reader, in a route handler and in a page alike.
 */
export async function currentVisitor(): Promise<SignedInVisitor | null> {
  const config = deployment();
  const cookie = (await headers()).get("cookie");
  const request = new Request(config.issuer, cookie ? { headers: { cookie } } : undefined);

  return signedInVisitor(sessionOf(request, config));
}

/**
 * Who is signed in, or nobody — for a page, which has to render either way.
 *
 * A failure to answer is not allowed to keep a page from rendering. Not knowing
 * whether somebody is signed in is a reason to offer them a sign-in, not a reason
 * to answer an error: the home page has to work when nothing else does, and the
 * landing page is the answer that is safe to give a stranger. Falling this way
 * cannot leak anything — a visitor treated as signed out is shown no labels.
 *
 * The message only, never the thrown object, for the same reason a page reports
 * nothing else about the user.
 */
export async function resolveVisitor(): Promise<SignedInVisitor | null> {
  try {
    return await currentVisitor();
  } catch (error) {
    console.error(
      `[inboxlabeler] page: could not resolve a session: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  }
}

export type { SignedInVisitor };
