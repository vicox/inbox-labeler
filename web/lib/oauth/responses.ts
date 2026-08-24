import { ConfigurationError } from "./config.ts";

/**
 * The three answers the OAuth endpoints give, in one place.
 *
 * They are together because the choice between them is a rule rather than a
 * preference. An endpoint a client talks to answers JSON, because a client
 * parses it; an endpoint a *person* is looking at answers text, because there
 * is nobody to parse it and a plain body cannot carry markup out of whatever
 * was echoed into it; and a deployment that is misconfigured says so as a
 * server fault rather than blaming the client for it.
 *
 * Every one of them is `no-store`. A token response, an error naming a client,
 * a page mid-flow — none of it may sit in a cache to be handed to the next
 * caller.
 */

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" } as const;

/**
 * What a client is told when the deployment is misconfigured.
 *
 * Deliberately incurious. The specific fault — which variable is unset, what it
 * is for — is the operator's to see and nobody else's: these endpoints are public
 * and unauthenticated, so naming an environment variable in a 500 tells whoever
 * is probing exactly how the deployment is put together and what is broken about
 * it. It cannot help them fix it, and there is no reason to help them map it.
 */
const CONFIGURATION_FAULT =
  "The server is not configured correctly and cannot handle this request. If you run this deployment, check its logs.";

/** An OAuth error or success document, per RFC 6749 §5. */
export function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { ...NO_STORE } });
}

/** An OAuth error response: a code a client switches on, and prose for a human. */
export function oauthError(error: string, description: string, status: number): Response {
  return json({ error, error_description: description }, status);
}

/**
 * A dead end a person has reached, in plain text.
 *
 * Text rather than HTML on purpose: there is nothing here worth styling, and a
 * text body cannot become a scripting bug if a value from the request is
 * repeated in it.
 */
export function errorPage(
  error: string,
  description: string,
  status: number,
  setCookie?: string,
): Response {
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8", ...NO_STORE });
  if (setCookie) headers.append("set-cookie", setCookie);
  return new Response(`${error}\n\n${description}\n`, { status, headers });
}

/**
 * Answers a misconfiguration without describing it.
 *
 * The detail is already in the log — `ConfigurationError` writes itself there
 * when it is constructed, so every path reports it, including the ones that never
 * reach this function. All that is left here is to give the client an answer that
 * tells it nothing about the deployment.
 *
 * Anything that is not a `ConfigurationError` is re-thrown: it is a fault we did
 * not anticipate, and the framework's own handler reports those without
 * describing our internals.
 */
export function configurationFault(error: unknown, shape: "json" | "text" = "json"): Response {
  if (!(error instanceof ConfigurationError)) throw error;

  return shape === "json"
    ? oauthError("server_error", CONFIGURATION_FAULT, 500)
    : errorPage("server_error", CONFIGURATION_FAULT, 500);
}
