import { validateRegistration } from "./clients.ts";
import { ConfigurationError, deployment } from "./config.ts";
import { json, oauthError } from "./responses.ts";
import { oauthStore } from "./store.ts";

/**
 * Dynamic Client Registration, per RFC 7591.
 *
 * How an MCP client that has never met this server gets a client id: it posts
 * its redirect URIs and receives one, with no human registering anything in
 * advance. That is what lets a client be handed a bare URL and complete a flow,
 * and it is why the endpoint is open — an unauthenticated POST is the whole
 * point of the mechanism, and requiring pre-registration would defeat it.
 *
 * Open, but not unguarded: what is accepted is decided in `clients.ts`, and a
 * client id grants nothing on its own. It names where an authorization code may
 * be delivered, and a code is worthless without both a user approving the
 * client and the PKCE verifier only the client that began the flow holds.
 *
 * The current MCP specification marks RFC 7591 deprecated in favour of Client
 * ID Metadata Documents, while keeping it available for authorization servers
 * that do not implement them. The deprecated mechanism is implemented here on
 * purpose: it is the one every MCP client in the field speaks today, and
 * offering only the newer one would leave this endpoint unreachable in practice.
 */
export async function handleRegistration(request: Request): Promise<Response> {
  let registrationEndpoint: string;
  try {
    ({ registrationEndpoint } = deployment());
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return oauthError("server_error", error.message, 500);
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return oauthError("invalid_client_metadata", "The request body must be JSON.", 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return oauthError("invalid_client_metadata", "The request body must be a JSON object.", 400);
  }

  const validated = validateRegistration(body);
  if ("error" in validated) return json(validated, 400);

  const client = await (await oauthStore()).registerClient({
    redirectUris: validated.redirectUris,
    clientName: validated.clientName,
  });

  // No client_secret, and its absence is the answer rather than an omission:
  // `token_endpoint_auth_method: "none"` tells the client it is a public client
  // and that PKCE is what will prove its token requests.
  return json(
    {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.registeredAt / 1000),
      redirect_uris: client.redirectUris,
      ...(client.clientName ? { client_name: client.clientName } : {}),
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      registration_client_uri: registrationEndpoint,
    },
    201,
  );
}
