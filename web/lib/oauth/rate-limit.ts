import { errorPage, json } from "./responses.ts";

/**
 * The ceilings on the endpoints anyone may call, and who they are counted
 * against.
 *
 * Two endpoints are open by necessity rather than by choice. Registration has to
 * be, because dynamic registration is how a client that has never met this server
 * gets an id at all; the authorization endpoint has to be, because it is a page a
 * browser visits before anyone knows who is visiting. Both therefore write to the
 * database on behalf of callers who have proved nothing, and a ceiling is the only
 * thing between that and a table that grows for as long as someone keeps asking.
 *
 * These limits are not a correctness mechanism and must not become one. Every
 * caller treats a refusal as "later", never as "invalid", and nothing downstream
 * assumes a request got through because it was allowed to.
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
 * Who to count a request against.
 *
 * The left-most entry of `X-Forwarded-For` is the caller as the platform saw
 * them. It is client-controlled and therefore spoofable, which matters less here
 * than anywhere else: a spoofed address spreads one attacker across many buckets
 * rather than letting them into somebody else's, so the failure mode is a weaker
 * limit and never a bypass of anything but the limit itself.
 *
 * Callers behind one address share a bucket, which is the other half of the same
 * trade. It is why the limits are set where a shared office does not notice them.
 */
export function callerAddress(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || "unknown";
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

/** The same, for an endpoint a person is looking at. */
export function tooManyRequestsPage(what: string): Response {
  return errorPage(
    "temporarily_unavailable",
    `Too many ${what} from this address. Wait a little and start again from your MCP client.`,
    429,
  );
}
