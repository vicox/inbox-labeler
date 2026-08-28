import assert from "node:assert/strict";
import test from "node:test";

import { codeRedirect, errorRedirect, validateAuthorization } from "./authorization-request.ts";
import type { Deployment } from "./config.ts";
import { sameResource } from "./resource.ts";
import type { RegisteredClient } from "./store.ts";

const DEPLOYMENT: Deployment = {
  issuer: "https://inboxlabeler.example",
  resource: "https://inboxlabeler.example/mcp",
  authorizationEndpoint: "https://inboxlabeler.example/oauth/authorize",
  tokenEndpoint: "https://inboxlabeler.example/oauth/token",
  registrationEndpoint: "https://inboxlabeler.example/oauth/register",
  callbackEndpoint: "https://inboxlabeler.example/oauth/callback",
  webCallbackEndpoint: "https://inboxlabeler.example/auth/callback",
  resourceMetadataUrl: "https://inboxlabeler.example/.well-known/oauth-protected-resource/mcp",
  hostname: "inboxlabeler.example",
  insecure: false,
};

const CLIENT: RegisteredClient = {
  clientId: "client-1",
  redirectUris: ["https://client.example/cb"],
  registeredAt: 0,
};

/** A well-formed request, so each test can spoil exactly one thing. */
function request(overrides: Record<string, string | null> = {}): URLSearchParams {
  const params = new URLSearchParams({
    client_id: CLIENT.clientId,
    redirect_uri: "https://client.example/cb",
    response_type: "code",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    scope: "mcp",
    state: "client-state",
    resource: DEPLOYMENT.resource,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  return params;
}

/**
 * Reads a decision back as "ok", or as how it was refused.
 *
 * `null` says there is no such client, and is spelled that way rather than as
 * `undefined` because `undefined` would fall through to the default and quietly
 * test the opposite of what the caller asked for.
 */
function decide(params: URLSearchParams, client: RegisteredClient | null = CLIENT): string {
  const result = validateAuthorization(params, client ?? undefined, DEPLOYMENT);
  if (!("kind" in result)) return "ok";
  return `${result.kind}:${result.error}`;
}

test("a well-formed request is accepted, and carries the deployment's own resource", () => {
  const result = validateAuthorization(request(), CLIENT, DEPLOYMENT);
  assert.ok(!("kind" in result));
  assert.deepEqual(result, {
    clientId: "client-1",
    redirectUri: "https://client.example/cb",
    codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    scope: "mcp",
    resource: DEPLOYMENT.resource,
    clientState: "client-state",
  });
});

// --- what may never be redirected ------------------------------------------
//
// Until the client and its redirect URI are both established there is nowhere
// trustworthy to send an error. Redirecting anyway is the open redirect.

test("an unknown client is refused without redirecting anywhere", () => {
  assert.equal(decide(request(), null), "unredirectable:invalid_client");
});

test("a missing client_id is refused without redirecting anywhere", () => {
  assert.equal(decide(request({ client_id: null }), null), "unredirectable:invalid_request");
});

test("an unregistered redirect URI is refused without redirecting to it", () => {
  assert.equal(decide(request({ redirect_uri: "https://evil.test/cb" })), "unredirectable:invalid_request");
});

test("a redirect URI that only nearly matches is still refused, and not redirected", () => {
  assert.equal(decide(request({ redirect_uri: "https://client.example/cb/" })), "unredirectable:invalid_request");
  assert.equal(decide(request({ redirect_uri: "https://client.example/cb?x=1" })), "unredirectable:invalid_request");
});

test("a missing redirect URI is refused even when the client registered exactly one", () => {
  assert.equal(decide(request({ redirect_uri: null })), "unredirectable:invalid_request");
});

// --- what goes back to the client ------------------------------------------

test("PKCE is required", () => {
  assert.equal(decide(request({ code_challenge: null })), "redirectable:invalid_request");
});

test("only S256 is accepted, and a missing method is not treated as plain", () => {
  assert.equal(decide(request({ code_challenge_method: "plain" })), "redirectable:invalid_request");
  assert.equal(decide(request({ code_challenge_method: null })), "redirectable:invalid_request");
  assert.equal(decide(request({ code_challenge_method: "s256" })), "redirectable:invalid_request");
});

test("only the code response type is supported", () => {
  assert.equal(decide(request({ response_type: "token" })), "redirectable:unsupported_response_type");
  assert.equal(decide(request({ response_type: null })), "redirectable:unsupported_response_type");
});

test("an unknown scope is refused", () => {
  assert.equal(decide(request({ scope: "mcp labels:write" })), "redirectable:invalid_scope");
});

test("an omitted scope falls back to the only scope there is", () => {
  const result = validateAuthorization(request({ scope: null }), CLIENT, DEPLOYMENT);
  assert.equal("kind" in result ? null : result.scope, "mcp");
});

test("a token cannot be requested for another resource", () => {
  assert.equal(decide(request({ resource: "https://evil.test/mcp" })), "redirectable:invalid_target");
  assert.equal(decide(request({ resource: "https://inboxlabeler.example/other" })), "redirectable:invalid_target");
});

test("the scheme and host are compared case-insensitively, as URIs are", () => {
  assert.equal(decide(request({ resource: "HTTPS://INBOXLABELER.EXAMPLE/mcp" })), "ok");
  assert.equal(decide(request({ resource: "https://InboxLabeler.Example/mcp" })), "ok");
});

test("the path is compared exactly, because it names which server on the host", () => {
  // A trailing slash and a different case are both different paths. Two MCP
  // servers can share a host, so normalising the path away would let a grant for
  // one be honoured for the other.
  assert.equal(decide(request({ resource: "https://inboxlabeler.example/mcp/" })), "redirectable:invalid_target");
  assert.equal(decide(request({ resource: "https://inboxlabeler.example/MCP" })), "redirectable:invalid_target");
});

test("a trailing slash on an empty path is not a difference", () => {
  // The one liberty the specification does grant: https://host and https://host/
  // are the same resource.
  assert.ok(sameResource("https://inboxlabeler.example", "https://inboxlabeler.example/"));
});

test("a resource with a fragment is not canonical and is refused", () => {
  assert.equal(decide(request({ resource: "https://inboxlabeler.example/mcp#x" })), "redirectable:invalid_target");
});

test("an omitted resource falls back to the only resource there is", () => {
  const result = validateAuthorization(request({ resource: null }), CLIENT, DEPLOYMENT);
  assert.equal("kind" in result ? null : result.resource, DEPLOYMENT.resource);
});

test("a request without state is fine, and none is invented", () => {
  const result = validateAuthorization(request({ state: null }), CLIENT, DEPLOYMENT);
  assert.equal("kind" in result ? "refused" : result.clientState, undefined);
});

// --- the redirects themselves ----------------------------------------------

test("an error redirect carries the error, the client's state and the issuer", () => {
  const url = new URL(
    errorRedirect(
      {
        kind: "redirectable",
        redirectUri: "https://client.example/cb",
        error: "access_denied",
        description: "The user declined.",
        clientState: "client-state",
      },
      DEPLOYMENT.issuer,
    ),
  );
  assert.equal(url.origin + url.pathname, "https://client.example/cb");
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("state"), "client-state");
  assert.equal(url.searchParams.get("iss"), DEPLOYMENT.issuer, "RFC 9207 applies to errors too");
});

test("a code redirect carries the code, the client's state and the issuer", () => {
  const url = new URL(codeRedirect("https://client.example/cb", "the-code", DEPLOYMENT.issuer, "client-state"));
  assert.equal(url.searchParams.get("code"), "the-code");
  assert.equal(url.searchParams.get("state"), "client-state");
  assert.equal(url.searchParams.get("iss"), DEPLOYMENT.issuer);
});

test("a client that sent no state gets none back, rather than an empty one", () => {
  const url = new URL(codeRedirect("https://client.example/cb", "the-code", DEPLOYMENT.issuer, undefined));
  assert.equal(url.searchParams.has("state"), false);
});

test("a redirect URI's own query survives having parameters added to it", () => {
  const url = new URL(codeRedirect("https://client.example/cb?tenant=a", "the-code", DEPLOYMENT.issuer, undefined));
  assert.equal(url.searchParams.get("tenant"), "a");
  assert.equal(url.searchParams.get("code"), "the-code");
});
