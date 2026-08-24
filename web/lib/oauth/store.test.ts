import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTHORIZATION_CODE_TTL_MS,
  OAuthStore,
  PENDING_LOGIN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from "./store.ts";

const GRANT = {
  clientId: "client-1",
  redirectUri: "https://client.example/cb",
  codeChallenge: "challenge",
  scope: "mcp",
  resource: "https://inboxlabeler.example/mcp",
  userId: "google:1",
};

const LOGIN = {
  clientId: "client-1",
  redirectUri: "https://client.example/cb",
  codeChallenge: "challenge",
  scope: "mcp",
  resource: "https://inboxlabeler.example/mcp",
  clientState: "client-state",
  nonce: "nonce",
  providerCodeVerifier: "verifier",
};

test("an authorization code is redeemable exactly once", () => {
  const store = new OAuthStore();
  const code = store.issueCode(GRANT);

  assert.equal(store.redeemCode(code)?.userId, "google:1");
  assert.equal(store.redeemCode(code), undefined, "a second redemption finds nothing");
});

test("an authorization code stops working once it expires", () => {
  const store = new OAuthStore();
  const code = store.issueCode(GRANT);
  const after = Date.now() + AUTHORIZATION_CODE_TTL_MS + 1;

  assert.equal(store.redeemCode(code, after), undefined);
});

test("a refresh token is spent by being used, so a client must keep the new one", () => {
  const store = new OAuthStore();
  const first = store.issueRefreshToken(GRANT);

  const granted = store.redeemRefreshToken(first);
  assert.equal(granted?.userId, "google:1");
  assert.equal(store.redeemRefreshToken(first), undefined, "rotation retires the old token");

  const second = store.issueRefreshToken(GRANT);
  assert.notEqual(second, first);
  assert.equal(store.redeemRefreshToken(second)?.userId, "google:1");
});

test("a refresh token stops working once it expires", () => {
  const store = new OAuthStore();
  const token = store.issueRefreshToken(GRANT);
  assert.equal(store.redeemRefreshToken(token, Date.now() + REFRESH_TOKEN_TTL_MS + 1), undefined);
});

test("a parked login resumes once, which is what makes the consent form single-use", () => {
  const store = new OAuthStore();
  const reference = store.parkLogin(LOGIN);

  assert.equal(store.takeLogin(reference)?.nonce, "nonce");
  assert.equal(store.takeLogin(reference), undefined);
});

test("a parked login expires", () => {
  const store = new OAuthStore();
  const reference = store.parkLogin(LOGIN);
  assert.equal(store.takeLogin(reference, Date.now() + PENDING_LOGIN_TTL_MS + 1), undefined);
});

test("the same login parked twice gets two references, and each is spent alone", () => {
  const store = new OAuthStore();
  const forConsent = store.parkLogin(LOGIN);
  const taken = store.takeLogin(forConsent);
  assert.ok(taken);

  const forProvider = store.parkLogin(taken);
  assert.notEqual(forProvider, forConsent);
  assert.equal(store.takeLogin(forProvider)?.clientState, "client-state");
});

test("a reference that was never issued finds nothing", () => {
  const store = new OAuthStore();
  assert.equal(store.redeemCode("made-up"), undefined);
  assert.equal(store.redeemRefreshToken("made-up"), undefined);
  assert.equal(store.takeLogin("made-up"), undefined);
  assert.equal(store.client("made-up"), undefined);
});

test("references are unguessable and never repeat", () => {
  const store = new OAuthStore();
  const codes = new Set(Array.from({ length: 200 }, () => store.issueCode(GRANT)));

  assert.equal(codes.size, 200, "no two codes collided");
  for (const code of codes) {
    // 32 bytes, base64url: no padding, and long enough that guessing is not a
    // strategy. The point of the check is that the width never quietly shrinks.
    assert.match(code, /^[A-Za-z0-9_-]{43}$/);
  }
});

test("a registered client gets an id it did not choose, and can be found by it", () => {
  const store = new OAuthStore();
  const client = store.registerClient({
    redirectUris: ["https://client.example/cb"],
    clientName: "Claude",
  });

  assert.match(client.clientId, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(store.client(client.clientId)?.redirectUris, ["https://client.example/cb"]);
});

test("two clients registering identical metadata are still two clients", () => {
  const store = new OAuthStore();
  const metadata = { redirectUris: ["https://client.example/cb"], clientName: "Claude" };

  assert.notEqual(
    store.registerClient(metadata).clientId,
    store.registerClient(metadata).clientId,
  );
});

test("one store's grants are invisible to another", () => {
  const mine = new OAuthStore();
  const theirs = new OAuthStore();
  const code = mine.issueCode(GRANT);

  assert.equal(theirs.redeemCode(code), undefined);
});
