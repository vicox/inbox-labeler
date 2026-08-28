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

export type { SignedInVisitor };
