import assert from "node:assert/strict";
import test from "node:test";

import { consentPage } from "./consent.ts";

const PROMPT = {
  redirectUri: "https://client.example/cb",
  reference: "the-reference",
  action: "https://inboxlabeler.example/oauth/authorize",
};

test("the page names the client and where an approval would send the code", () => {
  const html = consentPage({ ...PROMPT, clientName: "Claude" });

  assert.match(html, /Claude/);
  assert.match(html, /client\.example/, "the redirect host is shown, per the spec");
  assert.match(html, /name="request" value="the-reference"/, "the single-use reference is carried");
  assert.match(html, /action="https:\/\/inboxlabeler\.example\/oauth\/authorize"/);
  assert.match(html, /name="approve"/);
  assert.match(html, /name="deny"/);
});

test("a client that registered no name is described as such, not left blank", () => {
  const html = consentPage(PROMPT);
  assert.match(html, /did not give a name/);
});

// --- escaping ---------------------------------------------------------------
//
// The client's name and redirect URI arrive from an unauthenticated
// registration request, so both are attacker-controlled text being written into
// a page on this origin. This is the page where an injection would do the most
// damage, because it is the one that collects an approval.

test("a client name cannot break out of the page", () => {
  const html = consentPage({
    ...PROMPT,
    clientName: "<script>alert(1)</script>",
  });

  assert.equal(html.includes("<script>alert(1)</script>"), false);
  assert.match(html, /&lt;script&gt;/);
});

test("a client name cannot break out of an attribute", () => {
  const html = consentPage({
    ...PROMPT,
    clientName: '" onmouseover="alert(1)',
  });

  assert.equal(html.includes('onmouseover="alert(1)'), false);
  assert.match(html, /&quot;/);
});

test("a redirect URI cannot break out of the page", () => {
  const html = consentPage({
    ...PROMPT,
    redirectUri: "https://evil.test/cb?x=<img src=x onerror=alert(1)>",
  });

  assert.equal(html.includes("<img src=x"), false);
});

test("the form action cannot break out of its attribute", () => {
  const html = consentPage({ ...PROMPT, action: '"><script>alert(1)</script>' });

  assert.equal(html.includes("<script>"), false);
});

test("a hostile reference cannot break out of the hidden field", () => {
  const html = consentPage({ ...PROMPT, reference: '"><script>alert(1)</script>' });

  assert.equal(html.includes("<script>"), false);
});

test("an ampersand in a name is escaped rather than left as a bare entity", () => {
  const html = consentPage({ ...PROMPT, clientName: "Tom & Jerry" });

  assert.match(html, /Tom &amp; Jerry/);
});

test("a redirect URI that will not parse is shown whole rather than hidden", () => {
  const html = consentPage({ ...PROMPT, redirectUri: "not a uri" });

  assert.match(html, /not a uri/);
});
