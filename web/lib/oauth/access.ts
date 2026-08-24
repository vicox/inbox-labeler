/**
 * Who is allowed to sign in to this deployment.
 *
 * A private beta needs a way to say "these people, nobody else yet", and the
 * smallest honest way to say it is a list of addresses in the environment. There
 * is no users table behind this and it is not an account model: it is one
 * question — may this person authenticate at all — asked once, at the moment the
 * identity provider has established who they are and before InboxLabeler has
 * issued anything.
 *
 * ## The address is not the identity
 *
 * The email decides *access*. The Google subject remains the identity, and it is
 * the only thing that leaves this layer. That split matters because the two
 * properties are different: a subject is stable and survives someone changing
 * their address, which is what a storage key needs; an address is what a human
 * can be told to put on a list. Using the address as the key would mean a beta
 * tester who renames their Google account loses their labels.
 *
 * So nothing here is stored, and nothing here reaches a token, a database row or
 * an MCP client. The address is read from the identity token, used to answer one
 * boolean, and dropped.
 *
 * ## An empty list means no list
 *
 * With `ALLOWED_EMAILS` unset or empty, anyone who can authenticate with the
 * configured Google client may sign in — which is what a local checkout wants and
 * what this deployment did before the variable existed. It is therefore a thing
 * to *remember* for a hosted deployment rather than something that fails loudly
 * when forgotten, and both `.env.example` and the README say so where the variable
 * is documented.
 */

/**
 * Somebody who authenticated successfully and still may not come in.
 *
 * Its own type, separate from a failure to verify, because they are different
 * answers to different questions and the person in front of the browser deserves
 * to be told which one they got. Being told "your account is not on the list" is
 * useful and gives nothing away — they already know their own address.
 */
export class AccessDeniedError extends Error {
  override readonly name = "AccessDeniedError";
}

/**
 * An address in the one form comparisons are made in.
 *
 * Trimmed and lowercased, applied to both sides. The local part of an address is
 * technically case-sensitive, and in practice no provider treats it that way and
 * nobody writing an allowlist by hand expects it to — matching case-insensitively
 * is what makes the variable behave the way whoever set it assumed.
 */
function normalise(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The configured allowlist, or null when there is none.
 *
 * Null and empty are deliberately the same thing: a variable set to `""` or to
 * `" , "` is somebody who has not decided yet, not somebody who has decided
 * nobody may sign in. Locking everyone out of their own deployment is never what
 * an empty string was trying to say.
 */
export function allowlist(): string[] | null {
  const configured = process.env.ALLOWED_EMAILS ?? "";
  const entries = configured
    .split(",")
    .map(normalise)
    .filter(Boolean);

  return entries.length ? entries : null;
}

/**
 * Decides whether this address may sign in, and throws if it may not.
 *
 * Throwing rather than returning a boolean, so that a caller cannot proceed
 * having forgotten to look at the answer — the only way past this function is for
 * it to have said yes.
 */
export function requireAllowed(email: string): void {
  const allowed = allowlist();
  if (!allowed) return;

  if (!allowed.includes(normalise(email))) {
    throw new AccessDeniedError(
      "This Google account is not on this deployment's access list.",
    );
  }
}
