import assert from "node:assert/strict";
import test from "node:test";

/**
 * The label and match tools, driven through the endpoint the way a client drives
 * them: an HTTP request carrying a bearer token, and nothing else.
 *
 * The store's own tests cover the domain rules. What this file is for is the
 * seam — that the user a tool acts for comes from the token and from nowhere
 * else. Every assertion here is reachable only by minting a real access token,
 * so "Alice cannot see Bob's labels" is tested against the same path a hostile
 * client would use rather than against a function call with a different argument.
 */
process.env.MCP_PUBLIC_URL = "http://localhost:3000";
process.env.OAUTH_SIGNING_SECRET = "test-signing-secret-of-at-least-32-bytes";

const { handleMcpRequest } = await import("./endpoint.ts");
const { deployment, signingKey } = await import("../oauth/config.ts");
const { mintAccessToken } = await import("../oauth/tokens.ts");

const ENDPOINT = "http://localhost:3000/mcp";
const PROTOCOL_VERSION = "2026-07-28";

async function tokenFor(user: string): Promise<string> {
  const { token } = await mintAccessToken(deployment(), signingKey(), { id: user }, "client-1", "mcp", "http://localhost:3000/mcp");
  return token;
}

/**
 * A tool's answer, as a client reads it.
 *
 * `structuredContent` is left loosely typed on purpose: seven tools return seven
 * shapes, and pinning each one here would restate the schemas rather than test
 * them. The assertions below name the fields they care about.
 */
type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: { type: string; text: string }[];
  isError?: boolean;
};

/** Calls one tool and returns its result, whether it succeeded or was refused. */
async function callTool(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
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
            "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
            "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "1.0.0" },
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    }),
  );

  const body = (await response.json()) as { result?: ToolResult; error?: unknown };
  return { status: response.status, result: body.result, error: body.error, body };
}

/** The tool's answer, insisting it was not a refusal. */
async function ok(token: string, name: string, args: Record<string, unknown> = {}) {
  const { status, result } = await callTool(token, name, args);
  assert.equal(status, 200, name);
  assert.notEqual(result?.isError, true, `${name}: ${result?.content?.[0]?.text}`);
  assert.ok(result?.structuredContent, `${name} returned no structured content`);
  // Read as `any` at the boundary rather than in the type, so each assertion can
  // name the field it means without a cast of its own.
  /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
  return result.structuredContent as any;
}

/** The reason a tool refused. */
async function refused(token: string, name: string, args: Record<string, unknown> = {}) {
  const { status, result } = await callTool(token, name, args);
  assert.equal(status, 200, "a refused tool still answers");
  assert.equal(result?.isError, true, `${name} was expected to refuse`);
  return result?.content?.[0]?.text ?? "";
}

/**
 * A user nobody else in this file uses.
 *
 * The endpoint shares one database across the whole file, so tests would
 * otherwise see each other's labels. A distinct user per test is also closer to
 * the truth: this is a multi-tenant store, and every test being its own tenant is
 * the arrangement that catches a leak.
 */
let users = 0;
const someone = () => `google:user-${++users}`;

// --- labels ---------------------------------------------------------------

test("a new user has no labels, and gets a list rather than an error", async () => {
  const token = await tokenFor(someone());

  assert.deepEqual(await ok(token, "get_labels"), { labels: [] });
});

test("a label can be created and read back", async () => {
  const token = await tokenFor(someone());

  const created = await ok(token, "create_label", {
    label: "Invoices",
    instruction: "The message is an invoice or bill.",
  });
  assert.deepEqual(created.label, {
    label: "Invoices",
    type: "detection",
    attention: "normal",
    instruction: "The message is an invoice or bill.",
  });

  const listed = await ok(token, "get_labels");
  assert.deepEqual(listed.labels, [created.label]);
});

test("a derived label is created on top of detection labels", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });
  await ok(token, "create_label", { label: "Large amount", instruction: "a big number" });

  const created = await ok(token, "create_label", {
    label: "Large invoice",
    type: "derived",
    attention: "high",
    instruction: "an invoice worth a second look",
    required_labels: ["Invoices", "Large amount"],
  });

  assert.deepEqual(created.label, {
    label: "Large invoice",
    type: "derived",
    attention: "high",
    instruction: "an invoice worth a second look",
    required_labels: ["Invoices", "Large amount"],
    recommended_labels: [],
  });
});

test("a rejected label comes back as a readable refusal, not a protocol error", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });

  assert.match(
    await refused(token, "create_label", { label: "invoices", instruction: "again" }),
    /already exists — labels are unique, ignoring case/,
  );
  assert.match(
    await refused(token, "create_label", { label: "IL/Invoices", instruction: "x" }),
    /stored without the IL\/ prefix/,
  );
  assert.match(
    await refused(token, "delete_label", { label: "Nothing" }),
    /^no label "Nothing"/,
  );
});

test("a malformed call is refused by the schema before any tool runs", async () => {
  const token = await tokenFor(someone());

  // No instruction, which the schema requires.
  const { result, error } = await callTool(token, "create_label", { label: "Invoices" });
  assert.ok(result?.isError === true || error, "the call did not succeed");
  assert.deepEqual(await ok(token, "get_labels"), { labels: [] }, "and nothing was created");
});

test("update renames a label and carries its references", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Large amount", instruction: "a big number" });
  await ok(token, "create_label", {
    label: "Large invoice",
    type: "derived",
    instruction: "x",
    required_labels: ["Large amount"],
  });

  const renamed = await ok(token, "update_label", {
    label: "Large amount",
    new_label: "Big amount",
  });
  assert.equal(renamed.label.label, "Big amount");

  const listed = await ok(token, "get_labels");
  const derived = listed.labels.find((one: { label: string }) => one.label === "Large invoice");
  assert.deepEqual(derived.required_labels, ["Big amount"]);
});

test("delete is refused while another label references it", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });
  await ok(token, "create_label", {
    label: "Large invoice",
    type: "derived",
    instruction: "x",
    required_labels: ["Invoices"],
  });

  assert.match(
    await refused(token, "delete_label", { label: "Invoices" }),
    /cannot delete detection label "Invoices": it is referenced by derived label "Large invoice"/,
  );

  await ok(token, "delete_label", { label: "Large invoice" });
  const deleted = await ok(token, "delete_label", { label: "Invoices" });
  assert.equal(deleted.deleted.label, "Invoices");
});

// --- matches --------------------------------------------------------------

test("matches are recorded against the email's own day and read back", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });

  const recorded = await ok(token, "record_matches", {
    labels: ["Invoices"],
    email_timestamp: "2026-08-20T10:12:00Z",
  });
  assert.equal(recorded.day, "2026-08-20");
  assert.equal(recorded.email_timestamp, "2026-08-20T10:12:00Z");

  const read = await ok(token, "get_matches");
  assert.deepEqual(read.matches, {
    Invoices: { last_matched_at: "2026-08-20T10:12:00Z", daily_matches: { "2026-08-20": 1 } },
  });
});

test("one email against several labels is one call", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });
  await ok(token, "create_label", { label: "Large amount", instruction: "a big number" });

  const recorded = await ok(token, "record_matches", {
    labels: ["Invoices", "Large amount"],
    email_timestamp: "2026-08-20T10:12:00Z",
  });

  assert.deepEqual(Object.keys(recorded.labels), ["Invoices", "Large amount"]);
});

test("a timestamp without an offset is refused", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });

  assert.match(
    await refused(token, "record_matches", {
      labels: ["Invoices"],
      email_timestamp: "2026-08-20T10:12:00",
    }),
    /has no UTC offset/,
  );
  assert.deepEqual((await ok(token, "get_matches")).matches, {}, "and nothing was counted");
});

test("one bad label in a batch records none of them", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });

  await refused(token, "record_matches", {
    labels: ["Invoices", "Nothing"],
    email_timestamp: "2026-08-20T10:12:00Z",
  });

  assert.deepEqual((await ok(token, "get_matches")).matches, {});
});

test("a label that has never matched reads as an empty history", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });

  const read = await ok(token, "get_matches", { label: "Invoices" });
  assert.deepEqual(read.matches, {
    Invoices: { last_matched_at: null, daily_matches: {} },
  });
});

test("renaming a label carries its history, end to end", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });
  await ok(token, "record_matches", {
    labels: ["Invoices"],
    email_timestamp: "2026-08-20T10:12:00Z",
  });

  await ok(token, "update_label", { label: "Invoices", new_label: "Bills" });

  const read = await ok(token, "get_matches");
  assert.deepEqual(read.matches, {
    Bills: { last_matched_at: "2026-08-20T10:12:00Z", daily_matches: { "2026-08-20": 1 } },
  });
});

test("deleting a label takes its history with it", async () => {
  const token = await tokenFor(someone());
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });
  await ok(token, "record_matches", {
    labels: ["Invoices"],
    email_timestamp: "2026-08-20T10:12:00Z",
  });

  await ok(token, "delete_label", { label: "Invoices" });

  assert.deepEqual((await ok(token, "get_matches")).matches, {});
});

// --- isolation, through the token -----------------------------------------

test("two users hold the same label name independently", async () => {
  const alice = await tokenFor(someone());
  const bob = await tokenFor(someone());

  await ok(alice, "create_label", { label: "Invoices", instruction: "Alice's rule" });
  await ok(bob, "create_label", { label: "Invoices", instruction: "Bob's rule" });

  assert.equal((await ok(alice, "get_labels")).labels[0].instruction, "Alice's rule");
  assert.equal((await ok(bob, "get_labels")).labels[0].instruction, "Bob's rule");
});

test("one user's labels are invisible to another", async () => {
  const alice = await tokenFor(someone());
  const bob = await tokenFor(someone());
  await ok(alice, "create_label", { label: "Alice only", instruction: "hers" });

  assert.deepEqual(await ok(bob, "get_labels"), { labels: [] });
  assert.match(await refused(bob, "delete_label", { label: "Alice only" }), /^no label/);
  assert.match(
    await refused(bob, "update_label", { label: "Alice only", attention: "high" }),
    /^no label/,
  );
});

test("one user's matches are invisible to another", async () => {
  const alice = await tokenFor(someone());
  const bob = await tokenFor(someone());
  await ok(alice, "create_label", { label: "Invoices", instruction: "hers" });
  await ok(alice, "record_matches", {
    labels: ["Invoices"],
    email_timestamp: "2026-08-20T10:12:00Z",
  });

  assert.deepEqual((await ok(bob, "get_matches")).matches, {});

  // Even holding a label of the same name, Bob reads his own empty history.
  await ok(bob, "create_label", { label: "Invoices", instruction: "his" });
  assert.deepEqual((await ok(bob, "get_matches", { label: "Invoices" })).matches, {
    Invoices: { last_matched_at: null, daily_matches: {} },
  });
});

test("a client naming another user in its arguments is ignored, not obeyed", async () => {
  const alice = await tokenFor("google:alice-fixed");
  const bob = await tokenFor("google:bob-fixed");
  await ok(alice, "create_label", { label: "Alice secret", instruction: "hers" });

  // Every shape a hostile client might try. The schemas have no such field, so
  // these are either rejected outright or ignored — never honoured.
  for (const injection of [
    { user_id: "google:alice-fixed" },
    { user: "google:alice-fixed" },
    { owner: "google:alice-fixed" },
    { sub: "google:alice-fixed" },
    { userId: "google:alice-fixed" },
  ]) {
    const { result } = await callTool(bob, "get_labels", injection);
    const labels = result?.structuredContent?.labels;
    if (labels !== undefined) {
      assert.deepEqual(labels, [], `${JSON.stringify(injection)} reached Alice's labels`);
    }
  }

  assert.equal((await ok(alice, "get_labels")).labels.length, 1, "Alice still has hers");
});

test("the tool result never carries the user's id or token", async () => {
  const token = await tokenFor("google:112233445566778899");
  await ok(token, "create_label", { label: "Invoices", instruction: "an invoice" });

  const { body } = await callTool(token, "get_labels");
  const text = JSON.stringify(body);

  assert.equal(text.includes(token), false, "no access token");
  assert.equal(text.includes("112233445566778899"), false, "no provider subject");
  assert.equal(text.includes("google:"), false, "no internal user id");
  assert.equal(text.includes(process.env.OAUTH_SIGNING_SECRET!), false, "no signing secret");
});

test("no tool works without a token", async () => {
  const response = await handleMcpRequest(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "get_labels",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_labels", arguments: {} },
      }),
    }),
  );

  assert.equal(response.status, 401);
  assert.equal((await response.text()).includes("labels"), false, "no label data leaked");
});
