import { createHmac } from "node:crypto";

import { errorPage, json } from "./responses.ts";

/**
 * The ceilings on the endpoints anyone may call, and who they are counted
 * against.
 *
 * Three endpoints are open by necessity rather than by choice. Registration has to
 * be, because dynamic registration is how a client that has never met this server
 * gets an id at all; the authorization endpoint and the website's sign-in have to
 * be, because both are things a browser reaches before anyone knows who is
 * visiting. All three therefore write to the database on behalf of callers who
 * have proved nothing, and a ceiling is the only thing between that and a table
 * that grows for as long as someone keeps asking.
 *
 * These limits are not a correctness mechanism and must not become one. Every
 * caller treats a refusal as "later", never as "invalid", and nothing downstream
 * assumes a request got through because it was allowed to.
 *
 * Registration has a second bound that does not depend on any of this: a client
 * nobody has used for ninety days is deleted. See `CLIENT_RETENTION_MS` in
 * `store.ts` — a ceiling on rate only decides how fast a table grows, and that is
 * what decides how large it gets.
 */

/**
 * A client registers once and keeps its id, so ten an hour is far more than a
 * real one needs and far less than is worth automating.
 */
export const REGISTRATIONS_PER_WINDOW = 10;
export const REGISTRATION_WINDOW_MS = 60 * 60_000;

/**
 * Authorization is a page a person loads, so the ceiling is generous: six a
 * minute is more than anyone clicks and still bounds one address to about sixty
 * parked requests, which is what the limit is actually for — each visit writes a
 * pending login that lives for ten minutes.
 */
export const AUTHORIZATIONS_PER_WINDOW = 60;
export const AUTHORIZATION_WINDOW_MS = 10 * 60_000;

/**
 * Signing in to the website is the same shape of thing as authorizing a client —
 * a button a person presses, which parks a record that lives ten minutes — so it
 * gets the same ceiling, counted in its own bucket.
 */
export const SIGN_INS_PER_WINDOW = 60;
export const SIGN_IN_WINDOW_MS = 10 * 60_000;

/**
 * The name of the bucket every caller shares when none of them can be told apart.
 *
 * Not an address, and deliberately not derived from one — it is the answer to "we
 * do not know who this is", and everybody gets the same answer.
 */
const SHARED = "shared";

/**
 * The caller's address, but only where the platform is known to have established
 * it — otherwise nothing.
 *
 * ## The trust assumption, stated
 *
 * `X-Forwarded-For` is a request header, and a request header is written by
 * whoever sends the request. Reading one and treating its value as an identity is
 * how a limiter gets handed as many identities as an attacker cares to type.
 *
 * On Vercel it is safe, and for a documented reason rather than a hopeful one:
 * Vercel's ingress **overwrites** `X-Forwarded-For` with the connecting client's
 * address and does not forward an external value, explicitly so that the header
 * cannot be spoofed (vercel.com/docs/headers/request-headers). The value that
 * reaches a function is therefore the platform's own observation, not the
 * caller's claim.
 *
 * That guarantee is about *Vercel's* ingress, so it only holds when this is
 * actually running behind it. `process.env.VERCEL` is how that is known: it is an
 * environment variable the platform sets, not a header a request carries, so
 * nothing a caller sends can turn the trust on. Anywhere else — a laptop, a
 * self-hosted box, a proxy somebody put in front — there is no established value
 * and this returns null.
 *
 * Two things this deliberately does not do. It does not read
 * `x-vercel-forwarded-for`: that header is documented as the one to use when a
 * proxy of your own sits on top of Vercel, and there is no published statement
 * that a client-supplied copy is stripped, so trusting it here would be inventing
 * a guarantee. And it does not take the left-most entry of a list. Vercel writes a
 * single address; a comma means something is in front of the ingress that this
 * reasoning did not account for, so the value is not the one the guarantee is
 * about and is refused rather than parsed. An attacker who sends a list gets the
 * shared bucket, which is a tighter limit than their own, not a looser one.
 *
 * Deliberately not exported. The address identifies a person, and the only thing
 * this module does with it is derive the bucket below — so keeping it private is
 * what makes "the raw address does not leave here" a property of the code rather
 * than a habit of its callers.
 */
function establishedAddress(request: Request): string | null {
  // The platform's own variable. An attacker cannot set it; see above.
  if (process.env.VERCEL !== "1") return null;

  const forwarded = request.headers.get("x-forwarded-for")?.trim();
  if (!forwarded || forwarded.includes(",")) return null;

  return forwarded;
}

/**
 * The bucket a request is counted in: a namespace, and who the caller is.
 *
 * The caller is identified by an HMAC of their address rather than the address
 * itself, because this value is a primary key in `oauth_rate_limits` and
 * therefore the one place a rate limit would otherwise leave a plaintext record
 * of who visited. Counting is all the limiter needs, and counting only needs the
 * same caller to land in the same bucket — which a digest does exactly as well
 * as an address.
 *
 * Keyed, not a bare hash. The space of IPv4 addresses is small enough to
 * enumerate completely, so a plain digest of one is reversible by anyone holding
 * the table; an HMAC is not, without the key. The same reasoning and the same
 * construction as `userRef` in `lib/identity.ts`, and the key is taken as an
 * argument for the same reason: a caller that has one has been through the
 * configuration check, and this module never reads the environment.
 *
 * When no address has been established, every caller shares one bucket. That is
 * the conservative direction: an unknown caller gets a *tighter* limit than a
 * known one, never a private one of their own, so there is no value anybody can
 * send that buys them more room. It also means a deployment that is not behind a
 * trusted ingress limits everybody together, which is the honest consequence of
 * not knowing who is asking — and it is a limit on availability rather than a hole
 * in a control, which is the right way for this to fail.
 *
 * `kind` keeps the open endpoints counting separately, so a client registering
 * does not spend a person's authorization budget. It stays in the clear: it names
 * an endpoint, not a caller, and a readable prefix is what makes a row in that
 * table diagnosable at all.
 */
export function callerBucket(
  kind: "authorize" | "register" | "signin",
  request: Request,
  key: Uint8Array,
): string {
  const address = establishedAddress(request);
  if (!address) return `${kind}:${SHARED}`;

  const caller = createHmac("sha256", key)
    .update(`inboxlabeler.caller:${address}`)
    .digest("hex")
    .slice(0, 32);

  return `${kind}:${caller}`;
}

/** The answer for a caller who is over the limit, for a client that parses JSON. */
export function tooManyRequests(what: string): Response {
  return json(
    {
      error: "temporarily_unavailable",
      error_description: `Too many ${what} from this address. Try again later.`,
    },
    429,
  );
}

/**
 * The same, for an endpoint a person is looking at.
 *
 * `resume` says where to pick the flow up again, because the two endpoints a
 * person can hit this on are reached from different places: an authorization
 * request comes from an MCP client, and a sign-in comes from this website.
 * Telling someone to go back to a client they were not using is worse than
 * saying nothing.
 */
export function tooManyRequestsPage(what: string, resume = "start again from your MCP client"): Response {
  return errorPage(
    "temporarily_unavailable",
    `Too many ${what} from this address. Wait a little and ${resume}.`,
    429,
  );
}
