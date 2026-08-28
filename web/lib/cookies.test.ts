import assert from "node:assert/strict";
import test from "node:test";

import { clearCookie, cookieName, cookieOf, newCookieValue, setCookie } from "./cookies.ts";
import type { Deployment } from "./oauth/config.ts";

/**
 * How this deployment writes and reads a cookie.
 *
 * Every cookie here is a credential — a binding for one step of a flow, or a
 * session — so the attributes are not decoration. These tests hold the three
 * things that would be invisible if they broke: that production names cookies in
 * the form a browser will not let another host forge, that loopback does not
 * (because it cannot), and that an ambiguous `Cookie` header is read as no
 * credential at all rather than as one of the values in it.
 */

function deploymentAt(origin: string): Deployment {
  const url = new URL(origin);
  return {
    issuer: url.origin,
    resource: `${url.origin}/mcp`,
    authorizationEndpoint: `${url.origin}/oauth/authorize`,
    tokenEndpoint: `${url.origin}/oauth/token`,
    registrationEndpoint: `${url.origin}/oauth/register`,
    callbackEndpoint: `${url.origin}/oauth/callback`,
    webCallbackEndpoint: `${url.origin}/auth/callback`,
    resourceMetadataUrl: `${url.origin}/.well-known/oauth-protected-resource/mcp`,
    hostname: url.hostname,
    insecure: url.hostname === "localhost",
  };
}

const PRODUCTION = deploymentAt("https://inboxlabeler.com");
const LOOPBACK = deploymentAt("http://localhost:3000");

function requestWith(cookie: string): Request {
  return new Request("https://inboxlabeler.com/dashboard", { headers: { cookie } });
}

// --- production ------------------------------------------------------------

test("production names every cookie with the __Host- prefix", () => {
  assert.equal(cookieName("il_session", PRODUCTION), "__Host-il_session");
  assert.equal(cookieName("il_login_abc", PRODUCTION), "__Host-il_login_abc");
});

test("a production cookie carries what the prefix requires, and no Domain", () => {
  const header = setCookie("il_session", "the-value", PRODUCTION, {
    sameSite: "Lax",
    maxAgeSeconds: 604800,
  });

  assert.match(header, /^__Host-il_session=the-value;/);
  // The three the browser insists on for a `__Host-` cookie. Without all of them
  // it refuses to store it at all, which would be a silent sign-out.
  assert.match(header, /Secure/);
  assert.match(header, /Path=\//);
  assert.equal(/Path=\/\w/.test(header), false, "Path is the root, not a subtree");
  assert.equal(header.includes("Domain"), false, "a Domain would void the prefix");

  assert.match(header, /HttpOnly/, "no script may read it");
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Max-Age=604800/);
});

test("Strict is available and is written through unchanged", () => {
  const header = setCookie("il_consent_abc", "v", PRODUCTION, {
    sameSite: "Strict",
    maxAgeSeconds: 600,
  });

  assert.match(header, /SameSite=Strict/);
  assert.match(header, /^__Host-il_consent_abc=v;/);
});

test("clearing a cookie uses the same name, so it clears the one that was set", () => {
  const set = setCookie("il_session", "v", PRODUCTION, { sameSite: "Lax", maxAgeSeconds: 60 });
  const cleared = clearCookie("il_session", PRODUCTION, "Lax");

  assert.equal(set.split("=")[0], cleared.split("=")[0]);
  assert.match(cleared, /^__Host-il_session=;/);
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Secure/, "a cleared Secure cookie must also be Secure to replace it");
});

// --- loopback --------------------------------------------------------------

test("loopback drops the prefix, because the prefix requires Secure", () => {
  // A browser rejects a Secure cookie over plain http, and rejects a `__Host-`
  // cookie that is not Secure. Keeping the prefix locally would mean local
  // development could not sign in at all.
  assert.equal(cookieName("il_session", LOOPBACK), "il_session");

  const header = setCookie("il_session", "v", LOOPBACK, { sameSite: "Lax", maxAgeSeconds: 60 });
  assert.equal(header.includes("Secure"), false);
  assert.equal(header.includes("__Host-"), false);
  // Everything else is the same, so the two environments differ in the name alone.
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
});

test("the two environments are told apart by the configured origin, not a switch", () => {
  // `insecure` comes from PUBLIC_ORIGIN via `deployment()`. A production origin can
  // therefore never be served unprefixed by mistake.
  assert.notEqual(cookieName("il_session", PRODUCTION), cookieName("il_session", LOOPBACK));
});

// --- reading ---------------------------------------------------------------

test("a cookie is read under the name this deployment would have written", () => {
  assert.equal(cookieOf(requestWith("__Host-il_session=abc"), "il_session", PRODUCTION), "abc");
  assert.equal(cookieOf(requestWith("il_session=abc"), "il_session", LOOPBACK), "abc");
});

test("a production reader does not accept the unprefixed name", () => {
  // Which is the point of the prefix: a cookie some other host set for this name
  // is not the cookie this deployment writes, and must not be mistaken for it.
  assert.equal(cookieOf(requestWith("il_session=abc"), "il_session", PRODUCTION), null);
});

test("other cookies in the header do not confuse the one being read", () => {
  const header = "theme=dark; __Host-il_session=abc; other=1; __Host-il_login_x=def";

  assert.equal(cookieOf(requestWith(header), "il_session", PRODUCTION), "abc");
  assert.equal(cookieOf(requestWith(header), "il_login_x", PRODUCTION), "def");
  assert.equal(cookieOf(requestWith(header), "il_login_y", PRODUCTION), null);
});

test("a duplicate name is read as no cookie at all", () => {
  // What cookie tossing produces. Taking the first, or the last, would be choosing
  // which of two credentials to honour on a rule the attacker also knows — so an
  // ambiguous header resolves to nothing and whatever needed it fails closed.
  const header = "__Host-il_session=mine; __Host-il_session=theirs";

  assert.equal(cookieOf(requestWith(header), "il_session", PRODUCTION), null);
});

test("an empty value, a missing cookie and a missing header all read as nothing", () => {
  assert.equal(cookieOf(requestWith("__Host-il_session="), "il_session", PRODUCTION), null);
  assert.equal(cookieOf(requestWith("other=1"), "il_session", PRODUCTION), null);
  assert.equal(
    cookieOf(new Request("https://inboxlabeler.com/dashboard"), "il_session", PRODUCTION),
    null,
  );
});

test("a malformed header does not throw and does not match", () => {
  for (const header of ["", ";", "=", "; ; ;", "no-equals-sign", "=value"]) {
    assert.equal(cookieOf(requestWith(header), "il_session", PRODUCTION), null, header);
  }
});

// --- the value -------------------------------------------------------------

test("a cookie value is unguessable and safe to put in a header", () => {
  const values = Array.from({ length: 200 }, () => newCookieValue());

  assert.equal(new Set(values).size, 200, "no repeats");
  for (const value of values) {
    // 32 bytes, base64url. The alphabet matters as much as the entropy: a value
    // containing ';' or a newline would let a cookie define its own attributes.
    assert.match(value, /^[A-Za-z0-9_-]{43}$/);
  }
});
