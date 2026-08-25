import assert from "node:assert/strict";
import test from "node:test";

/**
 * The promises a hosted deployment has to keep.
 *
 * Everything here is about the difference between running this on a laptop and
 * running it at a public origin. Development is allowed conveniences — an origin
 * it can assume, a database it can conjure — and production is allowed none of
 * them, because each one would be a way for a deployment to look healthy while
 * serving something nobody meant.
 *
 * `NODE_ENV` is set per test rather than for the file, so the two worlds can be
 * compared in one run. It is restored afterwards; nothing else in the suite would
 * survive being left in production.
 */

const { ConfigurationError, deployment, signingKey } = await import("./oauth/config.ts");
const { authorizationServerMetadata, authMetadataOptions } = await import("./oauth/metadata.ts");
const { buildOAuthProtectedResourceMetadata } = await import("@modelcontextprotocol/server");
const { discoveryResponse } = await import("./oauth/discovery.ts");

const PRODUCTION_ORIGIN = "https://inboxlabeler.com";

/** Runs `work` as though this process were a production deployment. */
async function inProduction<T>(env: Record<string, string | undefined>, work: () => T | Promise<T>) {
  const before = { ...process.env };
  // Next.js types NODE_ENV as read-only, which is right for application code and
  // exactly what this has to override: the point of the test is to be the other
  // environment for a moment.
  const mutable = process.env as Record<string, string | undefined>;

  mutable.NODE_ENV = "production";
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete mutable[name];
    else mutable[name] = value;
  }
  try {
    return await work();
  } finally {
    for (const name of Object.keys(mutable)) delete mutable[name];
    Object.assign(mutable, before);
  }
}

/** The error a call refused with, or "accepted". */
async function refusal(work: () => unknown): Promise<string> {
  try {
    await work();
    return "accepted";
  } catch (error) {
    if (error instanceof ConfigurationError) return error.message;
    throw error;
  }
}

// --- nothing is assumed in production -------------------------------------

test("production refuses to run without a public origin", async () => {
  const message = await inProduction({ PUBLIC_ORIGIN: undefined }, () => refusal(deployment));

  assert.match(message, /PUBLIC_ORIGIN is not set/);
  assert.equal(message.includes("localhost"), false, "and does not fall back to one");
});

test("production refuses to run without durable storage", async () => {
  const { database } = await import("./db.ts");

  const message = await inProduction(
    { PUBLIC_ORIGIN: PRODUCTION_ORIGIN, DATABASE_URL: undefined },
    () => refusal(database),
  );

  assert.match(message, /DATABASE_URL is not set/);
});

test("production refuses to run without a signing secret", async () => {
  const message = await inProduction(
    { PUBLIC_ORIGIN: PRODUCTION_ORIGIN, OAUTH_SIGNING_SECRET: undefined },
    () => refusal(signingKey),
  );

  assert.match(message, /OAUTH_SIGNING_SECRET must be at least 32 bytes/);
});

test("a short signing secret is refused rather than stretched", async () => {
  const message = await inProduction({ OAUTH_SIGNING_SECRET: "too-short" }, () => refusal(signingKey));

  assert.match(message, /at least 32 bytes/);
});

// --- the URLs a client will actually see -----------------------------------

test("every public URL is derived from the configured origin", async () => {
  const config = await inProduction({ PUBLIC_ORIGIN: PRODUCTION_ORIGIN }, deployment);

  assert.deepEqual(config, {
    issuer: "https://inboxlabeler.com",
    resource: "https://inboxlabeler.com/mcp",
    authorizationEndpoint: "https://inboxlabeler.com/oauth/authorize",
    tokenEndpoint: "https://inboxlabeler.com/oauth/token",
    registrationEndpoint: "https://inboxlabeler.com/oauth/register",
    callbackEndpoint: "https://inboxlabeler.com/oauth/callback",
    resourceMetadataUrl:
      "https://inboxlabeler.com/.well-known/oauth-protected-resource/mcp",
    hostname: "inboxlabeler.com",
    insecure: false,
  });
});

test("a trailing slash is not a difference", async () => {
  // A client compares the issuer byte for byte, so it must not vary with how
  // somebody happened to type the variable — and these two are the same origin.
  for (const written of ["https://inboxlabeler.com", "https://inboxlabeler.com/"]) {
    const config = await inProduction({ PUBLIC_ORIGIN: written }, deployment);
    assert.equal(config.issuer, "https://inboxlabeler.com", written);
    assert.equal(config.resource, "https://inboxlabeler.com/mcp", written);
  }
});

test("a path is refused rather than quietly dropped", async () => {
  // Every endpoint is derived by appending to this value, so dropping a path
  // would serve the OAuth surface from somewhere nobody configured — and nothing
  // would say so until a client failed.
  const message = await inProduction({ PUBLIC_ORIGIN: "https://inboxlabeler.com/app" }, () =>
    refusal(deployment),
  );

  assert.match(message, /must be an origin with no path/);
  assert.match(message, /https:\/\/inboxlabeler\.com/, "and it says what to use instead");
});

test("a query or a fragment is refused too", async () => {
  for (const written of ["https://inboxlabeler.com?x=1", "https://inboxlabeler.com#x"]) {
    assert.match(
      await inProduction({ PUBLIC_ORIGIN: written }, () => refusal(deployment)),
      /no path, query or fragment/,
      written,
    );
  }
});

test("something that is not a URL at all is refused", async () => {
  for (const written of ["inboxlabeler.com", "not a url", "://x"]) {
    assert.match(
      await inProduction({ PUBLIC_ORIGIN: written }, () => refusal(deployment)),
      /is not a URL|must be an http or https URL/,
      written,
    );
  }
});

test("a scheme other than http or https is refused", async () => {
  assert.match(
    await inProduction({ PUBLIC_ORIGIN: "ftp://inboxlabeler.com" }, () => refusal(deployment)),
    /must be an http or https URL/,
  );
});

test("no discovery document mentions localhost when a real origin is configured", async () => {
  const documents = await inProduction(
    { PUBLIC_ORIGIN: PRODUCTION_ORIGIN, OAUTH_SIGNING_SECRET: "x".repeat(48) },
    async () => {
      const paths = [
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
      ];
      return Promise.all(
        paths.map(async (path) => {
          const response = discoveryResponse(new Request(`${PRODUCTION_ORIGIN}${path}`));
          assert.equal(response.status, 200, path);
          return { path, body: await response.text() };
        }),
      );
    },
  );

  for (const { path, body } of documents) {
    assert.equal(body.includes("localhost"), false, `${path} mentions localhost`);
    assert.equal(body.includes("127.0.0.1"), false, `${path} mentions a loopback address`);
    assert.equal(body.includes("http://"), false, `${path} names a plaintext URL`);
    assert.match(body, /https:\/\/inboxlabeler\.com/, path);
  }
});

test("the protected resource document is published at the path RFC 9728 requires", async () => {
  const config = await inProduction({ PUBLIC_ORIGIN: PRODUCTION_ORIGIN }, deployment);

  // The resource's path is reflected into the well-known route, so /mcp is
  // published under /.well-known/oauth-protected-resource/mcp and not at the bare
  // well-known path. A client that cannot find this cannot start.
  assert.equal(
    config.resourceMetadataUrl,
    "https://inboxlabeler.com/.well-known/oauth-protected-resource/mcp",
  );
});

test("a production origin is never treated as insecure", async () => {
  const config = await inProduction({ PUBLIC_ORIGIN: PRODUCTION_ORIGIN }, deployment);
  const options = authMetadataOptions(config);

  // The flag that lets a loopback origin serve OAuth metadata over plain HTTP.
  // It is derived from the origin rather than from a switch, so there is nothing
  // to leave enabled by accident.
  assert.equal(options.dangerouslyAllowInsecureIssuerUrl, false);
});

test("an http origin is only ever tolerated on loopback", async () => {
  const loopback = await inProduction({ PUBLIC_ORIGIN: "http://localhost:3000" }, deployment);
  assert.equal(loopback.insecure, true);

  const remote = await inProduction({ PUBLIC_ORIGIN: "http://inboxlabeler.com" }, deployment);
  assert.equal(remote.insecure, false, "a non-loopback http origin gets no exemption");

  // And nothing will publish metadata for it: the SDK validates the issuer URL
  // while building the document, so a plaintext public origin fails loudly rather
  // than advertising an issuer every conforming client would reject.
  assert.throws(
    () => buildOAuthProtectedResourceMetadata(authMetadataOptions(remote)),
    /https/i,
  );
});

// --- what a misconfigured deployment tells the world ----------------------

test("a misconfigured deployment does not name its own variables to a client", async () => {
  const response = await inProduction({ PUBLIC_ORIGIN: undefined }, async () => {
    const answer = discoveryResponse(new Request("https://inboxlabeler.com/.well-known/oauth-authorization-server"));
    return { status: answer.status, body: await answer.text() };
  });

  assert.equal(response.status, 500);
  for (const leak of ["PUBLIC_ORIGIN", "DATABASE_URL", "OAUTH_SIGNING_SECRET", "GOOGLE_CLIENT"]) {
    assert.equal(response.body.includes(leak), false, `the 500 body names ${leak}`);
  }
  assert.match(response.body, /not configured correctly/);
});

test("the authorization server metadata promises only what is implemented", async () => {
  const config = await inProduction({ PUBLIC_ORIGIN: PRODUCTION_ORIGIN }, deployment);
  const metadata = authorizationServerMetadata(config);

  // Deployment-readiness rather than protocol: a document that advertises an
  // endpoint this deployment does not serve would send clients to a 404.
  assert.equal(metadata.revocation_endpoint, undefined, "revocation is not implemented");
  assert.equal(metadata.introspection_endpoint, undefined, "introspection is not implemented");
  assert.equal(metadata.client_id_metadata_document_supported, undefined, "CIMD is not implemented");
  assert.ok(metadata.registration_endpoint, "dynamic registration is");
});

// --- only at the canonical origin -----------------------------------------
//
// A hosting platform gives every deployment its own hostname, and those
// deployments generally share the project's environment. Without this, the
// authorization server exists at several addresses at once, all signing with the
// same key, while the metadata names one — so a preview host could run a flow and
// mint a token nothing advertised.

const { handleRegistration } = await import("./oauth/registration.ts");
const { handleAuthorize } = await import("./oauth/authorization.ts");
const { handleToken } = await import("./oauth/exchange.ts");
const { handleMcpRequest } = await import("./mcp/endpoint.ts");

/** A request to `path` arriving at `host`, whatever the configured origin is. */
function arriving(host: string, path: string, method = "POST"): Request {
  return new Request(`https://${host}${path}`, {
    method,
    headers: { host, "content-type": "application/json" },
    body: method === "POST" ? "{}" : undefined,
  });
}

test("a request to a non-canonical hostname is refused, whatever the endpoint", async () => {
  const preview = "inboxlabeler-git-feature-acme.vercel.app";

  const answers = await inProduction(
    {
      PUBLIC_ORIGIN: PRODUCTION_ORIGIN,
      OAUTH_SIGNING_SECRET: "x".repeat(48),
      DATABASE_URL: undefined,
    },
    async () => [
      ["register", await handleRegistration(arriving(preview, "/oauth/register"))],
      ["authorize", await handleAuthorize(arriving(preview, "/oauth/authorize", "GET"))],
      ["token", await handleToken(arriving(preview, "/oauth/token"))],
      ["mcp", await handleMcpRequest(arriving(preview, "/mcp"))],
    ] as const,
  );

  for (const [name, response] of answers) {
    // 404: at an address this server does not serve, there is nothing here. Note
    // DATABASE_URL is deliberately unset — the refusal happens before anything
    // would have needed it, which is what "before anything else looks at it" means.
    assert.equal(response.status, 404, name);
  }
});

test("the guard passes a request that did arrive at the canonical hostname", async () => {
  const { wrongOrigin } = await import("./oauth/origin.ts");

  const config = await inProduction({ PUBLIC_ORIGIN: PRODUCTION_ORIGIN }, deployment);

  // Asserted on the guard itself rather than through a handler, because a handler
  // that gets past it goes on to need a database, and what is being checked here
  // is only that the gate opens.
  assert.equal(wrongOrigin(arriving("inboxlabeler.com", "/mcp"), config), undefined);
  assert.equal(wrongOrigin(arriving("INBOXLABELER.COM", "/mcp"), config), undefined, "host case");
  assert.equal(wrongOrigin(arriving("inboxlabeler.com:443", "/mcp"), config), undefined, "with a port");

  assert.equal(wrongOrigin(arriving("preview.vercel.app", "/mcp"), config)?.status, 404);
  assert.equal(wrongOrigin(arriving("inboxlabeler.com.evil.test", "/mcp"), config)?.status, 404);
  assert.equal(wrongOrigin(arriving("evil.test", "/mcp"), config)?.status, 404);
});

test("a forged X-Forwarded-Host does not make a preview host canonical", async () => {
  const response = await inProduction(
    { PUBLIC_ORIGIN: PRODUCTION_ORIGIN, OAUTH_SIGNING_SECRET: "x".repeat(48) },
    () => {
      const request = new Request("https://preview.vercel.app/oauth/register", {
        method: "POST",
        headers: {
          host: "preview.vercel.app",
          // What an attacker would add. The check reads Host, which the platform
          // sets, and never this.
          "x-forwarded-host": "inboxlabeler.com",
          "content-type": "application/json",
        },
        body: "{}",
      });
      return handleRegistration(request);
    },
  );

  assert.equal(response.status, 404);
});

test("development is exempt, so a loopback checkout keeps working", async () => {
  // The exemption is derived from the configured origin being loopback, not from
  // a switch — so it cannot be left on for a real one.
  const config = await inProduction({ PUBLIC_ORIGIN: "http://localhost:3000" }, deployment);
  assert.equal(config.insecure, true);

  const response = await handleAuthorize(
    new Request("http://127.0.0.1:3000/oauth/authorize", {
      method: "GET",
      headers: { host: "127.0.0.1:3000" },
    }),
  );
  assert.notEqual(response.status, 404, "a different loopback spelling is still served");
});
