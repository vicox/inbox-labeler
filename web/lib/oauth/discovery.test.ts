import assert from "node:assert/strict";
import test from "node:test";

/**
 * The two discovery documents, as a client reads them.
 *
 * Together they are the whole path from a bare MCP URL to a token: the
 * Protected Resource Metadata names the authorization server, and the
 * Authorization Server Metadata names its endpoints. A client that cannot walk
 * this is stuck at the 401, so these assertions are about the walk working
 * rather than about the JSON looking a certain way.
 */
process.env.MCP_PUBLIC_URL = "http://localhost:3000";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-of-at-least-32-bytes";

const { discoveryResponse } = await import("./discovery.ts");

const ORIGIN = "http://localhost:3000";

async function fetchDocument(path: string) {
  const response = discoveryResponse(new Request(`${ORIGIN}${path}`));
  return { status: response.status, headers: response.headers, body: await response.json() };
}

test("the protected resource document names this endpoint and its authorization server", async () => {
  const { status, body } = await fetchDocument("/.well-known/oauth-protected-resource/mcp");

  assert.equal(status, 200);
  assert.equal(body.resource, `${ORIGIN}/mcp`, "the audience a token must be minted for");
  assert.deepEqual(body.authorization_servers, [ORIGIN]);
  assert.deepEqual(body.scopes_supported, ["mcp"]);
  assert.equal(body.resource_name, "InboxLabeler");
});

test("the authorization server document names the endpoints a client needs", async () => {
  const { status, body } = await fetchDocument("/.well-known/oauth-authorization-server");

  assert.equal(status, 200);
  assert.equal(body.issuer, ORIGIN);
  assert.equal(body.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(body.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(body.registration_endpoint, `${ORIGIN}/oauth/register`);
});

test("PKCE support is advertised, because a conforming client refuses to proceed without it", async () => {
  const { body } = await fetchDocument("/.well-known/oauth-authorization-server");

  // The MCP specification has clients treat an absent
  // `code_challenge_methods_supported` as "this server does not support PKCE"
  // and stop. Advertising S256 — and only S256 — is what lets them continue.
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
});

test("only the flows this server actually implements are advertised", async () => {
  const { body } = await fetchDocument("/.well-known/oauth-authorization-server");

  assert.deepEqual(body.response_types_supported, ["code"]);
  assert.deepEqual(body.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"], "public clients only");
});

test("the iss parameter is advertised, and the endpoints really do send it", async () => {
  const { body } = await fetchDocument("/.well-known/oauth-authorization-server");

  // Claiming this without sending `iss` would break every conforming client,
  // which rejects a response missing it once the flag is set. The authorize
  // tests assert the sending half.
  assert.equal(body.authorization_response_iss_parameter_supported, true);
});

test("offline_access is not advertised as a resource requirement", async () => {
  const { body } = await fetchDocument("/.well-known/oauth-protected-resource/mcp");

  // The specification says a protected resource should not ask for it: wanting a
  // refresh token is the client's business, not something this resource needs.
  assert.equal(body.scopes_supported.includes("offline_access"), false);
});

test("both documents are readable cross-origin, since clients fetch them from anywhere", async () => {
  for (const path of [
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
  ]) {
    const { headers } = await fetchDocument(path);
    assert.equal(headers.get("access-control-allow-origin"), "*", path);
  }
});

test("a path that is neither document is a 404, not an empty document", async () => {
  const response = discoveryResponse(new Request(`${ORIGIN}/.well-known/something-else`));
  assert.equal(response.status, 404);
});

test("a deployment with no signing secret still publishes discovery", async () => {
  // Discovery is public and carries nothing signed, so it must not be the thing
  // that breaks when a secret is missing — the token endpoint is.
  const previous = process.env.OAUTH_SIGNING_SECRET;
  delete process.env.OAUTH_SIGNING_SECRET;
  try {
    const { status } = await fetchDocument("/.well-known/oauth-authorization-server");
    assert.equal(status, 200);
  } finally {
    process.env.OAUTH_SIGNING_SECRET = previous;
  }
});
