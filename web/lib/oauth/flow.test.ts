import assert from "node:assert/strict";
import test from "node:test";

/**
 * The OAuth endpoints, driven the way a client drives them.
 *
 * The one hop that cannot be exercised here is the round trip to Google, which
 * needs a real Google account and real credentials. Everything on either side of
 * it can be: registration, the request validation, the consent step, and the
 * token exchange with its PKCE check, its single-use codes and its refresh
 * rotation. The seam is `store.issueCode`, which is exactly what the provider
 * callback does once it has verified an identity — so these tests stand in for
 * the callback's output rather than skipping past the flow.
 */
process.env.MCP_PUBLIC_URL = "http://localhost:3000";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-of-at-least-32-bytes";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";

const { handleRegistration } = await import("./registration.ts");
const { handleAuthorize, handleConsent } = await import("./authorization.ts");
const { handleToken } = await import("./exchange.ts");
const { store } = await import("./store.ts");
const { createPkce } = await import("./pkce.ts");
const { deployment, signingKey } = await import("./config.ts");
const { accessTokenVerifier } = await import("./tokens.ts");

const ORIGIN = "http://localhost:3000";
const REDIRECT_URI = "http://localhost:41234/callback";

async function register(overrides: Record<string, unknown> = {}) {
  const response = await handleRegistration(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "Test Client", ...overrides }),
    }),
  );
  return { status: response.status, body: await response.json() };
}

function authorizeUrl(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "mcp",
    state: "client-state",
    resource: `${ORIGIN}/mcp`,
    ...extra,
  });
  return `${ORIGIN}/oauth/authorize?${params}`;
}

async function token(fields: Record<string, string>) {
  const response = await handleToken(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }),
  );
  return { status: response.status, body: await response.json(), headers: response.headers };
}

/** Registers a client and walks it to a consent page, returning what it needs next. */
async function upToConsent() {
  const { body: client } = await register();
  const pkce = createPkce();

  const response = await handleAuthorize(new Request(authorizeUrl(client.client_id, pkce.challenge)));
  assert.equal(response.status, 200);
  const html = await response.text();

  const reference = /name="request" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(reference, "the consent page carries a single-use reference");

  return { clientId: client.client_id as string, pkce, reference, html };
}

// --- registration -----------------------------------------------------------

test("a client can register itself and is given an id it did not choose", async () => {
  const { status, body } = await register();

  assert.equal(status, 201);
  assert.ok(body.client_id);
  assert.deepEqual(body.redirect_uris, [REDIRECT_URI]);
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.equal("client_secret" in body, false, "a public client is given no secret");
});

test("registration refuses metadata it cannot honour", async () => {
  assert.equal((await register({ redirect_uris: ["http://evil.test/cb"] })).status, 400);
  assert.equal((await register({ redirect_uris: [] })).status, 400);
  assert.equal((await register({ token_endpoint_auth_method: "client_secret_basic" })).status, 400);
});

test("a body that is not a JSON object is refused", async () => {
  const response = await handleRegistration(
    new Request(`${ORIGIN}/oauth/register`, { method: "POST", body: "not json" }),
  );
  assert.equal(response.status, 400);
});

// --- consent ---------------------------------------------------------------

test("an authorization request reaches a consent page naming the client", async () => {
  const { html } = await upToConsent();

  assert.match(html, /Test Client/);
  assert.match(html, /localhost:41234/, "and where an approval would send the code");
});

test("the consent page refuses to be framed", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const response = await handleAuthorize(new Request(authorizeUrl(client.client_id, pkce.challenge)));

  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("an unknown client is stopped before any redirect happens", async () => {
  const response = await handleAuthorize(new Request(authorizeUrl("not-a-client", "challenge")));

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null, "nothing is redirected anywhere");
});

test("approving forwards to Google, carrying our own PKCE and nonce", async () => {
  const { reference } = await upToConsent();

  const response = await handleConsent(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      body: new URLSearchParams({ request: reference, approve: "yes" }),
    }),
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("scope"), "openid", "no email, no profile");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  assert.ok(location.searchParams.get("nonce"));
  assert.ok(location.searchParams.get("state"));
  assert.equal(location.searchParams.get("redirect_uri"), `${ORIGIN}/oauth/callback`);
});

test("declining sends access_denied back to the client, with its state and the issuer", async () => {
  const { reference } = await upToConsent();

  const response = await handleConsent(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      body: new URLSearchParams({ request: reference, deny: "yes" }),
    }),
  );

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin + location.pathname, REDIRECT_URI);
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "client-state");
  assert.equal(location.searchParams.get("iss"), ORIGIN);
});

test("an approval cannot be replayed", async () => {
  const { reference } = await upToConsent();
  const approve = () =>
    handleConsent(
      new Request(`${ORIGIN}/oauth/authorize`, {
        method: "POST",
        body: new URLSearchParams({ request: reference, approve: "yes" }),
      }),
    );

  assert.equal((await approve()).status, 302);
  assert.equal((await approve()).status, 400, "the reference was spent the first time");
});

test("a forged approval reference is refused", async () => {
  const response = await handleConsent(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      body: new URLSearchParams({ request: "made-up", approve: "yes" }),
    }),
  );
  assert.equal(response.status, 400);
});

// --- the token exchange ----------------------------------------------------
//
// Picking up where the provider callback leaves off: a code issued against a
// verified identity.

function issueCodeFor(clientId: string, challenge: string, userId = "google:alice") {
  return store.issueCode({
    clientId,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    scope: "mcp",
    resource: `${ORIGIN}/mcp`,
    userId,
  });
}

test("a code plus its verifier buys an access token bound to this MCP endpoint", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge);

  const { status, body, headers } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });

  assert.equal(status, 200);
  assert.equal(body.token_type, "Bearer");
  assert.equal(body.scope, "mcp");
  assert.ok(body.expires_in > 0);
  assert.ok(body.refresh_token);
  assert.equal(headers.get("cache-control"), "no-store");

  const info = await accessTokenVerifier(deployment(), signingKey()).verifyAccessToken(body.access_token);
  assert.equal(info.extra?.userId, "google:alice");
  assert.equal(info.resource?.href, `${ORIGIN}/mcp`);
});

test("a code is redeemable once", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge);
  const exchange = () =>
    token({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    });

  assert.equal((await exchange()).status, 200);

  const second = await exchange();
  assert.equal(second.status, 400);
  assert.equal(second.body.error, "invalid_grant");
});

test("a code without the right verifier is worthless", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const other = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge);

  const { status, body } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: other.verifier,
  });

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_grant");
});

test("a code with no verifier at all is refused", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge);

  const { status } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
  });
  assert.equal(status, 400);
});

test("another client cannot redeem someone else's code", async () => {
  const { body: mine } = await register();
  const { body: theirs } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(mine.client_id, pkce.challenge);

  const { status, body } = await token({
    grant_type: "authorization_code",
    client_id: theirs.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_grant");
});

test("the redirect URI must be repeated and must match", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge);

  assert.equal(
    (
      await token({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code,
        redirect_uri: "http://localhost:41234/other",
        code_verifier: pkce.verifier,
      })
    ).status,
    400,
  );
});

test("a code cannot be retargeted at another resource", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge);

  const { status, body } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
    resource: "https://evil.test/mcp",
  });

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_target");
});

test("a refresh token is exchanged for a new pair, and retires itself", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge, "google:bob");

  const first = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });

  const refreshed = await token({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: first.body.refresh_token,
  });

  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.refresh_token, first.body.refresh_token, "rotation, as OAuth 2.1 requires");

  const info = await accessTokenVerifier(deployment(), signingKey()).verifyAccessToken(
    refreshed.body.access_token,
  );
  assert.equal(info.extra?.userId, "google:bob", "refreshing keeps the same user");

  const replayed = await token({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: first.body.refresh_token,
  });
  assert.equal(replayed.status, 400, "the retired token no longer works");
});

test("a refresh token cannot be widened", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge);
  const first = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });

  const { status, body } = await token({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: first.body.refresh_token,
    scope: "mcp labels:write",
  });

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_scope");
});

test("a made-up code or refresh token is refused", async () => {
  const { body: client } = await register();

  assert.equal(
    (
      await token({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: "made-up",
        redirect_uri: REDIRECT_URI,
        code_verifier: "whatever",
      })
    ).body.error,
    "invalid_grant",
  );
  assert.equal(
    (await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: "made-up" })).body
      .error,
    "invalid_grant",
  );
});

test("the token endpoint requires a client and a grant type", async () => {
  assert.equal((await token({ grant_type: "authorization_code" })).status, 401);
  assert.equal((await token({ client_id: "x" })).body.error, "invalid_request");
  assert.equal((await token({ client_id: "x", grant_type: "password" })).body.error, "unsupported_grant_type");
});

test("a token response carries no signing secret", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = issueCodeFor(client.client_id, pkce.challenge);
  const { body } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });

  const serialised = JSON.stringify(body);
  assert.equal(serialised.includes(process.env.OAUTH_SIGNING_SECRET!), false);
  assert.equal(serialised.includes(process.env.GOOGLE_CLIENT_SECRET!), false);
});
