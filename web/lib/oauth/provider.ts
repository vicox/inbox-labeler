import type { AuthenticatedUser } from "../identity.ts";
import { google } from "./google.ts";

/**
 * The seam between this authorization server and whatever authenticates the
 * person behind it.
 *
 * InboxLabeler issues its own tokens for its own MCP endpoint — that part is
 * ours and stays ours, because it is what binds a token to a resource we own.
 * Who the user *is*, though, is a question we have no business answering
 * ourselves: it would mean passwords, resets and a mail path, none of which
 * InboxLabeler wants to own. So the flow steps aside for exactly one round
 * trip, and comes back with an identity.
 *
 * The interface exists so the rest of the OAuth layer never learns which
 * provider answered. It hands out a redirect and takes back an
 * `AuthenticatedUser`; everything in between — the shape of the identity token,
 * whose keys signed it, which claim holds the subject — lives inside the
 * implementation. Adding a second provider is a second file and a branch in
 * `identityProvider`, and nothing else moves.
 */
export type IdentityProvider = {
  /**
   * Names the provider, and prefixes the ids it mints. Part of the identity:
   * see `AuthenticatedUser` for why the qualification matters.
   */
  readonly name: string;

  /**
   * Where to send the browser so the user can authenticate.
   *
   * Every argument is something we generate and remember, and check again on
   * the way back: `state` finds the parked request, `nonce` ties the identity
   * token to this one login, and `codeChallenge` is our own PKCE for the leg to
   * the provider — this server is a public client there too.
   */
  authorizationUrl(request: {
    redirectUri: string;
    state: string;
    nonce: string;
    codeChallenge: string;
  }): string;

  /**
   * Turns the provider's authorization code into a verified identity.
   *
   * Throws if anything fails to check out. There is no partial success worth
   * reporting: without a verified subject there is no user, and the flow must
   * end rather than continue with a guess.
   */
  identify(response: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  }): Promise<AuthenticatedUser>;
};

/**
 * The provider this deployment authenticates with.
 *
 * One today. Google, because InboxLabeler already reads a Gmail mailbox and
 * writes to a Drive folder on the user's behalf — the account it labels mail
 * for is the account it should identify them by, and asking them for a second
 * identity would be inventing a distinction the product does not have.
 */
export function identityProvider(): IdentityProvider {
  return google();
}
