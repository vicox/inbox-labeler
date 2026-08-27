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
   * The origin `authorizationUrl` sends the browser to.
   *
   * Stated on its own because it has to be known *before* a URL is built. The
   * consent page names it in its Content-Security-Policy as a permitted form
   * destination, and that header leaves with the page — long before anyone has
   * approved anything. A browser checks `form-action` against where a form
   * submission lands as well as where it was addressed, and an approval here is
   * answered with a redirect to the provider, so the provider's origin is a
   * navigation that one form performs. Chrome enforces that leg; omitting the
   * origin is what stops an approval from ever reaching it.
   *
   * It must come from the provider implementation and from nothing else. A value
   * a request could influence — a client's registered redirect URI, a header, a
   * registration body — would let a caller name its own origin in the policy of
   * the page that collects an approval, which is the single thing that policy is
   * there to prevent.
   */
  readonly authorizationOrigin: string;

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
 * One today. Google, because the mail these labels are for lives in Gmail — the
 * account whose mail is being labelled is the account to identify someone by,
 * and asking for a second identity would invent a distinction the product does
 * not have.
 *
 * ## Authenticating is all Google is used for here
 *
 * This service requests `openid email` and nothing else. It never reads a
 * mailbox, never lists a message and never writes to Drive; there is no Gmail or
 * Drive scope anywhere in it, and no code that could use one.
 *
 * That access belongs to the skills in `skills/`, which run in the user's own
 * environment and talk to Google directly. Nothing they read passes through
 * here: what reaches this server is a label name and one timestamp per match,
 * which is why the store has nowhere to put a subject or a sender. Stated
 * because the distinction is easy to lose — the product as a whole does read
 * mail, and this half of it deliberately does not.
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
