/**
 * Comparing RFC 8707 resource identifiers.
 *
 * Its own module because two places need the same answer — the authorization
 * request, deciding whether a client may ask for this resource, and the token
 * exchange, deciding whether a grant still names it — and a resource comparison
 * that differs between them is a way to mint a token for something nobody
 * authorized.
 *
 * The rule is URI comparison, not string comparison, and only where the URI
 * standard says a difference is not a difference:
 *
 *     scheme, host   case-insensitive   (RFC 3986 §6.2.2.1)
 *     path, query    case-sensitive     — a path is an opaque name to us
 *     trailing slash on an empty path   not significant
 *     fragment       makes it non-canonical, so it is refused
 *
 * Lowercasing the whole URI would be the easy mistake, and it would make
 * `/mcp` and `/MCP` the same resource. They are not: RFC 8707 canonical URIs
 * differ in path, and treating two servers on one host as one is exactly the
 * confusion the audience claim exists to prevent.
 */

/**
 * The canonical form of a resource identifier, or null if it is not one.
 *
 * Null rather than a throw, because every caller has to answer "is this the
 * resource?" and a malformed value is simply not it.
 */
function canonical(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  // RFC 8707 §2: a canonical resource URI carries no fragment. Refusing rather
  // than stripping keeps a malformed request visible instead of quietly
  // matching something the client did not write.
  if (url.hash) return null;

  // `URL` has already lowercased the scheme and host for us. The path is left
  // exactly as written, except that a lone "/" is the same as no path at all.
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.protocol}//${url.host}${path}${url.search}`;
}

/** Whether two resource identifiers name the same resource. */
export function sameResource(one: string, other: string): boolean {
  const left = canonical(one);
  return left !== null && left === canonical(other);
}
