import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";

/**
 * The MCP endpoint, end to end: what an MCP client can do, and what it cannot
 * do without a token.
 *
 * Configuration is set here rather than in a fixture because the modules under
 * test read it per request, which is what lets one process exercise a
 * deployment at all. The origin is loopback so that the discovery documents are
 * allowed to be served over http.
 */
process.env.PUBLIC_ORIGIN = "http://localhost:3000";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-of-at-least-32-bytes";

const { handleMcpRequest } = await import("./endpoint.ts");
const { deployment, signingKey } = await import("../oauth/config.ts");
const { mintAccessToken } = await import("../oauth/tokens.ts");

const ENDPOINT = "http://localhost:3000/mcp";

/**
 * The protocol revision these tests speak.
 *
 * Written out rather than imported: the SDK's `LATEST_PROTOCOL_VERSION` is the
 * 2025-era constant kept for the legacy fallback, so it is not this. Asserting
 * against a literal is also the point — if the endpoint's advertised revision
 * changes, a test should notice rather than follow along.
 */
const PROTOCOL_VERSION = "2026-07-28";

async function accessToken(user = "google:1", clientId = "client-1", scope = "mcp") {
  const { token } = await mintAccessToken(deployment(), signingKey(), { id: user }, clientId, scope, deployment().resource);
  return token;
}

/** What get_server_info answers with. */
type ServerInfo = { name: string; version: string; authenticated: boolean; user: string };

/**
 * Just enough of a JSON-RPC response to assert against.
 *
 * Spelled out rather than left loose so a test that reads a field the endpoint
 * stopped sending fails at the type level instead of comparing `undefined`.
 */
type RpcResponse = {
  result?: {
    supportedVersions?: string[];
    capabilities?: { tools?: unknown };
    tools?: {
      name: string;
      title?: string;
      description?: string;
      inputSchema?: unknown;
      annotations?: { readOnlyHint?: boolean };
    }[];
    structuredContent?: ServerInfo;
    _meta?: Record<string, { name?: string }>;
  };
  error?: string;
};

/** Sends one JSON-RPC request, with the headers the transport requires. */
async function call(
  method: string,
  options: { token?: string; name?: string; params?: Record<string, unknown> } = {},
): Promise<{ status: number; headers: Headers; body: string; json: RpcResponse }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": method,
  };
  if (options.name) headers["mcp-name"] = options.name;
  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...options.params,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );

  const body = await response.text();
  let json: RpcResponse = {};
  try {
    json = JSON.parse(body);
  } catch {
    // Left empty: a non-JSON body is itself what some tests assert about.
  }
  return { status: response.status, headers: response.headers, body, json };
}

/** Calls the one tool, and reads its structured result back. */
async function getServerInfo(token: string) {
  const { status, json } = await call("tools/call", {
    token,
    name: "get_server_info",
    params: { name: "get_server_info", arguments: {} },
  });
  assert.equal(status, 200, JSON.stringify(json));
  const info = json.result?.structuredContent;
  assert.ok(info, "the tool returned a structured result");
  return info;
}

// --- discovery --------------------------------------------------------------

test("an authenticated client can discover the server and its protocol revision", async () => {
  const { status, json } = await call("server/discover", { token: await accessToken() });

  assert.equal(status, 200);
  assert.deepEqual(json.result?.supportedVersions, [PROTOCOL_VERSION]);
  assert.equal(json.result?._meta?.["io.modelcontextprotocol/serverInfo"]?.name, "InboxLabeler");
  assert.ok(json.result?.capabilities?.tools, "tools are advertised");
});

test("every tool is discoverable, and only the intended ones", async () => {
  const { status, json } = await call("tools/list", { token: await accessToken() });

  assert.equal(status, 200);
  const tools = json.result?.tools;
  assert.ok(tools);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "create_label",
    "delete_label",
    "get_labels",
    "get_matches",
    "get_server_info",
    "record_matches",
    "update_label",
  ]);

  const info = tools.find((tool) => tool.name === "get_server_info");
  assert.equal(info?.title, "Server information");
  assert.equal(info?.annotations?.readOnlyHint, true);
});

test("no tool accepts a user id, so a client cannot name someone else", async () => {
  const { json } = await call("tools/list", { token: await accessToken() });
  const tools = json.result?.tools ?? [];

  assert.ok(tools.length > 1);
  for (const tool of tools) {
    const properties = Object.keys(
      (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {},
    );
    for (const property of properties) {
      assert.equal(
        /user|owner|account|subject|tenant/i.test(property),
        false,
        `${tool.name}.${property} would let a client choose whose state to touch`,
      );
    }
  }
});

test("a legacy client that still opens with initialize is served too", async () => {
  // The 2025-era shape: an `initialize` handshake and no per-request envelope.
  // The SDK's stateless fallback answers it, so a client one revision behind is
  // not turned away.
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${await accessToken()}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      }),
    }),
  );

  assert.equal(response.status, 200);
  const text = await response.text();
  assert.match(text, /InboxLabeler/);
});

// --- the authorization boundary --------------------------------------------

test("a call with no token is refused, and told where to get one", async () => {
  const { status, headers, json } = await call("tools/list");

  assert.equal(status, 401);
  assert.equal(json.error, "invalid_token");

  const challenge = headers.get("www-authenticate") ?? "";
  assert.match(challenge, /^Bearer /);
  assert.match(
    challenge,
    /resource_metadata="http:\/\/localhost:3000\/\.well-known\/oauth-protected-resource\/mcp"/,
    "the challenge points at the Protected Resource Metadata document",
  );
  assert.match(challenge, /scope="mcp"/, "and says which scope is needed");
});

test("an unauthenticated call is refused, not served as an anonymous user", async () => {
  const { status, body } = await call("tools/call", {
    name: "get_server_info",
    params: { name: "get_server_info", arguments: {} },
  });

  assert.equal(status, 401);
  assert.equal(body.includes("InboxLabeler"), false, "the tool did not run");
  assert.equal(body.includes("authenticated"), false);
});

test("an unauthenticated client cannot even list the tools", async () => {
  const { status, body } = await call("tools/list");

  assert.equal(status, 401);
  assert.equal(body.includes("get_server_info"), false);
});

test("a garbage token is refused", async () => {
  for (const token of ["not-a-token", "a.b.c", ""]) {
    const { status } = await call("tools/list", { token: token || undefined });
    assert.equal(status, 401, token);
  }
});

test("a token signed with another key is refused", async () => {
  const forged = await new SignJWT({ client_id: "client-1", scope: "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer("http://localhost:3000")
    .setAudience("http://localhost:3000/mcp")
    .setSubject("google:intruder")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode("a-different-secret-of-at-least-32-bytes!"));

  const { status, body } = await call("tools/list", { token: forged });

  assert.equal(status, 401);
  assert.equal(body.includes("get_server_info"), false);
});

test("an expired token is refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await new SignJWT({ client_id: "client-1", scope: "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer("http://localhost:3000")
    .setAudience("http://localhost:3000/mcp")
    .setSubject("google:1")
    .setIssuedAt(now - 7200)
    .setExpirationTime(now - 60)
    .sign(signingKey());

  const { status } = await call("tools/list", { token: expired });
  assert.equal(status, 401);
});

test("a token minted for another resource server is refused", async () => {
  const elsewhere = await new SignJWT({ client_id: "client-1", scope: "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer("http://localhost:3000")
    .setAudience("https://someone-else.example/mcp")
    .setSubject("google:1")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(signingKey());

  const { status } = await call("tools/list", { token: elsewhere });
  assert.equal(status, 401, "audience binding is what stops a token being replayed here");
});

test("a token without the mcp scope does not reach the tool", async () => {
  const { status } = await call("tools/list", {
    token: await accessToken("google:1", "client-1", "something-else"),
  });
  assert.equal(status, 401);
});

test("a request from an origin this deployment does not serve is refused", async () => {
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "tools/list",
        origin: "https://evil.test",
        authorization: `Bearer ${await accessToken()}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }),
  );

  assert.equal(response.status, 403);
});

// --- the authenticated call ------------------------------------------------

test("an authenticated client can call the tool", async () => {
  const info = await getServerInfo(await accessToken());

  assert.equal(info.name, "InboxLabeler");
  assert.equal(info.authenticated, true);
  assert.ok(info.user, "a reference to the caller is returned");
});

test("the tool sees the user the token was issued to", async () => {
  const alice = await getServerInfo(await accessToken("google:alice"));
  const bob = await getServerInfo(await accessToken("google:bob"));

  assert.notEqual(alice.user, bob.user, "two users are never conflated");
});

test("the same user is recognised across sessions and clients", async () => {
  const first = await getServerInfo(await accessToken("google:alice", "client-1"));
  const second = await getServerInfo(await accessToken("google:alice", "client-2"));

  assert.equal(first.user, second.user, "identity follows the user, not the client");
});

test("the identity comes from the token, not from what the caller asks for", async () => {
  // A client passing someone else's id as a tool argument must change nothing:
  // the tool takes no arguments, and the user was decided before it ran.
  const { status, json } = await call("tools/call", {
    token: await accessToken("google:alice"),
    name: "get_server_info",
    params: { name: "get_server_info", arguments: { user: "google:bob", userId: "google:bob" } },
  });

  assert.equal(status, 200);
  const answered = json.result?.structuredContent?.user;

  const bob = await getServerInfo(await accessToken("google:bob"));
  assert.notEqual(answered, bob.user, "the argument did not become the identity");

  const alice = await getServerInfo(await accessToken("google:alice"));
  assert.equal(answered, alice.user, "the token's own subject did");
});

// --- what a response must never contain -----------------------------------

test("the tool's answer carries no token, no secret and no account", async () => {
  const token = await accessToken("google:112233445566778899");
  const { body } = await call("tools/call", {
    token,
    name: "get_server_info",
    params: { name: "get_server_info", arguments: {} },
  });

  assert.equal(body.includes(token), false, "the access token is not echoed");
  assert.equal(body.includes(process.env.OAUTH_SIGNING_SECRET!), false, "the signing secret is absent");
  assert.equal(body.includes("112233445566778899"), false, "the provider's subject is not exposed");
  assert.equal(body.includes("google:"), false, "nor the internal user id");
  assert.equal(body.toLowerCase().includes("@"), false, "no address of any kind");
});

test("the reference is opaque: it does not reveal the id it was made from", async () => {
  const info = await getServerInfo(await accessToken("google:112233445566778899"));

  assert.match(info.user, /^[0-9a-f]{32}$/, "a fixed-width hex fingerprint");
  assert.equal(info.user.includes("112233"), false);
});

// --- methods the current revision removed ---------------------------------

test("GET and DELETE on the endpoint are not session operations any more", async () => {
  for (const method of ["GET", "DELETE"]) {
    const response = await handleMcpRequest(
      new Request(ENDPOINT, {
        method,
        headers: { authorization: `Bearer ${await accessToken()}` },
      }),
    );
    assert.equal(response.status, 405, method);
  }
});
