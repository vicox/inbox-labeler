import { ConfigurationError } from "./config.ts";

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
 * Nothing here reaches a token or an MCP client. The address is read from the
 * identity token, used to answer one boolean, and dropped — with one exception,
 * stated where it happens: a website sign-in keeps it on the browser-session row,
 * because the site names the account whose labels it is showing and because this question
 * is then re-asked on every request of that session. See `lib/web/store.ts`.
 *
 * ## In production, no list means nobody
 *
 * A closed beta must not become public because a variable was renamed, blanked, or
 * lost on the way into an environment. So in production an unset, empty or
 * whitespace-only `ALLOWED_EMAILS` is a `ConfigurationError`: the deployment
 * refuses the requests that need it and says why in its log, exactly as it does
 * for a missing signing secret or a missing database. Nobody is admitted, which is
 * the only safe reading of "there is no list of who may come in".
 *
 * Refusing rather than answering "you are not on the list" is deliberate. There is
 * no list, so that answer would be a lie told to somebody who might well be
 * invited, and it would leave the operator with a working-looking deployment that
 * nobody can use and nothing to say why. A configuration fault names the cause in
 * the place the operator can read.
 *
 * ## Outside production, no list means everyone
 *
 * A local checkout has to work after `npm install` without a list to maintain, and
 * a developer signing in to their own machine is not an access-control question.
 * That convenience is explicitly bounded to non-production: it is not "empty means
 * everyone" as a rule with an exception, it is a development affordance that
 * production does not have.
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
 * The configured allowlist.
 *
 * Every way of not having one is the same thing — unset, `""`, `" "`, `","`,
 * `" , "` — because they are all "no addresses were named". What that *means*
 * depends on where this is running, and the difference is the whole of the
 * function: in production it is a fault, and outside it is an open door. Null is
 * therefore only ever returned outside production.
 *
 * Read per call rather than at module load, so an operator who fixes the variable
 * in a dashboard does not have to wait for a process to be recycled.
 */
export function allowlist(): string[] | null {
  const entries = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map(normalise)
    .filter(Boolean);

  if (entries.length) return entries;

  if (process.env.NODE_ENV === "production") {
    throw new ConfigurationError(
      "ALLOWED_EMAILS is not set, or names no address. InboxLabeler is a closed beta: " +
        "with no list of who may sign in, nobody is admitted. Set it to the invited " +
        "addresses, comma-separated. See web/.env.example.",
    );
  }
  return null;
}

/**
 * Whether this address may use this deployment.
 *
 * The one implementation of the question, asked in two places for two different
 * reasons — see `requireAllowed` below, and `lib/web/session.ts`, which re-asks it
 * on every request of a browser session that was admitted days ago. Written once
 * so that changing what "allowed" means cannot reach one caller and miss the
 * other.
 *
 * Throws `ConfigurationError` in production when there is no list at all. That is
 * not this function saying no; it is saying the question cannot be answered, and
 * every caller turns it into a refusal rather than into access. Removing the last
 * address from a live deployment therefore blocks the sessions that were admitted
 * under it, on their next request.
 */
export function allows(email: string): boolean {
  const allowed = allowlist();
  return !allowed || allowed.includes(normalise(email));
}

/**
 * Decides whether this address may sign in, and throws if it may not.
 *
 * Throwing rather than returning a boolean, so that a caller mid-flow cannot
 * proceed having forgotten to look at the answer — the only way past this
 * function is for it to have said yes.
 */
export function requireAllowed(email: string): void {
  if (!allows(email)) {
    throw new AccessDeniedError(
      "This Google account is not on this deployment's access list.",
    );
  }
}
