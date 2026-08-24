import assert from "node:assert/strict";
import test from "node:test";

import { isRegisteredRedirectUri, validateRegistration } from "./clients.ts";

/** Reads a decision back as either the URIs it accepted or the error code. */
function decide(request: Record<string, unknown>): string[] | string {
  const result = validateRegistration(request);
  return "error" in result ? result.error : result.redirectUris;
}

test("a client registering one https redirect URI is accepted", () => {
  assert.deepEqual(decide({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] }), [
    "https://chatgpt.com/connector_platform_oauth_redirect",
  ]);
});

test("http is accepted on loopback, where there is no transit to intercept", () => {
  assert.deepEqual(decide({ redirect_uris: ["http://127.0.0.1:33418/callback"] }), [
    "http://127.0.0.1:33418/callback",
  ]);
  assert.deepEqual(decide({ redirect_uris: ["http://localhost:6274/oauth/callback"] }), [
    "http://localhost:6274/oauth/callback",
  ]);
});

test("http anywhere else is refused, because the code would travel in clear", () => {
  assert.equal(decide({ redirect_uris: ["http://example.com/cb"] }), "invalid_redirect_uri");
});

test("a private scheme is refused: this server cannot tell whose app it is", () => {
  assert.equal(decide({ redirect_uris: ["myapp://callback"] }), "invalid_redirect_uri");
});

test("a relative URI is refused", () => {
  assert.equal(decide({ redirect_uris: ["/callback"] }), "invalid_redirect_uri");
});

test("a fragment is refused: the authorization response owns that part", () => {
  assert.equal(decide({ redirect_uris: ["https://example.com/cb#frag"] }), "invalid_redirect_uri");
});

test("a wildcard is refused", () => {
  assert.equal(decide({ redirect_uris: ["https://*.example.com/cb"] }), "invalid_redirect_uri");
});

test("userinfo is refused", () => {
  assert.equal(decide({ redirect_uris: ["https://user:pw@example.com/cb"] }), "invalid_redirect_uri");
});

test("registering without a redirect URI is refused", () => {
  assert.equal(decide({}), "invalid_redirect_uri");
  assert.equal(decide({ redirect_uris: [] }), "invalid_redirect_uri");
  assert.equal(decide({ redirect_uris: "https://example.com/cb" }), "invalid_redirect_uri");
});

test("one bad URI refuses the whole registration", () => {
  assert.equal(
    decide({ redirect_uris: ["https://example.com/cb", "http://example.com/cb"] }),
    "invalid_redirect_uri",
  );
});

test("a client asking to authenticate at the token endpoint is told this server has no secrets", () => {
  assert.equal(
    decide({ redirect_uris: ["https://example.com/cb"], token_endpoint_auth_method: "client_secret_post" }),
    "invalid_client_metadata",
  );
});

test("a client asking for a grant this server does not issue is refused at registration", () => {
  assert.equal(
    decide({ redirect_uris: ["https://example.com/cb"], grant_types: ["implicit"] }),
    "invalid_client_metadata",
  );
  assert.deepEqual(
    decide({ redirect_uris: ["https://example.com/cb"], grant_types: ["authorization_code", "refresh_token"] }),
    ["https://example.com/cb"],
  );
});

test("a response type other than code is refused", () => {
  assert.equal(
    decide({ redirect_uris: ["https://example.com/cb"], response_types: ["token"] }),
    "invalid_client_metadata",
  );
});

test("a client name is kept when it is a string, and ignored otherwise", () => {
  const named = validateRegistration({ redirect_uris: ["https://example.com/cb"], client_name: "Claude" });
  assert.equal("error" in named ? null : named.clientName, "Claude");

  const odd = validateRegistration({ redirect_uris: ["https://example.com/cb"], client_name: { evil: true } });
  assert.equal("error" in odd ? null : odd.clientName, undefined);
});

// --- redirect URI matching -------------------------------------------------
//
// The checks that decide where an authorization code is delivered. Every one of
// these is a way someone has tried to widen a match, and each must fail.

test("a redirect URI matches only itself, exactly", () => {
  const registered = ["https://example.com/cb"];

  assert.equal(isRegisteredRedirectUri(registered, "https://example.com/cb"), true);

  assert.equal(isRegisteredRedirectUri(registered, "https://example.com/cb/"), false, "trailing slash");
  assert.equal(isRegisteredRedirectUri(registered, "https://example.com/cb?x=1"), false, "added query");
  assert.equal(isRegisteredRedirectUri(registered, "https://example.com/cb/evil"), false, "subpath");
  assert.equal(isRegisteredRedirectUri(registered, "https://example.com.evil.test/cb"), false, "suffixed host");
  assert.equal(isRegisteredRedirectUri(registered, "https://evil.test/cb"), false, "other host");
  assert.equal(isRegisteredRedirectUri(registered, "HTTPS://EXAMPLE.COM/cb"), false, "recased");
  assert.equal(isRegisteredRedirectUri(registered, "http://example.com/cb"), false, "downgraded scheme");
});

test("any one of several registered URIs matches", () => {
  const registered = ["https://a.example/cb", "http://localhost:1234/cb"];
  assert.equal(isRegisteredRedirectUri(registered, "http://localhost:1234/cb"), true);
  assert.equal(isRegisteredRedirectUri(registered, "https://a.example/cb"), true);
  assert.equal(isRegisteredRedirectUri(registered, "https://b.example/cb"), false);
});
