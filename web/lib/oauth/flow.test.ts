import assert from "node:assert/strict";
import test from "node:test";

/**
 * The OAuth endpoints, driven the way a client drives them.
 *
 * The one hop that cannot be exercised here is the round trip to Google, which
 * needs a real Google account and real credentials. Everything on either side of
 * it can be: registration, the request validation, the consent step, and the
 * token exchange with its PKCE check, its single-use codes and its refresh
 * rotation. The seam is the store's `issueCode`, which is exactly what the provider
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
const { oauthStore } = await import("./store.ts");
const { createPkce } = await import("./pkce.ts");
const { deployment, signingKey } = await import("./config.ts");
const { accessTokenVerifier } = await import("./tokens.ts");

const ORIGIN = "http://localhost:3000";
const REDIRECT_URI = "http://localhost:41234/callback";

/**
 * Registration counts against the caller's address, so each call here comes from
 * its own — which is what a room full of different clients looks like. The test
 * that means to reach the ceiling says so by passing one address twice.
 */
let callers = 0;
const anotherCaller = () => `198.51.100.${++callers % 250}`;

async function register(overrides: Record<string, unknown> = {}, from = anotherCaller()) {
  const response = await handleRegistration(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": from },
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

  // The page also hands the browser a binding. Carrying it back is what makes the
  // approval come from the browser that was shown the page, so the helper keeps
  // it and `approve` replays it — a test that forgets is testing the wrong
  // browser, which is the point of the cases further down.
  const cookie = consentCookie(response);
  assert.ok(cookie, "the consent page binds itself to the browser");

  return { clientId: client.client_id as string, pkce, reference, html, cookie, response };
}

/**
 * The whole `name=value` pair the consent page set, if it set one.
 *
 * The name is per-flow, so it is kept rather than reconstructed — a browser
 * holding two of these keeps them apart by name, and so does this.
 */
function consentCookie(response: Response): string | null {
  const header = response.headers.get("set-cookie");
  const pair = header ? /(?:^|,\s*)(il_consent_[0-9a-f]+=[^;,]*)/.exec(header)?.[1] : undefined;
  return pair ?? null;
}

/**
 * Submits the consent form as a browser carrying `cookies`.
 *
 * Several may be given, which is what a browser part-way through two flows looks
 * like: both bindings are in one header, and each flow finds its own.
 */
function approve(
  reference: string,
  cookies: string | readonly string[] | null,
  answer: "approve" | "deny" = "approve",
) {
  const carried = cookies === null ? [] : typeof cookies === "string" ? [cookies] : [...cookies];
  return handleConsent(
    new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: carried.length ? { cookie: carried.join("; ") } : {},
      body: new URLSearchParams({ request: reference, [answer]: "yes" }),
    }),
  );
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
  const { reference, cookie } = await upToConsent();

  const response = await approve(reference, cookie);

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
  const { reference, cookie } = await upToConsent();

  const response = await approve(reference, cookie, "deny");

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.origin + location.pathname, REDIRECT_URI);
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "client-state");
  assert.equal(location.searchParams.get("iss"), ORIGIN);
});

test("an approval cannot be replayed", async () => {
  const { reference, cookie } = await upToConsent();

  assert.equal((await approve(reference, cookie)).status, 302);
  assert.equal(
    (await approve(reference, cookie)).status,
    400,
    "the reference was spent the first time",
  );
});

test("a forged approval reference is refused", async () => {
  assert.equal((await approve("made-up", "made-up-cookie")).status, 400);
});

// --- the consent form is bound to one browser -----------------------------
//
// The reference in the form is not a secret from the attacker: they made the
// authorization request, for a client they registered, so they hold it already.
// What they must not be able to do is have somebody else's browser submit it.

test("an approval from the browser that was shown the page succeeds", async () => {
  const { reference, cookie } = await upToConsent();

  const response = await approve(reference, cookie);

  assert.equal(response.status, 302);
  assert.match(response.headers.get("location") ?? "", /accounts\.google\.com/);
});

test("an approval from a different browser is refused", async () => {
  const { reference } = await upToConsent();
  // A second visitor, with a binding of their own — the shape of a cross-site
  // submission that did carry some cookie, just not this page's.
  const { cookie: someoneElse } = await upToConsent();

  const response = await approve(reference, someoneElse);

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null, "nothing was forwarded anywhere");
});

test("an approval carrying no binding at all is refused", async () => {
  const { reference } = await upToConsent();

  // What a cross-site form POST actually looks like: SameSite=Strict means the
  // browser sends no cookie, so the approval arrives unbound.
  const response = await approve(reference, null);

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
});

test("a refused approval does not consume the request, and the right browser still works", async () => {
  const { reference, cookie } = await upToConsent();

  assert.equal((await approve(reference, null)).status, 400);
  assert.equal(
    (await approve(reference, cookie)).status,
    302,
    "the legitimate browser can still approve",
  );
});

test("the binding cookie is HttpOnly, SameSite=Strict and scoped to the flow", async () => {
  const { response } = await upToConsent();
  const header = response.headers.get("set-cookie") ?? "";

  assert.match(header, /il_consent_[0-9a-f]{16}=/, "named after this flow, not shared");
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Path=\/oauth/);
  // Not Secure here only because the test origin is loopback, where a browser
  // would reject a Secure cookie over plain http. The attribute is derived from
  // the configured origin — deployment.test.ts asserts the production case.
  assert.equal(header.includes("Secure"), false, "loopback development");
});

test("answering an approval clears that flow's binding, whatever the answer", async () => {
  const approved = await upToConsent();
  const clearedAfterApproval =
    (await approve(approved.reference, approved.cookie)).headers.get("set-cookie") ?? "";
  assert.match(clearedAfterApproval, /il_consent_[0-9a-f]+=;/);
  assert.match(clearedAfterApproval, /Max-Age=0/);
  assert.ok(
    approved.cookie && clearedAfterApproval.startsWith(approved.cookie.split("=")[0]),
    "the one that was set, not some other flow's",
  );

  const declined = await upToConsent();
  assert.match(
    (await approve(declined.reference, declined.cookie, "deny")).headers.get("set-cookie") ?? "",
    /il_consent_[0-9a-f]+=;/,
  );
});

test("two flows in one browser are approved independently", async () => {
  // Two MCP clients being connected at once, or one retried in another tab. A
  // single shared cookie would make the second overwrite the first's binding and
  // strand it; each flow has its own name, so both survive.
  const first = await upToConsent();
  const second = await upToConsent();

  assert.notEqual(
    first.cookie?.split("=")[0],
    second.cookie?.split("=")[0],
    "the two bindings are different cookies",
  );

  // The browser carries both, and each approval finds its own.
  const browser = [first.cookie!, second.cookie!];
  assert.equal((await approve(first.reference, browser)).status, 302);
  assert.equal((await approve(second.reference, browser)).status, 302);
});

test("a second flow does not invalidate the first", async () => {
  const first = await upToConsent();
  await upToConsent();

  // Carrying only the first flow's binding, after a second flow has been started.
  assert.equal((await approve(first.reference, first.cookie)).status, 302);
});

test("another flow's binding does not approve this one", async () => {
  const mine = await upToConsent();
  const theirs = await upToConsent();

  // The right shape of cookie, from the right browser, for the wrong request.
  const response = await approve(mine.reference, theirs.cookie);

  assert.equal(response.status, 400);
  assert.equal(response.headers.get("location"), null);
});

test("a binding cannot be used twice", async () => {
  const flow = await upToConsent();

  assert.equal((await approve(flow.reference, flow.cookie)).status, 302);
  // The cookie is still in hand — the browser was told to drop it, but a hostile
  // caller need not comply. The reference behind it is spent, so it buys nothing.
  assert.equal((await approve(flow.reference, flow.cookie)).status, 400);
});

// --- the token exchange ----------------------------------------------------
//
// Picking up where the provider callback leaves off: a code issued against a
// verified identity.

async function issueCodeFor(clientId: string, challenge: string, userId = "google:alice") {
  return (await oauthStore()).issueCode({
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
  const code = await issueCodeFor(client.client_id, pkce.challenge);

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
  const code = await issueCodeFor(client.client_id, pkce.challenge);
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
  const code = await issueCodeFor(client.client_id, pkce.challenge);

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
  const code = await issueCodeFor(client.client_id, pkce.challenge);

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
  const code = await issueCodeFor(mine.client_id, pkce.challenge);

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
  const code = await issueCodeFor(client.client_id, pkce.challenge);

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
  const code = await issueCodeFor(client.client_id, pkce.challenge);

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
  const code = await issueCodeFor(client.client_id, pkce.challenge, "google:bob");

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
  const code = await issueCodeFor(client.client_id, pkce.challenge);
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
  const code = await issueCodeFor(client.client_id, pkce.challenge);
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

// --- refresh token families ------------------------------------------------
//
// Rotation used to delete the presented token, which refuses a reused one but
// cannot notice it: a deleted row and a row that never existed look the same.
// Tokens now belong to a family and are marked spent, so a second presentation is
// evidence — and the only safe reading of that evidence is that somebody has a
// copy they should not.

/** Walks a client all the way to its first token pair. */
async function firstTokens() {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = await issueCodeFor(client.client_id, pkce.challenge, "google:family");

  const { status, body } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });
  assert.equal(status, 200);
  return { clientId: client.client_id as string, tokens: body };
}

test("a refresh token rotates into a new pair", async () => {
  const { clientId, tokens } = await firstTokens();

  const rotated = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
  });

  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.body.refresh_token, tokens.refresh_token, "a new credential");
  assert.ok(rotated.body.access_token);

  const info = await accessTokenVerifier(deployment(), signingKey()).verifyAccessToken(
    rotated.body.access_token,
  );
  assert.equal(info.extra?.userId, "google:family", "the same grant");
});

test("reusing an already-rotated refresh token is refused", async () => {
  const { clientId, tokens } = await firstTokens();
  await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });

  const replay = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
  });

  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, "invalid_grant");
});

test("a replay revokes the whole family, including the token that was legitimately issued", async () => {
  const { clientId, tokens } = await firstTokens();

  const second = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(second.status, 200);

  // Somebody replays the first token. Which of the two holders is the thief
  // cannot be told from here, so the chain ends for both.
  await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });

  const afterwards = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: second.body.refresh_token,
  });
  assert.equal(afterwards.status, 400, "the successor died with its family");
  assert.equal(afterwards.body.error, "invalid_grant");
});

test("a long chain of rotations keeps working, and each link retires", async () => {
  const { clientId, tokens } = await firstTokens();

  let current = tokens.refresh_token as string;
  const seen = new Set([current]);
  for (let round = 0; round < 4; round += 1) {
    const next = await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: current });
    assert.equal(next.status, 200, `round ${round}`);
    assert.equal(seen.has(next.body.refresh_token), false, "every successor is new");
    seen.add(next.body.refresh_token);
    current = next.body.refresh_token;
  }

  // And the one before last is genuinely dead rather than merely superseded.
  const stale = [...seen][seen.size - 2];
  assert.equal(
    (await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: stale })).status,
    400,
  );
});

test("simultaneous rotations of one refresh token: exactly one succeeds", async () => {
  const { clientId, tokens } = await firstTokens();

  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token }),
    ),
  );

  assert.equal(attempts.filter((attempt) => attempt.status === 200).length, 1);
});

test("another client cannot rotate someone else's refresh token", async () => {
  const { tokens } = await firstTokens();
  const { body: intruder } = await register();

  const attempt = await token({
    grant_type: "refresh_token",
    client_id: intruder.client_id,
    refresh_token: tokens.refresh_token,
  });

  assert.equal(attempt.status, 400);
  assert.equal(attempt.body.error, "invalid_grant");
});

// --- registration abuse controls ------------------------------------------

test("a registration body over the size limit is refused", async () => {
  const response = await handleRegistration(
    new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": anotherCaller() },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI], client_name: "x".repeat(8 * 1024) }),
    }),
  );

  assert.equal(response.status, 413);
});

test("an over-long client name is refused", async () => {
  const { status, body } = await register({ client_name: "x".repeat(500) });

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_client_metadata");
});

test("an over-long redirect URI is refused", async () => {
  // Over the per-URI limit but inside the body limit, so this reaches the check
  // it is about. A longer one is refused too, by the size cap first — the two
  // limits are layered, and either answer is a refusal.
  const { status, body } = await register({
    redirect_uris: [`https://client.example/${"a".repeat(2_500)}`],
  });

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_redirect_uri");
});

test("too many redirect URIs are refused", async () => {
  const many = Array.from({ length: 25 }, (_unused, index) => `https://client.example/cb${index}`);
  const { status } = await register({ redirect_uris: many });

  assert.equal(status, 400);
});

test("registrations from one address are rate limited, and others are unaffected", async () => {
  const busy = "203.0.113.99";

  let refused = 0;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    const { status } = await register({}, busy);
    if (status === 429) refused += 1;
  }

  assert.ok(refused > 0, "the ceiling was reached");
  assert.equal((await register({}, "203.0.113.100")).status, 201, "a different caller is unaffected");
});

// --- PKCE shapes ----------------------------------------------------------

test("a malformed code challenge is refused at the authorization request", async () => {
  const { body: client } = await register();

  for (const challenge of ["short", "x".repeat(44), `${"a".repeat(42)}+`, ""]) {
    const response = await handleAuthorize(new Request(authorizeUrl(client.client_id, challenge)));
    // Redirected back to the client as invalid_request, or refused outright for
    // the empty one — never accepted.
    const location = response.headers.get("location");
    if (location) {
      assert.equal(new URL(location).searchParams.get("error"), "invalid_request", challenge);
    } else {
      assert.equal(response.status, 400, challenge);
    }
  }
});

test("a malformed code verifier is refused at the token endpoint", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = await issueCodeFor(client.client_id, pkce.challenge);

  const { status, body } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: "too-short",
  });

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_request", "malformed, rather than merely mismatched");
});

test("a verifier with characters RFC 7636 does not allow is refused", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = await issueCodeFor(client.client_id, pkce.challenge);

  const { status, body } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: `${"a".repeat(42)}!`,
  });

  assert.equal(status, 400);
  assert.equal(body.error, "invalid_request");
});

test("a verifier longer than RFC 7636 allows is refused", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = await issueCodeFor(client.client_id, pkce.challenge);

  const { status } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: "a".repeat(129),
  });

  assert.equal(status, 400);
});

// --- a grant stays bound to the resource it was approved for ---------------

test("a grant cannot be retargeted by moving the deployment's origin", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  // Approved while this deployment served http://localhost:3000/mcp.
  const code = await issueCodeFor(client.client_id, pkce.challenge);

  // The origin is reconfigured — a domain change, a misconfiguration, a preview
  // that inherited the secrets. The grant was never approved for the new one.
  //
  // Another loopback port, so that the canonical-origin guard stays exempt and
  // this reaches the resource check. In production that guard would refuse a
  // request at the old host first; the two are separate layers, and this is the
  // inner one.
  process.env.MCP_PUBLIC_URL = "http://localhost:3999";
  try {
    const { status, body } = await token({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pkce.verifier,
    });

    assert.equal(status, 400);
    assert.equal(body.error, "invalid_grant");
    assert.equal(body.access_token, undefined, "no token was minted for the new resource");
  } finally {
    process.env.MCP_PUBLIC_URL = ORIGIN;
  }
});

test("the audience of a minted token is the resource the grant carried", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const code = await issueCodeFor(client.client_id, pkce.challenge);

  const { body } = await token({
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: pkce.verifier,
  });

  const claims = JSON.parse(
    Buffer.from(body.access_token.split(".")[1], "base64url").toString("utf8"),
  );
  assert.equal(claims.aud, `${ORIGIN}/mcp`);
});

// --- a refused refresh request costs the holder nothing --------------------
//
// Rotation used to happen first and the request's constraints be checked against
// its result, so a request naming the wrong client consumed a perfectly good
// refresh token on its way to being refused. The order is now the other way
// round, inside the transaction that would have spent it.

test("a wrong client_id does not consume the refresh token", async () => {
  const { clientId, tokens } = await firstTokens();
  const { body: other } = await register();

  const refused = await token({
    grant_type: "refresh_token",
    client_id: other.client_id,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_grant");

  // The token is still the holder's to use.
  const rotated = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(rotated.status, 200, "the refused request spent nothing");
  assert.ok(rotated.body.refresh_token);
});

test("a wrong resource does not consume the refresh token", async () => {
  const { clientId, tokens } = await firstTokens();

  const refused = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    resource: "https://somewhere-else.example/mcp",
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_target");

  assert.equal(
    (
      await token({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
    ).status,
    200,
    "the refused request spent nothing",
  );
});

test("a widened scope does not consume the refresh token", async () => {
  const { clientId, tokens } = await firstTokens();

  const refused = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    scope: "mcp labels:write",
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_scope");

  assert.equal(
    (
      await token({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
    ).status,
    200,
    "the refused request spent nothing",
  );
});

test("a grant for a resource this deployment no longer serves is refused without being spent", async () => {
  const { clientId, tokens } = await firstTokens();

  // Another loopback port, so the canonical-origin guard stays exempt and this
  // reaches the resource check rather than being turned away at the door.
  process.env.MCP_PUBLIC_URL = "http://localhost:3999";
  let refused;
  try {
    refused = await token({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    });
  } finally {
    process.env.MCP_PUBLIC_URL = ORIGIN;
  }

  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, "invalid_grant");

  // And once the origin is itself again, the token still works: the stale grant
  // was refused, not destroyed.
  assert.equal(
    (
      await token({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokens.refresh_token,
      })
    ).status,
    200,
  );
});

test("a refused request does not revoke the family either", async () => {
  const { clientId, tokens } = await firstTokens();
  const { body: other } = await register();

  // Several refusals, of each kind.
  await token({ grant_type: "refresh_token", client_id: other.client_id, refresh_token: tokens.refresh_token });
  await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
    scope: "mcp everything",
  });

  // Then a proper rotation, and its successor works — so the chain was never
  // touched. Replay detection is for a *spent* token, not a refused request.
  const first = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(first.status, 200);
  assert.equal(
    (
      await token({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: first.body.refresh_token,
      })
    ).status,
    200,
  );
});

test("replay detection still fires, and still outranks a bad client_id", async () => {
  const { clientId, tokens } = await firstTokens();
  const { body: other } = await register();

  await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token });

  // A spent token replayed by someone naming the wrong client. It is a replay
  // first: the family ends.
  const replay = await token({
    grant_type: "refresh_token",
    client_id: other.client_id,
    refresh_token: tokens.refresh_token,
  });
  assert.equal(replay.status, 400);

  const successorIsDead = await token({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: (
      await token({ grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token })
    ).body.refresh_token,
  });
  assert.equal(successorIsDead.status, 400, "the family was revoked");
});

// --- the authorization endpoint has a ceiling ------------------------------

test("authorization requests from one address are rate limited", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const busy = "203.0.113.201";

  const visit = () =>
    handleAuthorize(
      new Request(authorizeUrl(client.client_id, pkce.challenge), {
        headers: { "x-forwarded-for": busy },
      }),
    );

  let refused = 0;
  for (let attempt = 0; attempt < 70; attempt += 1) {
    if ((await visit()).status === 429) refused += 1;
  }

  assert.ok(refused > 0, "the ceiling was reached");
});

test("the ceiling refuses before any pending request is parked", async () => {
  const { body: client } = await register();
  const pkce = createPkce();
  const busy = "203.0.113.202";

  const visit = () =>
    handleAuthorize(
      new Request(authorizeUrl(client.client_id, pkce.challenge), {
        headers: { "x-forwarded-for": busy },
      }),
    );

  let refusal: Response | undefined;
  for (let attempt = 0; attempt < 70 && !refusal; attempt += 1) {
    const response = await visit();
    if (response.status === 429) refusal = response;
  }

  assert.ok(refusal, "the ceiling was reached");
  const body = await refusal.text();
  // No consent page, so no request was parked and no binding handed out.
  assert.equal(body.includes("Connect to InboxLabeler"), false);
  assert.equal(refusal.headers.get("set-cookie"), null);
});

test("one address reaching its ceiling does not affect another", async () => {
  const { body: client } = await register();
  const pkce = createPkce();

  const visit = (from: string) =>
    handleAuthorize(
      new Request(authorizeUrl(client.client_id, pkce.challenge), {
        headers: { "x-forwarded-for": from },
      }),
    );

  for (let attempt = 0; attempt < 70; attempt += 1) await visit("203.0.113.203");

  assert.equal((await visit("203.0.113.204")).status, 200, "a different caller is unaffected");
});
