import type { AuthenticatedUser } from "../identity.ts";
import { requireAllowed } from "./access.ts";
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
/**
 * What a provider establishes about the person who signed in.
 *
 * Two things, and only one of them travels further. `user` is the identity —
 * stable, opaque, the thing that will decide whose labels these are. `email` is
 * an attribute used to answer one question, at the seam below, and then dropped:
 * it is never stored, never in a token, and never visible to an MCP client.
 *
 * They are separate fields rather than one because they are not the same
 * property. An address is what a person can be told to put on an access list; a
 * subject is what survives them changing that address.
 */
export type VerifiedIdentity = {
  user: AuthenticatedUser;
  /** Verified and normalised. Used to decide access, then discarded. */
  email: string;
};

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
  }): Promise<VerifiedIdentity>;
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

/**
 * Establishes who signed in, and whether they are allowed to.
 *
 * The one way in. A provider verifies the identity; this applies the deployment's
 * access list to it and returns what the rest of the flow is allowed to know —
 * the user, and nothing else. Putting the check here rather than inside the
 * provider means a second provider inherits it instead of having to remember it,
 * and putting it here rather than in the callback means the address never crosses
 * out of this layer at all.
 *
 * It runs before InboxLabeler has issued anything. A rejected address never
 * reaches an authorization code, let alone a token.
 */
export async function identifyUser(
  response: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
    nonce: string;
  },
  // The configured provider by default. Named so that a test can hand this seam
  // a provider it controls and check what happens to the identity it returns,
  // which is otherwise only reachable by signing a token as Google.
  provider: IdentityProvider = identityProvider(),
): Promise<AuthenticatedUser> {
  const { user, email } = await provider.identify(response);

  requireAllowed(email);

  return user;
}
