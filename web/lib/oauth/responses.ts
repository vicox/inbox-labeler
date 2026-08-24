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
export function errorPage(error: string, description: string, status: number): Response {
  return new Response(`${error}\n\n${description}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...NO_STORE },
  });
}
