import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

/**
 * The website's sign-in, driven the way a browser drives it — and the invariant
 * the whole feature exists to establish: a browser session reaches exactly one
 * InboxLabeler owner, and it is the same owner an MCP client reaches with the same
 * Google account.
 *
 * The one hop that cannot be exercised here is the round trip to Google, which
 * needs a real account and real credentials. Everything on either side of it can
 * be, so the identity provider is passed in: `handleWebCallback` takes one for
 * exactly this reason, and what it returns is precisely the thing the rest of the
 * flow has to handle correctly. Nothing else about the flow is stubbed — the
 * cookies, the parked state, the store, the access list and the label read are all
 * the real ones, on a real database.
 */
/**
 * Counted as though this were running behind the trusted ingress.
 *
 * `callerBucket` only tells callers apart where the platform has established the
 * address itself — on Vercel, where `X-Forwarded-For` is overwritten by the
 * ingress. Everywhere else every caller shares one bucket, which is the
 * conservative answer and is what a laptop gets. These tests need the production
 * behaviour, because a room full of independent clients is what they are about;
 * `rate-limit.test.ts` covers both modes and the attempt to forge a way out of
 * the shared one.
 */
process.env.VERCEL = "1";

process.env.PUBLIC_ORIGIN = "http://localhost:3000";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-of-at-least-32-bytes";
process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";

const { handleSignIn, handleWebCallback, handleSignOut } = await import("./signin.ts");
const { signedInVisitor } = await import("./session.ts");
const { SESSION_COOKIE } = await import("./cookies.ts");
const { WEB_SESSION_TTL_MS } = await import("./store.ts");
const { challengeFor } = await import("../oauth/pkce.ts");
const { deployment, signingKey } = await import("../oauth/config.ts");
const { mintAccessToken } = await import("../oauth/tokens.ts");
const { handleMcpRequest } = await import("../mcp/endpoint.ts");
const { inboxStore } = await import("../inbox/store.ts");

// Types only, so the modules under test are still reached through the dynamic
// imports above — which is what makes the configuration set at the top of this
// file the configuration they read.
type IdentityProvider = import("../oauth/provider.ts").IdentityProvider;
type VerifiedIdentity = import("../oauth/provider.ts").VerifiedIdentity;
type Label = import("../inbox/labels.ts").Label;
type WebStore = import("./store.ts").WebStore;

const ORIGIN = "http://localhost:3000";

/**
 * Sign-ins count against the caller's address, so each one here comes from its
 * own — which is what a room full of different browsers looks like.
 */
let callers = 0;
const anotherCaller = () => `198.51.100.${++callers % 250}`;

/** An identity, as Google would establish one. */
function account(sub: string, email: string): VerifiedIdentity {
  return { user: { id: `google:${sub}` }, email };
}

/**
 * A provider that authenticates one account, and records what it was asked.
 *
 * The recording is the point of the second return value: the nonce and the code
 * verifier it receives are the ones parked before the browser left, and checking
 * that is how "a token issued for a different sign-in cannot be replayed into this
 * one" is tested without forging a Google signature.
 */
function providerFor(identity: VerifiedIdentity | Error) {
  const asked: { redirectUri?: string; codeVerifier?: string; nonce?: string; code?: string } = {};

  const provider: IdentityProvider = {
    name: "stub",
    authorizationOrigin: "https://accounts.google.example",
    authorizationUrl: () => "https://accounts.google.example/authorize",
    identify: async (response) => {
      Object.assign(asked, response);
      if (identity instanceof Error) throw identity;
      return identity;
    },
  };
  return { provider, asked };
}

/**
 * The whole `name=value` pair this response set for a cookie whose name starts
 * with `prefix`, if it set a non-empty one.
 *
 * The pair rather than the value, because the login cookie's name is per sign-in:
 * a browser part-way through two of them keeps them apart by name, and so does a
 * test that means to send one back. An empty value is a cleared cookie, which is
 * not something to carry anywhere.
 */
function cookiePair(response: Response, prefix: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator === -1) continue;
    if (!pair.slice(0, separator).startsWith(prefix)) continue;
    if (!pair.slice(separator + 1)) continue;
    return pair;
  }
  return null;
}

/** The value alone, for the session cookie, which has one name. */
function sessionValue(response: Response): string | null {
  const pair = cookiePair(response, SESSION_COOKIE);
  return pair ? (pair.split("=")[1] ?? null) : null;
}

/** The full attribute string of the first `Set-Cookie` whose name starts with `prefix`. */
function setCookieHeader(response: Response, prefix: string): string {
  return (
    response.headers.getSetCookie().find((one) => one.split("=")[0]?.startsWith(prefix)) ?? ""
  );
}

/** Presses "Sign in with Google", and reads what the browser is left holding. */
async function startSignIn(
  headers: Record<string, string> = { origin: ORIGIN },
): Promise<{ response: Response; state: string; login: string }> {
  const response = await handleSignIn(
    new Request(`${ORIGIN}/auth/signin`, {
      method: "POST",
      headers: { "x-forwarded-for": anotherCaller(), ...headers },
    }),
  );

  const location = response.headers.get("location");
  const state = location ? (new URL(location).searchParams.get("state") ?? "") : "";
  return { response, state, login: cookiePair(response, "il_login") ?? "" };
}

/** Comes back from Google, as the browser that started the sign-in. */
async function completeSignIn(
  identity: VerifiedIdentity | Error,
  options: { state: string; cookies?: string; query?: Record<string, string> } = { state: "" },
) {
  const { provider, asked } = providerFor(identity);
  const params = new URLSearchParams({
    code: "google-authorization-code",
    state: options.state,
    ...options.query,
  });

  const response = await handleWebCallback(
    new Request(`${ORIGIN}/auth/callback?${params}`, {
      headers: options.cookies ? { cookie: options.cookies } : {},
    }),
    provider,
  );

  return { response, asked, session: sessionValue(response) };
}

/** The whole flow, for a test that only wants the cookie at the end of it. */
async function signIn(identity: VerifiedIdentity, alsoHolding?: string): Promise<string> {
  const { state, login } = await startSignIn();
  const cookies = [login, alsoHolding && `${SESSION_COOKIE}=${alsoHolding}`]
    .filter(Boolean)
    .join("; ");
  const { response, session } = await completeSignIn(identity, { state, cookies });

  assert.equal(response.status, 302, "the sign-in should have completed");
  assert.ok(session, "and left a session cookie");
  return session;
}

/**
 * What `/` answers, expressed as the composition `app/page.tsx` is: a cookie
 * resolves to an owner, and that owner opens a store.
 *
 * Written out here rather than by rendering the page, because this is the part
 * with the isolation in it — the page adds markup and nothing else. There is no
 * argument in this expression for an owner: it comes from the cookie or from
 * nowhere.
 *
 * `null` is the landing page: the branch where `app/page.tsx` renders <Landing />,
 * no store is opened, and no row is read. Every "closed to them" assertion below
 * means that, and there is no second address it could mean instead.
 */
async function home(cookieValue: string | null): Promise<{ email: string; labels: Label[] } | null> {
  const visitor = await signedInVisitor(cookieValue);
  if (!visitor) return null;
  return { email: visitor.email, labels: await (await inboxStore(visitor.user)).labels() };
}

/** Calls an MCP tool as one user, the way a real client would. */
async function mcp(user: string, name: string, args: Record<string, unknown> = {}) {
  const { token } = await mintAccessToken(
    deployment(),
    signingKey(),
    { id: user },
    "test-client",
    "mcp",
    deployment().resource,
  );

  const response = await handleMcpRequest(
    new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": name,
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );

  const body = (await response.json()) as {
    result?: { structuredContent?: { labels?: Label[] }; isError?: boolean; content?: unknown };
  };
  assert.equal(response.status, 200, `${name} should have been answered`);
  assert.notEqual(body.result?.isError, true, `${name} should have succeeded: ${JSON.stringify(body.result?.content)}`);
  return body.result?.structuredContent;
}

/** Runs `work` with a given access list, and puts the environment back. */
async function withAllowlist<T>(value: string | undefined, work: () => Promise<T>): Promise<T> {
  const before = process.env.ALLOWED_EMAILS;
  if (value === undefined) delete process.env.ALLOWED_EMAILS;
  else process.env.ALLOWED_EMAILS = value;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.ALLOWED_EMAILS;
    else process.env.ALLOWED_EMAILS = before;
  }
}

// --- the flow ---------------------------------------------------------------

test("signing in leaves a session cookie and lands on the home page", async () => {
  const { state, login } = await startSignIn();
  const { response, session } = await completeSignIn(account("s1", "s1@example.com"), {
    state,
    cookies: login,
  });

  assert.equal(response.status, 302);
  // Home is the app once there is a session to read it with; there is no second
  // address, and nothing in this flow takes a destination from the request.
  assert.equal(response.headers.get("location"), "/");
  assert.ok(session);

  const cookie = setCookieHeader(response, SESSION_COOKIE);
  assert.match(cookie, /HttpOnly/, "no script may read it");
  assert.match(cookie, /SameSite=Lax/, "it has to survive the return from Google");
  assert.match(cookie, /Path=\//, "the home page and signing out both read it");
  assert.match(cookie, new RegExp(`Max-Age=${WEB_SESSION_TTL_MS / 1000}\\b`));

  // The sign-in's own cookie is spent and taken away, whatever happened.
  assert.match(setCookieHeader(response, "il_login"), /Max-Age=0/);
});

test("the redirect to Google demands that an account be chosen", async () => {
  const { response } = await startSignIn();
  const url = new URL(response.headers.get("location")!);

  // The answer to the account confusion this flow exists to prevent: a browser
  // holding several Google sessions is made to say which one this is.
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.origin, "https://accounts.google.com");
  assert.equal(url.searchParams.get("scope"), "openid email", "and nothing more is asked for");
  assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/auth/callback`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("the MCP flow asks for an account chooser too, and is otherwise unchanged", async () => {
  // Account selection is not the website's alone: the provider makes every
  // authorization it starts show the chooser. What must stay the same is
  // everything else about an MCP client's request.
  const { identityProvider } = await import("../oauth/provider.ts");
  const url = new URL(
    identityProvider().authorizationUrl({
      redirectUri: deployment().callbackEndpoint,
      state: "s",
      nonce: "n",
      codeChallenge: challengeFor("v".repeat(43)),
    }),
  );

  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("redirect_uri"), `${ORIGIN}/oauth/callback`);
  assert.equal(url.searchParams.get("scope"), "openid email");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("the identity token has to belong to this sign-in, and this browser's PKCE", async () => {
  const { response, state, login } = await startSignIn();
  const url = new URL(response.headers.get("location")!);

  const { asked } = await completeSignIn(account("s2", "s2@example.com"), {
    state,
    cookies: login,
  });

  // The nonce required of Google's token is the one that travelled to Google, and
  // the verifier sent to redeem the code is the one whose challenge did.
  assert.equal(asked.nonce, url.searchParams.get("nonce"));
  assert.equal(challengeFor(asked.codeVerifier!), url.searchParams.get("code_challenge"));
  assert.equal(asked.redirectUri, `${ORIGIN}/auth/callback`);
});

test("a callback carrying no login cookie is refused", async () => {
  const { state } = await startSignIn();
  const { response, session } = await completeSignIn(account("s3", "s3@example.com"), { state });

  assert.equal(response.status, 400);
  assert.equal(session, null, "and no session is created");
});

test("a state completed in a browser that did not start it is refused", async () => {
  // Somebody starts their own sign-in, keeps the `state`, and gets a victim's
  // browser to finish it. The victim's browser holds a different cookie, so the
  // parked sign-in is not found.
  const { state } = await startSignIn();
  const other = await startSignIn();

  const { response, session } = await completeSignIn(account("s4", "s4@example.com"), {
    state,
    cookies: other.login,
  });

  assert.equal(response.status, 400);
  assert.equal(session, null);
});

test("a state cannot be completed twice", async () => {
  const { state, login: cookies } = await startSignIn();

  const first = await completeSignIn(account("s5", "s5@example.com"), { state, cookies });
  const second = await completeSignIn(account("s5", "s5@example.com"), { state, cookies });

  assert.equal(first.response.status, 302);
  assert.equal(second.response.status, 400);
  assert.equal(second.session, null);
});

test("a sign-in cannot be started from another site", async () => {
  const attempts: Record<string, string>[] = [
    {},
    { origin: "https://evil.example" },
    { origin: `${ORIGIN}.evil.example` },
  ];
  for (const headers of attempts) {
    const { response } = await startSignIn(headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get("location"), null, "and nothing is set going");
  }
});

test("signing out cannot be done from another site", async () => {
  const session = await signIn(account("s6", "s6@example.com"));

  const response = await handleSignOut(
    new Request(`${ORIGIN}/auth/signout`, {
      method: "POST",
      headers: { origin: "https://evil.example", cookie: `${SESSION_COOKIE}=${session}` },
    }),
  );

  assert.equal(response.status, 403);
  assert.notEqual(await home(session), null, "and the session still works");
});

test("signing out ends the session rather than only forgetting it", async () => {
  const session = await signIn(account("s7", "s7@example.com"));

  const response = await handleSignOut(
    new Request(`${ORIGIN}/auth/signout`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session}` },
    }),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
  assert.match(setCookieHeader(response, SESSION_COOKIE), /Max-Age=0/);
  // The part that matters: a copy of the cookie taken before signing out is now
  // worth nothing, which a signed cookie could not have promised.
  assert.equal(await home(session), null);
});

test("signing out with no session is answered the same way", async () => {
  const response = await handleSignOut(
    new Request(`${ORIGIN}/auth/signout`, { method: "POST", headers: { origin: ORIGIN } }),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/");
});

// --- who is let in ----------------------------------------------------------

test("an account that is not on the access list gets nothing for authenticating", async () => {
  await withAllowlist("invited@example.com", async () => {
    const { state, login } = await startSignIn();
    const { response, session } = await completeSignIn(account("outsider", "outsider@example.com"), {
      state,
      cookies: login,
    });

    assert.equal(response.status, 403);
    assert.equal(session, null, "no session cookie is issued");
    assert.match(await response.text(), /access list/, "and they are told why, which they can act on");
  });
});

test("the access list is matched the way it is written: case and space are ignored", async () => {
  await withAllowlist(" Invited@Example.COM , other@example.com ", async () => {
    const session = await signIn(account("invited", "invited@example.com"));
    assert.notEqual(await home(session), null);
  });
});

test("the access list is re-asked while a session is live, not only at sign-in", async () => {
  const session = await withAllowlist("beta@example.com", () =>
    signIn(account("beta", "beta@example.com")),
  );

  // The operator takes the address off the list while that browser is signed in.
  await withAllowlist("someone-else@example.com", async () => {
    assert.equal(await home(session), null, "the app is closed to them");
  });

  // And the session was ended rather than merely refused, so putting the address
  // back does not revive a week-old cookie.
  await withAllowlist("beta@example.com", async () => {
    assert.equal(await home(session), null, "the session is gone, not suspended");
  });
});

test("a session cookie that was never issued resolves to nobody", async () => {
  const real = await signIn(account("s8", "s8@example.com"));

  for (const forged of ["", "guess", real.slice(0, -1), `${real}x`, "google:s8"]) {
    assert.equal(await home(forged), null, JSON.stringify(forged));
  }
});

// --- whose labels ------------------------------------------------------------

test("signed out, the home page is the landing page and reads nobody's labels", async () => {
  // The other half of the same URL. `home` returns null exactly where
  // `app/page.tsx` renders <Landing />, and what matters is what does not happen on
  // the way there: with no owner, no store is opened and no row is read, so there
  // is nothing private for the landing HTML to carry.
  for (const cookie of [null, "", "   ", "not-a-session", "../etc/passwd"]) {
    assert.equal(await home(cookie), null, JSON.stringify(cookie));
  }
});

test("the home page shows the signed-in account's labels and no others", async () => {
  // Created the way an MCP client creates them, which is the point: this is not a
  // second store with its own idea of who owns what.
  await mcp("google:alpha", "create_label", {
    label: "Alpha only",
    instruction: "Alpha's own label.",
  });
  await mcp("google:beta", "create_label", {
    label: "Beta only",
    instruction: "Beta's own label.",
  });

  const alpha = await signIn(account("alpha", "alpha@example.com"));
  assert.deepEqual(
    (await home(alpha))?.labels.map((one) => one.label),
    ["Alpha only"],
  );

  const beta = await signIn(account("beta", "beta@example.com"));
  assert.deepEqual(
    (await home(beta))?.labels.map((one) => one.label),
    ["Beta only"],
  );

  // And the first cookie still reaches only the first account, so signing in as
  // somebody else in another browser did not move anything.
  assert.deepEqual((await home(alpha))?.labels.map((one) => one.label), ["Alpha only"]);
});

test("nothing a request carries can name whose labels are read", async () => {
  await mcp("google:gamma", "create_label", { label: "Gamma only", instruction: "Gamma's." });
  await mcp("google:delta", "create_label", { label: "Delta only", instruction: "Delta's." });

  // Every field somebody might hope is load-bearing, in the callback that mints
  // the session: an address, an owner, a user id, a subject.
  const { state, login } = await startSignIn();
  const { session } = await completeSignIn(account("gamma", "gamma@example.com"), {
    state,
    cookies: login,
    query: {
      email: "delta@example.com",
      user_id: "google:delta",
      owner: "google:delta",
      sub: "delta",
    },
  });

  const shown = await home(session);
  assert.equal(shown?.email, "gamma@example.com");
  assert.deepEqual(shown?.labels.map((one) => one.label), ["Gamma only"]);
});

test("signing in as another account in one browser replaces the session", async () => {
  await mcp("google:epsilon", "create_label", { label: "Epsilon only", instruction: "Epsilon's." });
  await mcp("google:zeta", "create_label", { label: "Zeta only", instruction: "Zeta's." });

  const epsilon = await signIn(account("epsilon", "epsilon@example.com"));
  // The browser still holds epsilon's cookie while it signs in as zeta, which is
  // what switching account looks like.
  const zeta = await signIn(account("zeta", "zeta@example.com"), epsilon);

  assert.deepEqual((await home(zeta))?.labels.map((one) => one.label), ["Zeta only"]);
  assert.equal(await home(epsilon), null, "the session it replaced is ended, not left running");
});

test("one Google account is one owner, whether it arrives by MCP or by browser", async () => {
  const SUB = "parity";
  const labels = [
    { label: "Invoice", instruction: "The message is an invoice.", attention: "high" },
    { label: "Newsletter", instruction: "The message is a newsletter.", attention: "none" },
  ];
  for (const label of labels) await mcp(`google:${SUB}`, "create_label", label);
  await mcp(`google:${SUB}`, "create_label", {
    label: "Needs paying",
    type: "derived",
    instruction: "An invoice that has not been settled.",
    required_labels: ["Invoice"],
    recommended_labels: ["Newsletter"],
  });

  const fromMcp = (await mcp(`google:${SUB}`, "get_labels")) as { labels: Label[] };
  const fromWeb = await home(await signIn(account(SUB, "parity@example.com")));

  // Byte for byte the same policy, in the same order, with the same fields. Both
  // read the same rows through the same store, because the browser session
  // resolves to the same provider-qualified subject the access token carries.
  assert.deepEqual(fromWeb?.labels, fromMcp.labels);
  assert.equal(fromWeb?.labels.length, 3);
  assert.deepEqual(
    fromWeb?.labels.find((one) => one.type === "derived")?.required_labels,
    ["Invoice"],
  );
});

test("a Google account with no labels reaches an empty home page, not somebody else's", async () => {
  const shown = await home(await signIn(account("newcomer", "newcomer@example.com")));

  assert.deepEqual(shown?.labels, []);
  assert.equal(shown?.email, "newcomer@example.com");
});


// --- what counts as coming from this site -----------------------------------

test("a sign-in is refused from a wrong scheme, a wrong port, or a malformed Origin", async () => {
  // `Origin` is compared to the configured origin whole, so each of these is a
  // different site however much of the string it shares. A prefix or suffix match
  // would admit every one of them.
  const attempts: Record<string, string>[] = [
    { origin: "https://localhost:3000" }, // right host and port, wrong scheme
    { origin: "http://localhost:3001" }, // right scheme and host, wrong port
    { origin: "http://localhost" }, // no port, which is port 80
    { origin: "http://localhost:3000/" }, // a trailing slash is not an origin
    { origin: "http://localhost:3000/auth" }, // nor is a path
    { origin: "http://evil.localhost:3000" },
    { origin: "http://localhost:3000.evil.example" },
    { origin: "null" }, // what a sandboxed frame sends
    { origin: "" },
    { origin: "not a url" },
    { origin: "HTTP://LOCALHOST:3000" }, // schemes and hosts are lowercased by browsers
  ];

  for (const headers of attempts) {
    const { response } = await startSignIn(headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get("location"), null, "and nothing is set going");
    assert.deepEqual(response.headers.getSetCookie(), [], "and no cookie is handed out");
  }
});

test("signing out is refused from those same origins, and the session survives", async () => {
  const session = await signIn(account("origins", "origins@example.com"));

  for (const origin of ["https://localhost:3000", "http://localhost:3001", "null", ""]) {
    const response = await handleSignOut(
      new Request(`${ORIGIN}/auth/signout`, {
        method: "POST",
        headers: { origin, cookie: `${SESSION_COOKIE}=${session}` },
      }),
    );
    assert.equal(response.status, 403, origin);
  }

  assert.notEqual(await home(session), null, "still signed in");
});

// --- two tabs ---------------------------------------------------------------

test("two sign-ins started in one browser both complete", async () => {
  // A single login cookie would make these mutually exclusive: the second press
  // would overwrite the first's binding and leave a flow that can never finish.
  const first = await startSignIn();
  const second = await startSignIn();

  const both = [first.login, second.login].join("; ");

  const b = await completeSignIn(account("tab-b", "tab-b@example.com"), {
    state: second.state,
    cookies: both,
  });
  assert.equal(b.response.status, 302, "the second tab completes");

  const a = await completeSignIn(account("tab-a", "tab-a@example.com"), {
    state: first.state,
    cookies: both,
  });
  assert.equal(a.response.status, 302, "and the first still can, afterwards");

  assert.equal((await home(a.session))?.email, "tab-a@example.com");
  assert.equal((await home(b.session))?.email, "tab-b@example.com");
});

test("answering one sign-in clears only its own cookie", async () => {
  const first = await startSignIn();
  const second = await startSignIn();

  const answered = await completeSignIn(account("clears", "clears@example.com"), {
    state: first.state,
    cookies: [first.login, second.login].join("; "),
  });

  const cleared = answered.response.headers
    .getSetCookie()
    .filter((one) => /Max-Age=0\b/.test(one))
    .map((one) => one.split("=")[0]);

  assert.deepEqual(cleared, [first.login.split("=")[0]], "exactly this flow's login cookie");

  // Which is to say the other tab is still completable.
  const other = await completeSignIn(account("clears2", "clears2@example.com"), {
    state: second.state,
    cookies: second.login,
  });
  assert.equal(other.response.status, 302);
});

test("a callback with no state clears nothing and destroys no pending sign-in", async () => {
  const waiting = await startSignIn();

  const stray = await completeSignIn(account("stray", "stray@example.com"), {
    state: "",
    cookies: waiting.login,
  });

  assert.equal(stray.response.status, 400);
  assert.deepEqual(stray.response.headers.getSetCookie(), [], "no cookie is touched");

  const completed = await completeSignIn(account("waiting", "waiting@example.com"), {
    state: waiting.state,
    cookies: waiting.login,
  });
  assert.equal(completed.response.status, 302, "the pending sign-in is intact");
});

test("a callback for an unknown state does not disturb a pending sign-in", async () => {
  const waiting = await startSignIn();

  const unknown = await completeSignIn(account("unknown", "unknown@example.com"), {
    state: "a-state-nobody-parked",
    cookies: waiting.login,
  });
  assert.equal(unknown.response.status, 400);

  const completed = await completeSignIn(account("waiting2", "waiting2@example.com"), {
    state: waiting.state,
    cookies: waiting.login,
  });
  assert.equal(completed.response.status, 302);
});

// --- cookies a browser should not be believed about -------------------------

test("a duplicated session cookie resolves to nobody", async () => {
  const real = await signIn(account("dup", "dup@example.com"));
  const other = await signIn(account("dup2", "dup2@example.com"));

  // Two cookies of one name is what tossing from a sibling subdomain produces.
  // Honouring either would be honouring the attacker's choice of which.
  const request = new Request(`${ORIGIN}/auth/signout`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      cookie: `${SESSION_COOKIE}=${real}; ${SESSION_COOKIE}=${other}`,
    },
  });

  const response = await handleSignOut(request);
  assert.equal(response.status, 302);

  // Neither session was ended, because neither was read.
  assert.notEqual(await home(real), null);
  assert.notEqual(await home(other), null);
});

test("a duplicated login cookie cannot complete a sign-in", async () => {
  const { state, login } = await startSignIn();
  const name = login.split("=")[0];

  const ambiguous = await completeSignIn(account("dup3", "dup3@example.com"), {
    state,
    cookies: `${login}; ${name}=something-else`,
  });

  assert.equal(ambiguous.response.status, 400);
  assert.equal(ambiguous.session, null);

  // And the legitimate browser, presenting one cookie, still completes.
  const honest = await completeSignIn(account("dup3", "dup3@example.com"), { state, cookies: login });
  assert.equal(honest.response.status, 302);
});

// --- when the database is not there ----------------------------------------

test("signing out fails visibly when the session cannot be deleted", async () => {
  const session = await signIn(account("dbfail", "dbfail@example.com"));

  // The store, unreachable. Clearing the cookie and answering 302 here would tell
  // somebody they had signed out while the row — the thing that actually grants
  // access — was still live.
  const broken = Promise.resolve({
    endSession: () => Promise.reject(new Error("connection terminated unexpectedly")),
  } as unknown as WebStore);

  await assert.rejects(
    handleSignOut(
      new Request(`${ORIGIN}/auth/signout`, {
        method: "POST",
        headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session}` },
      }),
      broken,
    ),
  );

  // The session is untouched, which is the honest state: nothing was deleted, so
  // nothing may claim to have been.
  assert.notEqual(await home(session), null);

  // And a retry against the working store does end it.
  const retried = await handleSignOut(
    new Request(`${ORIGIN}/auth/signout`, {
      method: "POST",
      headers: { origin: ORIGIN, cookie: `${SESSION_COOKIE}=${session}` },
    }),
  );
  assert.equal(retried.status, 302);
  assert.equal(await home(session), null);
});

// --- two tenants, side by side ---------------------------------------------

test("two tenants resolve independently in one process, in either order", async () => {
  await mcp("google:tenant-one", "create_label", { label: "One", instruction: "One's." });
  await mcp("google:tenant-two", "create_label", { label: "Two", instruction: "Two's." });

  const one = await signIn(account("tenant-one", "one@example.com"));
  const two = await signIn(account("tenant-two", "two@example.com"));

  // Interleaved on purpose: a store or a session cached across requests would show
  // up as one of these answering with the other's labels.
  for (const [cookie, email, label] of [
    [one, "one@example.com", "One"],
    [two, "two@example.com", "Two"],
    [one, "one@example.com", "One"],
    [two, "two@example.com", "Two"],
  ] as const) {
    const shown = await home(cookie);
    assert.equal(shown?.email, email);
    assert.deepEqual(shown?.labels.map((entry) => entry.label), [label]);
  }
});

test("the home page is declared private and uncacheable", async () => {
  // A Server Component cannot set a response header, so the rule lives in the
  // Next.js config. What must be true is that nothing between the function and the
  // browser may keep a copy of one person's labels: a CDN, a proxy, or a shared
  // browser cache handing them to the next request for the same URL is the failure.
  // `/` needs this precisely because it answers two different things at one URL.
  const { default: config } = await import("../../next.config.ts");
  const rules = await config.headers!();

  const homeRule = rules.find((rule) => rule.source === "/");
  assert.ok(homeRule, "the home page has a header rule");

  const header = (key: string) => homeRule.headers.find((one) => one.key === key)?.value ?? "";

  assert.match(header("cache-control"), /private/);
  assert.match(header("cache-control"), /no-store/);
  assert.equal(header("x-frame-options"), "DENY");
  // Deliberately not noindex: a crawler is never signed in, so what it can reach
  // here is the landing page, which is meant to be found.
  assert.equal(header("x-robots-tag"), "");

  // The sign-in endpoints answer redirects and refusals mid-flow, which must not
  // be cached either.
  const authRule = rules.find((rule) => rule.source === "/auth/:path*");
  assert.ok(authRule);
  assert.match(
    authRule.headers.find((one) => one.key === "cache-control")?.value ?? "",
    /no-store/,
  );
});

test("there is one application route, and no /dashboard behind it", async () => {
  // The app used to live at its own address. It does not any more, and there is no
  // redirect standing in for it either — a second address that renders the same
  // rows, or resolves to the one that does, is a second thing to keep true.
  assert.equal(
    existsSync(new URL("../../app/dashboard", import.meta.url)),
    false,
    "no page renders at /dashboard",
  );

  const { default: config } = await import("../../next.config.ts");
  assert.equal(config.redirects, undefined, "and nothing redirects from it");
});
