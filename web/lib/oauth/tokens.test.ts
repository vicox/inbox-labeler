import assert from "node:assert/strict";
import test from "node:test";
import { SignJWT } from "jose";

import type { Deployment } from "./config.ts";
import { ACCESS_TOKEN_TTL_SECONDS, accessTokenVerifier, mintAccessToken } from "./tokens.ts";

const DEPLOYMENT: Deployment = {
  issuer: "https://inboxlabeler.example",
  resource: "https://inboxlabeler.example/mcp",
  authorizationEndpoint: "https://inboxlabeler.example/oauth/authorize",
  tokenEndpoint: "https://inboxlabeler.example/oauth/token",
  registrationEndpoint: "https://inboxlabeler.example/oauth/register",
  callbackEndpoint: "https://inboxlabeler.example/oauth/callback",
  resourceMetadataUrl: "https://inboxlabeler.example/.well-known/oauth-protected-resource/mcp",
  hostname: "inboxlabeler.example",
  insecure: false,
};

const KEY = new TextEncoder().encode("a".repeat(48));
const OTHER_KEY = new TextEncoder().encode("b".repeat(48));

const verifier = accessTokenVerifier(DEPLOYMENT, KEY);

async function mint(user = "google:1", clientId = "client-1", scope = "mcp") {
  const { token } = await mintAccessToken(DEPLOYMENT, KEY, { id: user }, clientId, scope, DEPLOYMENT.resource);
  return token;
}

/**
 * Signs a token by hand, so a test can spoil exactly one thing and leave the
 * rest genuinely valid.
 *
 * Every claim is a named option rather than a payload to spread, because the
 * `SignJWT` setters overwrite the payload: a spread `aud` would be silently
 * replaced by `setAudience`, and the test would forge a perfectly valid token
 * while claiming to forge a bad one.
 */
function forge(
  spoil: {
    key?: Uint8Array;
    issuer?: string;
    audience?: string;
    subject?: string | null;
    scope?: string;
    issuedAt?: number;
    expiresAt?: number | string;
  } = {},
) {
  const token = new SignJWT({ client_id: "client-1", scope: spoil.scope ?? "mcp" })
    .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
    .setIssuer(spoil.issuer ?? DEPLOYMENT.issuer)
    .setAudience(spoil.audience ?? DEPLOYMENT.resource)
    .setIssuedAt(spoil.issuedAt)
    .setExpirationTime(spoil.expiresAt ?? `${ACCESS_TOKEN_TTL_SECONDS}s`);

  // `null` means leave the subject out, which is a different thing from an
  // empty one and is the case the verifier has to refuse.
  if (spoil.subject !== null) token.setSubject(spoil.subject ?? "google:1");

  return token.sign(spoil.key ?? KEY);
}

/**
 * The OAuth error code a token was refused with, or "accepted".
 *
 * The code, not the message: the code is what the SDK turns into the HTTP
 * status and the `WWW-Authenticate` challenge, so it is the part a client acts
 * on. The message is asserted separately, once, where uniformity is the point.
 */
async function verify(token: string): Promise<string> {
  try {
    await verifier.verifyAccessToken(token);
    return "accepted";
  } catch (error) {
    return String((error as { code?: string }).code ?? (error as Error).message);
  }
}

test("a freshly minted token verifies, and says who it is for", async () => {
  const info = await verifier.verifyAccessToken(await mint("google:42", "client-9"));

  assert.equal(info.extra?.userId, "google:42");
  assert.equal(info.clientId, "client-9");
  assert.deepEqual(info.scopes, ["mcp"]);
  assert.equal(info.resource?.href, DEPLOYMENT.resource);
  assert.ok(info.expiresAt && info.expiresAt > Date.now() / 1000);
});

test("the user id comes from the token's subject and nothing else", async () => {
  const a = await verifier.verifyAccessToken(await mint("google:a"));
  const b = await verifier.verifyAccessToken(await mint("google:b"));

  assert.equal(a.extra?.userId, "google:a");
  assert.equal(b.extra?.userId, "google:b");
});

test("a token signed with another key is refused", async () => {
  assert.equal(await verify(await forge({ key: OTHER_KEY })), "invalid_token");
});

test("a tampered token is refused", async () => {
  const token = await mint();
  const [header, payload, signature] = token.split(".");
  const swapped = JSON.parse(Buffer.from(payload, "base64url").toString());
  swapped.sub = "google:someone-else";
  const repacked = Buffer.from(JSON.stringify(swapped)).toString("base64url");

  assert.equal(await verify(`${header}.${repacked}.${signature}`), "invalid_token");
});

test("an unsigned token is refused", async () => {
  const payload = Buffer.from(
    JSON.stringify({
      iss: DEPLOYMENT.issuer,
      aud: DEPLOYMENT.resource,
      sub: "google:1",
      scope: "mcp",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");

  assert.equal(await verify(`${header}.${payload}.`), "invalid_token");
});

test("an expired token is refused", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = await forge({ issuedAt: now - 7200, expiresAt: now - 3600 });

  assert.equal(await verify(expired), "invalid_token");
});

test("a token minted for another audience is refused, however well it is signed", async () => {
  assert.equal(await verify(await forge({ audience: "https://evil.test/mcp" })), "invalid_token");
});

test("a token from another issuer is refused", async () => {
  assert.equal(await verify(await forge({ issuer: "https://evil.test" })), "invalid_token");
});

test("a token without the mcp scope is refused", async () => {
  assert.equal(await verify(await mint("google:1", "client-1", "")), "invalid_token");
  assert.equal(await verify(await mint("google:1", "client-1", "something-else")), "invalid_token");
});

test("a token without a subject is refused: there is no one to attribute it to", async () => {
  assert.equal(await verify(await forge({ subject: null })), "invalid_token");
});

test("nonsense is refused rather than crashing", async () => {
  for (const token of ["", "not-a-token", "a.b.c", "Bearer x"]) {
    assert.equal(await verify(token), "invalid_token", token);
  }
});

test("every refusal reads the same, so probing learns nothing from the reason", async () => {
  const reasons = await Promise.all([
    verifyMessage(await forge({ key: OTHER_KEY })),
    verifyMessage(await forge({ audience: "https://evil.test/mcp" })),
    verifyMessage(await forge({ subject: null })),
    verifyMessage("garbage"),
  ]);

  assert.equal(new Set(reasons).size, 1, reasons.join(" | "));
});

async function verifyMessage(token: string): Promise<string> {
  try {
    await verifier.verifyAccessToken(token);
    return "accepted";
  } catch (error) {
    return (error as Error).message;
  }
}

test("a token does not carry the signing secret", async () => {
  const token = await mint();
  const decoded = Buffer.from(token.split(".")[1], "base64url").toString();

  assert.equal(decoded.includes("aaaa"), false);
  assert.match(decoded, /"sub":"google:1"/);
});

test("the audience is the resource it was minted for, not the deployment's current one", async () => {
  // Minting for a resource this deployment does not serve is possible — the
  // caller decides — and such a token is then refused here, which is the property
  // that keeps a grant from being retargeted by a configuration change.
  const { token } = await mintAccessToken(
    DEPLOYMENT,
    KEY,
    { id: "google:1" },
    "client-1",
    "mcp",
    "https://somewhere-else.example/mcp",
  );

  const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  assert.equal(claims.aud, "https://somewhere-else.example/mcp");
  assert.equal(await verify(token), "invalid_token", "and this server will not accept it");
});
