import type { Deployment } from "./config.ts";
import { errorPage, oauthError } from "./responses.ts";

/**
 * Refusing security-sensitive requests that did not arrive at the canonical
 * origin.
 *
 * A hosting platform gives every deployment its own hostname as well as the one
 * the domain points at, and those deployments generally share the project's
 * environment — the same signing secret, the same database, the same Google
 * client. Without this check, the OAuth server therefore exists at several
 * addresses at once, all issuing tokens signed with the same key, while every
 * discovery document names only one of them. That is a confusing-deputy shape: a
 * preview host will happily run an authorization flow, mint a token, and write a
 * client registration into the production database.
 *
 * So a request whose `Host` is not the configured origin's is refused before
 * anything else looks at it. The rule is deliberately narrow — the endpoint is
 * either at the address its metadata advertises or it is not open.
 *
 * `Host` and not `X-Forwarded-Host`: the forwarded header is set by whoever is
 * in front, and on the way *in* it is attacker-controlled. Trusting it would let
 * a request to a preview host claim to be the canonical one, which is exactly
 * what this refuses.
 *
 * Loopback deployments are exempt, which is how local development keeps working:
 * a developer's origin is `http://localhost:3000` and their `Host` matches it
 * already, but a checkout reached over `127.0.0.1` or a LAN address should not
 * become a puzzle. The exemption is derived from the configured origin, so it
 * cannot be switched on for a real one.
 */
export function wrongOrigin(
  request: Request,
  deployment: Deployment,
  shape: "json" | "text" = "json",
): Response | undefined {
  if (deployment.insecure) return undefined;

  const host = request.headers.get("host");
  if (host && hostnameOf(host) === deployment.hostname) return undefined;

  // 404 rather than 403: at an address this server does not serve, the honest
  // answer is that there is nothing here. It also declines to confirm to a
  // scanner that it found a real OAuth server on the wrong hostname.
  const description =
    "This endpoint is only served at this deployment's canonical origin. " +
    "Use the URL published in its OAuth metadata.";

  return shape === "json"
    ? oauthError("invalid_request", description, 404)
    : errorPage("invalid_request", description, 404);
}

/** The hostname from a `Host` header, which may carry a port or IPv6 brackets. */
function hostnameOf(host: string): string {
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return "";
  }
}
