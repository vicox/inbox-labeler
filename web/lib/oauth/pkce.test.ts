import assert from "node:assert/strict";
import test from "node:test";

import {
  challengeFor,
  checkCodeChallenge,
  checkCodeVerifier,
  createPkce,
  verifyCodeChallenge,
} from "./pkce.ts";

/**
 * PKCE inputs, against RFC 7636's own limits.
 *
 * Checking the shape matters for a reason beyond tidiness: a challenge that no
 * verifier can satisfy, accepted at the authorization request, becomes a flow
 * that fails minutes later at the token endpoint with a message about a
 * mismatched proof — which tells the client nothing about the request that was
 * actually malformed.
 */

/** The error a check refused with, or "accepted". */
const refusal = (result: { error: string } | object) => ("error" in result ? result.error : "accepted");

test("what this server generates is what it accepts", () => {
  const { verifier, challenge } = createPkce();

  assert.equal(refusal(checkCodeVerifier(verifier)), "accepted");
  assert.equal(refusal(checkCodeChallenge(challenge)), "accepted");
  assert.equal(verifyCodeChallenge(challenge, verifier), true);
});

// --- challenges -----------------------------------------------------------

test("an S256 challenge is exactly the width of the digest behind it", () => {
  // 32 bytes of SHA-256 is 43 unpadded base64url characters, always. A challenge
  // of any other length was not produced by hashing a verifier.
  assert.equal(refusal(checkCodeChallenge("a".repeat(43))), "accepted");
  assert.match(refusal(checkCodeChallenge("a".repeat(42))), /43 characters/);
  assert.match(refusal(checkCodeChallenge("a".repeat(44))), /43 characters/);
  assert.match(refusal(checkCodeChallenge("")), /43 characters/);
});

test("a challenge must be base64url, without padding", () => {
  assert.match(refusal(checkCodeChallenge(`${"a".repeat(42)}+`)), /base64url/);
  assert.match(refusal(checkCodeChallenge(`${"a".repeat(42)}/`)), /base64url/);
  assert.match(refusal(checkCodeChallenge(`${"a".repeat(42)}=`)), /base64url/);
  assert.equal(refusal(checkCodeChallenge(`${"a".repeat(41)}-_`)), "accepted", "- and _ are base64url");
});

test("a challenge that is not a string is refused rather than coerced", () => {
  for (const value of [undefined, null, 42, {}, ["a".repeat(43)]]) {
    assert.match(refusal(checkCodeChallenge(value)), /43 characters/, String(value));
  }
});

// --- verifiers ------------------------------------------------------------

test("a verifier is between 43 and 128 characters", () => {
  assert.equal(refusal(checkCodeVerifier("a".repeat(43))), "accepted");
  assert.equal(refusal(checkCodeVerifier("a".repeat(128))), "accepted");
  assert.match(refusal(checkCodeVerifier("a".repeat(42))), /between 43 and 128/);
  assert.match(refusal(checkCodeVerifier("a".repeat(129))), /between 43 and 128/);
  assert.match(refusal(checkCodeVerifier("")), /between 43 and 128/);
});

test("a verifier uses the unreserved characters and no others", () => {
  assert.equal(refusal(checkCodeVerifier(`${"a".repeat(39)}-._~`)), "accepted");
  assert.match(refusal(checkCodeVerifier(`${"a".repeat(42)}!`)), /may only contain/);
  assert.match(refusal(checkCodeVerifier(`${"a".repeat(42)} `)), /may only contain/);
  assert.match(refusal(checkCodeVerifier(`${"a".repeat(42)}+`)), /may only contain/);
  assert.match(refusal(checkCodeVerifier(`${"a".repeat(42)}\n`)), /may only contain/);
});

test("a verifier that is not a string is refused rather than coerced", () => {
  for (const value of [undefined, null, 42, {}]) {
    assert.match(refusal(checkCodeVerifier(value)), /between 43 and 128/, String(value));
  }
});

// --- the proof itself -----------------------------------------------------

test("only the verifier the challenge was made from satisfies it", () => {
  const { verifier, challenge } = createPkce();
  const other = createPkce();

  assert.equal(verifyCodeChallenge(challenge, verifier), true);
  assert.equal(verifyCodeChallenge(challenge, other.verifier), false);
  assert.equal(verifyCodeChallenge(challenge, undefined), false);
  assert.equal(verifyCodeChallenge(challenge, ""), false);
});

test("the challenge is the base64url SHA-256 of the verifier's ASCII bytes", () => {
  // RFC 7636's own worked example, which is the one thing here that can be
  // checked against something outside this repository.
  assert.equal(
    challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});
