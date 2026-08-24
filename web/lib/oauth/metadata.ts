import type { AuthMetadataOptions, OAuthMetadata } from "@modelcontextprotocol/server";

import { MCP_SCOPE, type Deployment } from "./config.ts";

/**
 * The two documents that make this server discoverable.
 *
 * A client is given one URL — the MCP endpoint — and has to find its way to a
 * token from there without being told anything else. Two standards carry it:
 *
 *   401 from /mcp  ──►  Protected Resource Metadata (RFC 9728)
 *                            names the authorization server
 *                  ──►  Authorization Server Metadata (RFC 8414)
 *                            names /authorize, /token, /register
 *
 * The MCP authorization specification makes the first of these a MUST for an
 * MCP server and requires at least one of RFC 8414 or OpenID Connect Discovery
 * for the authorization server. Both are built here and served by the SDK's own
 * helper, so the document shapes come from the same code that the SDK's clients
 * expect rather than from a hand-written literal.
 *
 * Here the two roles happen to be the same deployment — InboxLabeler protects
 * its MCP endpoint and issues the tokens for it — but they stay separate
 * documents, because that is what a client is looking for and what lets the
 * authorization server move later without a client noticing.
 */

/**
 * The RFC 8414 description of InboxLabeler as an authorization server.
 *
 * Each field is a promise a client will hold us to, so the narrow ones are
 * deliberate:
 *
 * - `code` only, with `S256` the only challenge method. OAuth 2.1 drops the
 *   implicit flow and the `plain` challenge, and advertising either would
 *   invite a client to use it.
 * - `none` as the only client authentication method: MCP clients are public
 *   clients, and PKCE — not a secret they could not keep anyway — is what
 *   proves the exchange.
 * - `authorization_response_iss_parameter_supported` is true because the
 *   authorization response really does carry `iss` (RFC 9207). The current MCP
 *   specification has clients reject a response whose `iss` is missing when
 *   this flag is set, so the flag and the parameter have to be kept honest
 *   together — claiming it without sending it would break every conforming
 *   client.
 * - `refresh_token`, so a client that wants long-lived access asks for one
 *   rather than sending a user back through a browser every hour.
 */
export function authorizationServerMetadata(deployment: Deployment): OAuthMetadata {
  return {
    issuer: deployment.issuer,
    authorization_endpoint: deployment.authorizationEndpoint,
    token_endpoint: deployment.tokenEndpoint,
    registration_endpoint: deployment.registrationEndpoint,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * What the SDK needs to serve both documents.
 *
 * `resourceServerUrl` is the MCP endpoint rather than the origin, and that
 * matters twice over: it is the `resource` value a token's audience is checked
 * against, and RFC 9728 reflects its path into the well-known route — so
 * `https://host/mcp` is published at
 * `/.well-known/oauth-protected-resource/mcp`.
 *
 * `dangerouslyAllowInsecureIssuerUrl` is set only for a loopback origin. The
 * SDK otherwise insists on HTTPS, which is right: an authorization flow over
 * plain HTTP exposes the code in transit. Loopback is the one place there is no
 * transit to expose, and it is what makes `npm run dev` work — the flag is
 * derived from the configured origin rather than from a separate switch someone
 * could leave on in production.
 */
export function authMetadataOptions(deployment: Deployment): AuthMetadataOptions {
  return {
    oauthMetadata: authorizationServerMetadata(deployment),
    resourceServerUrl: new URL(deployment.resource),
    resourceName: "InboxLabeler",
    scopesSupported: [MCP_SCOPE],
    dangerouslyAllowInsecureIssuerUrl: deployment.insecure,
  };
}
